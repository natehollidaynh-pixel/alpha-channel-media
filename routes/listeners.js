const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const router = express.Router();
const { sendListenerConfirmationEmail, sendAdminListenerNotification } = require('../emails/sender');

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Create a new listener account (no password required)
router.post('/create', async (req, res) => {
  try {
    const { firstName, lastName, email, username } = req.body;
    const db = req.app.locals.db;

    if (!firstName || !lastName || !email || !username) {
      return res.status(400).json({ error: 'First name, last name, email, and username are required' });
    }

    // Check if username or email already exists (case-sensitive username)
    const existing = await db.query(
      'SELECT id FROM listeners WHERE username = $1 OR LOWER(email) = LOWER($2)',
      [username, email]
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }

    const result = await db.query(
      `INSERT INTO listeners (username, email, password_hash, first_name, last_name)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [username, email, null, firstName, lastName]
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

// Listener login (case-sensitive username)
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

    // If listener has no password (new flow), just check username match
    if (!listener.password_hash) {
      const token = jwt.sign(
        { id: listener.id, type: 'listener' },
        JWT_SECRET,
        { expiresIn: '30d' }
      );
      return res.json({
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
    }

    // If password exists (legacy accounts), validate it
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
