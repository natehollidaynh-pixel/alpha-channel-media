const express = require('express');
const jwt = require('jsonwebtoken');
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Get top creators sorted by subscriber count
router.get('/top', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const limit = parseInt(req.query.limit) || 10;

    const result = await db.query(
      `SELECT c.id, c.username, c.artist_name, c.bio, c.profile_photo,
              COUNT(DISTINCT lcs.listener_id) AS subscriber_count
       FROM creators c
       LEFT JOIN listener_creator_subscriptions lcs ON lcs.creator_id = c.id
       WHERE c.status = 'active'
       GROUP BY c.id
       ORDER BY subscriber_count DESC, c.created_at DESC
       LIMIT $1`,
      [limit]
    );

    // For each creator, get their top 3 songs
    const creators = [];
    for (const creator of result.rows) {
      const songsResult = await db.query(
        `SELECT id, title, artist, artwork_url, audio_url
         FROM songs WHERE creator_id = $1
         ORDER BY display_order ASC, uploaded_at DESC
         LIMIT 3`,
        [creator.id]
      );
      creators.push({
        ...creator,
        top_songs: songsResult.rows
      });
    }

    res.json({ creators });
  } catch (err) {
    console.error('Top creators error:', err);
    res.status(500).json({ error: 'Failed to fetch creators' });
  }
});

// Get featured creators for home page
router.get('/featured', async (req, res) => {
  try {
    const db = req.app.locals.db;

    const result = await db.query(
      `SELECT c.id, c.username, c.artist_name, c.bio, c.profile_photo, c.creator_title,
              c.feature_order,
              COUNT(DISTINCT lcs.listener_id) AS subscriber_count,
              COUNT(DISTINCT s.id) AS song_count
       FROM creators c
       LEFT JOIN listener_creator_subscriptions lcs ON lcs.creator_id = c.id
       LEFT JOIN songs s ON c.id = s.creator_id
       WHERE c.featured_on_home = true AND c.status = 'active'
       GROUP BY c.id
       ORDER BY c.feature_order ASC`
    );

    const creators = [];
    for (const creator of result.rows) {
      const songsResult = await db.query(
        `SELECT id, title, artist, artwork_url, audio_url
         FROM songs WHERE creator_id = $1
         ORDER BY display_order ASC, uploaded_at DESC
         LIMIT 3`,
        [creator.id]
      );
      creators.push({
        ...creator,
        top_songs: songsResult.rows
      });
    }

    res.json({ creators });
  } catch (err) {
    console.error('Featured creators error:', err);
    res.status(500).json({ error: 'Failed to fetch featured creators' });
  }
});

// Get a single creator's public profile + all songs
router.get('/:id/profile', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    const creatorResult = await db.query(
      `SELECT c.id, c.username, c.artist_name, c.bio, c.profile_photo,
              COUNT(DISTINCT lcs.listener_id) AS subscriber_count
       FROM creators c
       LEFT JOIN listener_creator_subscriptions lcs ON lcs.creator_id = c.id
       WHERE c.id = $1
       GROUP BY c.id`,
      [id]
    );

    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const creator = creatorResult.rows[0];

    const songsResult = await db.query(
      `SELECT id, title, artist, artwork_url, audio_url, description, backstory,
              lyrics, credits_producer, credits_writer, credits_engineer, credits_mixer, credits_master
       FROM songs WHERE creator_id = $1
       ORDER BY display_order ASC, uploaded_at DESC`,
      [id]
    );

    // Check if the requesting listener is subscribed
    let isSubscribed = false;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type === 'listener') {
          const subResult = await db.query(
            'SELECT id FROM listener_creator_subscriptions WHERE listener_id = $1 AND creator_id = $2',
            [decoded.id, id]
          );
          isSubscribed = subResult.rows.length > 0;
        }
      } catch (e) { /* invalid token, skip */ }
    }

    res.json({
      creator,
      songs: songsResult.rows,
      isSubscribed
    });
  } catch (err) {
    console.error('Creator profile error:', err);
    res.status(500).json({ error: 'Failed to fetch creator profile' });
  }
});

// Subscribe to a creator (requires listener JWT)
router.post('/:id/subscribe', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'listener') return res.status(403).json({ error: 'Not a listener' });

    // Create access + subscription
    await db.query(
      'INSERT INTO listener_creator_access (listener_id, creator_id) VALUES ($1, $2) ON CONFLICT (listener_id, creator_id) DO NOTHING',
      [decoded.id, id]
    );
    await db.query(
      'INSERT INTO listener_creator_subscriptions (listener_id, creator_id, email_on_upload) VALUES ($1, $2, true) ON CONFLICT (listener_id, creator_id) DO NOTHING',
      [decoded.id, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Subscribe error:', err);
    res.status(500).json({ error: 'Failed to subscribe' });
  }
});

// Unsubscribe from a creator (requires listener JWT)
router.delete('/:id/subscribe', async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { id } = req.params;

    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'Not authenticated' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'listener') return res.status(403).json({ error: 'Not a listener' });

    await db.query(
      'DELETE FROM listener_creator_subscriptions WHERE listener_id = $1 AND creator_id = $2',
      [decoded.id, id]
    );
    await db.query(
      'DELETE FROM listener_creator_access WHERE listener_id = $1 AND creator_id = $2',
      [decoded.id, id]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Unsubscribe error:', err);
    res.status(500).json({ error: 'Failed to unsubscribe' });
  }
});

module.exports = router;
