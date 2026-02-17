const express = require('express');
const router = express.Router();

// Get all tracks
router.get('/tracks', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const result = await db.query('SELECT * FROM songs ORDER BY uploaded_at DESC');
    res.json({ tracks: result.rows });
  } catch (err) {
    console.error('Tracks fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// Get all videos
router.get('/videos', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const result = await db.query('SELECT * FROM videos ORDER BY uploaded_at DESC');
    res.json({ videos: result.rows });
  } catch (err) {
    console.error('Videos fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

module.exports = router;
