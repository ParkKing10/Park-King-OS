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

// Year view URLs with correct filter params
const YEAR_VIEW_URLS = {
  parkking: '/#view=reservations.year&filters=JTdCJTIyZGF0ZVJhbmdlRmllbGQlMjIlM0ElMjJhcnJpdmFsRGF0ZSUyMiU3RA%3D%3D',
  psfmsf: '/#view=reservations.year&filters=JTdCJTIyZGF0ZVJhbmdlRmllbGQlMjIlM0ElMjJhcnJpdmFsRGF0ZSUyMiU3RA%3D%3D'
};

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

    // Navigate to year/reservations view with correct filter URL
    const yearPath = YEAR_VIEW_URLS[companyId] || '/#view=reservations.year&filters=JTdCJTIyZGF0ZVJhbmdlRmllbGQlMjIlM0ElMjJhcnJpdmFsRGF0ZSUyMiU3RA%3D%3D';
    console.log(`[YearScraper][${company.name}] Year view: ${yearPath}`);
    await page.goto(company.base_url + yearPath, { waitUntil: 'networkidle2', timeout: 45000 });
    await new Promise(r => setTimeout(r, 8000));

    // Wait for initial data rows
    let retries = 0, rowCount = 0;
    while (retries < 15) {
      rowCount = await page.evaluate(() => document.querySelectorAll('tr[data-uid]').length);
      if (rowCount > 0) break;
      await new Promise(r => setTimeout(r, 3000));
      retries++;
    }

    // Read total count from the page header (e.g. "938 Reservierungen gefunden")
    const totalExpected = await page.evaluate(() => {
      const text = document.body.innerText || '';
      const match = text.match(/(\d+)\s*Reservierungen?\s*gefunden/i);
      return match ? parseInt(match[1]) : 0;
    });
    console.log(`[YearScraper][${company.name}] Initial rows: ${rowCount}, total expected: ${totalExpected}`);

    // ──────────────────────────────────────────────────────────────────
    // Kendo UI uses VIRTUAL SCROLLING: it only renders ~16-20 rows at
    // a time and swaps them as you scroll. We must:
    //   1. Extract currently visible rows
    //   2. Scroll down a bit
    //   3. Extract again (new UIDs = new bookings)
    //   4. Repeat until we've seen all rows
    // We collect into a Map keyed by UID to deduplicate.
    // ──────────────────────────────────────────────────────────────────

    const extractVisibleRows = async () => {
      return await page.evaluate(() => {
        const rows = document.querySelectorAll('tr[data-uid]');
        const results = [];
        for (const row of rows) {
          const getField = (field) => {
            const cell = row.querySelector(`td[data-field="${field}"]`);
            return cell ? (cell.textContent || '').trim() : '';
          };

          const name = getField('fullName()') || getField('customer.fullName()') || '';
          const cleanName = name.replace(/^ParkKing:\s*/i, '').trim();
          const kennzeichen = getField('car.licensePlate') || getField('licensePlate') || '';
          
          const arrivalRaw = getField('arrivalDate') || getField('dayView.arrivalDate') || '';
          const departureRaw = getField('departureDate') || getField('dayView.departureDate') || '';
          
          let parkdatum = arrivalRaw, zeit = '';
          const arrParts = arrivalRaw.match(/^(.+?)\s+(\d{1,2}:\d{2})/);
          if (arrParts) { parkdatum = arrParts[1]; zeit = arrParts[2]; }
          
          let rueckgabe = departureRaw, rueckgabeZeit = '';
          const depParts = departureRaw.match(/^(.+?)\s+(\d{1,2}:\d{2})/);
          if (depParts) { rueckgabe = depParts[1]; rueckgabeZeit = depParts[2]; }

          const personen = getField('numberOfPersons') || '';
          const tage = getField('parkedDaysCount()') || getField('numberOfDays') || '';
          const flug = getField('flightNumber') || getField('dayView.flightNumber') || getField('arrivalFlightNumber') || '';
          const flugRueck = getField('departureFlightNumber') || '';
          const telefon = getField('contactInformation.phone') || getField('phone') || '';
          const fahrzeug = getField('car.description') || getField('carDescription') || '';
          const code = getField('reservationCode') || '';
          const uid = row.getAttribute('data-uid');

          if (uid && (kennzeichen || cleanName)) {
            results.push({
              name: cleanName, kennzeichen, parkdatum, rueckgabe,
              zeit, rueckgabeZeit,
              personen, tage, flug, flugRueck, telefon, fahrzeug, code, uid,
              type: 'checkin'
            });
          }
        }
        return results;
      });
    };

    // Collect all bookings by scrolling through the virtual grid
    const allCollected = new Map();

    // Extract initial visible rows
    const initial = await extractVisibleRows();
    for (const b of initial) allCollected.set(b.uid, b);
    console.log(`[YearScraper][${company.name}] Collected so far: ${allCollected.size}`);

    // Debug: find the actual scroll container
    const scrollDebug = await page.evaluate(() => {
      const selectors = [
        '.k-grid-content',
        '.k-virtual-scrollable-wrap', 
        '.k-grid-content-locked',
        '.k-grid .k-grid-content',
        '[data-role="grid"] .k-grid-content',
        '.k-grid-content table',
        '.k-scrollbar',
        '.entity-list .k-grid-content',
        '.k-grid-content > .k-virtual-scrollable-wrap',
      ];
      const info = [];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el) {
          info.push({
            selector: sel,
            scrollHeight: el.scrollHeight,
            scrollTop: el.scrollTop,
            clientHeight: el.clientHeight,
            overflow: getComputedStyle(el).overflow + ' / ' + getComputedStyle(el).overflowY,
            tag: el.tagName,
            classes: el.className.substring(0, 100)
          });
        }
      }
      // Also check all elements with overflow auto/scroll
      const allScrollable = [];
      document.querySelectorAll('*').forEach(el => {
        const style = getComputedStyle(el);
        if ((style.overflow === 'auto' || style.overflow === 'scroll' || 
             style.overflowY === 'auto' || style.overflowY === 'scroll') &&
            el.scrollHeight > el.clientHeight + 50) {
          allScrollable.push({
            tag: el.tagName,
            classes: el.className.substring(0, 80),
            scrollHeight: el.scrollHeight,
            clientHeight: el.clientHeight,
            scrollTop: el.scrollTop
          });
        }
      });
      return { known: info, scrollable: allScrollable.slice(0, 10) };
    });
    console.log(`[YearScraper][${company.name}] Scroll containers:`, JSON.stringify(scrollDebug, null, 2));

    // Scroll incrementally through the grid
    let stableRounds = 0;
    let lastCollectedSize = allCollected.size;

    for (let scrollAttempt = 0; scrollAttempt < 500; scrollAttempt++) {
      // Scroll: find the scrollable container and scroll it
      const scrollResult = await page.evaluate((attempt) => {
        // Try all possible scrollable containers
        const candidates = [];
        document.querySelectorAll('*').forEach(el => {
          const style = getComputedStyle(el);
          if ((style.overflow === 'auto' || style.overflow === 'scroll' || 
               style.overflowY === 'auto' || style.overflowY === 'scroll') &&
              el.scrollHeight > el.clientHeight + 50) {
            candidates.push(el);
          }
        });

        // Also try known Kendo selectors
        const kendo = document.querySelector('.k-grid-content') 
          || document.querySelector('.k-virtual-scrollable-wrap');
        if (kendo && !candidates.includes(kendo)) candidates.unshift(kendo);

        let scrolled = false;
        for (const container of candidates) {
          const before = container.scrollTop;
          const maxScroll = container.scrollHeight - container.clientHeight;
          if (before < maxScroll - 5) {
            container.scrollTop = Math.min(before + 400, maxScroll);
            scrolled = container.scrollTop > before;
            if (scrolled) {
              return { 
                scrolled: true, 
                scrollTop: container.scrollTop, 
                maxScroll,
                pct: Math.round((container.scrollTop / maxScroll) * 100),
                tag: container.tagName,
                cls: container.className.substring(0, 60)
              };
            }
          }
        }
        return { scrolled: false, candidateCount: candidates.length };
      }, scrollAttempt);

      // Wait for Kendo to render new rows
      await new Promise(r => setTimeout(r, 500));

      // Extract visible rows and merge
      const visible = await extractVisibleRows();
      for (const b of visible) allCollected.set(b.uid, b);

      // Log progress every 10 scrolls
      if ((scrollAttempt + 1) % 10 === 0 || !scrollResult.scrolled) {
        console.log(`[YearScraper][${company.name}] Scroll ${scrollAttempt + 1}: collected ${allCollected.size}${totalExpected ? '/' + totalExpected : ''} | scroll: ${JSON.stringify(scrollResult)}`);
      }

      // If we can't scroll anymore, we're done
      if (!scrollResult.scrolled) {
        console.log(`[YearScraper][${company.name}] Can't scroll further, stopping.`);
        break;
      }

      // Check if we've collected all expected
      if (totalExpected > 0 && allCollected.size >= totalExpected) {
        console.log(`[YearScraper][${company.name}] Reached expected total: ${allCollected.size}`);
        break;
      }

      if (allCollected.size === lastCollectedSize) {
        stableRounds++;
        if (stableRounds >= 50) {
          console.log(`[YearScraper][${company.name}] No new rows for 50 scrolls, stopping. Last scroll: ${JSON.stringify(scrollResult)}`);
          break;
        }
      } else {
        stableRounds = 0;
      }
      lastCollectedSize = allCollected.size;
    }

    const rawBookings = Array.from(allCollected.values());
    console.log(`[YearScraper][${company.name}] Total collected: ${rawBookings.length}`);

    // Helper: parse date string like "01.03.2026" or "2026-03-01" to "YYYY-MM-DD"
    function parseDate(str) {
      if (!str) return null;
      const parts = str.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{2,4})/);
      if (parts) {
        const day = parts[1].padStart(2, '0');
        const month = parts[2].padStart(2, '0');
        const year = parts[3].length === 2 ? '20' + parts[3] : parts[3];
        return `${year}-${month}-${day}`;
      }
      if (str.match(/^\d{4}-\d{2}-\d{2}/)) return str.substring(0, 10);
      return null;
    }

    // Upsert into database — create TWO entries per booking:
    //   1. type='in' (Annahme) on the parkdatum (arrival date)
    //   2. type='out' (Rückgabe) on the rueckgabedatum (departure date)
    let created = 0, updated = 0;
    for (const b of rawBookings) {
      const arrivalDate = parseDate(b.parkdatum);
      const departureDate = parseDate(b.rueckgabe);

      // 1) Annahme entry on arrival date
      if (arrivalDate) {
        const inData = {
          ...b,
          rueckgabeDatum: departureDate || b.rueckgabe,
          rueckgabeZeit: b.rueckgabeZeit || null,
          type: 'checkin',
        };
        const r1 = upsertBookingFromScrape(inData, companyId, arrivalDate);
        if (r1.action === 'created') created++; else updated++;
      }

      // 2) Rückgabe entry on departure date
      if (departureDate && departureDate !== arrivalDate) {
        const outData = {
          ...b,
          // For the checkout row, swap the time: zeit = rueckgabeZeit
          zeit: b.rueckgabeZeit || null,
          rueckgabeDatum: departureDate,
          rueckgabeZeit: b.rueckgabeZeit || null,
          type: 'checkout',
        };
        const r2 = upsertBookingFromScrape(outData, companyId, departureDate);
        if (r2.action === 'created') created++; else updated++;
      }
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
