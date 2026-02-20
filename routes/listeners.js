const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { sendListenerConfirmationEmail, sendAdminListenerNotification } = require('../emails/sender');

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Create a new listener account (password required)
router.post('/create', async (req, res) => {
  try {
    const { firstName, lastName, email, username, password, emailConsent } = req.body;
    const db = req.app.locals.db;

    if (!firstName || !lastName || !email || !username) {
      return res.status(400).json({ error: 'First name, last name, email, and username are required' });
    }

    if (!password || password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Check if username or email already exists (case-sensitive username)
    const existing = await db.query(
      'SELECT id FROM listeners WHERE username = $1 OR LOWER(email) = LOWER($2)',
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const wantsEmails = emailConsent !== false && emailConsent !== 'false';
    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO listeners (username, email, password_hash, first_name, last_name, email_notifications)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [username, email, passwordHash, firstName, lastName, wantsEmails]
    );

    const listener = result.rows[0];

    // Send confirmation email
    sendListenerConfirmationEmail(listener).catch(err =>
      console.error('Failed to send listener confirmation email:', err)
    );

    // Notify admin
    sendAdminListenerNotification(listener).catch(err =>
      console.error('Failed to send admin notification:', err)
    );

    // Auto-login: generate token
    const token = jwt.sign(
      { id: listener.id, type: 'listener' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ success: true, id: listener.id, token });
  } catch (err) {
    console.error('Listener create error:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

// Listener login (case-sensitive username, password required)
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const db = req.app.locals.db;

    // Case-sensitive username lookup
    const result = await db.query(
      'SELECT * FROM listeners WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const listener = result.rows[0];

    // If listener has no password (legacy account), prompt them to set one
    if (!listener.password_hash) {
      return res.json({
        success: false,
        needsPassword: true,
        username: listener.username,
        message: 'Please set a password for your account'
      });
    }

    // Validate password
    const validPassword = await bcrypt.compare(password, listener.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: listener.id, type: 'listener' },
      JWT_SECRET,
      { expiresIn: '30d' }
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
      }
    });
  } catch (err) {
    console.error('Listener login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set password for legacy passwordless listeners
router.post('/set-password', async (req, res) => {
  try {
    const { username, password } = req.body;
    const db = req.app.locals.db;

    if (!username || !password || password.length < 6) {
      return res.status(400).json({ error: 'Username and password (min 6 chars) are required' });
    }

    // Find the listener — only allow setting password if they don't already have one
    const result = await db.query(
      'SELECT * FROM listeners WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Account not found' });
    }

    const listener = result.rows[0];
    if (listener.password_hash) {
      return res.status(400).json({ error: 'Password already set. Use login instead.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE listeners SET password_hash = $1 WHERE id = $2',
      [passwordHash, listener.id]
    );

    // Auto-login after setting password
    const token = jwt.sign(
      { id: listener.id, type: 'listener' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get listener's email preferences (requires JWT)
router.get('/email-preferences', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'listener') return res.status(403).json({ error: 'Not a listener' });

    const db = req.app.locals.db;

    // Get global preference
    const listenerResult = await db.query(
      'SELECT email_notifications FROM listeners WHERE id = $1',
      [decoded.id]
    );
    if (listenerResult.rows.length === 0) return res.status(404).json({ error: 'Listener not found' });

    // Get per-creator subscriptions
    const subsResult = await db.query(
      `SELECT lcs.creator_id, lcs.email_on_upload, c.artist_name, c.username, c.first_name, c.last_name
       FROM listener_creator_subscriptions lcs
       JOIN creators c ON c.id = lcs.creator_id
       WHERE lcs.listener_id = $1
       ORDER BY lcs.subscribed_at DESC`,
      [decoded.id]
    );

    res.json({
      email_notifications: listenerResult.rows[0].email_notifications,
      subscriptions: subsResult.rows
    });
  } catch (err) {
    console.error('Email preferences error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update listener's email preferences (requires JWT)
router.put('/email-preferences', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'listener') return res.status(403).json({ error: 'Not a listener' });

    const db = req.app.locals.db;
    const { email_notifications, subscriptions } = req.body;

    // Update global preference
    if (typeof email_notifications === 'boolean') {
      await db.query(
        'UPDATE listeners SET email_notifications = $1 WHERE id = $2',
        [email_notifications, decoded.id]
      );
    }

    // Update per-creator subscriptions
    if (Array.isArray(subscriptions)) {
      for (const sub of subscriptions) {
        if (sub.creator_id && typeof sub.email_on_upload === 'boolean') {
          await db.query(
            `UPDATE listener_creator_subscriptions SET email_on_upload = $1
             WHERE listener_id = $2 AND creator_id = $3`,
            [sub.email_on_upload, decoded.id, sub.creator_id]
          );
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Update email preferences error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
