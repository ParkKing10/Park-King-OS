// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — Database Layer (SQLite via better-sqlite3)
// ═══════════════════════════════════════════════════════════════════════════

const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'parkking.db');

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

// ─── Schema ─────────────────────────────────────────────────────────────

function initSchema() {
  const d = getDb();

  d.exec(`
    -- ═══ USERS ═══
    CREATE TABLE IF NOT EXISTS users (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      username    TEXT NOT NULL UNIQUE,
      password    TEXT NOT NULL,
      display_name TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'staff',  -- 'admin' | 'staff'
      active      INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ COMPANIES ═══
    CREATE TABLE IF NOT EXISTS companies (
      id          TEXT PRIMARY KEY,                -- 'parkking', 'psfmsf'
      name        TEXT NOT NULL,
      base_url    TEXT NOT NULL,
      email       TEXT,
      password    TEXT,
      active      INTEGER NOT NULL DEFAULT 1
    );

    -- ═══ BOOKINGS ═══
    CREATE TABLE IF NOT EXISTS bookings (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      external_id     TEXT,                         -- ParkingPro booking code
      uid             TEXT,                         -- ParkingPro data-uid
      company_id      TEXT NOT NULL,
      type            TEXT NOT NULL DEFAULT 'in',   -- 'in' (Annahme) | 'out' (Rückgabe)
      status          TEXT NOT NULL DEFAULT 'new',  -- 'new' | 'pending' | 'checked' | 'noshow' | 'due'
      
      -- Customer
      name            TEXT,
      phone           TEXT,
      email           TEXT,
      pax             INTEGER DEFAULT 1,
      
      -- Vehicle
      plate           TEXT,
      car             TEXT,
      key_code        TEXT,
      key_handed_in   INTEGER DEFAULT 0,
      km_in           INTEGER,
      km_out          INTEGER,
      
      -- Dates
      date_in         TEXT,                         -- Parkdatum
      time_in         TEXT,
      date_out        TEXT,                         -- Rückgabedatum
      time_out        TEXT,
      checked_in_at   TEXT,
      checked_out_at  TEXT,
      
      -- Flight
      flight_code     TEXT,
      flight_sched    TEXT,
      flight_live     TEXT,
      
      -- Booking info
      provider        TEXT DEFAULT 'Park King',
      days            INTEGER,
      price           REAL DEFAULT 0,
      paid            INTEGER DEFAULT 0,
      paid_method     TEXT,
      paid_at         TEXT,
      
      -- Extras
      wash            TEXT,                         -- null | 'innen' | 'aussen' | 'innen_aussen'
      wash_done       INTEGER DEFAULT 0,
      comment         TEXT,
      phone_contacted INTEGER DEFAULT 0,
      
      -- Shuttle
      shuttle_driver  TEXT,
      shuttle_status  TEXT,
      
      -- Meta
      scraped_date    TEXT,                         -- which day this was scraped for
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
      created_by      INTEGER REFERENCES users(id),
      
      UNIQUE(external_id, company_id, scraped_date)
    );

    -- ═══ BOOKING LOG / PROTOKOLL ═══
    CREATE TABLE IF NOT EXISTS booking_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id  INTEGER NOT NULL REFERENCES bookings(id),
      action      TEXT NOT NULL,                   -- 'created' | 'checked_in' | 'checked_out' | 'paid' | 'edited' | 'noshow' | 'key_in' | 'key_out' | 'phone_called' | 'label_printed'
      details     TEXT,                            -- JSON details
      user_id     INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ LABELS (print log) ═══
    CREATE TABLE IF NOT EXISTS labels (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      booking_id  INTEGER REFERENCES bookings(id),
      plate       TEXT,
      name        TEXT,
      status      TEXT DEFAULT 'queued',           -- 'queued' | 'printing' | 'done' | 'error'
      printed_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ SCRAPE LOG ═══
    CREATE TABLE IF NOT EXISTS scrape_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id  TEXT NOT NULL,
      date        TEXT NOT NULL,
      bookings_found INTEGER DEFAULT 0,
      bookings_new   INTEGER DEFAULT 0,
      bookings_updated INTEGER DEFAULT 0,
      duration_ms INTEGER,
      error       TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ SETTINGS ═══
    CREATE TABLE IF NOT EXISTS settings (
      key         TEXT PRIMARY KEY,
      value       TEXT,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ TASKS (daily recurring task templates) ═══
    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      description TEXT,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      active      INTEGER NOT NULL DEFAULT 1,
      created_by  INTEGER REFERENCES users(id),
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- ═══ TASK COMPLETIONS (daily tracking) ═══
    CREATE TABLE IF NOT EXISTS task_completions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id     INTEGER NOT NULL REFERENCES tasks(id),
      date        TEXT NOT NULL,                    -- YYYY-MM-DD
      completed   INTEGER NOT NULL DEFAULT 1,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      completed_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(task_id, date)
    );

    -- ═══ INDEXES ═══
    CREATE INDEX IF NOT EXISTS idx_bookings_company ON bookings(company_id);
    CREATE INDEX IF NOT EXISTS idx_bookings_date ON bookings(scraped_date);
    CREATE INDEX IF NOT EXISTS idx_bookings_type ON bookings(type);
    CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
    CREATE INDEX IF NOT EXISTS idx_bookings_plate ON bookings(plate);
    CREATE INDEX IF NOT EXISTS idx_bookings_external ON bookings(external_id);
    CREATE INDEX IF NOT EXISTS idx_log_booking ON booking_log(booking_id);
  `);

  console.log('[DB] Schema initialized');
}

// ─── Seed defaults ──────────────────────────────────────────────────────

function seedDefaults() {
  const d = getDb();

  // Default admin user (password: admin123 — change in production!)
  const existingAdmin = d.prepare('SELECT id FROM users WHERE role = ?').get('admin');
  if (!existingAdmin) {
    const hash = bcrypt.hashSync('Berlin123!', 10);
    d.prepare('INSERT INTO users (username, password, display_name, role) VALUES (?, ?, ?, ?)')
      .run('admin', hash, 'Administrator', 'admin');
    console.log('[DB] Default admin created (admin / Berlin123!)');
  }

  // Default companies from env vars
  const upsertCompany = d.prepare(`
    INSERT INTO companies (id, name, base_url, email, password)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      base_url = excluded.base_url,
      email = COALESCE(excluded.email, companies.email),
      password = COALESCE(excluded.password, companies.password)
  `);

  upsertCompany.run(
    'parkking',
    'Park King',
    process.env.PK_URL || 'https://parkdirect24.parkingpro.de',
    process.env.PK_EMAIL || null,
    process.env.PK_PASSWORD || null
  );

  upsertCompany.run(
    'psfmsf',
    'PSF/MSF',
    process.env.PSF_URL || 'https://parkshuttlefly.parkingpro.de',
    process.env.PSF_EMAIL || null,
    process.env.PSF_PASSWORD || null
  );

  console.log('[DB] Companies seeded');
}

// ─── Booking helpers ────────────────────────────────────────────────────

function upsertBookingFromScrape(booking, companyId, scrapedDate) {
  const d = getDb();

  // Check if booking already exists for this date
  const existing = d.prepare(
    'SELECT id, status, paid, key_handed_in, phone_contacted, wash_done, comment, shuttle_driver FROM bookings WHERE external_id = ? AND company_id = ? AND scraped_date = ?'
  ).get(booking.code || booking.uid, companyId, scrapedDate);

  if (existing) {
    // Update scraped fields but preserve user-edited fields
    d.prepare(`
      UPDATE bookings SET
        name = COALESCE(?, name),
        plate = COALESCE(?, plate),
        car = COALESCE(?, car),
        phone = COALESCE(?, phone),
        time_in = COALESCE(?, time_in),
        time_out = COALESCE(?, time_out),
        date_in = COALESCE(?, date_in),
        date_out = COALESCE(?, date_out),
        flight_code = COALESCE(?, flight_code),
        pax = COALESCE(?, pax),
        days = COALESCE(?, days),
        provider = COALESCE(?, provider),
        type = COALESCE(?, type),
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      booking.name, booking.kennzeichen, booking.fahrzeug, booking.telefon,
      booking.type === 'checkout' ? null : booking.zeit,
      booking.type === 'checkout' ? booking.zeit : booking.rueckgabeZeit,
      booking.parkdatum, booking.rueckgabeDatum,
      booking.flug, booking.personen ? parseInt(booking.personen) : null,
      booking.tage ? parseInt(booking.tage) : null, null,
      booking.type === 'checkin' ? 'in' : booking.type === 'checkout' ? 'out' : null,
      existing.id
    );
    return { id: existing.id, action: 'updated' };
  }

  // Insert new booking
  const isCheckout = booking.type === 'checkout';
  const result = d.prepare(`
    INSERT INTO bookings (
      external_id, uid, company_id, type, status,
      name, phone, pax, plate, car,
      date_in, time_in, date_out, time_out,
      flight_code, days, provider, scraped_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    booking.code || booking.uid, booking.uid, companyId,
    isCheckout ? 'out' : 'in',
    'new',
    booking.name, booking.telefon,
    booking.personen ? parseInt(booking.personen) : 1,
    booking.kennzeichen, booking.fahrzeug,
    booking.parkdatum, isCheckout ? null : booking.zeit,
    booking.rueckgabeDatum || booking.rueckgabe, isCheckout ? booking.zeit : booking.rueckgabeZeit,
    booking.flug, booking.tage ? parseInt(booking.tage) : null,
    'Park King', scrapedDate
  );

  return { id: result.lastInsertRowid, action: 'created' };
}

function addLog(bookingId, action, details, userId) {
  const d = getDb();
  d.prepare('INSERT INTO booking_log (booking_id, action, details, user_id) VALUES (?, ?, ?, ?)')
    .run(bookingId, action, details ? JSON.stringify(details) : null, userId || null);
}

module.exports = { getDb, initSchema, seedDefaults, upsertBookingFromScrape, addLog };
