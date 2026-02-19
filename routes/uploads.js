const express = require('express');
const jwt = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const router = express.Router();
const { sendNewSongEmail, sendNewVideoEmail } = require('../emails/sender');

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

    const song = result.rows[0];
    res.json({ success: true, song });

    // Background: notify subscribed listeners (non-blocking)
    if (creatorId) {
      notifySubscribers(db, creatorId, 'song', song).catch(err =>
        console.error('Failed to notify subscribers about new song:', err)
      );
    }
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

    const video = result.rows[0];
    res.json({ success: true, video });

    // Background: notify subscribed listeners (non-blocking)
    if (creatorId) {
      notifySubscribers(db, creatorId, 'video', video).catch(err =>
        console.error('Failed to notify subscribers about new video:', err)
      );
    }
  } catch (err) {
    console.error('Save video error:', err);
    res.status(500).json({ error: 'Failed to save video' });
  }
});

// Background: notify all subscribed listeners when a creator uploads content
async function notifySubscribers(db, creatorId, contentType, content) {
  try {
    // Get creator info
    const creatorResult = await db.query(
      'SELECT id, username, artist_name, first_name, last_name FROM creators WHERE id = $1',
      [creatorId]
    );
    if (creatorResult.rows.length === 0) return;
    const creator = creatorResult.rows[0];

    // Get subscribed listeners who have email_on_upload enabled AND global email_notifications enabled
    const subsResult = await db.query(
      `SELECT l.id, l.email, l.first_name, l.last_name
       FROM listener_creator_subscriptions lcs
       JOIN listeners l ON l.id = lcs.listener_id
       WHERE lcs.creator_id = $1
         AND lcs.email_on_upload = true
         AND l.email_notifications = true`,
      [creatorId]
    );

    console.log(`Notifying ${subsResult.rows.length} subscribers about new ${contentType} from ${creator.artist_name || creator.username}`);

    for (const listener of subsResult.rows) {
      try {
        if (contentType === 'song') {
          await sendNewSongEmail(listener, creator, content);
        } else if (contentType === 'video') {
          await sendNewVideoEmail(listener, creator, content);
        }
        // Log the notification
        await db.query(
          `INSERT INTO email_notifications_log (listener_id, creator_id, email_type, subject, status)
           VALUES ($1, $2, $3, $4, 'sent')`,
          [listener.id, creatorId, `new_${contentType}`, content.title]
        );
      } catch (emailErr) {
        console.error(`Failed to email ${listener.email}:`, emailErr.message);
        // Log failure
        await db.query(
          `INSERT INTO email_notifications_log (listener_id, creator_id, email_type, subject, status)
           VALUES ($1, $2, $3, $4, 'failed')`,
          [listener.id, creatorId, `new_${contentType}`, content.title]
        ).catch(() => {});
      }
    }
  } catch (err) {
    console.error('Notify subscribers error:', err);
  }
}

module.exports = router;
