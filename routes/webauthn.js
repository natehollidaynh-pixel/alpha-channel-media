const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Derive RP config from APP_URL
function getRPConfig(req) {
  const appUrl = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  const url = new URL(appUrl);
  return {
    rpID: url.hostname,
    rpName: 'Alpha Channel Media',
    origin: url.origin
  };
}

// Helper: verify JWT and return listener info
function verifyListenerToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'listener') return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

// ===== REGISTRATION: Generate options =====
router.post('/register/options', async (req, res) => {
  try {
    const listener = verifyListenerToken(req);
    if (!listener) return res.status(401).json({ error: 'Authentication required' });

    const db = req.app.locals.db;
    const { rpID, rpName } = getRPConfig(req);

    // Get listener details
    const userResult = await db.query('SELECT id, username, email FROM listeners WHERE id = $1', [listener.id]);
    if (userResult.rows.length === 0) return res.status(404).json({ error: 'Listener not found' });
    const user = userResult.rows[0];

    // Get existing credentials to exclude
    const credResult = await db.query('SELECT credential_id, transports FROM webauthn_credentials WHERE listener_id = $1', [listener.id]);
    const excludeCredentials = credResult.rows.map(c => ({
      id: c.credential_id,
      transports: c.transports || []
    }));

    // Dynamic import for ESM module
    const { generateRegistrationOptions } = await import('@simplewebauthn/server');

    const options = await generateRegistrationOptions({
      rpName,
      rpID,
      userName: user.username,
      userDisplayName: user.username,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'preferred'
      },
      excludeCredentials
    });

    // Store challenge with 5-min TTL
    await db.query(
      `INSERT INTO webauthn_challenges (listener_id, challenge, type, expires_at) VALUES ($1, $2, 'registration', NOW() + INTERVAL '5 minutes')`,
      [listener.id, options.challenge]
    );

    res.json(options);
  } catch (err) {
    console.error('WebAuthn register options error:', err);
    res.status(500).json({ error: 'Failed to generate registration options' });
  }
});

// ===== REGISTRATION: Verify =====
router.post('/register/verify', async (req, res) => {
  try {
    const listener = verifyListenerToken(req);
    if (!listener) return res.status(401).json({ error: 'Authentication required' });

    const db = req.app.locals.db;
    const { rpID, origin } = getRPConfig(req);

    // Get stored challenge
    const challengeResult = await db.query(
      `SELECT challenge FROM webauthn_challenges WHERE listener_id = $1 AND type = 'registration' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [listener.id]
    );
    if (challengeResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid registration challenge found' });
    }
    const expectedChallenge = challengeResult.rows[0].challenge;

    const { verifyRegistrationResponse } = await import('@simplewebauthn/server');

    const verification = await verifyRegistrationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID
    });

    if (!verification.verified || !verification.registrationInfo) {
      return res.status(400).json({ error: 'Registration verification failed' });
    }

    const { credential, credentialDeviceType, credentialBackedUp } = verification.registrationInfo;

    // Store credential
    await db.query(
      `INSERT INTO webauthn_credentials (listener_id, credential_id, public_key, counter, device_type, backed_up, transports)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        listener.id,
        Buffer.from(credential.id).toString('base64url'),
        Buffer.from(credential.publicKey).toString('base64url'),
        credential.counter,
        credentialDeviceType,
        credentialBackedUp,
        credential.transports || []
      ]
    );

    // Clean up used challenges
    await db.query(`DELETE FROM webauthn_challenges WHERE listener_id = $1 AND type = 'registration'`, [listener.id]);

    res.json({ success: true });
  } catch (err) {
    console.error('WebAuthn register verify error:', err);
    res.status(500).json({ error: 'Registration verification failed' });
  }
});

// ===== AUTHENTICATION: Generate options =====
router.post('/authenticate/options', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { rpID } = getRPConfig(req);
    const { username } = req.body || {};

    let allowCredentials = [];
    let listenerId = null;

    if (username) {
      const userResult = await db.query('SELECT id FROM listeners WHERE username = $1', [username]);
      if (userResult.rows.length > 0) {
        listenerId = userResult.rows[0].id;
        const credResult = await db.query('SELECT credential_id, transports FROM webauthn_credentials WHERE listener_id = $1', [listenerId]);
        allowCredentials = credResult.rows.map(c => ({
          id: Buffer.from(c.credential_id, 'base64url'),
          transports: c.transports || []
        }));
      }
    }

    const { generateAuthenticationOptions } = await import('@simplewebauthn/server');

    const options = await generateAuthenticationOptions({
      rpID,
      allowCredentials,
      userVerification: 'preferred'
    });

    // Store challenge
    await db.query(
      `INSERT INTO webauthn_challenges (listener_id, challenge, type, expires_at) VALUES ($1, $2, 'authentication', NOW() + INTERVAL '5 minutes')`,
      [listenerId, options.challenge]
    );

    res.json(options);
  } catch (err) {
    console.error('WebAuthn auth options error:', err);
    res.status(500).json({ error: 'Failed to generate authentication options' });
  }
});

// ===== AUTHENTICATION: Verify =====
router.post('/authenticate/verify', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { rpID, origin } = getRPConfig(req);

    // Find the credential by ID from the response
    const credentialIdB64 = req.body.id;
    const credResult = await db.query(
      'SELECT * FROM webauthn_credentials WHERE credential_id = $1',
      [credentialIdB64]
    );

    if (credResult.rows.length === 0) {
      return res.status(400).json({ error: 'Credential not found' });
    }

    const storedCred = credResult.rows[0];

    // Get stored challenge for this listener
    const challengeResult = await db.query(
      `SELECT challenge FROM webauthn_challenges WHERE (listener_id = $1 OR listener_id IS NULL) AND type = 'authentication' AND expires_at > NOW() ORDER BY created_at DESC LIMIT 1`,
      [storedCred.listener_id]
    );
    if (challengeResult.rows.length === 0) {
      return res.status(400).json({ error: 'No valid authentication challenge found' });
    }
    const expectedChallenge = challengeResult.rows[0].challenge;

    const { verifyAuthenticationResponse } = await import('@simplewebauthn/server');

    const verification = await verifyAuthenticationResponse({
      response: req.body,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: storedCred.credential_id,
        publicKey: Buffer.from(storedCred.public_key, 'base64url'),
        counter: parseInt(storedCred.counter)
      }
    });

    if (!verification.verified) {
      return res.status(400).json({ error: 'Authentication verification failed' });
    }

    // Update counter
    await db.query(
      'UPDATE webauthn_credentials SET counter = $1 WHERE id = $2',
      [verification.authenticationInfo.newCounter, storedCred.id]
    );

    // Clean up used challenges
    await db.query(`DELETE FROM webauthn_challenges WHERE (listener_id = $1 OR listener_id IS NULL) AND type = 'authentication'`, [storedCred.listener_id]);

    // Get listener info
    const listenerResult = await db.query(
      'SELECT id, username, email, first_name, last_name FROM listeners WHERE id = $1',
      [storedCred.listener_id]
    );
    const listener = listenerResult.rows[0];

    // Issue JWT
    const token = jwt.sign(
      { id: listener.id, type: 'listener' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Get unlocked creators
    const creatorsResult = await db.query(
      `SELECT c.id, c.username, c.artist_name, c.first_name, c.last_name
       FROM listener_creator_access lca
       JOIN creators c ON c.id = lca.creator_id
       WHERE lca.listener_id = $1
       ORDER BY lca.granted_at DESC`,
      [listener.id]
    );

    res.json({
      success: true,
      token,
      user: {
        id: listener.id,
        username: listener.username,
        email: listener.email,
        firstName: listener.first_name,
        lastName: listener.last_name
      },
      creators: creatorsResult.rows
    });
  } catch (err) {
    console.error('WebAuthn auth verify error:', err);
    res.status(500).json({ error: 'Authentication verification failed' });
  }
});

module.exports = router;
