const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { sendListenerConfirmationEmail, sendAdminListenerNotification } = require('../emails/sender');

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Create a new listener account
router.post('/create', async (req, res) => {
  try {
    const { firstName, lastName, email, username, password } = req.body;
    const db = req.app.locals.db;

    // Check if username or email already exists
    const existing = await db.query(
      'SELECT id FROM listeners WHERE username = $1 OR email = $2',
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const result = await db.query(
      `INSERT INTO listeners (username, email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [username, email, passwordHash, firstName, lastName]
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

// Listener login (mounted at /api/listeners/login from server.js alias)
router.post('/login', async (req, res) => {
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

module.exports = router;
