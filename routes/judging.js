const express = require('express');
const router = express.Router();
const { authenticateToken, authenticateMaster } = require('../middleware/auth');

// Helper: look up username from the correct table
async function getUserInfo(db, userId, userType) {
  const table = userType === 'creator' ? 'creators' : 'listeners';
  const result = await db.query(
    `SELECT username, first_name, last_name FROM ${table} WHERE id = $1`,
    [userId]
  );
  return result.rows[0] || null;
}

// ========================================
// JUDGE APPLICATION ENDPOINTS
// ========================================

// POST /judges/apply — Submit judge application
router.post('/judges/apply', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;
  const { music_background, genres_familiar } = req.body;

  try {
    // Check if already a judge
    const existingJudge = await db.query(
      'SELECT id, status FROM judges WHERE user_id = $1 AND user_type = $2',
      [userId, userType]
    );
    if (existingJudge.rows.length > 0) {
      return res.status(400).json({ error: 'You are already a judge', status: existingJudge.rows[0].status });
    }

    // Check for pending application
    const pendingApp = await db.query(
      `SELECT id, status, next_attempt_date FROM judge_applications
       WHERE user_id = $1 AND user_type = $2
       ORDER BY created_at DESC LIMIT 1`,
      [userId, userType]
    );
    if (pendingApp.rows.length > 0) {
      const app = pendingApp.rows[0];
      if (app.status === 'pending' || app.status === 'screening') {
        return res.status(400).json({ error: 'You already have a pending application' });
      }
      if (app.status === 'rejected' && app.next_attempt_date && new Date(app.next_attempt_date) > new Date()) {
        return res.status(400).json({
          error: 'Cooldown period active',
          next_attempt_date: app.next_attempt_date
        });
      }
    }

    // Count previous attempts
    const attemptsResult = await db.query(
      'SELECT COUNT(*) as cnt FROM judge_applications WHERE user_id = $1 AND user_type = $2',
      [userId, userType]
    );
    const attempts = parseInt(attemptsResult.rows[0].cnt) + 1;

    const result = await db.query(
      `INSERT INTO judge_applications (user_id, user_type, music_background, genres_familiar, status, attempts)
       VALUES ($1, $2, $3, $4, 'screening', $5)
       RETURNING id, status, created_at`,
      [userId, userType, music_background, genres_familiar, attempts]
    );

    res.status(201).json({ application: result.rows[0] });
  } catch (err) {
    console.error('Judge application error:', err);
    res.status(500).json({ error: 'Failed to submit application' });
  }
});

// GET /judges/screening/:applicationId — Get anchor songs for screening
router.get('/judges/screening/:applicationId', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;

  try {
    // Verify this application belongs to the user
    const appResult = await db.query(
      `SELECT id, status FROM judge_applications WHERE id = $1 AND user_id = $2 AND user_type = $3`,
      [req.params.applicationId, userId, userType]
    );
    if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
    if (appResult.rows[0].status !== 'screening') {
      return res.status(400).json({ error: 'Application is not in screening phase' });
    }

    // Get 5 random active anchor songs
    const anchors = await db.query(
      `SELECT a.id, a.genre, a.difficulty, s.title, s.artist, s.audio_url, s.artwork_url
       FROM anchor_songs a
       JOIN songs s ON a.song_id = s.id
       WHERE a.active = true
       ORDER BY RANDOM() LIMIT 5`
    );

    if (anchors.rows.length < 5) {
      return res.status(503).json({ error: 'Not enough anchor songs configured. Please try again later.' });
    }

    res.json({ songs: anchors.rows });
  } catch (err) {
    console.error('Screening fetch error:', err);
    res.status(500).json({ error: 'Failed to load screening test' });
  }
});

// POST /judges/screening/:applicationId/submit — Submit screening answers
router.post('/judges/screening/:applicationId/submit', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;
  const { ratings } = req.body; // array of { anchorId, rating }

  try {
    const appResult = await db.query(
      `SELECT id, status FROM judge_applications WHERE id = $1 AND user_id = $2 AND user_type = $3`,
      [req.params.applicationId, userId, userType]
    );
    if (appResult.rows.length === 0) return res.status(404).json({ error: 'Application not found' });
    if (appResult.rows[0].status !== 'screening') {
      return res.status(400).json({ error: 'Application is not in screening phase' });
    }

    if (!Array.isArray(ratings) || ratings.length === 0) {
      return res.status(400).json({ error: 'Ratings array is required' });
    }

    // Score each rating against the anchor's correct_rating
    let totalDeviation = 0;
    let scored = 0;
    for (const r of ratings) {
      const anchor = await db.query(
        'SELECT correct_rating, tolerance FROM anchor_songs WHERE id = $1',
        [r.anchorId]
      );
      if (anchor.rows.length === 0) continue;
      const deviation = Math.abs(r.rating - anchor.rows[0].correct_rating);
      totalDeviation += deviation;
      scored++;
    }

    if (scored === 0) {
      return res.status(400).json({ error: 'No valid anchor songs scored' });
    }

    const avgDeviation = totalDeviation / scored;
    const score = Math.max(0, 100 - avgDeviation * 2);
    const passed = score >= 60 && avgDeviation <= 15;

    if (passed) {
      // Create judge record
      await db.query(
        `INSERT INTO judges (user_id, user_type, status) VALUES ($1, $2, 'active')
         ON CONFLICT (user_id, user_type) DO UPDATE SET status = 'active', updated_at = NOW()`,
        [userId, userType]
      );
      await db.query(
        `UPDATE judge_applications SET status = 'approved', screening_score = $1, screening_deviation = $2, reviewed_at = NOW()
         WHERE id = $3`,
        [score, avgDeviation, req.params.applicationId]
      );
      res.json({ passed: true, score, avgDeviation });
    } else {
      // Cooldown: 7 days
      const nextAttempt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      await db.query(
        `UPDATE judge_applications SET status = 'rejected', screening_score = $1, screening_deviation = $2,
         rejection_reason = 'Screening score below threshold', next_attempt_date = $3, reviewed_at = NOW()
         WHERE id = $4`,
        [score, avgDeviation, nextAttempt, req.params.applicationId]
      );
      res.json({ passed: false, score, avgDeviation, next_attempt_date: nextAttempt });
    }
  } catch (err) {
    console.error('Screening submit error:', err);
    res.status(500).json({ error: 'Failed to process screening' });
  }
});

// GET /judges/profile — Get own judge status and stats
router.get('/judges/profile', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;

  try {
    const judge = await db.query(
      'SELECT * FROM judges WHERE user_id = $1 AND user_type = $2',
      [userId, userType]
    );

    if (judge.rows.length === 0) {
      // Check for pending application
      const app = await db.query(
        `SELECT id, status, screening_score, next_attempt_date, created_at
         FROM judge_applications WHERE user_id = $1 AND user_type = $2
         ORDER BY created_at DESC LIMIT 1`,
        [userId, userType]
      );
      return res.json({ isJudge: false, application: app.rows[0] || null });
    }

    res.json({ isJudge: true, judge: judge.rows[0] });
  } catch (err) {
    console.error('Judge profile error:', err);
    res.status(500).json({ error: 'Failed to get judge profile' });
  }
});

// ========================================
// SESSION ENDPOINTS
// ========================================

// GET /sessions — List active/upcoming sessions
router.get('/sessions', async (req, res) => {
  const db = req.app.locals.db;
  const { status } = req.query;

  try {
    let query = `
      SELECT js.*, s.title as song_title, s.artist as song_artist, s.artwork_url
      FROM judging_sessions js
      JOIN songs s ON js.song_id = s.id
    `;
    const params = [];

    if (status) {
      query += ' WHERE js.status = $1';
      params.push(status);
    }
    query += ' ORDER BY js.scheduled_start DESC LIMIT 50';

    const result = await db.query(query, params);

    // For live sessions, compute current consensus from latest snapshots
    for (const session of result.rows) {
      if (session.status === 'live') {
        const consensus = await db.query(
          `SELECT AVG(sub.rating) as current_consensus, COUNT(DISTINCT sub.judge_id) as active_judges
           FROM (
             SELECT DISTINCT ON (judge_id) judge_id, rating
             FROM judge_rating_snapshots
             WHERE session_id = $1
             ORDER BY judge_id, timestamp DESC
           ) sub`,
          [session.id]
        );
        session.current_consensus = consensus.rows[0]?.current_consensus || null;
        session.active_judges = parseInt(consensus.rows[0]?.active_judges || 0);
      }
    }

    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Sessions list error:', err);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

// GET /sessions/:id — Single session details
router.get('/sessions/:id', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const session = await db.query(
      `SELECT js.*, s.title as song_title, s.artist as song_artist, s.audio_url, s.artwork_url
       FROM judging_sessions js
       JOIN songs s ON js.song_id = s.id
       WHERE js.id = $1`,
      [req.params.id]
    );
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });

    const data = session.rows[0];

    // Current consensus
    if (data.status === 'live') {
      const consensus = await db.query(
        `SELECT AVG(sub.rating) as current_consensus, COUNT(DISTINCT sub.judge_id) as active_judges
         FROM (
           SELECT DISTINCT ON (judge_id) judge_id, rating
           FROM judge_rating_snapshots WHERE session_id = $1
           ORDER BY judge_id, timestamp DESC
         ) sub`,
        [req.params.id]
      );
      data.current_consensus = consensus.rows[0]?.current_consensus || null;
      data.active_judges = parseInt(consensus.rows[0]?.active_judges || 0);
    }

    // Trading window status
    data.trading_open = data.status === 'live' &&
      (!data.trading_window_end || new Date(data.trading_window_end) > new Date());

    res.json({ session: data });
  } catch (err) {
    console.error('Session detail error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

// GET /sessions/:id/history — Consensus over time (5-second buckets)
router.get('/sessions/:id/history', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const result = await db.query(
      `SELECT
         date_trunc('second', timestamp) - (EXTRACT(SECOND FROM timestamp)::int % 5) * interval '1 second' as bucket,
         AVG(rating) as avg_rating,
         COUNT(*) as snapshot_count
       FROM judge_rating_snapshots
       WHERE session_id = $1
       GROUP BY bucket
       ORDER BY bucket ASC`,
      [req.params.id]
    );
    res.json({ history: result.rows });
  } catch (err) {
    console.error('Session history error:', err);
    res.status(500).json({ error: 'Failed to get session history' });
  }
});

// POST /sessions — Admin: create new judging session
router.post('/sessions', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  const { song_id, title, scheduled_start } = req.body;

  try {
    if (!song_id) return res.status(400).json({ error: 'song_id is required' });

    // Verify song exists
    const song = await db.query('SELECT id, title FROM songs WHERE id = $1', [song_id]);
    if (song.rows.length === 0) return res.status(404).json({ error: 'Song not found' });

    const sessionTitle = title || `Judging: ${song.rows[0].title}`;
    const result = await db.query(
      `INSERT INTO judging_sessions (song_id, title, scheduled_start, status, created_by)
       VALUES ($1, $2, $3, 'scheduled', $4)
       RETURNING *`,
      [song_id, sessionTitle, scheduled_start || new Date(), req.user?.id || null]
    );

    res.status(201).json({ session: result.rows[0] });
  } catch (err) {
    console.error('Create session error:', err);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

// ========================================
// TRADING ENDPOINTS
// ========================================

// GET /traders/profile — Get or create trader profile
router.get('/traders/profile', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;

  try {
    let trader = await db.query(
      'SELECT * FROM traders WHERE user_id = $1 AND user_type = $2',
      [userId, userType]
    );

    if (trader.rows.length === 0) {
      // Auto-create trader profile
      trader = await db.query(
        `INSERT INTO traders (user_id, user_type) VALUES ($1, $2) RETURNING *`,
        [userId, userType]
      );
    }

    const userInfo = await getUserInfo(db, userId, userType);
    res.json({ trader: { ...trader.rows[0], username: userInfo?.username } });
  } catch (err) {
    console.error('Trader profile error:', err);
    res.status(500).json({ error: 'Failed to get trader profile' });
  }
});

// POST /trades — Place a trade
router.post('/trades', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;
  const { sessionId, direction, amount } = req.body;

  try {
    if (!sessionId || !direction || !amount) {
      return res.status(400).json({ error: 'sessionId, direction, and amount are required' });
    }
    if (!['over', 'under'].includes(direction)) {
      return res.status(400).json({ error: 'Direction must be "over" or "under"' });
    }
    if (amount <= 0 || amount > 50) {
      return res.status(400).json({ error: 'Amount must be between 0.01 and 50' });
    }

    // Verify session is live and trading window open
    const session = await db.query(
      'SELECT id, status, trading_window_end FROM judging_sessions WHERE id = $1',
      [sessionId]
    );
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status !== 'live') {
      return res.status(400).json({ error: 'Session is not live' });
    }
    if (session.rows[0].trading_window_end && new Date(session.rows[0].trading_window_end) < new Date()) {
      return res.status(400).json({ error: 'Trading window has closed' });
    }

    // Get or create trader
    let trader = await db.query(
      'SELECT id, play_money_balance FROM traders WHERE user_id = $1 AND user_type = $2',
      [userId, userType]
    );
    if (trader.rows.length === 0) {
      trader = await db.query(
        'INSERT INTO traders (user_id, user_type) VALUES ($1, $2) RETURNING id, play_money_balance',
        [userId, userType]
      );
    }
    const traderRow = trader.rows[0];

    if (parseFloat(traderRow.play_money_balance) < amount) {
      return res.status(400).json({ error: 'Insufficient balance' });
    }

    // Check for existing trade on this session
    const existing = await db.query(
      'SELECT id FROM trades WHERE session_id = $1 AND user_id = $2 AND user_type = $3 AND status = $4',
      [sessionId, userId, userType, 'pending']
    );
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'You already have an active trade on this session' });
    }

    // Get current consensus as entry sentiment
    const consensus = await db.query(
      `SELECT AVG(sub.rating) as current_consensus
       FROM (
         SELECT DISTINCT ON (judge_id) judge_id, rating
         FROM judge_rating_snapshots WHERE session_id = $1
         ORDER BY judge_id, timestamp DESC
       ) sub`,
      [sessionId]
    );
    const entrySentiment = consensus.rows[0]?.current_consensus || 50;

    // Deduct balance and create trade
    await db.query(
      'UPDATE traders SET play_money_balance = play_money_balance - $1, total_trades = total_trades + 1, last_trade_at = NOW() WHERE id = $2',
      [amount, traderRow.id]
    );

    const trade = await db.query(
      `INSERT INTO trades (session_id, user_id, user_type, trader_id, direction, entry_sentiment, amount, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
       RETURNING *`,
      [sessionId, userId, userType, traderRow.id, direction, entrySentiment, amount]
    );

    res.status(201).json({ trade: trade.rows[0] });
  } catch (err) {
    console.error('Place trade error:', err);
    res.status(500).json({ error: 'Failed to place trade' });
  }
});

// GET /trades/active — User's pending trades
router.get('/trades/active', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;

  try {
    const result = await db.query(
      `SELECT t.*, js.title as session_title, js.status as session_status,
              s.title as song_title, s.artist as song_artist
       FROM trades t
       JOIN judging_sessions js ON t.session_id = js.id
       JOIN songs s ON js.song_id = s.id
       WHERE t.user_id = $1 AND t.user_type = $2 AND t.status = 'pending'
       ORDER BY t.created_at DESC`,
      [userId, userType]
    );
    res.json({ trades: result.rows });
  } catch (err) {
    console.error('Active trades error:', err);
    res.status(500).json({ error: 'Failed to get active trades' });
  }
});

// GET /trades/history — Settled trade history
router.get('/trades/history', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 50);
  const offset = (page - 1) * limit;

  try {
    const result = await db.query(
      `SELECT t.*, js.title as session_title, s.title as song_title, s.artist as song_artist
       FROM trades t
       JOIN judging_sessions js ON t.session_id = js.id
       JOIN songs s ON js.song_id = s.id
       WHERE t.user_id = $1 AND t.user_type = $2 AND t.status = 'settled'
       ORDER BY t.settled_at DESC
       LIMIT $3 OFFSET $4`,
      [userId, userType, limit, offset]
    );

    const countResult = await db.query(
      'SELECT COUNT(*) as total FROM trades WHERE user_id = $1 AND user_type = $2 AND status = $3',
      [userId, userType, 'settled']
    );

    res.json({
      trades: result.rows,
      total: parseInt(countResult.rows[0].total),
      page,
      pages: Math.ceil(parseInt(countResult.rows[0].total) / limit)
    });
  } catch (err) {
    console.error('Trade history error:', err);
    res.status(500).json({ error: 'Failed to get trade history' });
  }
});

// ========================================
// LEADERBOARD ENDPOINTS
// ========================================

// GET /leaderboards/traders — Trader rankings
router.get('/leaderboards/traders', async (req, res) => {
  const db = req.app.locals.db;
  const { period } = req.query; // daily, weekly, monthly, alltime

  try {
    let dateFilter = '';
    if (period === 'daily') dateFilter = "AND t.settled_at >= NOW() - INTERVAL '1 day'";
    else if (period === 'weekly') dateFilter = "AND t.settled_at >= NOW() - INTERVAL '7 days'";
    else if (period === 'monthly') dateFilter = "AND t.settled_at >= NOW() - INTERVAL '30 days'";

    const result = await db.query(`
      SELECT
        tr.id, tr.user_id, tr.user_type, tr.play_money_balance,
        tr.total_trades, tr.winning_trades, tr.best_streak,
        COALESCE(SUM(CASE WHEN t.outcome = 'win' THEN t.payout - t.amount ELSE -t.amount END), 0) as period_profit
      FROM traders tr
      LEFT JOIN trades t ON tr.id = t.trader_id AND t.status = 'settled' ${dateFilter}
      GROUP BY tr.id
      ORDER BY period_profit DESC
      LIMIT 50
    `);

    // Add usernames
    for (const row of result.rows) {
      const info = await getUserInfo(db, row.user_id, row.user_type);
      row.username = info?.username || 'Unknown';
    }

    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error('Trader leaderboard error:', err);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// GET /leaderboards/judges — Judge rankings
router.get('/leaderboards/judges', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const result = await db.query(`
      SELECT id, user_id, user_type, accuracy_score, total_ratings, sessions_judged, created_at
      FROM judges
      WHERE status = 'active'
      ORDER BY accuracy_score DESC, sessions_judged DESC
      LIMIT 50
    `);

    for (const row of result.rows) {
      const info = await getUserInfo(db, row.user_id, row.user_type);
      row.username = info?.username || 'Unknown';
    }

    res.json({ leaderboard: result.rows });
  } catch (err) {
    console.error('Judge leaderboard error:', err);
    res.status(500).json({ error: 'Failed to get leaderboard' });
  }
});

// ========================================
// WAITLIST ENDPOINTS
// ========================================

// POST /waitlist — Join waitlist (no auth needed)
router.post('/waitlist', async (req, res) => {
  const db = req.app.locals.db;
  const { email, name, wants_to_judge, wants_to_trade, wants_to_upload, referral_source, referral_code } = req.body;

  try {
    if (!email) return res.status(400).json({ error: 'Email is required' });

    // Check if already on waitlist
    const existing = await db.query('SELECT id, status FROM waitlist WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'Email already on waitlist', status: existing.rows[0].status });
    }

    // Resolve referral
    let referredBy = null;
    if (referral_code) {
      const referrer = await db.query('SELECT id FROM waitlist WHERE referral_code = $1', [referral_code]);
      if (referrer.rows.length > 0) referredBy = referrer.rows[0].id;
    }

    // Generate unique referral code for this entry
    const myCode = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').substring(0, 8) +
      Math.random().toString(36).substring(2, 6);

    const result = await db.query(
      `INSERT INTO waitlist (email, name, wants_to_judge, wants_to_trade, wants_to_upload, referral_source, referral_code, referred_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, referral_code, created_at`,
      [email, name, wants_to_judge || false, wants_to_trade || false, wants_to_upload || false,
       referral_source, myCode, referredBy]
    );

    res.status(201).json({ entry: result.rows[0] });
  } catch (err) {
    console.error('Waitlist error:', err);
    res.status(500).json({ error: 'Failed to join waitlist' });
  }
});

// GET /waitlist/stats — Public stats
router.get('/waitlist/stats', async (req, res) => {
  const db = req.app.locals.db;

  try {
    const result = await db.query(`
      SELECT
        COUNT(*) as total,
        COUNT(*) FILTER (WHERE wants_to_judge) as judges,
        COUNT(*) FILTER (WHERE wants_to_trade) as traders,
        COUNT(*) FILTER (WHERE wants_to_upload) as uploaders
      FROM waitlist
    `);
    res.json({ stats: result.rows[0] });
  } catch (err) {
    console.error('Waitlist stats error:', err);
    res.status(500).json({ error: 'Failed to get stats' });
  }
});

// ========================================
// NOTIFICATION ENDPOINTS
// ========================================

// GET /notifications — User's notifications
router.get('/notifications', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;
  const { unread } = req.query;

  try {
    let query = 'SELECT * FROM notifications WHERE user_id = $1 AND user_type = $2';
    const params = [userId, userType];

    if (unread === 'true') {
      query += ' AND read = false';
    }
    query += ' ORDER BY created_at DESC LIMIT 50';

    const result = await db.query(query, params);

    const countResult = await db.query(
      'SELECT COUNT(*) as unread FROM notifications WHERE user_id = $1 AND user_type = $2 AND read = false',
      [userId, userType]
    );

    res.json({ notifications: result.rows, unread_count: parseInt(countResult.rows[0].unread) });
  } catch (err) {
    console.error('Notifications error:', err);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// PATCH /notifications/:id/read — Mark single as read
router.patch('/notifications/:id/read', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;

  try {
    const result = await db.query(
      'UPDATE notifications SET read = true WHERE id = $1 AND user_id = $2 AND user_type = $3 RETURNING id',
      [req.params.id, userId, userType]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Notification not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Mark read error:', err);
    res.status(500).json({ error: 'Failed to mark notification' });
  }
});

// PATCH /notifications/read-all — Mark all as read
router.patch('/notifications/read-all', authenticateToken, async (req, res) => {
  const db = req.app.locals.db;
  const { id: userId, type: userType } = req.user;

  try {
    await db.query(
      'UPDATE notifications SET read = true WHERE user_id = $1 AND user_type = $2 AND read = false',
      [userId, userType]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Mark all read error:', err);
    res.status(500).json({ error: 'Failed to mark notifications' });
  }
});

// ========================================
// SESSION MANAGEMENT (ADMIN)
// ========================================

// PATCH /sessions/:id/start — Admin: start a session (set to live)
router.patch('/sessions/:id/start', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  const { trading_window_minutes } = req.body;

  try {
    const session = await db.query('SELECT id, status FROM judging_sessions WHERE id = $1', [req.params.id]);
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status !== 'scheduled') {
      return res.status(400).json({ error: 'Session is not in scheduled state' });
    }

    const tradingEnd = trading_window_minutes
      ? new Date(Date.now() + trading_window_minutes * 60 * 1000)
      : null;

    const result = await db.query(
      `UPDATE judging_sessions SET status = 'live', actual_start = NOW(), trading_window_end = $1
       WHERE id = $2 RETURNING *`,
      [tradingEnd, req.params.id]
    );

    res.json({ session: result.rows[0] });
  } catch (err) {
    console.error('Start session error:', err);
    res.status(500).json({ error: 'Failed to start session' });
  }
});

// POST /sessions/:id/settle — Admin: settle session and resolve trades
router.post('/sessions/:id/settle', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  const sessionId = req.params.id;

  try {
    const session = await db.query(
      'SELECT id, status FROM judging_sessions WHERE id = $1',
      [sessionId]
    );
    if (session.rows.length === 0) return res.status(404).json({ error: 'Session not found' });
    if (session.rows[0].status === 'completed') {
      return res.status(400).json({ error: 'Session already settled' });
    }

    // Calculate final consensus from each judge's latest rating
    const consensus = await db.query(
      `SELECT AVG(sub.rating) as final_consensus, COUNT(DISTINCT sub.judge_id) as judge_count
       FROM (
         SELECT DISTINCT ON (judge_id) judge_id, rating
         FROM judge_rating_snapshots
         WHERE session_id = $1
         ORDER BY judge_id, timestamp DESC
       ) sub`,
      [sessionId]
    );

    const finalConsensus = parseFloat(consensus.rows[0]?.final_consensus) || 0;
    const judgeCount = parseInt(consensus.rows[0]?.judge_count) || 0;

    // Update session to completed
    await db.query(
      `UPDATE judging_sessions SET status = 'completed', final_consensus = $1, judge_count = $2, end_time = NOW()
       WHERE id = $3`,
      [finalConsensus, judgeCount, sessionId]
    );

    // Get all pending trades for this session
    const trades = await db.query(
      `SELECT t.*, tr.id as trader_table_id
       FROM trades t
       JOIN traders tr ON t.trader_id = tr.id
       WHERE t.session_id = $1 AND t.status = 'pending'`,
      [sessionId]
    );

    let settled = 0;
    for (const trade of trades.rows) {
      const entry = parseFloat(trade.entry_sentiment);
      const amount = parseFloat(trade.amount);
      let outcome, payout;

      if (Math.abs(finalConsensus - entry) < 0.5) {
        outcome = 'push';
        payout = amount;
      } else if (trade.direction === 'over' && finalConsensus > entry) {
        outcome = 'win';
        payout = amount * 1.8;
      } else if (trade.direction === 'under' && finalConsensus < entry) {
        outcome = 'win';
        payout = amount * 1.8;
      } else {
        outcome = 'loss';
        payout = 0;
      }

      // Update trade record
      await db.query(
        `UPDATE trades SET status = 'settled', outcome = $1, final_sentiment = $2, payout = $3, settled_at = NOW()
         WHERE id = $4`,
        [outcome, finalConsensus, payout, trade.id]
      );

      // Update trader balance and stats
      const profitLoss = payout - amount;
      if (outcome === 'win') {
        await db.query(
          `UPDATE traders SET
             play_money_balance = play_money_balance + $1,
             winning_trades = winning_trades + 1,
             current_streak = current_streak + 1,
             best_streak = GREATEST(best_streak, current_streak + 1),
             total_profit_loss = total_profit_loss + $2
           WHERE id = $3`,
          [payout, profitLoss, trade.trader_table_id]
        );
      } else if (outcome === 'loss') {
        await db.query(
          `UPDATE traders SET
             losing_trades = losing_trades + 1,
             current_streak = 0,
             total_profit_loss = total_profit_loss - $1
           WHERE id = $2`,
          [amount, trade.trader_table_id]
        );
      } else {
        // Push — return money, no stat change
        await db.query(
          'UPDATE traders SET play_money_balance = play_money_balance + $1 WHERE id = $2',
          [payout, trade.trader_table_id]
        );
      }
      settled++;
    }

    // Update judge session counts
    const judgeIds = await db.query(
      `SELECT DISTINCT judge_id FROM judge_rating_snapshots WHERE session_id = $1`,
      [sessionId]
    );
    for (const row of judgeIds.rows) {
      const ratingCount = await db.query(
        'SELECT COUNT(*) as cnt FROM judge_rating_snapshots WHERE session_id = $1 AND judge_id = $2',
        [sessionId, row.judge_id]
      );
      await db.query(
        `UPDATE judges SET sessions_judged = sessions_judged + 1, total_ratings = total_ratings + $1 WHERE id = $2`,
        [parseInt(ratingCount.rows[0].cnt), row.judge_id]
      );
    }

    // Broadcast session ended via Socket.IO
    const io = req.app.locals.io;
    if (io) {
      io.of('/judging').to(`session:${sessionId}`).emit('session-ended', {
        sessionId,
        finalConsensus: Math.round(finalConsensus * 100) / 100,
        judgeCount,
        tradesSettled: settled
      });
    }

    res.json({
      success: true,
      finalConsensus: Math.round(finalConsensus * 100) / 100,
      judgeCount,
      tradesSettled: settled
    });
  } catch (err) {
    console.error('Settle session error:', err);
    res.status(500).json({ error: 'Failed to settle session' });
  }
});

// ========================================
// ANCHOR SONG MANAGEMENT (ADMIN)
// ========================================

// GET /admin/anchors — List all anchor songs
router.get('/admin/anchors', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(
      `SELECT a.*, s.title, s.artist, s.audio_url, s.artwork_url
       FROM anchor_songs a
       JOIN songs s ON a.song_id = s.id
       ORDER BY a.created_at DESC`
    );
    res.json({ anchors: result.rows });
  } catch (err) {
    console.error('Get anchors error:', err);
    res.status(500).json({ error: 'Failed to get anchors' });
  }
});

// POST /admin/anchors — Designate a song as anchor
router.post('/admin/anchors', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  const { song_id, correct_rating, tolerance, genre, difficulty } = req.body;

  try {
    if (!song_id || correct_rating === undefined) {
      return res.status(400).json({ error: 'song_id and correct_rating are required' });
    }
    const song = await db.query('SELECT id FROM songs WHERE id = $1', [song_id]);
    if (song.rows.length === 0) return res.status(404).json({ error: 'Song not found' });

    const existing = await db.query('SELECT id FROM anchor_songs WHERE song_id = $1', [song_id]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ error: 'This song is already an anchor' });
    }

    const result = await db.query(
      `INSERT INTO anchor_songs (song_id, correct_rating, tolerance, genre, difficulty, active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING *`,
      [song_id, correct_rating, tolerance || 10, genre || null, difficulty || 'medium']
    );
    res.status(201).json({ anchor: result.rows[0] });
  } catch (err) {
    console.error('Create anchor error:', err);
    res.status(500).json({ error: 'Failed to create anchor' });
  }
});

// DELETE /admin/anchors/:id — Remove an anchor
router.delete('/admin/anchors/:id', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query('DELETE FROM anchor_songs WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Anchor not found' });
    res.json({ success: true });
  } catch (err) {
    console.error('Delete anchor error:', err);
    res.status(500).json({ error: 'Failed to delete anchor' });
  }
});

// GET /admin/sessions — List all sessions for admin management
router.get('/admin/sessions', authenticateMaster, async (req, res) => {
  const db = req.app.locals.db;
  try {
    const result = await db.query(
      `SELECT js.*, s.title as song_title, s.artist as song_artist, s.artwork_url,
              (SELECT COUNT(*) FROM trades WHERE session_id = js.id) as trade_count
       FROM judging_sessions js
       JOIN songs s ON js.song_id = s.id
       ORDER BY js.created_at DESC
       LIMIT 100`
    );
    res.json({ sessions: result.rows });
  } catch (err) {
    console.error('Admin sessions error:', err);
    res.status(500).json({ error: 'Failed to get sessions' });
  }
});

module.exports = router;
