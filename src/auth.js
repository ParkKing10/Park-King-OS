// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — Authentication (JWT + bcrypt)
// ═══════════════════════════════════════════════════════════════════════════

const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { getDb } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'parkking-os-secret-change-me';
const TOKEN_EXPIRY = '24h';

// ─── Generate token ─────────────────────────────────────────────────────

function generateToken(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role, name: user.display_name },
    JWT_SECRET,
    { expiresIn: TOKEN_EXPIRY }
  );
}

// ─── Verify token ───────────────────────────────────────────────────────

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// ─── Login ──────────────────────────────────────────────────────────────

function login(username, password) {
  const d = getDb();
  const user = d.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
  if (!user) return null;
  if (!bcrypt.compareSync(password, user.password)) return null;
  const token = generateToken(user);
  return {
    token,
    user: { id: user.id, username: user.username, role: user.role, display_name: user.display_name }
  };
}

// ─── Middleware: require auth ────────────────────────────────────────────

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token fehlt' });
  }
  const token = authHeader.substring(7);
  const decoded = verifyToken(token);
  if (!decoded) {
    return res.status(401).json({ error: 'Token ungültig oder abgelaufen' });
  }
  req.user = decoded;
  next();
}

// ─── Middleware: require admin ───────────────────────────────────────────

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin-Rechte erforderlich' });
  }
  next();
}

// ─── User management ────────────────────────────────────────────────────

function createUser(username, password, displayName, role) {
  const d = getDb();
  const hash = bcrypt.hashSync(password, 10);
  const result = d.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)')
    .run(username, hash, displayName, role || 'staff');
  return result.lastInsertRowid;
}

function updateUser(id, updates) {
  const d = getDb();
  const fields = [];
  const values = [];

  if (updates.display_name) { fields.push('display_name = ?'); values.push(updates.display_name); }
  if (updates.role) { fields.push('role = ?'); values.push(updates.role); }
  if (updates.active !== undefined) { fields.push('active = ?'); values.push(updates.active ? 1 : 0); }
  if (updates.password) {
    fields.push('password = ?');
    values.push(bcrypt.hashSync(updates.password, 10));
  }

  if (!fields.length) return false;
  fields.push("updated_at = datetime('now')");
  values.push(id);

  d.prepare(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  return true;
}

function listUsers() {
  const d = getDb();
  return d.prepare('SELECT id, username, display_name, role, active, created_at FROM users ORDER BY role DESC, display_name').all();
}

module.exports = { login, generateToken, verifyToken, requireAuth, requireAdmin, createUser, updateUser, listUsers };
