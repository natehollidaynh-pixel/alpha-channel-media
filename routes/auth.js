const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

if (!process.env.JWT_SECRET) {
  console.warn('WARNING: JWT_SECRET not set, using default. Set JWT_SECRET in environment variables for production.');
}

// Creator login (PIN-based)
router.post('/login', async (req, res) => {
  try {
    const { username, pin, password } = req.body;
    const credential = pin || password; // Accept either field name
    const db = req.app.locals.db;

    if (!username || !credential) {
      return res.status(400).json({ error: 'Username and PIN are required' });
    }

    const result = await db.query(
      'SELECT * FROM creators WHERE username = $1',
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const creator = result.rows[0];

    // Check if PIN has been generated yet
    if (!creator.pin_hash) {
      return res.status(401).json({ error: 'Account not yet activated. Contact admin for your PIN.' });
    }

    const validPin = await bcrypt.compare(credential, creator.pin_hash);

    if (!validPin) {
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
