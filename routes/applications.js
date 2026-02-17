const express = require('express');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const router = express.Router();
const { sendCreatorApplicationEmail, sendCreatorWelcomeEmail } = require('../emails/sender');

// Submit a new creator application
router.post('/submit', async (req, res) => {
  try {
    const { firstName, lastName, email, username, artistName, bio, reason } = req.body;
    const db = req.app.locals.db;

    const result = await db.query(
      `INSERT INTO applications (first_name, last_name, email, username, artist_name, bio, reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [firstName, lastName, email, username, artistName || null, bio || null, reason || null]
    );

    const application = result.rows[0];

    // Send notification email to admin
    sendCreatorApplicationEmail(application).catch(err =>
      console.error('Failed to send application email:', err)
    );

    res.json({ success: true, id: application.id });
  } catch (err) {
    console.error('Application submit error:', err);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// Approve a creator application
router.post('/approve/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.locals.db;

    const appResult = await db.query('SELECT * FROM applications WHERE id = $1', [id]);
    if (appResult.rows.length === 0) {
      return res.status(404).json({ error: 'Application not found' });
    }

    const application = appResult.rows[0];

    // Create creator account with NO pin — admin generates it separately
    await db.query(
      `INSERT INTO creators (username, email, pin_hash, first_name, last_name, artist_name, bio)
       VALUES ($1, $2, NULL, $3, $4, $5, $6)`,
      [
        application.username,
        application.email,
        application.first_name,
        application.last_name,
        application.artist_name,
        application.bio
      ]
    );

    // Update application status
    await db.query(
      `UPDATE applications SET status = 'approved', processed_at = NOW() WHERE id = $1`,
      [id]
    );

    // Send welcome email (tells them admin will provide PIN)
    sendCreatorWelcomeEmail(application).catch(err =>
      console.error('Failed to send welcome email:', err)
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Application approve error:', err);
    res.status(500).json({ error: 'Failed to approve application' });
  }
});

// Generate PIN for a creator (admin action)
router.post('/generate-pin/:creatorId', async (req, res) => {
  try {
    const { creatorId } = req.params;
    const db = req.app.locals.db;

    // Verify creator exists
    const result = await db.query('SELECT id, username FROM creators WHERE id = $1', [creatorId]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    // Generate 6-digit numeric PIN
    const pin = crypto.randomInt(100000, 999999).toString();

    // Hash the PIN
    const pinHash = await bcrypt.hash(pin, 10);

    // Store the hash
    await db.query('UPDATE creators SET pin_hash = $1 WHERE id = $2', [pinHash, creatorId]);

    // Return plaintext PIN (shown once to admin)
    res.json({
      success: true,
      pin: pin,
      username: result.rows[0].username,
      message: 'PIN generated. Share this with the creator. It will not be shown again.'
    });
  } catch (err) {
    console.error('Generate PIN error:', err);
    res.status(500).json({ error: 'Failed to generate PIN' });
  }
});

// Deny a creator application
router.post('/deny/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const db = req.app.locals.db;

    await db.query(
      `UPDATE applications SET status = 'denied', processed_at = NOW() WHERE id = $1`,
      [id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Application deny error:', err);
    res.status(500).json({ error: 'Failed to deny application' });
  }
});

// Get all applications
router.get('/', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const result = await db.query('SELECT * FROM applications ORDER BY submitted_at DESC');
    res.json({ applications: result.rows });
  } catch (err) {
    console.error('Applications fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch applications' });
  }
});

// Get dashboard stats
router.get('/stats', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const [creators, listeners, tracks, pending] = await Promise.all([
      db.query('SELECT COUNT(*) FROM creators'),
      db.query('SELECT COUNT(*) FROM listeners'),
      db.query('SELECT COUNT(*) FROM songs'),
      db.query("SELECT COUNT(*) FROM applications WHERE status = 'pending'")
    ]);
    res.json({
      creators: parseInt(creators.rows[0].count),
      listeners: parseInt(listeners.rows[0].count),
      tracks: parseInt(tracks.rows[0].count),
      pending: parseInt(pending.rows[0].count)
    });
  } catch (err) {
    console.error('Stats fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

module.exports = router;
