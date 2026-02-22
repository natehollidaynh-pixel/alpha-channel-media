const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'default-secret-change-me';

// Authenticate any user (creator, listener, or master)
// Sets req.user = { id, type } on success
function authenticateToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = { id: decoded.id, type: decoded.type };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Authenticate master admin via x-master-password header or master JWT
function authenticateMaster(req, res, next) {
  // Check header password first
  const masterPassword = req.headers['x-master-password'];
  if (masterPassword && masterPassword === process.env.MASTER_PASSWORD) {
    req.user = { type: 'master' };
    return next();
  }

  // Fall back to JWT
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.split(' ')[1];
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      if (decoded.type === 'master') {
        req.user = { type: 'master' };
        return next();
      }
    } catch (err) {
      // fall through
    }
  }

  return res.status(403).json({ error: 'Unauthorized' });
}

module.exports = { authenticateToken, authenticateMaster };
