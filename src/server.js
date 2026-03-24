// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — Server
//  Parkplatz-Management System mit ParkingPro Integration
// ═══════════════════════════════════════════════════════════════════════════

require('dotenv').config();
const express = require('express');
const path = require('path');
const { initSchema, seedDefaults } = require('./db');
const { autoScrapeAll, closeBrowser } = require('./scraper');
const routes = require('./routes');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ─── API Routes ─────────────────────────────────────────────────────────
app.use('/api', routes);

// ─── SPA Fallback ───────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ─── Initialize DB ──────────────────────────────────────────────────────
initSchema();
seedDefaults();

// ─── Start Server ───────────────────────────────────────────────────────
const AUTO_SCRAPE_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

app.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════════╗');
  console.log('  ║       🅿️  Park King OS v1.0.0        ║');
  console.log('  ║    Parkplatz-Management System       ║');
  console.log('  ╚══════════════════════════════════════╝');
  console.log(`  → Port: ${PORT}`);
  console.log(`  → DB:   ${process.env.DB_PATH || 'data/parkking.db'}`);
  console.log(`  → Auto-Scrape: alle ${AUTO_SCRAPE_INTERVAL_MS / 1000 / 60} Minuten`);
  console.log('');

  // Auto-scrape on startup (15 sec delay for Chrome init)
  setTimeout(() => {
    console.log('[AutoScrape] Initial scrape starting...');
    autoScrapeAll();
  }, 15000);

  // Auto-scrape interval
  setInterval(() => {
    console.log('[AutoScrape] Scheduled refresh...');
    autoScrapeAll();
  }, AUTO_SCRAPE_INTERVAL_MS);
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────
process.on('SIGTERM', async () => {
  console.log('[Server] Shutting down...');
  await closeBrowser();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('[Server] Interrupted...');
  await closeBrowser();
  process.exit(0);
});
