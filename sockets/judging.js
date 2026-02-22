const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

module.exports = function(io, pool) {
  const judgingNamespace = io.of('/judging');

  // Auth middleware for socket connections
  judgingNamespace.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('Authentication required'));

    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = { id: decoded.id, type: decoded.type };
      next();
    } catch (err) {
      next(new Error('Invalid token'));
    }
  });

  judgingNamespace.on('connection', (socket) => {
    console.log(`Judge/Trader connected: ${socket.user.type}:${socket.user.id}`);

    socket.on('join-session', (sessionId) => {
      socket.join(`session:${sessionId}`);
    });

    socket.on('leave-session', (sessionId) => {
      socket.leave(`session:${sessionId}`);
    });

    // Live rating submission from judges
    socket.on('submit-rating', async ({ sessionId, rating }) => {
      const userId = socket.user.id;
      const userType = socket.user.type;

      try {
        // Verify judge is active
        const judgeResult = await pool.query(
          'SELECT id FROM judges WHERE user_id = $1 AND user_type = $2 AND status = $3',
          [userId, userType, 'active']
        );
        if (judgeResult.rows.length === 0) return;
        const judgeId = judgeResult.rows[0].id;

        // Verify session is live
        const sessionResult = await pool.query(
          'SELECT id, status FROM judging_sessions WHERE id = $1 AND status = $2',
          [sessionId, 'live']
        );
        if (sessionResult.rows.length === 0) return;

        // Clamp rating
        const clampedRating = Math.max(0, Math.min(100, Math.round(rating)));

        // Insert snapshot
        await pool.query(
          `INSERT INTO judge_rating_snapshots (session_id, judge_id, rating, timestamp)
           VALUES ($1, $2, $3, NOW())`,
          [sessionId, judgeId, clampedRating]
        );

        // Calculate new consensus from each judge's latest rating
        const consensus = await pool.query(
          `SELECT AVG(sub.rating) as consensus, COUNT(DISTINCT sub.judge_id) as judge_count
           FROM (
             SELECT DISTINCT ON (judge_id) judge_id, rating
             FROM judge_rating_snapshots
             WHERE session_id = $1
             ORDER BY judge_id, timestamp DESC
           ) sub`,
          [sessionId]
        );

        const consensusValue = parseFloat(consensus.rows[0].consensus) || 0;
        const judgeCount = parseInt(consensus.rows[0].judge_count) || 0;

        // Update session judge_count
        await pool.query(
          'UPDATE judging_sessions SET judge_count = $1 WHERE id = $2',
          [judgeCount, sessionId]
        );

        // Broadcast to all clients in session room
        judgingNamespace.to(`session:${sessionId}`).emit('consensus-update', {
          consensus: Math.round(consensusValue * 100) / 100,
          judgeCount,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('Submit rating error:', err);
      }
    });

    socket.on('disconnect', () => {
      console.log(`Judge/Trader disconnected: ${socket.user.type}:${socket.user.id}`);
    });
  });

  return judgingNamespace;
};
