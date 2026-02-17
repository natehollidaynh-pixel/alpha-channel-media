require('dotenv').config();

const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from public directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve uploaded files
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.query('SELECT NOW()')
  .then(() => console.log('Database connected successfully'))
  .catch(err => console.error('Database connection error:', err.message));

// Make db available to routes
app.locals.db = pool;

// Mount routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/listeners', require('./routes/listeners'));
app.use('/api/uploads', require('./routes/uploads'));
app.use('/api/content', require('./routes/content'));

// Aliases to match frontend expectations
// login.html calls /api/creators/login and /api/listeners/login
app.use('/api/creators', require('./routes/auth'));
// master-admin.html calls /api/master/login
const jwt = require('jsonwebtoken');
app.post('/api/master/login', (req, res) => {
  const { password } = req.body;
  if (!process.env.MASTER_PASSWORD) {
    return res.status(500).json({ error: 'Master password not configured' });
  }
  if (password !== process.env.MASTER_PASSWORD) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  const token = jwt.sign(
    { type: 'master' },
    process.env.JWT_SECRET || 'default-secret-change-me',
    { expiresIn: '24h' }
  );
  res.json({ success: true, token });
});
// admin.html calls /api/upload/music and /api/upload/video
app.use('/api/upload', require('./routes/uploads'));
// player.html calls /api/tracks directly
app.get('/api/tracks', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM songs ORDER BY uploaded_at DESC');
    res.json({ tracks: result.rows });
  } catch (err) {
    console.error('Error fetching tracks:', err);
    res.status(500).json({ error: 'Failed to fetch tracks' });
  }
});
// videos.html calls /api/videos directly
app.get('/api/videos', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM videos ORDER BY uploaded_at DESC');
    res.json({ videos: result.rows });
  } catch (err) {
    console.error('Error fetching videos:', err);
    res.status(500).json({ error: 'Failed to fetch videos' });
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
