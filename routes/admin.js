const express = require('express');
const router = express.Router();

// Master admin authentication middleware
function authenticateMaster(req, res, next) {
  const masterPassword = req.headers['x-master-password'];
  if (!masterPassword || masterPassword !== process.env.MASTER_PASSWORD) {
    return res.status(403).json({ error: 'Unauthorized' });
  }
  next();
}

router.use(authenticateMaster);

// ========================================
// DASHBOARD STATS
// ========================================

router.get('/stats', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(`
      SELECT
        (SELECT COUNT(*) FROM listeners WHERE status = 'active' OR status IS NULL) as active_listeners,
        (SELECT COUNT(*) FROM listeners WHERE status = 'deactivated') as deactivated_listeners,
        (SELECT COUNT(*) FROM creators WHERE status = 'active' OR status IS NULL) as active_creators,
        (SELECT COUNT(*) FROM creators WHERE status = 'deactivated') as deactivated_creators,
        (SELECT COUNT(*) FROM songs) as total_songs,
        (SELECT COUNT(*) FROM videos) as total_videos,
        (SELECT COUNT(*) FROM applications WHERE status = 'pending') as pending_applications
    `);
    res.json(result.rows[0]);
  } catch (err) {
    console.error('Admin stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ========================================
// LISTENER MANAGEMENT
// ========================================

router.get('/listeners', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(`
      SELECT
        l.id, l.username, l.email, l.first_name, l.last_name,
        COALESCE(l.status, 'active') as status,
        l.email_notifications, l.created_at,
        COUNT(DISTINCT lca.creator_id) as creators_connected
      FROM listeners l
      LEFT JOIN listener_creator_access lca ON l.id = lca.listener_id
      GROUP BY l.id
      ORDER BY l.created_at DESC
    `);
    res.json({ listeners: result.rows });
  } catch (err) {
    console.error('Admin listeners error:', err);
    res.status(500).json({ error: 'Failed to get listeners' });
  }
});

router.get('/listeners/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const listenerResult = await db.query(
      'SELECT id, username, email, first_name, last_name, COALESCE(status, \'active\') as status, email_notifications, created_at FROM listeners WHERE id = $1',
      [req.params.id]
    );
    if (listenerResult.rows.length === 0) {
      return res.status(404).json({ error: 'Listener not found' });
    }

    const creatorsResult = await db.query(`
      SELECT
        c.id, c.username, c.artist_name, c.first_name, c.last_name,
        lca.granted_at,
        COUNT(DISTINCT s.id) as total_songs,
        COUNT(DISTINCT v.id) as total_videos
      FROM listener_creator_access lca
      JOIN creators c ON lca.creator_id = c.id
      LEFT JOIN songs s ON c.id = s.creator_id
      LEFT JOIN videos v ON c.id = v.creator_id
      WHERE lca.listener_id = $1
      GROUP BY c.id, lca.granted_at
      ORDER BY lca.granted_at DESC
    `, [req.params.id]);

    res.json({
      listener: listenerResult.rows[0],
      connected_creators: creatorsResult.rows
    });
  } catch (err) {
    console.error('Admin listener detail error:', err);
    res.status(500).json({ error: 'Failed to get listener details' });
  }
});

router.post('/listeners/:id/deactivate', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await db.query('UPDATE listeners SET status = $1 WHERE id = $2', ['deactivated', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Deactivate listener error:', err);
    res.status(500).json({ error: 'Failed to deactivate listener' });
  }
});

router.post('/listeners/:id/reactivate', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await db.query('UPDATE listeners SET status = $1 WHERE id = $2', ['active', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Reactivate listener error:', err);
    res.status(500).json({ error: 'Failed to reactivate listener' });
  }
});

router.delete('/listeners/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query('DELETE FROM listeners WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Listener not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete listener error:', err);
    res.status(500).json({ error: 'Failed to delete listener' });
  }
});

// ========================================
// CREATOR MANAGEMENT
// ========================================

router.get('/creators', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(`
      SELECT
        c.id, c.username, c.email, c.first_name, c.last_name,
        c.artist_name, c.listener_key, c.featured_on_home,
        c.pin_hash IS NOT NULL as pin_set,
        COALESCE(c.status, 'active') as status,
        c.created_at,
        COUNT(DISTINCT s.id) as total_songs,
        COUNT(DISTINCT v.id) as total_videos,
        COUNT(DISTINCT lca.listener_id) as total_subscribers
      FROM creators c
      LEFT JOIN songs s ON c.id = s.creator_id
      LEFT JOIN videos v ON c.id = v.creator_id
      LEFT JOIN listener_creator_access lca ON c.id = lca.creator_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);
    res.json({ creators: result.rows });
  } catch (err) {
    console.error('Admin creators error:', err);
    res.status(500).json({ error: 'Failed to get creators' });
  }
});

router.get('/creators/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const creatorResult = await db.query(
      `SELECT id, username, email, first_name, last_name, artist_name, bio, creator_title,
              listener_key, pin_hash IS NOT NULL as pin_set,
              featured_on_home, feature_order, featured_at,
              COALESCE(status, 'active') as status, created_at
       FROM creators WHERE id = $1`,
      [req.params.id]
    );
    if (creatorResult.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }

    const songsResult = await db.query(
      'SELECT id, title, artist, audio_url, artwork_url, file_size, format, uploaded_at FROM songs WHERE creator_id = $1 ORDER BY uploaded_at DESC',
      [req.params.id]
    );

    const videosResult = await db.query(
      'SELECT id, title, description, video_url, thumbnail_url, file_size, format, uploaded_at FROM videos WHERE creator_id = $1 ORDER BY uploaded_at DESC',
      [req.params.id]
    );

    const subscribersResult = await db.query(`
      SELECT l.id, l.username, l.first_name, l.last_name, l.email, lca.granted_at
      FROM listener_creator_access lca
      JOIN listeners l ON lca.listener_id = l.id
      WHERE lca.creator_id = $1
      ORDER BY lca.granted_at DESC
    `, [req.params.id]);

    res.json({
      creator: creatorResult.rows[0],
      songs: songsResult.rows,
      videos: videosResult.rows,
      subscribers: subscribersResult.rows
    });
  } catch (err) {
    console.error('Admin creator detail error:', err);
    res.status(500).json({ error: 'Failed to get creator details' });
  }
});

router.post('/creators/:id/deactivate', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await db.query('UPDATE creators SET status = $1 WHERE id = $2', ['deactivated', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Deactivate creator error:', err);
    res.status(500).json({ error: 'Failed to deactivate creator' });
  }
});

router.post('/creators/:id/reactivate', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await db.query('UPDATE creators SET status = $1 WHERE id = $2', ['active', req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Reactivate creator error:', err);
    res.status(500).json({ error: 'Failed to reactivate creator' });
  }
});

router.delete('/creators/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query('DELETE FROM creators WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Creator not found' });
    }
    res.json({ success: true });
  } catch (err) {
    console.error('Delete creator error:', err);
    res.status(500).json({ error: 'Failed to delete creator' });
  }
});

// ========================================
// FEATURED CREATORS MANAGEMENT
// ========================================

// Get featured creators list + count
router.get('/featured', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(
      `SELECT id, username, artist_name, creator_title, feature_order, featured_at
       FROM creators
       WHERE featured_on_home = true
       ORDER BY feature_order ASC`
    );
    res.json({ featured: result.rows, count: result.rows.length });
  } catch (err) {
    console.error('Featured list error:', err);
    res.status(500).json({ error: 'Failed to get featured creators' });
  }
});

// Add creator to featured (enforce max 3)
router.post('/featured/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { position } = req.body;
    if (!position || position < 1 || position > 3) {
      return res.status(400).json({ error: 'Position must be 1, 2, or 3' });
    }
    // Check current count
    const countResult = await db.query(
      'SELECT COUNT(*) as cnt FROM creators WHERE featured_on_home = true'
    );
    if (parseInt(countResult.rows[0].cnt) >= 3) {
      return res.status(400).json({ error: 'Maximum 3 featured creators. Remove one first.' });
    }
    // Check if position is taken
    const posResult = await db.query(
      'SELECT id FROM creators WHERE featured_on_home = true AND feature_order = $1',
      [position]
    );
    if (posResult.rows.length > 0) {
      return res.status(400).json({ error: 'Position ' + position + ' is already taken' });
    }
    await db.query(
      'UPDATE creators SET featured_on_home = true, feature_order = $1, featured_at = NOW() WHERE id = $2',
      [position, req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Feature creator error:', err);
    res.status(500).json({ error: 'Failed to feature creator' });
  }
});

// Remove creator from featured
router.delete('/featured/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    await db.query(
      'UPDATE creators SET featured_on_home = false, feature_order = NULL, featured_at = NULL WHERE id = $1',
      [req.params.id]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Unfeature creator error:', err);
    res.status(500).json({ error: 'Failed to remove featured status' });
  }
});

// Update featured position (swap with current holder)
router.put('/featured/:id', async (req, res) => {
  const db = req.app.locals.db;
  try {
    const { position } = req.body;
    if (!position || position < 1 || position > 3) {
      return res.status(400).json({ error: 'Position must be 1, 2, or 3' });
    }
    // Get this creator's current position
    const movingResult = await db.query(
      'SELECT feature_order FROM creators WHERE id = $1 AND featured_on_home = true',
      [req.params.id]
    );
    if (movingResult.rows.length === 0) {
      return res.status(400).json({ error: 'Creator is not currently featured' });
    }
    const oldPosition = movingResult.rows[0].feature_order;
    if (oldPosition === position) {
      return res.json({ success: true, message: 'No change needed' });
    }
    // Swap with whoever holds the target position
    const holderResult = await db.query(
      'SELECT id FROM creators WHERE featured_on_home = true AND feature_order = $1',
      [position]
    );
    if (holderResult.rows.length > 0) {
      await db.query('UPDATE creators SET feature_order = $1 WHERE id = $2', [oldPosition, holderResult.rows[0].id]);
    }
    await db.query('UPDATE creators SET feature_order = $1 WHERE id = $2', [position, req.params.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Update featured position error:', err);
    res.status(500).json({ error: 'Failed to update position' });
  }
});

module.exports = router;
