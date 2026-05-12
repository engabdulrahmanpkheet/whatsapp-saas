# WhatsApp Campaign SaaS — Project Context

This file gives Claude Code (and any AI assistant) the context it needs to work productively in this codebase. Read this before making changes.

---

## What this project does

A complete SaaS for WhatsApp marketing campaigns:
- **Server** (Node + Express + MongoDB Atlas): license system, JWT auth, durable campaign queue, daily quotas, warm-up gradient
- **Admin Dashboard** (static SPA): create/revoke licenses, monitor campaigns
- **Desktop Client** (Electron + whatsapp-web.js): the customer-facing app — activates with a license key, scans WhatsApp QR, sends campaigns

Customers install **only the desktop app**. No DB or backend runs on customer machines. All campaigns, contacts, queue state, and licenses live on the server.

---

## Repository structure

```
whatsapp-saas-v5/
├── server/                  # ⚠ DO NOT MODIFY — production stable
│   ├── app.js
│   ├── config/db.js
│   ├── models/              # license, admin, campaign
│   ├── controllers/         # license, admin, campaign
│   ├── middleware/auth.middleware.js   # adminAuth + clientAuth
│   ├── services/queue.service.js       # atomic claim, warmup ramp, skip jobs
│   ├── routes/
│   ├── utils/               # generateLicenseKey, seedAdmin
│   └── .env.example
│
├── admin-dashboard/         # Static SPA (vanilla JS, no framework)
│   ├── login.html / login.js
│   ├── index.html / app.js
│   └── styles.css
│
├── client-desktop/          # ACTIVE DEVELOPMENT TARGET
│   ├── package.json         # electron-builder config for win/mac/linux
│   └── src/
│       ├── main/
│       │   ├── main.js      # Electron main process, IPC handlers, worker loop
│       │   └── preload.js   # contextBridge API
│       ├── renderer/
│       │   ├── login.html / login.js       # License activation screen
│       │   ├── dashboard.html              # 6 nav pages: WA, Contacts, New, Campaigns, Groups, Blacklist
│       │   ├── dashboard.js                # All renderer logic (no framework)
│       │   └── styles.css                  # Dark theme, CSS variables
│       ├── services/
│       │   ├── whatsapp.service.js   # WhatsAppManager singleton (puppeteer wrapper)
│       │   ├── api.service.js        # Axios client with JWT auto-refresh
│       │   └── messageBuilder.js     # Template + variations + media
│       └── utils/
│           ├── fingerprint.js        # SHA-256 device ID for license binding
│           ├── phoneNormalizer.js    # EG-aware: 01XXXXXXXXX → 201XXXXXXXXX
│           ├── excelParser.js        # xlsx/csv reader
│           ├── blacklist.js          # electron-store persisted blocklist
│           └── sentContacts.js       # Auto-saved sent log (10k FIFO)
│
├── render.yaml              # Render.com 1-click deploy blueprint
├── Dockerfile               # node:20-alpine for VPS
├── ecosystem.config.js      # PM2 config
└── README.md                # Run + deploy + build instructions
```

---

## Hard constraints

### 🚫 Do NOT modify
- `server/` — production stable, do not touch endpoints, models, or middleware
- License binding logic (`controllers/license.controller.js`, `middleware/auth.middleware.js`)
- Queue atomic claim logic (`services/queue.service.js` — uses MongoDB `$arrayFilters`)

### ✅ Active development target
- `client-desktop/` — all UX improvements, new features, performance work goes here

### When server changes are unavoidable
- Stop and ask first. Explain why client-only is impossible.
- Never break backward compatibility — existing v3/v4 clients must continue working.
- All new server fields must have defaults.

---

## Critical implementation details

### License + JWT flow
1. Customer enters license key + auto-generated device fingerprint
2. Server binds first device permanently (`device_fingerprint` field on License model)
3. Server returns JWT with `{ license_key, fp }` claims, signed with `JWT_SECRET`, valid 12h
4. Every client API call re-validates fingerprint match in `clientAuth` middleware
5. Desktop auto-refreshes JWT every 10 min via `/api/license/validate`
6. On 401/403, Axios interceptor calls `/validate` to refresh, then retries once

### WhatsApp session lives at
```
app.getPath('userData') / wa-session / session-default /
```
- On Windows: `%AppData%\Roaming\whatsapp-saas-client\wa-session\`
- On macOS: `~/Library/Application Support/whatsapp-saas-client/wa-session/`
- On Linux: `~/.config/whatsapp-saas-client/wa-session/`

**Never delete this folder programmatically except in `clearSession()`** — losing it forces a QR re-scan.

### Phone number invariants
- All phones stored as **digits only**, no `+`, no spaces, no `00`
- Egyptian numbers normalized to 12 digits starting with `20` (e.g. `201001234567`)
- Valid EG mobile prefixes: `10`, `11`, `12`, `15`
- Server-side dedup is by normalized phone, case-insensitive

### Worker loop (in `main.js`)
- Long-polls `/api/campaign/:id/next` (one job at a time)
- Per-send: 60s timeout, max 2 retries with 3s backoff
- Waits up to 60s for WhatsApp reconnect if disconnected mid-send
- Watchdog logs warning if no progress in 2 minutes
- Hard server-side floor: `HARD_MIN_DELAY_SEC=5` (cannot send faster)
- Random delay within speed mode range:
  - `safe`: 15-25s
  - `medium`: 8-15s (default)
  - `fast`: 3-5s (high ban risk)
  - `custom`: user-defined, server enforces 5s minimum

### WhatsAppManager singleton
- One puppeteer browser per app lifetime — never recreate
- Concurrent `start()` calls await the same `_initPromise`
- State machine: `idle → initializing → restoring_session → awaiting_qr → authenticating → connected`
- Auto-reconnect: exponential backoff (3s, 6s, 9s..., cap 30s), max 5 attempts
- Hard logouts (`LOGOUT`, `CONFLICT`, `UNPAIRED`): no auto-reconnect — needs new QR
- Soft drops (network): auto-reconnect transparently

### "View WhatsApp" implementation
This is **NOT** a BrowserView. It's the puppeteer Chromium window itself, repositioned via CDP:
- Electron window calls `wa:show` IPC
- `WhatsAppManager.showWindow(bounds, onBack)` uses `Browser.setWindowBounds` to overlay puppeteer Chromium at Electron's exact coordinates
- Floating "← Back to Dashboard" button injected via `page.evaluate` into the WhatsApp page
- Clicking it calls back through `__electronBackToDashboard__` exposed function → minimizes puppeteer + re-shows Electron

**Why not BrowserView?** Chromium IndexedDB can't be open in two processes. WhatsApp's session lives in IndexedDB. Two views = session corruption.

---

## Running locally

### Server
```bash
cd server
cp .env.example .env
# Edit MONGO_URI, JWT_SECRET, ADMIN_JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run seed:admin    # creates admin user from .env
npm start             # → http://localhost:4000
curl http://localhost:4000/api/health
```

### Admin dashboard
```bash
cd admin-dashboard
npm start             # → http://localhost:3000/login.html
```

### Desktop client (dev mode)
```bash
cd client-desktop
npm install
npm start             # opens Electron window
```

### Build .exe for Windows
```bash
cd client-desktop
npm run build:win
# → dist/WhatsAppCampaignPro-Setup-X.X.X.exe
```

Cross-build from macOS/Linux needs `wine`:
```bash
brew install --cask wine-stable    # macOS
sudo apt install wine64            # Ubuntu
```

---

## API reference (concise)

### Public
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/health` | Health check |
| POST | `/api/license/activate` | Bind license to device → JWT |
| POST | `/api/license/validate` | Refresh JWT |
| POST | `/api/admin/login` | Admin login → admin JWT |

### Client (clientAuth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/license/me` | License info |
| POST | `/api/campaign/start` | Create + queue campaign |
| GET | `/api/campaign` | List my campaigns |
| GET | `/api/campaign/:id` | Get one |
| GET | `/api/campaign/:id/report` | Sent/failed/skipped breakdown |
| PATCH | `/api/campaign/:id/status` | Pause / resume |
| PATCH | `/api/campaign/:id/risk` | Bulk update risk levels |
| DELETE | `/api/campaign/:id` | Delete |
| GET | `/api/campaign/:id/next` | Worker: claim next job |
| POST | `/api/campaign/:id/report` | Worker: report success/fail |
| POST | `/api/campaign/:id/skip` | Worker: skip risky/blacklisted |

### Admin (adminAuth)
| Method | Path | Purpose |
|---|---|---|
| GET | `/api/admin/stats` | License counters |
| GET | `/api/admin/licenses` | List with filter+search |
| GET | `/api/admin/campaigns` | All campaigns across customers |
| POST | `/api/admin/create-license` | Single OR bulk (max 100) |
| PATCH | `/api/admin/license/:key/revoke` | Revoke |
| PATCH | `/api/admin/license/:key/reset-device` | Unbind device |

---

## IPC channels (renderer ↔ main)

All exposed via `window.api.*` from `preload.js`. Renderer never has direct Node access.

### License
`activate`, `me`, `logout`, `goDashboard`, `getConfig`, `setServer`

### WhatsApp lifecycle
`startWA`, `stopWA`, `logoutWA`, `restartWA`, `clearWASession`, `waState`, `waInfo`, `waProfilePic`, `showWA`, `hideWA`

### Groups
`waListGroups`, `waGroupDetails`, `waSendGroup`, `waSendGroupMedia`, `waExtractGroup`, `waValidateBatch`

### Files + contacts
`pickFile`, `pickMedia`, `normalizePhones`

### Blacklist + sent log
`blacklistList`, `blacklistAdd`, `blacklistRemove`, `blacklistClear`, `blacklistCheck`, `sentList`, `sentClear`

### Campaigns
`startCampaign`, `listCampaigns`, `getCampaign`, `getReport`, `setStatus`, `deleteCampaign`, `updateRisk`

### Worker
`startWorker(campaignId, { safeMode, simulateTyping })`, `stopWorker`

### Events (subscribe with `window.api.on(channel, handler)`)
`wa:qr`, `wa:ready`, `wa:error`, `wa:disconnected`, `wa:account`, `wa:status`, `wa:returned`, `worker:log`, `worker:done`, `worker:progress`, `license:invalid`, `validate:progress`

---

## Common task patterns

### Adding a new IPC handler
1. Add `ipcMain.handle('namespace:action', async (_, payload) => {...})` in `main.js`
2. Add to allowlist + expose method in `preload.js`
3. Call via `window.api.methodName()` in `dashboard.js`

### Adding a new renderer page
1. Add `<section id="pageX">` in `dashboard.html`
2. Add nav item: `<div id="navX" class="nav-item">Label</div>`
3. Add to `pages` + `navs` objects in `dashboard.js`
4. Handle in `show(name)` switch if it needs init logic

### Adding a new utility
- Pure logic → `client-desktop/src/utils/X.js`
- Stateful service (uses Electron APIs / external libs) → `client-desktop/src/services/X.js`
- Import in `main.js` if it needs to run in main process

### Adding a new field to campaign model
**Server change required.** Stop and ask first. If approved:
- Add to `server/models/campaign.model.js` with sensible default
- Accept in `server/controllers/campaign.controller.js` `start()` with validation
- Return in worker's `/next` response if relevant
- Old clients must continue working (new fields are optional)

---

## Anti-ban guidelines (in code)

Worker enforces these — don't bypass:
- Random delay within speed mode range (never fixed)
- Server-side `HARD_MIN_DELAY_SEC=5` floor
- Daily quota per license (with optional warm-up ramp)
- Skip contacts marked `risk_level: 'red'` automatically
- Skip blacklisted numbers before send
- Typing simulation (optional) — calls `chat.sendStateTyping()` for 800-4000ms scaled to text length
- Message variations: pick random alt template per send

---

## Validation commands

```bash
# Syntax-check all JS files
find . -name "*.js" -not -path "*/node_modules/*" -exec node --check {} \;

# Validate JSON files
find . -name "*.json" -not -path "*/node_modules/*" -exec node -e "JSON.parse(require('fs').readFileSync('{}', 'utf8'))" \;

# Run server unit tests (if added)
cd server && npm test
```

---

## Things to flag, not silently change

- WhatsApp account ban risk implications of a change
- Anything that could leak the customer's contacts or messages
- Changes to license enforcement (anti-piracy)
- Anything that increases the risk of session corruption
- Code that touches puppeteer launch args — these are tuned for compatibility, not preference
- Adding heavyweight dependencies (>10MB installed) without justification

---

## Useful slash commands in Claude Code

- `/init` — regenerate this file from analysis
- `/clear` — reset conversation context
- `/help` — list all commands
- `/cost` — view token usage

---

_Last updated: v5. Server stable since v2. Client-desktop is the active dev surface._
