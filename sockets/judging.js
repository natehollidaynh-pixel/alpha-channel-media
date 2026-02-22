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

    socket.on('disconnect', () => {
      console.log(`Judge/Trader disconnected: ${socket.user.type}:${socket.user.id}`);
    });
  });

  return judgingNamespace;
};
