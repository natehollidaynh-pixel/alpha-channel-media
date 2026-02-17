const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set, using default. Set JWT_SECRET in environment variables for production.');
}

// Creator login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const db = req.app.locals.db;

    const result = await db.query(
      'SELECT * FROM creators WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const creator = result.rows[0];

    // Check if creator needs to set their password (first login after approval)
    if (creator.must_set_password) {
      const setupToken = jwt.sign(
        { id: creator.id, type: 'password_setup' },
        JWT_SECRET,
        { expiresIn: '15m' }
      );
      return res.json({
        success: false,
        must_set_password: true,
        setup_token: setupToken,
        username: creator.username
      });
    }

    const validPassword = await bcrypt.compare(password, creator.password_hash);

    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const token = jwt.sign(
      { id: creator.id, type: 'creator' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: creator.id,
        username: creator.username,
        email: creator.email,
        firstName: creator.first_name,
        lastName: creator.last_name,
        artistName: creator.artist_name
      }
    });
  } catch (err) {
    console.error('Creator login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set password (first-time creator login)
router.post('/set-password', async (req, res) => {
  try {
    const { setup_token, password } = req.body;

    if (!setup_token || !password) {
      return res.status(400).json({ error: 'Token and password are required' });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Verify the setup token
    let decoded;
    try {
      decoded = jwt.verify(setup_token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired setup token. Please log in again.' });
    }

    if (decoded.type !== 'password_setup') {
      return res.status(401).json({ error: 'Invalid token type' });
    }

    const db = req.app.locals.db;

    // Verify creator still needs password setup
    const result = await db.query('SELECT * FROM creators WHERE id = $1', [decoded.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creator = result.rows[0];
    if (!creator.must_set_password) {
      return res.status(400).json({ error: 'Password already set' });
    }

    // Hash and save the password
    const passwordHash = await bcrypt.hash(password, 10);
    await db.query(
      'UPDATE creators SET password_hash = $1, must_set_password = false WHERE id = $2',
      [passwordHash, decoded.id]
    );

    // Generate a real auth token so they are logged in immediately
    const token = jwt.sign(
      { id: creator.id, type: 'creator' },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: creator.id,
        username: creator.username,
        email: creator.email,
        firstName: creator.first_name,
        lastName: creator.last_name,
        artistName: creator.artist_name
      }
    });
  } catch (err) {
    console.error('Set password error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Listener login
router.post('/listener/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const db = req.app.locals.db;

    const result = await db.query(
      'SELECT * FROM listeners WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const listener = result.rows[0];
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

// Master admin login
router.post('/master/login', async (req, res) => {
  try {
    const { password } = req.body;

    if (!process.env.MASTER_PASSWORD) {
      return res.status(500).json({ error: 'Master password not configured' });
    }

    if (password !== process.env.MASTER_PASSWORD) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    const token = jwt.sign(
      { type: 'master' },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    res.json({ success: true, token });
  } catch (err) {
    console.error('Master login error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
