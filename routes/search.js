const express = require('express');
const router = express.Router();

// Universal search — searches creators and songs
router.get('/', async (req, res) => {
  try {
    const { q } = req.query;
    const db = req.app.locals.db;

    if (!q || q.trim().length === 0) {
      return res.json({ creators: [], songs: [] });
    }

    const searchTerm = `%${q.trim()}%`;

    // Search creators by artist_name, username, bio
    const creatorsResult = await db.query(
      `SELECT c.id, c.username, c.artist_name, c.bio, c.profile_photo,
              COUNT(DISTINCT lcs.listener_id) AS subscriber_count
       FROM creators c
       LEFT JOIN listener_creator_subscriptions lcs ON lcs.creator_id = c.id
       WHERE c.status = 'active'
         AND (c.artist_name ILIKE $1 OR c.username ILIKE $1 OR c.bio ILIKE $1)
       GROUP BY c.id
       ORDER BY subscriber_count DESC
       LIMIT 20`,
      [searchTerm]
    );

    // Search songs by title, artist
    const songsResult = await db.query(
      `SELECT s.id, s.title, s.artist, s.artwork_url, s.audio_url, s.creator_id, s.description,
              c.artist_name AS creator_artist_name, c.profile_photo AS creator_photo
       FROM songs s
       JOIN creators c ON c.id = s.creator_id
       WHERE s.title ILIKE $1 OR s.artist ILIKE $1
       ORDER BY s.uploaded_at DESC
       LIMIT 20`,
      [searchTerm]
    );

    res.json({
      creators: creatorsResult.rows,
      songs: songsResult.rows
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed' });
  }
});

module.exports = router;
