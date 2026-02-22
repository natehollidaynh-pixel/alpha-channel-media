require('dotenv').config();

const http = require('http');
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
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
  .then(() => {
    console.log('WebAuthn cleanup complete');
    // Backfill: create email subscriptions for any listener_creator_access
    // that doesn't already have a matching subscription
    return pool.query(`
      INSERT INTO listener_creator_subscriptions (listener_id, creator_id, email_on_upload)
      SELECT lca.listener_id, lca.creator_id, true
      FROM listener_creator_access lca
      WHERE NOT EXISTS (
          SELECT 1 FROM listener_creator_subscriptions lcs
          WHERE lcs.listener_id = lca.listener_id
            AND lcs.creator_id = lca.creator_id
      )
      ON CONFLICT (listener_id, creator_id) DO NOTHING
    `);
  })
  .then(() => {
    console.log('Email subscription backfill complete');
    // Add status column to listeners for account management
    return pool.query(`
      DO $$ BEGIN
        ALTER TABLE listeners ADD COLUMN status VARCHAR(20) DEFAULT 'active';
      EXCEPTION WHEN duplicate_column THEN NULL;
      END $$;
    `);
  })
  .then(() => console.log('Account status columns ready'))
  .then(() => {
    return pool.query(`
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN credits_producer VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN credits_writer VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN credits_engineer VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN credits_mixer VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN credits_master VARCHAR(255); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
  })
  .then(() => console.log('Production credits columns ready'))
  .then(() => {
    return pool.query(`
      DO $$ BEGIN ALTER TABLE creators ADD COLUMN profile_photo TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN description TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN backstory TEXT; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE songs ADD COLUMN display_order INTEGER DEFAULT 0; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
  })
  .then(() => console.log('Profile photo + song metadata columns ready'))
  .then(() => {
    return pool.query(`
      DO $$ BEGIN ALTER TABLE creators ADD COLUMN featured_on_home BOOLEAN DEFAULT false; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE creators ADD COLUMN feature_order INTEGER; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE creators ADD COLUMN creator_title VARCHAR(50); EXCEPTION WHEN duplicate_column THEN NULL; END $$;
      DO $$ BEGIN ALTER TABLE creators ADD COLUMN featured_at TIMESTAMP; EXCEPTION WHEN duplicate_column THEN NULL; END $$;
    `);
  })
  .then(() => console.log('Featured creators columns ready'))
  .then(() => {
    // Judge & Trader system — core tables
    return pool.query(`
      CREATE TABLE IF NOT EXISTS judges (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_type VARCHAR(10) NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        accuracy_score NUMERIC(5,2) DEFAULT 0,
        total_ratings INTEGER DEFAULT 0,
        sessions_judged INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(user_id, user_type)
      );

      CREATE TABLE IF NOT EXISTS judge_applications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_type VARCHAR(10) NOT NULL,
        music_background TEXT,
        genres_familiar TEXT,
        screening_score NUMERIC(5,2),
        screening_deviation NUMERIC(5,2),
        status VARCHAR(20) DEFAULT 'pending',
        rejection_reason TEXT,
        next_attempt_date TIMESTAMP,
        attempts INTEGER DEFAULT 1,
        created_at TIMESTAMP DEFAULT NOW(),
        reviewed_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS anchor_songs (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        song_id UUID REFERENCES songs(id) ON DELETE CASCADE,
        correct_rating INTEGER NOT NULL,
        tolerance INTEGER DEFAULT 10,
        genre VARCHAR(50),
        difficulty VARCHAR(20) DEFAULT 'medium',
        active BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
  })
  .then(() => console.log('Judge tables ready'))
  .then(() => {
    // Judge & Trader system — session and rating tables
    return pool.query(`
      CREATE TABLE IF NOT EXISTS judging_sessions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        song_id UUID REFERENCES songs(id) ON DELETE CASCADE,
        title VARCHAR(255),
        scheduled_start TIMESTAMP,
        actual_start TIMESTAMP,
        trading_window_end TIMESTAMP,
        end_time TIMESTAMP,
        final_consensus NUMERIC(5,2),
        judge_count INTEGER DEFAULT 0,
        total_snapshots INTEGER DEFAULT 0,
        status VARCHAR(20) DEFAULT 'scheduled',
        created_by UUID,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS judge_rating_snapshots (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES judging_sessions(id) ON DELETE CASCADE,
        judge_id UUID REFERENCES judges(id) ON DELETE CASCADE,
        rating INTEGER CHECK (rating >= 0 AND rating <= 100),
        timestamp TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_snapshots_session ON judge_rating_snapshots(session_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_judge ON judge_rating_snapshots(judge_id);
      CREATE INDEX IF NOT EXISTS idx_snapshots_time ON judge_rating_snapshots(timestamp);
    `);
  })
  .then(() => console.log('Session and rating tables ready'))
  .then(() => {
    // Judge & Trader system — trading, notifications, waitlist
    return pool.query(`
      CREATE TABLE IF NOT EXISTS traders (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_type VARCHAR(10) NOT NULL,
        play_money_balance NUMERIC(10,2) DEFAULT 100.00,
        total_trades INTEGER DEFAULT 0,
        winning_trades INTEGER DEFAULT 0,
        losing_trades INTEGER DEFAULT 0,
        total_profit_loss NUMERIC(10,2) DEFAULT 0,
        biggest_win NUMERIC(10,2) DEFAULT 0,
        biggest_loss NUMERIC(10,2) DEFAULT 0,
        current_streak INTEGER DEFAULT 0,
        best_streak INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT NOW(),
        last_trade_at TIMESTAMP,
        UNIQUE(user_id, user_type)
      );

      CREATE TABLE IF NOT EXISTS trades (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        session_id UUID REFERENCES judging_sessions(id) ON DELETE CASCADE,
        user_id UUID NOT NULL,
        user_type VARCHAR(10) NOT NULL,
        trader_id UUID REFERENCES traders(id) ON DELETE CASCADE,
        direction VARCHAR(10) CHECK (direction IN ('over', 'under')),
        entry_sentiment NUMERIC(5,2),
        final_sentiment NUMERIC(5,2),
        amount NUMERIC(10,2),
        payout NUMERIC(10,2),
        outcome VARCHAR(10) CHECK (outcome IN ('win', 'loss', 'push')),
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        settled_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id UUID NOT NULL,
        user_type VARCHAR(10) NOT NULL,
        type VARCHAR(50),
        title VARCHAR(255),
        message TEXT,
        data JSONB,
        read BOOLEAN DEFAULT false,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS waitlist (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        name VARCHAR(255),
        wants_to_judge BOOLEAN DEFAULT false,
        wants_to_trade BOOLEAN DEFAULT false,
        wants_to_upload BOOLEAN DEFAULT false,
        referral_source VARCHAR(100),
        referral_code VARCHAR(50),
        referred_by UUID,
        status VARCHAR(20) DEFAULT 'waiting',
        invited_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_trades_session ON trades(session_id);
      CREATE INDEX IF NOT EXISTS idx_trades_user ON trades(user_id, user_type);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, user_type);
      CREATE INDEX IF NOT EXISTS idx_waitlist_email ON waitlist(email);
    `);
  })
  .then(() => console.log('Trading, notification, and waitlist tables ready'))
  .catch(err => console.error('Database setup error:', err.message));

// Make db and io available to routes
app.locals.db = pool;
app.locals.io = io;

// Mount routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/listeners', require('./routes/listeners'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/content', require('./routes/content'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/search', require('./routes/search'));
app.use('/api/creators-public', require('./routes/creators-public'));
app.use('/api/judging', require('./routes/judging'));
// Aliases to match frontend expectations
app.use('/api/creators', require('./routes/auth'));
app.use('/api/upload', require('./routes/uploads'));

// Initialize Socket.IO judging namespace
require('./sockets/judging')(io, pool);

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

// Reorder songs (requires creator auth)
app.put('/api/songs/reorder', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    if (decoded.type !== 'creator') return res.status(403).json({ error: 'Not a creator' });

    const { songs } = req.body; // array of { id, display_order }
    if (!Array.isArray(songs)) return res.status(400).json({ error: 'songs array is required' });

    for (const song of songs) {
      await pool.query(
        'UPDATE songs SET display_order = $1 WHERE id = $2 AND creator_id = $3',
        [song.display_order, song.id, decoded.id]
      );
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Reorder error:', err);
    res.status(500).json({ error: 'Failed to reorder songs' });
  }
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
      'SELECT id, username, email, first_name, last_name, artist_name, listener_key, bio, profile_photo, creator_title, created_at FROM creators WHERE id = $1',
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
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api`);
});

module.exports = app;
