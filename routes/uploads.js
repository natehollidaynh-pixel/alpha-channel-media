const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
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

// Use memory storage so we can stream to Cloudinary
const storage = multer.memoryStorage();

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

// Helper: upload buffer to Cloudinary
function uploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
    stream.end(buffer);
  });
}

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

    // Extract creator_id from auth token
    let creatorId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type === 'creator') creatorId = decoded.id;
      } catch (e) {}
    }

    const audioFile = req.files.audio[0];
    const ext = path.extname(audioFile.originalname).toLowerCase().replace('.', '');

    // Upload audio to Cloudinary
    const audioResult = await uploadToCloudinary(audioFile.buffer, {
      resource_type: 'video', // Cloudinary uses 'video' for audio files
      folder: 'alpha-channel/audio',
      public_id: uuidv4(),
      format: ext
    });
    const audioUrl = audioResult.secure_url;

    // Upload artwork to Cloudinary if provided
    let artworkUrl = null;
    if (req.files.artwork) {
      const artworkFile = req.files.artwork[0];
      const artResult = await uploadToCloudinary(artworkFile.buffer, {
        resource_type: 'image',
        folder: 'alpha-channel/artwork',
        public_id: uuidv4()
      });
      artworkUrl = artResult.secure_url;
    }

    const result = await db.query(
      `INSERT INTO songs (creator_id, title, artist, lyrics, audio_url, artwork_url, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [creatorId, title, artist, lyrics || null, audioUrl, artworkUrl, audioFile.size, ext]
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

    // Extract creator_id from auth token
    let creatorId = null;
    const authHeader = req.headers.authorization;
    if (authHeader) {
      try {
        const token = authHeader.split(' ')[1];
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.type === 'creator') creatorId = decoded.id;
      } catch (e) {}
    }

    const videoFile = req.files.video[0];
    const ext = path.extname(videoFile.originalname).toLowerCase().replace('.', '');

    // Upload video to Cloudinary
    const videoResult = await uploadToCloudinary(videoFile.buffer, {
      resource_type: 'video',
      folder: 'alpha-channel/videos',
      public_id: uuidv4(),
      format: ext
    });
    const videoUrl = videoResult.secure_url;

    // Upload thumbnail to Cloudinary if provided
    let thumbnailUrl = null;
    if (req.files.thumbnail) {
      const thumbFile = req.files.thumbnail[0];
      const thumbResult = await uploadToCloudinary(thumbFile.buffer, {
        resource_type: 'image',
        folder: 'alpha-channel/thumbnails',
        public_id: uuidv4()
      });
      thumbnailUrl = thumbResult.secure_url;
    }

    const result = await db.query(
      `INSERT INTO videos (creator_id, title, description, category, video_url, thumbnail_url, file_size, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [creatorId, title, description || null, category || null, videoUrl, thumbnailUrl, videoFile.size, ext]
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
