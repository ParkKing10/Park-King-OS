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

  sql += " ORDER BY COALESCE(time_in, time_out, '99:99') ASC";

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

// ─── TASKS (daily recurring) ────────────────────────────────────────────

// Get all tasks with today's completion status
router.get('/tasks', requireAuth, (req, res) => {
  const d = getDb();
  const date = req.query.date || new Date().toISOString().split('T')[0];
  const tasks = d.prepare(`
    SELECT t.*, 
      tc.user_id as completed_by_id,
      tc.completed_at,
      u.display_name as completed_by_name
    FROM tasks t
    LEFT JOIN task_completions tc ON t.id = tc.task_id AND tc.date = ?
    LEFT JOIN users u ON tc.user_id = u.id
    WHERE t.active = 1
    ORDER BY t.sort_order ASC, t.id ASC
  `).all(date);
  res.json({ tasks, date });
});

// Create task (admin only)
router.post('/tasks', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { title, description } = req.body;
  if (!title) return res.status(400).json({ error: 'Titel erforderlich' });
  const maxOrder = d.prepare('SELECT MAX(sort_order) as m FROM tasks WHERE active = 1').get();
  const result = d.prepare('INSERT INTO tasks (title, description, sort_order, created_by) VALUES (?, ?, ?, ?)')
    .run(title, description || null, (maxOrder?.m || 0) + 1, req.user.id);
  res.json({ id: result.lastInsertRowid, message: 'Aufgabe erstellt' });
});

// Update task (admin only)
router.put('/tasks/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { title, description, sort_order } = req.body;
  const fields = [];
  const values = [];
  if (title !== undefined) { fields.push('title = ?'); values.push(title); }
  if (description !== undefined) { fields.push('description = ?'); values.push(description); }
  if (sort_order !== undefined) { fields.push('sort_order = ?'); values.push(sort_order); }
  if (!fields.length) return res.status(400).json({ error: 'Keine Änderungen' });
  values.push(parseInt(req.params.id));
  d.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ message: 'Aufgabe aktualisiert' });
});

// Delete task (admin only) — soft delete
router.delete('/tasks/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  d.prepare('UPDATE tasks SET active = 0 WHERE id = ?').run(parseInt(req.params.id));
  res.json({ message: 'Aufgabe entfernt' });
});

// Toggle task completion for today
router.post('/tasks/:id/toggle', requireAuth, (req, res) => {
  const d = getDb();
  const taskId = parseInt(req.params.id);
  const date = new Date().toISOString().split('T')[0];
  
  const existing = d.prepare('SELECT id FROM task_completions WHERE task_id = ? AND date = ?').get(taskId, date);
  if (existing) {
    d.prepare('DELETE FROM task_completions WHERE id = ?').run(existing.id);
    res.json({ completed: false, message: 'Aufgabe als offen markiert' });
  } else {
    d.prepare('INSERT INTO task_completions (task_id, date, user_id) VALUES (?, ?, ?)')
      .run(taskId, date, req.user.id);
    res.json({ completed: true, message: 'Aufgabe erledigt ✓' });
  }
});

// Task completion history (admin)
router.get('/tasks/history', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const days = parseInt(req.query.days) || 7;
  const history = d.prepare(`
    SELECT tc.*, t.title as task_title, u.display_name as user_name
    FROM task_completions tc
    JOIN tasks t ON tc.task_id = t.id
    JOIN users u ON tc.user_id = u.id
    ORDER BY tc.completed_at DESC
    LIMIT ?
  `).all(days * 20);
  res.json(history);
});

// ─── SHIFT TEMPLATES ────────────────────────────────────────────────────

router.get('/shift-templates', requireAuth, (req, res) => {
  const d = getDb();
  const templates = d.prepare('SELECT * FROM shift_templates WHERE active = 1 ORDER BY start_time ASC').all();
  res.json(templates);
});

router.post('/shift-templates', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { name, start_time, end_time, color } = req.body;
  if (!name || !start_time || !end_time) return res.status(400).json({ error: 'Name, Start und Ende erforderlich' });
  const result = d.prepare('INSERT INTO shift_templates (name, start_time, end_time, color) VALUES (?, ?, ?, ?)')
    .run(name, start_time, end_time, color || '#CC6CE7');
  res.json({ id: result.lastInsertRowid, message: 'Vorlage erstellt' });
});

router.put('/shift-templates/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { name, start_time, end_time, color } = req.body;
  d.prepare('UPDATE shift_templates SET name = COALESCE(?, name), start_time = COALESCE(?, start_time), end_time = COALESCE(?, end_time), color = COALESCE(?, color) WHERE id = ?')
    .run(name, start_time, end_time, color, parseInt(req.params.id));
  res.json({ message: 'Vorlage aktualisiert' });
});

router.delete('/shift-templates/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  d.prepare('UPDATE shift_templates SET active = 0 WHERE id = ?').run(parseInt(req.params.id));
  res.json({ message: 'Vorlage entfernt' });
});

// ─── SHIFTS (schedule) ─────────────────────────────────────────────────

// Get shifts for a week (date = any day in the week, returns Mon-Sun)
router.get('/shifts', requireAuth, (req, res) => {
  const d = getDb();
  const dateParam = req.query.date || new Date().toISOString().split('T')[0];
  const userId = req.query.user_id;

  // Calculate week boundaries (Mon-Sun)
  const refDate = new Date(dateParam + 'T12:00:00');
  const dayOfWeek = refDate.getDay(); // 0=Sun, 1=Mon...
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(refDate);
  monday.setDate(refDate.getDate() + mondayOffset);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  const weekStart = monday.toISOString().split('T')[0];
  const weekEnd = sunday.toISOString().split('T')[0];

  let sql = `
    SELECT s.*, u.display_name as user_name, u.username,
      st.name as template_name, st.color as template_color
    FROM shifts s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN shift_templates st ON s.template_id = st.id
    WHERE s.date >= ? AND s.date <= ?
  `;
  const params = [weekStart, weekEnd];

  if (userId) {
    sql += ' AND s.user_id = ?';
    params.push(parseInt(userId));
  }

  sql += ' ORDER BY s.date ASC, s.start_time ASC';

  const shifts = d.prepare(sql).all(...params);

  // Calculate hours per user for this week
  const hoursByUser = {};
  for (const s of shifts) {
    if (!hoursByUser[s.user_id]) hoursByUser[s.user_id] = { name: s.user_name, hours: 0, shifts: 0 };
    const hours = calcShiftHours(s.start_time, s.end_time, s.break_min);
    hoursByUser[s.user_id].hours += hours;
    hoursByUser[s.user_id].shifts += 1;
  }

  res.json({ shifts, weekStart, weekEnd, hoursByUser });
});

// Create shift (admin only)
router.post('/shifts', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { user_id, date, template_id, start_time, end_time, break_min, note } = req.body;
  if (!user_id || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'User, Datum, Start und Ende erforderlich' });
  }
  const result = d.prepare(`
    INSERT INTO shifts (user_id, date, template_id, start_time, end_time, break_min, note, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(user_id, date, template_id || null, start_time, end_time, break_min || 0, note || null, req.user.id);
  res.json({ id: result.lastInsertRowid, message: 'Schicht erstellt' });
});

// Update shift (admin only)
router.put('/shifts/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  const { user_id, date, template_id, start_time, end_time, break_min, note } = req.body;
  d.prepare(`
    UPDATE shifts SET
      user_id = COALESCE(?, user_id),
      date = COALESCE(?, date),
      template_id = ?,
      start_time = COALESCE(?, start_time),
      end_time = COALESCE(?, end_time),
      break_min = COALESCE(?, break_min),
      note = ?,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(user_id, date, template_id || null, start_time, end_time, break_min, note || null, parseInt(req.params.id));
  res.json({ message: 'Schicht aktualisiert' });
});

// Delete shift (admin only)
router.delete('/shifts/:id', requireAuth, requireAdmin, (req, res) => {
  const d = getDb();
  d.prepare('DELETE FROM shifts WHERE id = ?').run(parseInt(req.params.id));
  res.json({ message: 'Schicht gelöscht' });
});

// Monthly hours summary
router.get('/shifts/hours', requireAuth, (req, res) => {
  const d = getDb();
  const month = req.query.month || new Date().toISOString().slice(0, 7); // YYYY-MM
  const monthStart = month + '-01';
  const nextMonth = new Date(month + '-01T12:00:00');
  nextMonth.setMonth(nextMonth.getMonth() + 1);
  const monthEnd = nextMonth.toISOString().split('T')[0];

  const shifts = d.prepare(`
    SELECT s.user_id, u.display_name as user_name, s.start_time, s.end_time, s.break_min
    FROM shifts s
    JOIN users u ON s.user_id = u.id
    WHERE s.date >= ? AND s.date < ?
    ORDER BY s.user_id
  `).all(monthStart, monthEnd);

  const summary = {};
  for (const s of shifts) {
    if (!summary[s.user_id]) summary[s.user_id] = { name: s.user_name, totalHours: 0, totalShifts: 0 };
    summary[s.user_id].totalHours += calcShiftHours(s.start_time, s.end_time, s.break_min);
    summary[s.user_id].totalShifts += 1;
  }

  res.json({ month, summary });
});

// Helper: calculate shift hours
function calcShiftHours(startTime, endTime, breakMin) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  let startMinutes = sh * 60 + sm;
  let endMinutes = eh * 60 + em;
  // Handle overnight (e.g. 15:00 - 00:00 or 22:00 - 06:00)
  if (endMinutes <= startMinutes) endMinutes += 24 * 60;
  const totalMinutes = endMinutes - startMinutes - (breakMin || 0);
  return Math.max(0, totalMinutes / 60);
}

// ─── HEALTH ─────────────────────────────────────────────────────────────

router.get('/health', (req, res) => {
  res.json({ status: 'ok', app: 'Park King OS', version: '1.0.0', time: new Date().toISOString() });
});

module.exports = router;
