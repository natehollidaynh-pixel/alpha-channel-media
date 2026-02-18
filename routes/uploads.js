const express = require('express');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Configure Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET
});

// Helper: extract creator ID from auth token
function getCreatorId(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return null;
  try {
    const token = authHeader.split(' ')[1];
    const decoded = jwt.verify(token, JWT_SECRET);
    return decoded.type === 'creator' ? decoded.id : null;
  } catch (e) { return null; }
}

// Generate a Cloudinary signature for direct browser upload
router.post('/sign', (req, res) => {
  try {
    const creatorId = getCreatorId(req);
    if (!creatorId) return res.status(401).json({ error: 'Not authenticated' });

    const { folder, resource_type } = req.body;
    const timestamp = Math.round(new Date().getTime() / 1000);

    const params = {
      timestamp,
      folder: folder || 'alpha-channel/audio'
    };

    const signature = cloudinary.utils.api_sign_request(params, process.env.CLOUDINARY_API_SECRET);

    res.json({
      signature,
      timestamp,
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      folder: params.folder
    });
  } catch (err) {
    console.error('Sign error:', err);
    res.status(500).json({ error: 'Failed to generate upload signature' });
  }
});

// Save music record (after browser uploads directly to Cloudinary)
router.post('/music', express.json(), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const creatorId = getCreatorId(req);
    const { title, artist, lyrics, audio_url, artwork_url, file_size, format } = req.body;

    if (!title || !artist || !audio_url) {
      return res.status(400).json({ error: 'Title, artist, and audio URL are required' });
    }

    const result = await db.query(
      `INSERT INTO songs (creator_id, title, artist, lyrics, audio_url, artwork_url, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [creatorId, title, artist, lyrics || null, audio_url, artwork_url || null, file_size || 0, format || 'mp3']
    );

    res.json({ success: true, song: result.rows[0] });
  } catch (err) {
    console.error('Save music error:', err);
    res.status(500).json({ error: 'Failed to save track' });
  }
});

// Save video record (after browser uploads directly to Cloudinary)
router.post('/video', express.json(), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const creatorId = getCreatorId(req);
    const { title, description, category, video_url, thumbnail_url, file_size, format } = req.body;

    if (!title || !video_url) {
      return res.status(400).json({ error: 'Title and video URL are required' });
    }

    const result = await db.query(
      `INSERT INTO videos (creator_id, title, description, category, video_url, thumbnail_url, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [creatorId, title, description || null, category || null, video_url, thumbnail_url || null, file_size || 0, format || 'mp4']
    );

    res.json({ success: true, video: result.rows[0] });
  } catch (err) {
    console.error('Save video error:', err);
    res.status(500).json({ error: 'Failed to save video' });
  }
});

module.exports = router;
