require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Increase timeout for large file uploads (10 minutes)
app.use(function(req, res, next) {
  if (req.url.startsWith('/api/upload')) {
    req.setTimeout(600000);
    res.setTimeout(600000);
  }
  next();
});

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection and run auto-migration
pool.query('SELECT NOW()')
  .then(() => {
    console.log('Database connected successfully');
    // Auto-create persistent access table if it doesn't exist
    return pool.query(`
      CREATE TABLE IF NOT EXISTS listener_creator_access (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        listener_id UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
        creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
        granted_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(listener_id, creator_id)
      );
    `);
  })
  .then(() => {
    console.log('Access tables ready');
    // Add email notification columns and tables
    return pool.query(`
      -- Add email_notifications column to listeners if not exists
      DO $$ BEGIN
        ALTER TABLE listeners ADD COLUMN email_notifications BOOLEAN DEFAULT true;
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;

      -- Listener-creator subscription table
      CREATE TABLE IF NOT EXISTS listener_creator_subscriptions (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        listener_id UUID NOT NULL REFERENCES listeners(id) ON DELETE CASCADE,
        creator_id UUID NOT NULL REFERENCES creators(id) ON DELETE CASCADE,
        email_on_upload BOOLEAN DEFAULT true,
        subscribed_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(listener_id, creator_id)
      );

      -- Email notification log
      CREATE TABLE IF NOT EXISTS email_notifications_log (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        listener_id UUID REFERENCES listeners(id) ON DELETE SET NULL,
        creator_id UUID REFERENCES creators(id) ON DELETE SET NULL,
        email_type VARCHAR(50) NOT NULL,
        subject TEXT,
        sent_at TIMESTAMP DEFAULT NOW(),
        status VARCHAR(20) DEFAULT 'sent'
      );
    `);
  })
  .then(() => {
    console.log('Email notification tables ready');
    // Drop old WebAuthn tables if they exist (cleanup from previous version)
    return pool.query(`
      DROP TABLE IF EXISTS webauthn_challenges CASCADE;
      DROP TABLE IF EXISTS webauthn_credentials CASCADE;
    `);
  })
  .then(() => console.log('WebAuthn cleanup complete'))
  .catch(err => console.error('Database setup error:', err.message));

// Make db available to routes
app.locals.db = pool;

// Mount routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/listeners', require('./routes/listeners'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/content', require('./routes/content'));
// Aliases to match frontend expectations
app.use('/api/creators', require('./routes/auth'));
app.use('/api/upload', require('./routes/uploads'));

// Master admin login
app.post('/api/master/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.MASTER_PASSWORD) {
    return res.status(500).json({ error: 'Master password not configured' });
  }
  if (password !== process.env.MASTER_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = jwt.sign({ type: 'master' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ success: true, token });
});

// Tracks - supports optional ?creator_id= filter
app.get('/api/tracks', async (req, res) => {
  try {
    const { creator_id } = req.query;
    let result;
    if (creator_id) {
      result = await pool.query('SELECT * FROM songs WHERE creator_id = $1 ORDER BY uploaded_at DESC', [creator_id]);
    } else {
      result = await pool.query('SELECT * FROM songs ORDER BY uploaded_at DESC');
    }
    res.json({ tracks: result.rows });
  } catch (err) {
    console.error('Error fetching tracks:', err);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});

// Videos - supports optional ?creator_id= filter
app.get('/api/videos', async (req, res) => {
  try {
    const { creator_id } = req.query;
    let result;
    if (creator_id) {
      result = await pool.query('SELECT * FROM videos WHERE creator_id = $1 ORDER BY uploaded_at DESC', [creator_id]);
    } else {
      result = await pool.query('SELECT * FROM videos ORDER BY uploaded_at DESC');
    }
    res.json({ videos: result.rows });
  } catch (err) {
    console.error('Error fetching videos:', err);
    res.status(500).json({ error: 'Failed to fetch videos' });
  }
});

// Validate listener key (and persist access if listener is authenticated)
app.post('/api/listener-key/validate', async (req, res) => {
  try {
    const { listener_key } = req.body;
    if (!listener_key) {
      return res.status(400).json({ error: 'Listener key is required' });
    }
    const result = await pool.query(
      'SELECT id, username, artist_name, first_name, last_name FROM creators WHERE listener_key = $1',
      [listener_key]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invalid listener key' });
    }

    const creator = result.rows[0];
    let accessSaved = false;

    // If listener is authenticated, persist the creator access and create subscription
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type === 'listener') {
          await pool.query(
            'INSERT INTO listener_creator_access (listener_id, creator_id) VALUES ($1, $2) ON CONFLICT (listener_id, creator_id) DO NOTHING',
            [decoded.id, creator.id]
          );
          // Auto-create email subscription for this creator
          await pool.query(
            'INSERT INTO listener_creator_subscriptions (listener_id, creator_id, email_on_upload) VALUES ($1, $2, true) ON CONFLICT (listener_id, creator_id) DO NOTHING',
            [decoded.id, creator.id]
          );
          accessSaved = true;
        }
      } catch (e) { /* token invalid, skip saving */ }
    }

    res.json({ success: true, creator, access_saved: accessSaved });
  } catch (err) {
    console.error('Listener key validation error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get creator's listener key (requires auth)
app.get('/api/creators/listener-key', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const result = await pool.query('SELECT listener_key FROM creators WHERE id = $1', [decoded.id]);
    res.json({ listener_key: result.rows[0]?.listener_key || null });
  } catch (err) {
    console.error('Listener key fetch error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Set/update creator's listener key (requires auth)
app.post('/api/creators/listener-key', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const { listener_key } = req.body;
    if (!listener_key || !/^\d{4}$/.test(listener_key)) {
      return res.status(400).json({ error: 'Listener key must be exactly 4 digits' });
    }

    // Check if key is already taken by another creator
    const existing = await pool.query(
      'SELECT id FROM creators WHERE listener_key = $1 AND id != $2',
      [listener_key, decoded.id]
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This listener key is already in use' });
    }

    await pool.query('UPDATE creators SET listener_key = $1 WHERE id = $2', [listener_key, decoded.id]);
    res.json({ success: true });
  } catch (err) {
    console.error('Listener key update error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Admin: get all creators
app.get('/api/admin/creators', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, first_name, last_name, artist_name, listener_key, pin_hash IS NOT NULL AS pin_set, status, created_at FROM creators ORDER BY created_at DESC'
    );
    res.json({ creators: result.rows });
  } catch (err) {
    console.error('Admin creators fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch creators' });
  }
});

// Admin: get all listeners
app.get('/api/admin/listeners', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, first_name, last_name, created_at FROM listeners ORDER BY created_at DESC'
    );
    res.json({ listeners: result.rows });
  } catch (err) {
    console.error('Admin listeners fetch error:', err);
    res.status(500).json({ error: 'Failed to fetch listeners' });
  }
});

// Creator profile info (requires auth)
app.get('/api/creators/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const result = await pool.query(
      'SELECT id, username, email, first_name, last_name, artist_name, listener_key, created_at FROM creators WHERE id = $1',
      [decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Creator not found' });
    res.json({ creator: result.rows[0] });
  } catch (err) {
    console.error('Creator profile error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Creator's own tracks (requires auth)
app.get('/api/creators/my-tracks', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const result = await pool.query(
      'SELECT * FROM songs WHERE creator_id = $1 ORDER BY uploaded_at DESC',
      [decoded.id]
    );
    res.json({ tracks: result.rows });
  } catch (err) {
    console.error('Creator tracks error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Creator's own videos (requires auth)
app.get('/api/creators/my-videos', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const result = await pool.query(
      'SELECT * FROM videos WHERE creator_id = $1 ORDER BY uploaded_at DESC',
      [decoded.id]
    );
    res.json({ videos: result.rows });
  } catch (err) {
    console.error('Creator videos error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a creator's track (requires auth)
app.delete('/api/creators/tracks/:trackId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const result = await pool.query(
      'DELETE FROM songs WHERE id = $1 AND creator_id = $2 RETURNING *',
      [req.params.trackId, decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Track not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete track error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a creator's video (requires auth)
app.delete('/api/creators/videos/:videoId', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const result = await pool.query(
      'DELETE FROM videos WHERE id = $1 AND creator_id = $2 RETURNING *',
      [req.params.videoId, decoded.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Video not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete video error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get listener's unlocked creators (requires listener JWT)
app.get('/api/listeners/my-creators', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'listener') return res.status(403).json({ error: 'Not a listener' });

    const result = await pool.query(
      `SELECT c.id, c.username, c.artist_name, c.first_name, c.last_name
       FROM listener_creator_access lca
       JOIN creators c ON c.id = lca.creator_id
       WHERE lca.listener_id = $1
       ORDER BY lca.granted_at DESC`,
      [decoded.id]
    );
    res.json({ creators: result.rows });
  } catch (err) {
    console.error('My creators error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Serve welcome page at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
});

module.exports = app;
