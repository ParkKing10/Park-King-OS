// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — API Routes
// ═══════════════════════════════════════════════════════════════════════════

const express = require('express');
const { getDb, addLog } = require('./db');
const { login, requireAuth, requireAdmin, createUser, updateUser, listUsers } = require('./auth');
const { scrapeCompany, autoScrapeAll } = require('./scraper');

const router = express.Router();

// ─── AUTH ────────────────────────────────────────────────────────────────

router.post('/auth/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Username und Passwort erforderlich' });
  const result = login(username, password);
  if (!result) return res.status(401).json({ error: 'Ungültige Zugangsdaten' });
  res.json(result);
});

router.get('/auth/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

// ─── USERS (admin only) ─────────────────────────────────────────────────

router.get('/users', requireAuth, requireAdmin, (req, res) => {
  res.json(listUsers());
});

router.post('/users', requireAuth, requireAdmin, (req, res) => {
  try {
    const { username, password, display_name, role } = req.body;
    if (!username || !password || !display_name) {
      return res.status(400).json({ error: 'Username, Passwort und Name erforderlich' });
    }
    const id = createUser(username, password, display_name, role || 'staff');
    res.json({ id, message: 'Benutzer erstellt' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'Username bereits vergeben' });
    res.status(500).json({ error: err.message });
  }
});

router.put('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const success = updateUser(parseInt(req.params.id), req.body);
  if (success) res.json({ message: 'Benutzer aktualisiert' });
  else res.status(400).json({ error: 'Keine Änderungen' });
});

router.delete('/users/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Du kannst dich nicht selbst löschen' });
  d.prepare('UPDATE users SET active = 0 WHERE id = ?').run(id);
  res.json({ message: 'Benutzer deaktiviert' });
});

// ─── COMPANIES ──────────────────────────────────────────────────────────

router.get('/companies', requireAuth, (req, res) => {
  const d = getDb();
  const companies = d.prepare('SELECT id, name, active FROM companies').all();
  res.json(companies);
});

router.put('/companies/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { name, base_url, email, password, active } = req.body;
  d.prepare(`
    UPDATE companies SET
      name = COALESCE(?, name),
      base_url = COALESCE(?, base_url),
      email = COALESCE(?, email),
      password = COALESCE(?, password),
      active = COALESCE(?, active)
    WHERE id = ?
  `).run(name, base_url, email, password, active !== undefined ? (active ? 1 : 0) : null, req.params.id);
  res.json({ message: 'Firma aktualisiert' });
});

// ─── BOOKINGS ───────────────────────────────────────────────────────────

router.get('/bookings', requireAuth, (req, res) => {
  const d = getDb();
  const { company, date, type, status, search, limit, offset } = req.query;

  let sql = 'SELECT * FROM bookings WHERE 1=1';
  const params = [];

  if (company) { sql += ' AND company_id = ?'; params.push(company); }
  if (date) { sql += ' AND scraped_date = ?'; params.push(date); }
  else { sql += ' AND scraped_date = ?'; params.push(new Date().toISOString().split('T')[0]); }
  if (type) { sql += ' AND type = ?'; params.push(type); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (search) {
    sql += ' AND (plate LIKE ? OR name LIKE ? OR phone LIKE ? OR external_id LIKE ?)';
    const s = `%${search}%`;
    params.push(s, s, s, s);
  }

  sql += ' ORDER BY CASE WHEN time_in IS NOT NULL THEN time_in ELSE time_out END ASC';

  if (limit) { sql += ' LIMIT ?'; params.push(parseInt(limit)); }
  if (offset) { sql += ' OFFSET ?'; params.push(parseInt(offset)); }

  const bookings = d.prepare(sql).all(...params);

  // Stats
  const statsDate = date || new Date().toISOString().split('T')[0];
  const stats = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'in' THEN 1 ELSE 0 END) as annahmen,
      SUM(CASE WHEN type = 'out' THEN 1 ELSE 0 END) as rueckgaben,
      SUM(CASE WHEN status IN ('new', 'pending') THEN 1 ELSE 0 END) as offen,
      SUM(COALESCE(price, 0)) as total_due,
      SUM(CASE WHEN paid = 1 THEN COALESCE(price, 0) ELSE 0 END) as total_paid
    FROM bookings WHERE scraped_date = ? ${company ? 'AND company_id = ?' : ''}
  `).get(...(company ? [statsDate, company] : [statsDate]));

  res.json({ bookings, stats, date: statsDate });
});

router.get('/bookings/:id', requireAuth, (req, res) => {
  const d = getDb();
  const booking = d.prepare('SELECT * FROM bookings WHERE id = ?').get(parseInt(req.params.id));
  if (!booking) return res.status(404).json({ error: 'Buchung nicht gefunden' });

  const log = d.prepare('SELECT l.*, u.display_name as user_name FROM booking_log l LEFT JOIN users u ON l.user_id = u.id WHERE l.booking_id = ? ORDER BY l.created_at DESC').all(booking.id);
  res.json({ booking, log });
});

router.put('/bookings/:id', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  const b = req.body;

  const fields = [];
  const values = [];
  const allowed = ['name', 'phone', 'email', 'pax', 'plate', 'car', 'key_code',
    'key_handed_in', 'km_in', 'km_out', 'date_in', 'time_in', 'date_out', 'time_out',
    'flight_code', 'flight_sched', 'flight_live', 'provider', 'days', 'price',
    'wash', 'wash_done', 'comment', 'phone_contacted', 'shuttle_driver', 'shuttle_status', 'type', 'status'];

  for (const key of allowed) {
    if (b[key] !== undefined) {
      fields.push(`${key} = ?`);
      values.push(b[key]);
    }
  }

  if (!fields.length) return res.status(400).json({ error: 'Keine Änderungen' });
  fields.push("updated_at = datetime('now')");
  values.push(id);

  d.prepare(`UPDATE bookings SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  addLog(id, 'edited', b, req.user.id);
  res.json({ message: 'Buchung aktualisiert' });
});

// ─── BOOKING ACTIONS ────────────────────────────────────────────────────

router.post('/bookings/:id/checkin', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  const { km } = req.body;
  d.prepare("UPDATE bookings SET status = 'checked', checked_in_at = datetime('now'), km_in = COALESCE(?, km_in), updated_at = datetime('now') WHERE id = ?")
    .run(km || null, id);
  addLog(id, 'checked_in', { km }, req.user.id);
  res.json({ message: 'Check-in erfolgreich' });
});

router.post('/bookings/:id/checkout', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  const { km } = req.body;
  d.prepare("UPDATE bookings SET status = 'checked', checked_out_at = datetime('now'), km_out = COALESCE(?, km_out), updated_at = datetime('now') WHERE id = ?")
    .run(km || null, id);
  addLog(id, 'checked_out', { km }, req.user.id);
  res.json({ message: 'Check-out erfolgreich' });
});

router.post('/bookings/:id/pay', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  const { method } = req.body;
  d.prepare("UPDATE bookings SET paid = 1, paid_method = ?, paid_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(method || 'Cash', id);
  addLog(id, 'paid', { method }, req.user.id);
  res.json({ message: 'Zahlung erfasst' });
});

router.post('/bookings/:id/noshow', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  d.prepare("UPDATE bookings SET status = 'noshow', updated_at = datetime('now') WHERE id = ?").run(id);
  addLog(id, 'noshow', null, req.user.id);
  res.json({ message: 'No-Show markiert' });
});

router.post('/bookings/:id/key', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  const { handed_in } = req.body;
  d.prepare("UPDATE bookings SET key_handed_in = ?, updated_at = datetime('now') WHERE id = ?")
    .run(handed_in ? 1 : 0, id);
  addLog(id, handed_in ? 'key_in' : 'key_out', null, req.user.id);
  res.json({ message: handed_in ? 'Schlüssel abgegeben' : 'Schlüssellos markiert' });
});

router.post('/bookings/:id/phone', requireAuth, (req, res) => {
  const d = getDb();
  const id = parseInt(req.params.id);
  d.prepare("UPDATE bookings SET phone_contacted = 1, updated_at = datetime('now') WHERE id = ?").run(id);
  addLog(id, 'phone_called', null, req.user.id);
  res.json({ message: 'Telefonat vermerkt' });
});

// ─── MANUAL BOOKING ─────────────────────────────────────────────────────

router.post('/bookings', requireAuth, (req, res) => {
  const d = getDb();
  const b = req.body;
  const today = new Date().toISOString().split('T')[0];

  const result = d.prepare(`
    INSERT INTO bookings (
      company_id, type, status, name, phone, email, pax, plate, car, key_code,
      date_in, time_in, date_out, time_out, flight_code, provider, price,
      wash, comment, scraped_date, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    b.company_id || 'parkking', b.type || 'in', 'new',
    b.name, b.phone, b.email, b.pax || 1,
    b.plate, b.car, b.key_code,
    b.date_in, b.time_in, b.date_out, b.time_out,
    b.flight_code, b.provider || 'Park King', b.price || 0,
    b.wash, b.comment, today, req.user.id
  );

  addLog(result.lastInsertRowid, 'created', b, req.user.id);
  res.json({ id: result.lastInsertRowid, message: 'Buchung erstellt' });
});

// ─── LABELS ─────────────────────────────────────────────────────────────

router.post('/labels', requireAuth, (req, res) => {
  const d = getDb();
  const { booking_id, plate, name } = req.body;
  const result = d.prepare('INSERT INTO labels (booking_id, plate, name, status, printed_by) VALUES (?, ?, ?, ?, ?)')
    .run(booking_id, plate, name, 'queued', req.user.id);
  if (booking_id) addLog(booking_id, 'label_printed', { plate }, req.user.id);
  // Simulate print completion
  setTimeout(() => {
    d.prepare("UPDATE labels SET status = 'done' WHERE id = ?").run(result.lastInsertRowid);
  }, 2000);
  res.json({ id: result.lastInsertRowid, message: 'Label erstellt' });
});

router.get('/labels', requireAuth, (req, res) => {
  const d = getDb();
  const labels = d.prepare(`
    SELECT l.*, u.display_name as printed_by_name
    FROM labels l LEFT JOIN users u ON l.printed_by = u.id
    ORDER BY l.created_at DESC LIMIT 50
  `).all();
  res.json(labels);
});

// ─── SCRAPING ───────────────────────────────────────────────────────────

// Track active scrapes
const activeScrapes = {};

router.post('/scrape', requireAuth, async (req, res) => {
  const { company } = req.body;
  const companyId = company || 'parkking';

  if (activeScrapes[companyId]) {
    return res.json({ message: 'Scrape läuft bereits', inProgress: true });
  }

  try {
    activeScrapes[companyId] = true;
    const result = await scrapeCompany(companyId);
    delete activeScrapes[companyId];
    res.json({ message: 'Scrape erfolgreich', ...result });
  } catch (err) {
    delete activeScrapes[companyId];
    res.status(500).json({ error: 'Scrape fehlgeschlagen', detail: err.message });
  }
});

router.post('/scrape/all', requireAuth, requireAdmin, async (req, res) => {
  try {
    await autoScrapeAll();
    res.json({ message: 'Alle Firmen gescrapt' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/scrape/log', requireAuth, (req, res) => {
  const d = getDb();
  const log = d.prepare('SELECT * FROM scrape_log ORDER BY created_at DESC LIMIT 20').all();
  res.json(log);
});

// ─── STATS / DASHBOARD ─────────────────────────────────────────────────

router.get('/stats', requireAuth, (req, res) => {
  const d = getDb();
  const today = new Date().toISOString().split('T')[0];

  const todayStats = d.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN type = 'in' THEN 1 ELSE 0 END) as annahmen,
      SUM(CASE WHEN type = 'out' THEN 1 ELSE 0 END) as rueckgaben,
      SUM(CASE WHEN status IN ('new', 'pending') THEN 1 ELSE 0 END) as offen,
      SUM(CASE WHEN status = 'checked' THEN 1 ELSE 0 END) as erledigt,
      SUM(CASE WHEN status = 'noshow' THEN 1 ELSE 0 END) as noshow,
      SUM(COALESCE(price, 0)) as total_due,
      SUM(CASE WHEN paid = 1 THEN COALESCE(price, 0) ELSE 0 END) as total_paid
    FROM bookings WHERE scraped_date = ?
  `).get(today);

  const lastScrape = d.prepare('SELECT * FROM scrape_log ORDER BY created_at DESC LIMIT 1').get();

  res.json({ today: todayStats, lastScrape, date: today });
});

// ─── SETTINGS (admin) ───────────────────────────────────────────────────

router.get('/settings', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const settings = d.prepare('SELECT * FROM settings').all();
  const obj = {};
  settings.forEach(s => obj[s.key] = s.value);
  res.json(obj);
});

router.put('/settings', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const upsert = d.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')");
  const tx = d.transaction((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      upsert.run(key, String(value));
    }
  });
  tx(req.body);
  res.json({ message: 'Einstellungen gespeichert' });
});

// ─── HEALTH ─────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'Park King OS', version: '1.0.0', time: new Date().toISOString() });
});

module.exports = router;
