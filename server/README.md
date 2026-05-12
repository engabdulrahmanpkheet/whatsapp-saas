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

### Health (public, unconditional 200)
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | `API is running 🚀` |
| GET | `/healthz` | `OK` — Render/Railway healthcheck |
| GET | `/health` | `{ "status": "ok" }` |
| GET | `/healthz/detailed` | Mongo state + missing-config + session counters |
| GET | `/api/health` | Legacy alias |

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

## Boot-time guarantees (production stability)

- **`/`, `/healthz`, `/health`, `/api/health` always respond 200.** They have
  no dependencies — they pass even if Mongo is down or env is misconfigured.
- **The server never crashes on missing env vars.** Missing `MONGO_URI`,
  `JWT_SECRET`, `ADMIN_JWT_SECRET` are logged as warnings; endpoints that
  depend on them return `503 SERVICE_UNAVAILABLE` with a structured body.
- **Mongo connects in the background with exponential backoff.** The HTTP
  server is up first; DB-dependent routes return 503 until connection is live.
- **WhatsApp sessions restore after `app.listen()`,** not before — Baileys is
  never on the startup critical path.
- **Global `uncaughtException` and `unhandledRejection` handlers** log and
  keep the process alive.
- **Per-request timeout** (`REQUEST_TIMEOUT_MS`, default 30 s) protects the
  event loop from stuck downstreams.

## Render deployment

1. New Web Service → connect this repo.
2. Render reads `render.yaml` at the repo root automatically:
   - `rootDir: server`, `startCommand: node src/server.js`
   - `healthCheckPath: /healthz`
3. Set the secrets the blueprint doesn't generate:
   - `MONGO_URI`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CORS_ORIGINS`.
   - `JWT_SECRET` / `ADMIN_JWT_SECRET` are auto-generated by Render.
4. First deploy: open Render shell → `npm run seed:admin`.

## Railway deployment

1. Connect this repo to a Railway project. `railway.json` at repo root tells
   Railway to use the `Dockerfile` and healthcheck `/healthz`.
2. Set Variables under the service: `MONGO_URI`, `JWT_SECRET`,
   `ADMIN_JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CORS_ORIGINS`,
   `NODE_ENV=production`.
3. `PORT` is injected by Railway — do not override.
4. First deploy: open the Railway shell → `npm run seed:admin`.

## Docker

```
docker build -t whatsapp-saas-api -f Dockerfile .
docker run --rm -p 10000:10000 \
  -e MONGO_URI="mongodb+srv://..." \
  -e JWT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))') \
  -e ADMIN_JWT_SECRET=$(node -e 'console.log(require("crypto").randomBytes(48).toString("hex"))') \
  -e ADMIN_EMAIL=admin@example.com -e ADMIN_PASSWORD=changeme \
  whatsapp-saas-api
curl http://127.0.0.1:10000/healthz
```

## Logs

Production emits one-line JSON to stdout for Render/Railway log viewers.
Local dev uses pretty `morgan` + plain text logger output.

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
