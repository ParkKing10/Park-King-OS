# 🅿️ Park King OS

Parkplatz-Management System mit ParkingPro Integration, SQLite Datenbank, JWT Auth und **Offline-PWA-Modus**.

## Architektur

```
parkking-os/
├── src/
│   ├── server.js      → Express Server + Auto-Scrape
│   ├── db.js          → SQLite Schema + Booking-Helpers
│   ├── auth.js        → JWT + bcrypt Auth + User-Management
│   ├── routes.js      → Alle API-Endpunkte
│   └── scraper.js     → ParkingPro Puppeteer Scraper
├── public/
│   ├── index.html     → Frontend (PWA)
│   ├── app.js         → App-Logik (offline-first)
│   ├── offline-store.js → IndexedDB Cache + Sync Queue
│   ├── sw.js          → Service Worker
│   ├── manifest.json  → PWA Manifest
│   └── icons/         → PWA Icons (192px + 512px)
├── data/
│   └── parkking.db    → SQLite Datenbank (auto-created)
├── Dockerfile         → Docker Build für Render
├── render.yaml        → Render Deployment Config
└── package.json
```

## Offline-Modus (PWA)

### So funktioniert es

1. **Morgens mit Internet öffnen** → App lädt alle Tagesbuchungen und cached sie in IndexedDB
2. **Internet aus** → App arbeitet komplett offline aus dem Cache:
   - Buchungen anzeigen, filtern, durchsuchen
   - Labels generieren und drucken (Canvas-basiert, kein Server nötig)
   - Check-ins / Check-outs durchführen
   - Buchungen bearbeiten
   - Tagesaufgaben abhaken
   - Dienstplan anschauen
3. **Internet wieder da** → Alle Offline-Änderungen werden automatisch synchronisiert

### iPhone Homescreen Installation

1. Safari → Park King OS öffnen
2. Teilen-Button → "Zum Home-Bildschirm"
3. App läuft jetzt standalone ohne Safari-UI

### Was offline NICHT funktioniert

- Neuen Scrape auslösen (braucht Server + Chromium)
- Neue Benutzer anlegen (Admin-Funktion)
- Fotos hochladen (braucht Upload-Server)
- Neue Schäden protokollieren (braucht Server für Schadensnummer)

## Deployment auf Render

1. Push zu GitHub
2. Render → New → Web Service → Docker
3. Disk hinzufügen: `/app/data` (1 GB)
4. Env-Vars setzen
5. Deploy

Default Login: `admin` / `Berlin123!`
