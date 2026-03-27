// ═══════════════════════════════════════════════════════════════════════════
//  Park King OS — Service Worker (PWA + Offline)
//  Caches app shell + fonts, proxies API calls through IndexedDB when offline
// ═══════════════════════════════════════════════════════════════════════════

const CACHE_NAME = 'parkking-v6';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/offline-store.js',
  '/manifest.json',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon.svg'
];

const FONT_CACHE = 'parkking-fonts-v1';

// ─── Install: cache app shell ───────────────────────────────────────────
self.addEventListener('install', (event) => {
  console.log('[SW] Installing...');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ─── Activate: clean old caches ─────────────────────────────────────────
self.addEventListener('activate', (event) => {
  console.log('[SW] Activating...');
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== FONT_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── Fetch: network-first for API, cache-first for assets ───────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET cross-origin (except Google Fonts)
  if (url.origin !== self.location.origin) {
    // Cache Google Fonts
    if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
      event.respondWith(
        caches.open(FONT_CACHE).then(cache =>
          cache.match(event.request).then(cached => {
            if (cached) return cached;
            return fetch(event.request).then(response => {
              if (response.ok) cache.put(event.request, response.clone());
              return response;
            }).catch(() => cached || new Response('', { status: 503 }));
          })
        )
      );
      return;
    }
    return;
  }

  // ── API requests: network-first, fall through to IndexedDB in the client ──
  if (url.pathname.startsWith('/api/')) {
    // For GET requests: try network, return offline marker if fails
    if (event.request.method === 'GET') {
      event.respondWith(
        fetch(event.request)
          .then(response => {
            // Clone and notify client of fresh data for caching
            const clone = response.clone();
            if (response.ok) {
              notifyClients({
                type: 'API_RESPONSE_CACHE',
                url: url.pathname + url.search,
                // Client will read from its own fetch
              });
            }
            return response;
          })
          .catch(() => {
            // Return offline marker — client will serve from IndexedDB
            return new Response(
              JSON.stringify({ _offline: true, _url: url.pathname + url.search }),
              { status: 200, headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' } }
            );
          })
      );
      return;
    }

    // For POST/PUT/DELETE: try network, queue if offline
    if (['POST', 'PUT', 'DELETE'].includes(event.request.method)) {
      event.respondWith(
        event.request.clone().text().then(body => {
          return fetch(event.request)
            .catch(() => {
              // Network failed — notify client to queue this action
              const actionData = {
                type: 'QUEUE_OFFLINE_ACTION',
                method: event.request.method,
                url: url.pathname,
                body: body,
                headers: Object.fromEntries(event.request.headers.entries()),
                timestamp: Date.now()
              };
              notifyClients(actionData);
              return new Response(
                JSON.stringify({ _offline: true, _queued: true, message: 'Offline gespeichert — wird synchronisiert' }),
                { status: 200, headers: { 'Content-Type': 'application/json', 'X-Offline': 'true' } }
              );
            });
        })
      );
      return;
    }
    return;
  }

  // ── App shell: cache-first ──
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        // Cache new static assets
        if (response.ok && event.request.method === 'GET') {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      }).catch(() => {
        // Fallback to index.html for SPA navigation
        if (event.request.mode === 'navigate') {
          return caches.match('/index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// ─── Message handler for sync triggers ──────────────────────────────────
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// ─── Background Sync ────────────────────────────────────────────────────
self.addEventListener('sync', (event) => {
  if (event.tag === 'parkking-sync') {
    event.waitUntil(notifyClients({ type: 'TRIGGER_SYNC' }));
  }
});

// ─── Periodic Sync (if available) ───────────────────────────────────────
self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'parkking-refresh') {
    event.waitUntil(notifyClients({ type: 'TRIGGER_SYNC' }));
  }
});

// ─── Notify all clients ────────────────────────────────────────────────
async function notifyClients(data) {
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(client => client.postMessage(data));
}
