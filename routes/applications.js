const express = require('express');
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

    // Create creator account with NO password — they set it on first login
    await db.query(
      `INSERT INTO creators (username, email, password_hash, must_set_password, first_name, last_name, artist_name, bio)
       VALUES ($1, $2, NULL, true, $3, $4, $5, $6)`,
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

    // Send welcome email (no password — tells them to log in and set one)
    sendCreatorWelcomeEmail(application).catch(err =>
      console.error('Failed to send welcome email:', err)
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Application approve error:', err);
    res.status(500).json({ error: 'Failed to approve application' });
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
