// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — ParkingPro Scraper
//  Reused and cleaned up from the Label Print Tool scraper
// ═══════════════════════════════════════════════════════════════════════════

const puppeteer = require('puppeteer');
const { getDb, upsertBookingFromScrape, addLog } = require('./db');
const fs = require('fs');
const { execSync } = require('child_process');

let browserInstance = null;

// ─── Find Chrome ────────────────────────────────────────────────────────

async function findChromePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  try {
    const result = execSync('find /opt/render -name "chrome" -type f 2>/dev/null || find /home -name "chrome" -type f 2>/dev/null || true', { encoding: 'utf8' });
    const paths = result.trim().split('\n').filter(p => p && !p.includes('crashpad'));
    if (paths.length > 0) return paths[0];
  } catch { /* ignore */ }

  const systemPaths = ['/usr/bin/chromium-browser', '/usr/bin/chromium', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable'];
  for (const p of systemPaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

async function getBrowser() {
  if (!browserInstance || !browserInstance.isConnected()) {
    const executablePath = await findChromePath();
    console.log('[Scraper] Chrome at:', executablePath || 'puppeteer default');
    browserInstance = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
      ...(executablePath ? { executablePath } : {})
    });
  }
  return browserInstance;
}

// ─── Scrape bookings from ParkingPro ────────────────────────────────────

async function scrapeCompany(companyId) {
  const d = getDb();
  const company = d.prepare('SELECT * FROM companies WHERE id = ? AND active = 1').get(companyId);
  if (!company) throw new Error('Firma nicht gefunden: ' + companyId);
  if (!company.email || !company.password) throw new Error('Login-Daten fehlen für ' + company.name);

  const startTime = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1400, height: 900 });
    console.log(`[Scraper][${company.name}] Navigating...`);
    await page.goto(company.base_url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2000));

    // Login
    console.log(`[Scraper][${company.name}] Login...`);
    await page.goto(company.base_url + '/authentication/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const hasPasswordField = await page.evaluate(() => !!document.querySelector('input[type="password"]'));
    if (hasPasswordField) {
      await page.evaluate((email) => {
        const selectors = ['input[type="email"]','input[name="email"]','input[name="username"]','#email','#username','input[type="text"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.type !== 'password') {
            el.value = email;
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return;
          }
        }
      }, company.email);

      await page.evaluate((pass) => {
        const el = document.querySelector('input[type="password"]');
        if (el) { el.value = pass; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
      }, company.password);

      await new Promise(r => setTimeout(r, 500));
      await page.evaluate(() => {
        const btns = ['button[type="submit"]','input[type="submit"]','.btn-primary','button.login','.btn-login'];
        for (const sel of btns) { const el = document.querySelector(sel); if (el) { el.click(); return; } }
        const form = document.querySelector('form');
        if (form) { const btn = form.querySelector('button, input[type="submit"]'); if (btn) btn.click(); }
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
    }

    // Day view
    console.log(`[Scraper][${company.name}] Day view...`);
    await page.goto(company.base_url + '/#view=day-all', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 5000));

    // Wait for data rows
    let retries = 0, rowCount = 0;
    while (retries < 10) {
      rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-uid]').length);
      if (rowCount > 0) break;
      await new Promise(r => setTimeout(r, 2000));
      retries++;
    }

    // Extract bookings
    console.log(`[Scraper][${company.name}] Extracting ${rowCount} rows...`);
    const rawBookings = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[data-uid]');
      const results = [];
      for (const row of rows) {
        const getField = (field) => {
          const cell = row.querySelector(`td[data-field="${field}"]`);
          return cell ? (cell.textContent || '').trim() : '';
        };
        const name = getField('fullName()').replace(/^ParkKing:\s*/i, '').trim();
        const kennzeichen = getField('car.licensePlate');
        const zeit = getField('dayView.time');
        const parkdatum = getField('dayView.arrivalDate');
        const rueckgabe = getField('dayView.departureDate');
        const personen = getField('numberOfPersons');
        const tage = getField('parkedDaysCount()');
        const flug = getField('dayView.flightNumber');
        const telefon = getField('contactInformation.phone');
        const fahrzeug = getField('car.description');
        const code = getField('reservationCode');
        const uid = row.getAttribute('data-uid');
        const classList = row.className || '';
        let type = 'unknown';
        if (classList.includes('bg-success')) type = 'checkin';
        if (classList.includes('bg-danger')) type = 'checkout';
        if (kennzeichen || name) {
          results.push({ name, kennzeichen, zeit, parkdatum, rueckgabe, personen, tage, flug, telefon, fahrzeug, code, type, uid });
        }
      }
      return results;
    });

    // Get departure times for check-ins
    const checkins = rawBookings.filter(b => b.type === 'checkin');
    console.log(`[Scraper][${company.name}] Getting departure times for ${checkins.length} check-ins...`);

    for (let i = 0; i < checkins.length; i++) {
      try {
        const clicked = await page.evaluate((uid) => {
          const row = document.querySelector(`tr[data-uid="${uid}"]`);
          if (row) { row.click(); return true; }
          return false;
        }, checkins[i].uid);
        if (!clicked) continue;

        await page.waitForFunction(() => {
          const el = document.querySelector('span[data-bind*="selectedEntity.departureDate"][data-format="g"]');
          return el && el.textContent.trim().length > 0;
        }, { timeout: 8000 }).catch(() => {});
        await new Promise(r => setTimeout(r, 500));

        const departureFull = await page.evaluate(() => {
          const el = document.querySelector('span[data-bind*="selectedEntity.departureDate"][data-format="g"]');
          return el ? el.textContent.trim() : '';
        });

        if (departureFull) {
          checkins[i].rueckgabeVoll = departureFull;
          const parts = departureFull.split(' ');
          if (parts.length >= 2) {
            checkins[i].rueckgabeDatum = parts[0];
            checkins[i].rueckgabeZeit = parts[1];
          }
        }
      } catch { /* continue */ }
    }

    // Display date
    const displayDate = await page.evaluate(() => {
      const dateEl = document.querySelector('[data-role="datefilter"] .k-input, .entity-list-filter input[type="date"]');
      if (dateEl && dateEl.value) return dateEl.value;
      return new Date().toISOString().split('T')[0];
    });

    const scrapedDate = displayDate || new Date().toISOString().split('T')[0];

    // Merge check-in departure data back
    const allBookings = rawBookings.map(b => {
      const ci = checkins.find(c => c.uid === b.uid);
      return ci || b;
    });

    // Upsert into database
    let created = 0, updated = 0;
    for (const b of allBookings) {
      const result = upsertBookingFromScrape(b, companyId, scrapedDate);
      if (result.action === 'created') created++;
      else updated++;
    }

    const duration = Date.now() - startTime;

    // Log the scrape
    d.prepare('INSERT INTO scrape_log (company_id, date, bookings_found, bookings_new, bookings_updated, duration_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(companyId, scrapedDate, allBookings.length, created, updated, duration);

    console.log(`[Scraper][${company.name}] Done! ${allBookings.length} found, ${created} new, ${updated} updated (${duration}ms)`);

    return {
      company: company.name,
      date: scrapedDate,
      total: allBookings.length,
      created,
      updated,
      duration
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    d.prepare('INSERT INTO scrape_log (company_id, date, error, duration_ms) VALUES (?, ?, ?, ?)')
      .run(companyId, new Date().toISOString().split('T')[0], error.message, duration);
    throw error;
  } finally {
    await page.close();
  }
}

// ─── Scrape YEAR VIEW (one-time full import) ────────────────────────────

async function scrapeYearView(companyId) {
  const d = getDb();
  const company = d.prepare('SELECT * FROM companies WHERE id = ? AND active = 1').get(companyId);
  if (!company) throw new Error('Firma nicht gefunden: ' + companyId);
  if (!company.email || !company.password) throw new Error('Login-Daten fehlen für ' + company.name);

  const startTime = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();

  try {
    await page.setViewport({ width: 1400, height: 900 });
    console.log(`[YearScraper][${company.name}] Navigating...`);
    await page.goto(company.base_url, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 2000));

    // Login
    console.log(`[YearScraper][${company.name}] Login...`);
    await page.goto(company.base_url + '/authentication/login', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 3000));

    const hasPasswordField = await page.evaluate(() => !!document.querySelector('input[type="password"]'));
    if (hasPasswordField) {
      await page.evaluate((email) => {
        const selectors = ['input[type="email"]','input[name="email"]','input[name="username"]','#email','#username','input[type="text"]'];
        for (const sel of selectors) {
          const el = document.querySelector(sel);
          if (el && el.type !== 'password') {
            el.value = email;
            el.dispatchEvent(new Event('input', {bubbles:true}));
            el.dispatchEvent(new Event('change', {bubbles:true}));
            return;
          }
        }
      }, company.email);

      await page.evaluate((pass) => {
        const el = document.querySelector('input[type="password"]');
        if (el) { el.value = pass; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); }
      }, company.password);

      await new Promise(r => setTimeout(r, 500));
      await page.evaluate(() => {
        const btns = ['button[type="submit"]','input[type="submit"]','.btn-primary','button.login','.btn-login'];
        for (const sel of btns) { const el = document.querySelector(sel); if (el) { el.click(); return; } }
        const form = document.querySelector('form');
        if (form) { const btn = form.querySelector('button, input[type="submit"]'); if (btn) btn.click(); }
      });
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));
    }

    // Navigate to year/reservations view
    console.log(`[YearScraper][${company.name}] Year view...`);
    await page.goto(company.base_url + '/#view=reservations.year', { waitUntil: 'networkidle2', timeout: 30000 });
    await new Promise(r => setTimeout(r, 8000));

    // Wait for data rows to load
    let retries = 0, rowCount = 0;
    while (retries < 15) {
      rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-uid]').length);
      if (rowCount > 0) break;
      await new Promise(r => setTimeout(r, 3000));
      retries++;
    }

    console.log(`[YearScraper][${company.name}] Found ${rowCount} rows, extracting...`);

    // Extract ALL bookings from year view
    const rawBookings = await page.evaluate(() => {
      const rows = document.querySelectorAll('tr[data-uid]');
      const results = [];
      for (const row of rows) {
        const getField = (field) => {
          const cell = row.querySelector(`td[data-field="${field}"]`);
          return cell ? (cell.textContent || '').trim() : '';
        };
        const name = getField('fullName()').replace(/^ParkKing:\s*/i, '').trim();
        const kennzeichen = getField('car.licensePlate');
        const parkdatum = getField('arrivalDate') || getField('dayView.arrivalDate');
        const rueckgabe = getField('departureDate') || getField('dayView.departureDate');
        const personen = getField('numberOfPersons');
        const tage = getField('parkedDaysCount()');
        const flug = getField('flightNumber') || getField('dayView.flightNumber');
        const telefon = getField('contactInformation.phone');
        const fahrzeug = getField('car.description');
        const code = getField('reservationCode');
        const uid = row.getAttribute('data-uid');
        const status = getField('status') || getField('reservationStatus');

        if (kennzeichen || name) {
          results.push({ name, kennzeichen, parkdatum, rueckgabe, personen, tage, flug, telefon, fahrzeug, code, uid, status });
        }
      }
      return results;
    });

    console.log(`[YearScraper][${company.name}] Extracted ${rawBookings.length} bookings`);

    // Upsert into database — use date_in (parkdatum) as scraped_date
    let created = 0, updated = 0;
    for (const b of rawBookings) {
      // Parse the parkdatum to get a proper date for scraped_date
      let scrapedDate = null;
      if (b.parkdatum) {
        // Try various date formats: DD.MM.YYYY, DD-MM-YYYY, YYYY-MM-DD, DD/MM/YYYY
        const parts = b.parkdatum.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
        if (parts) {
          const day = parts[1].padStart(2, '0');
          const month = parts[2].padStart(2, '0');
          const year = parts[3].length === 2 ? '20' + parts[3] : parts[3];
          scrapedDate = `${year}-${month}-${day}`;
        } else if (b.parkdatum.match(/^\d{4}-\d{2}-\d{2}$/)) {
          scrapedDate = b.parkdatum;
        }
      }
      if (!scrapedDate) scrapedDate = new Date().toISOString().split('T')[0];

      const bookingData = {
        ...b,
        zeit: null,
        type: 'checkin',
      };

      const result = upsertBookingFromScrape(bookingData, companyId, scrapedDate);
      if (result.action === 'created') created++;
      else updated++;
    }

    const duration = Date.now() - startTime;

    // Log the scrape
    d.prepare('INSERT INTO scrape_log (company_id, date, bookings_found, bookings_new, bookings_updated, duration_ms) VALUES (?, ?, ?, ?, ?, ?)')
      .run(companyId, 'YEAR-IMPORT', rawBookings.length, created, updated, duration);

    console.log(`[YearScraper][${company.name}] Done! ${rawBookings.length} found, ${created} new, ${updated} updated (${duration}ms)`);

    return {
      company: company.name,
      date: 'YEAR-IMPORT',
      total: rawBookings.length,
      created,
      updated,
      duration
    };

  } catch (error) {
    const duration = Date.now() - startTime;
    d.prepare('INSERT INTO scrape_log (company_id, date, error, duration_ms) VALUES (?, ?, ?, ?)')
      .run(companyId, 'YEAR-IMPORT', error.message, duration);
    throw error;
  } finally {
    await page.close();
  }
}

// ─── Auto-scrape all companies ──────────────────────────────────────────

async function autoScrapeAll() {
  const d = getDb();
  const companies = d.prepare('SELECT id, name FROM companies WHERE active = 1').all();
  for (const co of companies) {
    try {
      console.log(`[AutoScrape] ${co.name}...`);
      await scrapeCompany(co.id);
    } catch (err) {
      console.error(`[AutoScrape] ${co.name} error:`, err.message);
    }
  }
}

// ─── Cleanup ────────────────────────────────────────────────────────────

async function closeBrowser() {
  if (browserInstance) {
    await browserInstance.close();
    browserInstance = null;
  }
}

module.exports = { scrapeCompany, scrapeYearView, autoScrapeAll, closeBrowser };
