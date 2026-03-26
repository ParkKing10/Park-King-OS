// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — Offline Store (IndexedDB + Sync Queue)
//  Manages local data cache and offline action queue
// ═══════════════════════════════════════════════════════════════════════════

const OfflineStore = (() => {
  const DB_NAME = 'parkking-offline';
  const DB_VERSION = 2;
  let db = null;

  // ─── Open IndexedDB ───────────────────────────────────────────────────
  function openDB() {
    return new Promise((resolve, reject) => {
      if (db) return resolve(db);
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        // Bookings cache (keyed by company+date)
        if (!d.objectStoreNames.contains('bookings')) {
          d.createObjectStore('bookings', { keyPath: 'id' });
        }
        // Booking responses cache (keyed by company_date)
        if (!d.objectStoreNames.contains('bookingCache')) {
          d.createObjectStore('bookingCache', { keyPath: 'cacheKey' });
        }
        // Tasks cache
        if (!d.objectStoreNames.contains('tasks')) {
          d.createObjectStore('tasks', { keyPath: 'cacheKey' });
        }
        // Offline action queue
        if (!d.objectStoreNames.contains('actionQueue')) {
          const aq = d.createObjectStore('actionQueue', { keyPath: 'id', autoIncrement: true });
          aq.createIndex('timestamp', 'timestamp');
        }
        // Labels generated offline
        if (!d.objectStoreNames.contains('offlineLabels')) {
          d.createObjectStore('offlineLabels', { keyPath: 'id', autoIncrement: true });
        }
        // General cache for misc API responses
        if (!d.objectStoreNames.contains('apiCache')) {
          d.createObjectStore('apiCache', { keyPath: 'url' });
        }
        // Sync metadata
        if (!d.objectStoreNames.contains('syncMeta')) {
          d.createObjectStore('syncMeta', { keyPath: 'key' });
        }
      };
      req.onsuccess = (e) => { db = e.target.result; resolve(db); };
      req.onerror = (e) => reject(e.target.error);
    });
  }

  // ─── Generic helpers ──────────────────────────────────────────────────
  async function put(storeName, data) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).put(data);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function get(storeName, key) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function getAll(storeName) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readonly');
      const req = tx.objectStore(storeName).getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = (e) => reject(e.target.error);
    });
  }

  async function del(storeName, key) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  async function clear(storeName) {
    const d = await openDB();
    return new Promise((resolve, reject) => {
      const tx = d.transaction(storeName, 'readwrite');
      tx.objectStore(storeName).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);
    });
  }

  // ─── Bookings cache ───────────────────────────────────────────────────
  async function cacheBookings(company, date, response) {
    const cacheKey = `${company}_${date}`;
    await put('bookingCache', {
      cacheKey,
      company,
      date,
      bookings: response.bookings,
      stats: response.stats,
      cachedAt: Date.now()
    });
  }

  async function getCachedBookings(company, date) {
    const cacheKey = `${company}_${date}`;
    return get('bookingCache', cacheKey);
  }

  // ─── Tasks cache ──────────────────────────────────────────────────────
  async function cacheTasks(date, tasks) {
    await put('tasks', { cacheKey: `tasks_${date}`, date, tasks, cachedAt: Date.now() });
  }

  async function getCachedTasks(date) {
    return get('tasks', `tasks_${date}`);
  }

  // ─── API response cache (generic) ─────────────────────────────────────
  async function cacheApiResponse(url, data) {
    await put('apiCache', { url, data, cachedAt: Date.now() });
  }

  async function getCachedApiResponse(url) {
    return get('apiCache', url);
  }

  // ─── Offline action queue ─────────────────────────────────────────────
  async function queueAction(action) {
    // action: { method, url, body, headers, timestamp, description }
    await put('actionQueue', {
      ...action,
      id: Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      synced: false
    });
    await updateSyncMeta();
  }

  async function getQueuedActions() {
    return getAll('actionQueue');
  }

  async function removeQueuedAction(id) {
    await del('actionQueue', id);
    await updateSyncMeta();
  }

  async function clearQueue() {
    await clear('actionQueue');
    await updateSyncMeta();
  }

  async function getQueueLength() {
    const actions = await getAll('actionQueue');
    return actions.length;
  }

  // ─── Apply offline action to local cache ──────────────────────────────
  async function applyOfflineAction(action) {
    const url = action.url;
    const body = typeof action.body === 'string' ? JSON.parse(action.body) : action.body;

    // Check-in: update local booking status
    const checkinMatch = url.match(/\/api\/bookings\/(\d+)\/checkin/);
    if (checkinMatch) {
      await updateCachedBooking(parseInt(checkinMatch[1]), {
        status: 'checked',
        checked_in_at: new Date().toISOString(),
        km_in: body.km || null
      });
      return;
    }

    // Check-out
    const checkoutMatch = url.match(/\/api\/bookings\/(\d+)\/checkout/);
    if (checkoutMatch) {
      await updateCachedBooking(parseInt(checkoutMatch[1]), {
        status: 'checked',
        checked_out_at: new Date().toISOString(),
        km_out: body.km || null
      });
      return;
    }

    // Pay
    const payMatch = url.match(/\/api\/bookings\/(\d+)\/pay/);
    if (payMatch) {
      await updateCachedBooking(parseInt(payMatch[1]), {
        paid: 1,
        paid_method: body.method || 'Cash',
        paid_at: new Date().toISOString()
      });
      return;
    }

    // No-show
    const noshowMatch = url.match(/\/api\/bookings\/(\d+)\/noshow/);
    if (noshowMatch) {
      await updateCachedBooking(parseInt(noshowMatch[1]), { status: 'noshow' });
      return;
    }

    // Key
    const keyMatch = url.match(/\/api\/bookings\/(\d+)\/key/);
    if (keyMatch) {
      await updateCachedBooking(parseInt(keyMatch[1]), { key_handed_in: body.handed_in ? 1 : 0 });
      return;
    }

    // Phone
    const phoneMatch = url.match(/\/api\/bookings\/(\d+)\/phone/);
    if (phoneMatch) {
      await updateCachedBooking(parseInt(phoneMatch[1]), { phone_contacted: 1 });
      return;
    }

    // Edit booking
    const editMatch = url.match(/\/api\/bookings\/(\d+)$/);
    if (editMatch && action.method === 'PUT') {
      await updateCachedBooking(parseInt(editMatch[1]), body);
      return;
    }

    // Task toggle
    const taskMatch = url.match(/\/api\/tasks\/(\d+)\/toggle/);
    if (taskMatch) {
      await toggleCachedTask(parseInt(taskMatch[1]));
      return;
    }
  }

  async function updateCachedBooking(bookingId, updates) {
    const caches = await getAll('bookingCache');
    for (const cache of caches) {
      const idx = cache.bookings.findIndex(b => b.id === bookingId);
      if (idx >= 0) {
        Object.assign(cache.bookings[idx], updates, { updated_at: new Date().toISOString(), _offlineEdited: true });
        await put('bookingCache', cache);
        return;
      }
    }
  }

  async function toggleCachedTask(taskId) {
    const caches = await getAll('tasks');
    for (const cache of caches) {
      const task = cache.tasks.find(t => t.id === taskId);
      if (task) {
        if (task.completed_by_id) {
          task.completed_by_id = null;
          task.completed_by_name = null;
          task.completed_at = null;
        } else {
          task.completed_by_id = -1; // placeholder
          task.completed_by_name = 'Offline';
          task.completed_at = new Date().toISOString();
        }
        await put('tasks', cache);
        return;
      }
    }
  }

  // ─── Sync metadata ───────────────────────────────────────────────────
  async function updateSyncMeta() {
    const count = await getQueueLength();
    await put('syncMeta', { key: 'queueCount', value: count, updatedAt: Date.now() });
  }

  async function setLastSync(timestamp) {
    await put('syncMeta', { key: 'lastSync', value: timestamp });
  }

  async function getLastSync() {
    const meta = await get('syncMeta', 'lastSync');
    return meta ? meta.value : null;
  }

  // ─── Sync all queued actions ──────────────────────────────────────────
  async function syncAll(token) {
    const actions = await getQueuedActions();
    if (!actions.length) return { synced: 0, failed: 0, errors: [] };

    let synced = 0, failed = 0;
    const errors = [];

    for (const action of actions) {
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (token) headers['Authorization'] = 'Bearer ' + token;

        const response = await fetch(action.url, {
          method: action.method,
          headers,
          body: action.body || undefined
        });

        if (response.ok || response.status === 409) {
          // Success or conflict (already processed) — remove from queue
          await removeQueuedAction(action.id);
          synced++;
        } else if (response.status === 401) {
          // Token expired — stop sync
          errors.push({ action, error: 'Token abgelaufen' });
          failed++;
          break;
        } else {
          const err = await response.json().catch(() => ({}));
          errors.push({ action, error: err.error || response.statusText });
          failed++;
        }
      } catch (e) {
        // Network still down
        errors.push({ action, error: e.message });
        failed++;
        break; // Stop trying if network is down
      }
    }

    if (synced > 0) {
      await setLastSync(Date.now());
    }

    return { synced, failed, errors };
  }

  // ─── Save label for offline printing ──────────────────────────────────
  async function saveLabel(bookingId, plate, imageDataUrl) {
    await put('offlineLabels', {
      id: Date.now() + '-' + bookingId,
      bookingId,
      plate,
      imageDataUrl,
      createdAt: Date.now()
    });
  }

  async function getOfflineLabels() {
    return getAll('offlineLabels');
  }

  async function clearLabels() {
    await clear('offlineLabels');
  }

  return {
    openDB,
    cacheBookings,
    getCachedBookings,
    cacheTasks,
    getCachedTasks,
    cacheApiResponse,
    getCachedApiResponse,
    queueAction,
    getQueuedActions,
    removeQueuedAction,
    clearQueue,
    getQueueLength,
    applyOfflineAction,
    syncAll,
    setLastSync,
    getLastSync,
    saveLabel,
    getOfflineLabels,
    clearLabels,
    updateCachedBooking
  };
})();
