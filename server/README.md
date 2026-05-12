# WhatsApp SaaS — Server (v3)

Node + Express + MongoDB Atlas + Baileys WhatsApp engine.
Deployed on Railway. Built for multi-tenant WhatsApp messaging with license/JWT
auth, durable campaign queue, daily quotas and per-license WhatsApp sessions.

---

## Quick start (local)

```bash
cd server
cp .env.example .env
# Edit MONGO_URI, JWT_SECRET, ADMIN_JWT_SECRET, ADMIN_EMAIL, ADMIN_PASSWORD
npm install
npm run seed:admin
npm start              # → http://localhost:4000
curl http://localhost:4000/health
```

---

## Architecture

```
server/
└── src/
    ├── server.js              # entry: db + http + graceful shutdown
    ├── app.js                 # express app factory
    ├── config/
    │   ├── env.js             # validated env (fail-fast on boot)
    │   └── db.js              # mongo connect w/ retry + listeners
    ├── middleware/
    │   ├── auth.js            # adminAuth + clientAuth
    │   ├── error.js           # central error handler + notFound
    │   ├── rateLimit.js       # global + auth + send limiters
    │   ├── security.js        # helmet + cors
    │   └── validate.js        # generic schema validator helper
    ├── models/
    │   ├── admin.model.js
    │   ├── license.model.js
    │   ├── campaign.model.js
    │   ├── session.model.js   # WhatsApp session persisted state
    │   └── authState.model.js # Baileys auth state (creds + keys)
    ├── controllers/
    │   ├── health.controller.js
    │   ├── license.controller.js
    │   ├── admin.controller.js
    │   ├── campaign.controller.js
    │   ├── session.controller.js
    │   └── message.controller.js
    ├── services/
    │   ├── license.service.js
    │   └── queue.service.js   # atomic-claim campaign queue
    ├── whatsapp/
    │   ├── manager.js         # multi-session Baileys manager + events
    │   └── mongoAuthState.js  # Mongo-backed Baileys auth state
    ├── routes/
    │   ├── index.js
    │   ├── health.routes.js
    │   ├── license.routes.js
    │   ├── admin.routes.js
    │   ├── campaign.routes.js
    │   ├── session.routes.js
    │   └── message.routes.js
    └── utils/
        ├── AppError.js
        ├── asyncHandler.js
        ├── logger.js          # JSON-structured prod logging
        ├── phone.js           # EG-aware normalization + JID
        ├── generateLicenseKey.js
        └── seedAdmin.js
```

---

## Endpoints

### Health (public)
| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{ "status": "ok" }` — Railway healthcheck |
| GET | `/health/detailed` | Includes Mongo + session counters |
| GET | `/api/health` | Alias for legacy callers |

### License (public, rate-limited)
| Method | Path | Purpose |
|---|---|---|
| POST | `/api/license/activate` | Bind device → JWT |
| POST | `/api/license/validate` | Refresh JWT |
| GET  | `/api/license/me` | (client JWT) License info |

### Sessions (client JWT)
| Method | Path | Purpose |
|---|---|---|
| POST | `/session/create` | Start a Baileys session for this license |
| GET  | `/session/:id/qr` | Fetch QR (data URL) for first scan |
| GET  | `/session/:id/status` | Current state (idle/awaiting_qr/connected/...) |
| POST | `/session/:id/logout` | Logout + wipe stored auth |

> `:id` is the license_key (uppercase). The server enforces caller == owner.

### Messages (client JWT, send-rate limited)
| Method | Path | Purpose |
|---|---|---|
| POST | `/message/send` | `{ phone, text?, media? }` direct send |

### Campaigns (client JWT)
Unchanged contract — see `/api/campaign/*` in `routes/campaign.routes.js`.

### Admin (admin JWT)
- `POST /api/admin/login`
- `GET  /api/admin/stats`
- `GET  /api/admin/licenses`, `POST /api/admin/create-license`
- `PATCH /api/admin/license/:key/revoke`, `.../reset-device`
- `GET  /api/admin/sessions`, `GET /api/admin/sessions/:id`,
  `POST /api/admin/sessions/:id/logout`

---

## Environment variables

See `.env.example`. Required: `MONGO_URI`, `JWT_SECRET`, `ADMIN_JWT_SECRET`
(both ≥ 24 chars and must differ).

The server fails fast on boot if any required variable is missing or invalid.

---

## Railway deployment

1. Connect this repo to a Railway project.
2. Set the variables from `.env.example` under **Variables**.
3. `railway.json` (repo root) instructs Railway to build the Dockerfile and
   healthcheck `/health`.
4. The Dockerfile copies only `server/` into the image; Railway will inject
   `PORT` automatically — `config/env.js` honours it.
5. First deploy: open a shell and run `npm run seed:admin` once, OR set
   `ADMIN_EMAIL`/`ADMIN_PASSWORD` and run that command from the Railway shell.

### What Railway needs
- `PORT` (Railway injects it; do not override).
- `MONGO_URI` (Atlas SRV string).
- `JWT_SECRET`, `ADMIN_JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
- Optional: `CORS_ORIGINS`, `LOG_LEVEL`.

### Logs
In production, logs are emitted as one-line JSON for ingestion by Railway's
log viewer. Local dev uses pretty console output.

---

## WhatsApp engine notes

- One Baileys socket per license, kept in-process.
- Auth state persists in Mongo (`auth_states` collection) → survives redeploys.
- Hard logouts (`loggedOut`, `connectionReplaced`, `forbidden`) do NOT
  auto-reconnect; a new QR scan is required.
- Soft drops auto-reconnect with exponential backoff (capped at 30 s, max 5
  attempts before going to `error`).
- `/message/send` returns `409 SESSION_NOT_CONNECTED` if the customer hasn't
  scanned a QR yet.

---

## Operations

```bash
npm start             # production
npm run dev           # nodemon
npm run seed:admin    # idempotent
npm run syntax-check  # node --check on every JS file
```

Graceful shutdown: SIGTERM/SIGINT → close http server → stop all WA sessions →
disconnect Mongo. Hard exit after 15 s if something hangs.
