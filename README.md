# 🅿️ Park King OS

Parkplatz-Management System mit ParkingPro Integration, SQLite Datenbank und JWT Auth.

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
│   └── index.html     → Frontend (Phase 2)
├── data/
│   └── parkking.db    → SQLite Datenbank (auto-created)
├── Dockerfile         → Docker Build für Render
├── render.yaml        → Render Deployment Config
└── package.json
```

## API Endpunkte

### Auth
| Methode | Endpoint | Beschreibung |
|---------|----------|-------------|
| POST | `/api/auth/login` | Login (username + password) → JWT Token |
| GET | `/api/auth/me` | Aktueller User |

### Buchungen
| Methode | Endpoint | Beschreibung |
|---------|----------|-------------|
| GET | `/api/bookings` | Liste (Filter: company, date, type, status, search) |
| GET | `/api/bookings/:id` | Detail + Protokoll |
| POST | `/api/bookings` | Neue Buchung anlegen |
| PUT | `/api/bookings/:id` | Buchung bearbeiten |
| POST | `/api/bookings/:id/checkin` | Check-in |
| POST | `/api/bookings/:id/checkout` | Check-out |
| POST | `/api/bookings/:id/pay` | Zahlung erfassen |
| POST | `/api/bookings/:id/noshow` | No-Show markieren |
| POST | `/api/bookings/:id/key` | Schlüssel an/abgeben |
| POST | `/api/bookings/:id/phone` | Telefonat vermerken |

### Scraping
| Methode | Endpoint | Beschreibung |
|---------|----------|-------------|
| POST | `/api/scrape` | Einzelne Firma scrapen |
| POST | `/api/scrape/all` | Alle Firmen (Admin) |
| GET | `/api/scrape/log` | Scrape-Protokoll |

### User (Admin)
| Methode | Endpoint | Beschreibung |
|---------|----------|-------------|
| GET | `/api/users` | Alle User |
| POST | `/api/users` | User anlegen |
| PUT | `/api/users/:id` | User bearbeiten |
| DELETE | `/api/users/:id` | User deaktivieren |

### Sonstiges
| Methode | Endpoint | Beschreibung |
|---------|----------|-------------|
| GET | `/api/stats` | Dashboard-Statistiken |
| GET | `/api/companies` | Firmen-Liste |
| GET/PUT | `/api/settings` | Einstellungen (Admin) |
| GET | `/api/labels` | Label-Druckprotokoll |
| POST | `/api/labels` | Label erstellen |
| GET | `/api/health` | Health Check |

## Rollen

| Rolle | Buchungen | Check-in/out | Labels | User verwalten | Einstellungen |
|-------|-----------|-------------|--------|---------------|---------------|
| **Admin** | ✅ CRUD | ✅ | ✅ | ✅ | ✅ |
| **Staff** | ✅ Lesen + Bearbeiten | ✅ | ✅ | ❌ | ❌ |

## Deployment auf Render

1. Push zu GitHub
2. Render → New → Web Service → Docker
3. Disk hinzufügen: `/app/data` (1 GB)
4. Env-Vars setzen (gleiche wie Label Print Tool)
5. Deploy

## Lokale Entwicklung

```bash
cp .env.example .env
# .env ausfüllen
npm install
npm run dev
```

Default Login: `admin` / `admin123`

## Datenbank

SQLite mit WAL-Modus. Tabellen:
- **users** — Admin + Mitarbeiter
- **companies** — ParkingPro Firmen
- **bookings** — Alle Buchungen (gescrapt + manuell)
- **booking_log** — Protokoll (wer hat was wann gemacht)
- **labels** — Druckaufträge
- **scrape_log** — Scraping-Protokoll
- **settings** — App-Einstellungen
