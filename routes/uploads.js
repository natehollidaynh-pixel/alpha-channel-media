const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const router = express.Router();

// Configure multer storage
const storage = multer.diskStorage({
  destination: async function (req, file, cb) {
    let folder = 'uploads/';
    if (file.fieldname === 'audio') folder += 'audio/';
    else if (file.fieldname === 'video') folder += 'videos/';
    else if (file.fieldname === 'artwork') folder += 'artwork/';
    else if (file.fieldname === 'thumbnail') folder += 'thumbnails/';
    else folder += 'other/';

    try {
      await fs.promises.mkdir(path.join(process.cwd(), folder), { recursive: true });
    } catch (err) {
      // Directory may already exist
    }
    cb(null, folder);
  },
  filename: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, uuidv4() + ext);
  }
});

// File filter
const fileFilter = (req, file, cb) => {
  const audioExts = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.m4a', '.wma', '.alac', '.ape'];
  const videoExts = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv', '.m4v'];
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

  const ext = path.extname(file.originalname).toLowerCase();
  const allAllowed = [...audioExts, ...videoExts, ...imageExts];

  if (allAllowed.includes(ext)) {
    cb(null, true);
  } else {
    cb(new Error(`File type ${ext} is not supported`), false);
  }
};

const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
  fileFilter
});

// Upload music
router.post('/music', upload.fields([
  { name: 'audio', maxCount: 1 },
  { name: 'artwork', maxCount: 1 }
]), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, artist, lyrics } = req.body;

    if (!req.files || !req.files.audio) {
      return res.status(400).json({ error: 'Audio file is required' });
    }

    const audioFile = req.files.audio[0];
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const audioUrl = `${appUrl}/${audioFile.path}`;

    let artworkUrl = null;
    if (req.files.artwork) {
      artworkUrl = `${appUrl}/${req.files.artwork[0].path}`;
    }

    const ext = path.extname(audioFile.originalname).toLowerCase().replace('.', '');

    const result = await db.query(
      `INSERT INTO songs (title, artist, lyrics, audio_url, artwork_url, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, artist, lyrics || null, audioUrl, artworkUrl, audioFile.size, ext]
    );

    res.json({ success: true, song: result.rows[0] });
  } catch (err) {
    console.error('Music upload error:', err);
    res.status(500).json({ error: 'Failed to upload music' });
  }
});

// Upload video
router.post('/video', upload.fields([
  { name: 'video', maxCount: 1 },
  { name: 'thumbnail', maxCount: 1 }
]), async (req, res) => {
  try {
    const db = req.app.locals.db;
    const { title, description, category } = req.body;

    if (!req.files || !req.files.video) {
      return res.status(400).json({ error: 'Video file is required' });
    }

    const videoFile = req.files.video[0];
    const appUrl = process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`;
    const videoUrl = `${appUrl}/${videoFile.path}`;

    let thumbnailUrl = null;
    if (req.files.thumbnail) {
      thumbnailUrl = `${appUrl}/${req.files.thumbnail[0].path}`;
    }

    const ext = path.extname(videoFile.originalname).toLowerCase().replace('.', '');

    const result = await db.query(
      `INSERT INTO videos (title, description, category, video_url, thumbnail_url, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [title, description || null, category || null, videoUrl, thumbnailUrl, videoFile.size, ext]
    );

    res.json({ success: true, video: result.rows[0] });
  } catch (err) {
    console.error('Video upload error:', err);
    res.status(500).json({ error: 'Failed to upload video' });
  }
});

// Handle multer errors
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 500MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

module.exports = router;
