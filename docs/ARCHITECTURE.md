# WhatsApp SaaS — Backend architecture

This document describes the runtime architecture of the `server/` service:
what each subsystem does, how state flows between them, and what happens
during the most important lifecycles. It complements the OpenAPI spec
(`server/openapi.yaml`) which documents the wire contracts.

## TL;DR

```
                    ┌────────────────────┐
                    │   MongoDB Atlas    │
                    │  (licenses, admin, │
                    │   campaigns,       │
                    │   sessions,        │
                    │   auth_states)     │
                    └─────────▲──────────┘
                              │ (driver retry + pool)
                              │
┌────────────┐   HTTPS  ┌─────┴───────────────┐
│  Clients   ├─────────▶│   Express API       │
│ (any: web, │          │  ──────────────     │
│  electron, │          │  routes/            │
│  mobile,   │          │  controllers/       │
│  CLI…)     │          │  services/          │
└────────────┘          │  middleware/        │
                        │  whatsapp/manager   │◀── per-license Baileys socket
                        │  services/worker    │◀── per-campaign worker
                        └─────────────────────┘
```

There is **one process** running on Render. All state that matters
(licenses, queue, session credentials) lives in Mongo so deploys are
stateless from the FS perspective.

---

## 1. Subsystems

### 1.1 HTTP layer

```
server/src/server.js     entry: traps, listen, background workers, shutdown
server/src/app.js        express factory (security, compression, requestId,
                         timeout, body, morgan, rate-limit, routes, errors)
server/src/routes/       grouped routers — health, license, session, message,
                         campaign, admin, docs
server/src/middleware/   auth, error, rateLimit, security, requestId
```

**Startup order is deliberate:**
1. Install global crash handlers.
2. Build app, call `app.listen()` — `/healthz` answers immediately.
3. Kick off Mongo connection in the background (retry-forever loop).
4. Kick off WhatsApp session restoration in the background.
5. Kick off campaign worker resume in the background.

Anything that fails in steps 3-5 is logged and retried; the HTTP server
never goes down because a dependency is sick.

### 1.2 Config (`src/config/env.js`)

Single source of truth for env vars. Categorises them:

| Level       | Behaviour                                | Examples                                |
| ----------- | ---------------------------------------- | --------------------------------------- |
| Critical    | Endpoints depending on them return 503   | `MONGO_URI`, `JWT_SECRET`, `ADMIN_JWT_SECRET` |
| Recommended | Logged as warning; safe fallback applied | `ADMIN_EMAIL`, `ADMIN_PASSWORD`, `CORS_ORIGINS` |
| Optional    | Silent defaults                          | rate limits, WA tunables, delays        |

Defensive sanitisation: every value is trimmed and stripped of wrapping
quotes (a common cloud-dashboard paste mistake).

Diagnostics: `env.printStartupBanner()` for operators, `env.getDiagnostics()`
for `/healthz/detailed` (secrets masked).

### 1.3 Database (`src/config/db.js`)

Mongoose with `bufferCommands: false` (fail fast instead of hanging when
disconnected). `connectDB()` kicks off a non-blocking background retry
loop with exponential backoff (1s → 30s, then steady). Reconnect is
handled by the driver; we just log transitions.

Indexes are declared on the schemas themselves and created automatically
on first connect.

### 1.4 Auth (`src/middleware/auth.js`)

Two surfaces:

- **`clientAuth`** — validates a license-bound JWT. Re-loads the license
  from Mongo on every request, re-checks status + fingerprint match,
  updates `last_seen_at` opportunistically. Returns 503 if `JWT_SECRET`
  is unset or Mongo is down (no fingerprint forging).
- **`adminAuth`** — pure JWT signature check; carries `iss`/`aud` claims.

### 1.5 WhatsApp engine (`src/whatsapp/`)

```
manager.js        in-process registry of Baileys sockets, one per license
mongoAuthState.js Mongo-backed Baileys auth state (creds + signal keys)
```

Sessions are keyed by license_key (uppercase). Each session is its own
Baileys socket with:

- `creds.update` → persisted to `auth_states` collection (survives redeploys).
- Per-session **serial send chain** — concurrent `sendMessage` calls are
  queued so ratchet state cannot race.
- **Typing simulation** — `sendPresenceUpdate('composing'/'paused')`
  scaled to message length (800ms–4s).
- Auto-reconnect with exponential backoff (3s/6s/9s/15s/30s, max 5
  attempts) for soft drops. Hard logouts (`loggedOut`, `connectionReplaced`,
  `forbidden`) require a fresh QR.

### 1.6 Campaign queue (`src/services/queue.service.js`)

Durable Mongo-backed queue with atomic claim:

- `claimNextJob` uses `findOneAndUpdate` with `arrayFilters` to flip exactly
  one contact from `pending` → `processing`. No double-send possible.
- Stale jobs (`processing` for > 2 min) are auto-reclaimed on the next
  claim. So if the process crashes, work resumes after a short delay.
- Daily quota enforced per campaign + license (with optional warm-up
  ramp: `day1 + days * day_step`).

### 1.7 Campaign worker (`src/services/campaign.worker.js`)

One worker per campaign. Replaces the role the old desktop client played:

1. Wait for the owner's WhatsApp session to be `connected` (up to 5 min).
2. Claim one job.
3. Skip if `risk_level=red` or `on_whatsapp=false`.
4. Random delay within `delay_min..max_seconds` (HARD floor at 5s).
5. Build message text (`messageBuilder` picks a variation + expands vars).
6. Send via the manager (typing simulation runs inside the send call).
7. Report success / fail.
8. Loop until the campaign is `completed` or worker is stopped.

Workers are started lazily by `/api/campaign/start` and re-attached on boot
for any campaign with pending contacts.

### 1.8 Health (`/`, `/healthz`, `/health`, `/healthz/detailed`)

Always 200. `/healthz/detailed` reports:

- Mongo connected? Ping latency (ms)?
- Session counters by status.
- Active campaign workers.
- Memory (`rss`, `heap_used`, `heap_total`, `external` — all MB).
- Uptime, node version, version string.
- Full env diagnostics with masked secrets.

---

## 2. MongoDB collections

| Collection      | Purpose                                                  | Hot indexes |
|-----------------|----------------------------------------------------------|-------------|
| `licenses`      | One per customer; binds device fingerprint, plan, expiry | `license_key` (unique), `status`, `device_fingerprint` |
| `admins`        | Admin login accounts                                     | `email` (unique), `locked_until` |
| `campaigns`     | Campaign config + contact array + queue state            | `license_key+status+createdAt`, `status+contacts.status` |
| `sessions`      | Persisted WhatsApp session state (status, QR, errors)    | `session_id` (unique), `license_key+status`, `status+updatedAt` |
| `auth_states`   | Baileys auth state (creds + signal keys)                 | `session_id+key` (unique) |

---

## 3. Flows

### 3.1 Auth flow (client / desktop / mobile)

```
┌────────┐                  ┌──────────┐                ┌────────┐
│ Client │                  │   API    │                │ Mongo  │
└───┬────┘                  └────┬─────┘                └───┬────┘
    │ POST /api/license/activate │                          │
    │ { license_key, fp }        │                          │
    │───────────────────────────▶│                          │
    │                            │ find license by key      │
    │                            │─────────────────────────▶│
    │                            │ refresh status           │
    │                            │ (bind fp if first time)  │
    │                            │ save                     │
    │                            │─────────────────────────▶│
    │ 200 { token, license }     │                          │
    │◀───────────────────────────│                          │
    │                                                       │
    │ Authorization: Bearer <token>                         │
    │ on every subsequent request                           │
    │ → clientAuth re-validates fp + status                 │
```

JWT carries `{ license_key, fp }` and expires in 12h. The client calls
`/api/license/validate` periodically (e.g. every 10 min) to rotate.

### 3.2 WhatsApp session flow

```
POST /session/create   ──▶  manager.create
                              │
                              ├─▶ load auth state from Mongo
                              ├─▶ makeWASocket()
                              └─▶ ev.on('connection.update'):
                                    qr        → store + emit
                                    open      → persist 'connected'
                                    close     → persist 'disconnected'
                                                schedule reconnect
GET /session/:id/qr    ──▶  return last QR (or null if connected / expired)
GET /session/:id/status──▶  return live + persisted state
POST /message/send     ──▶  manager.sendText (serialised)
POST /session/:id/logout ▶  manager.logout (clears auth_states)
```

**States** (`Session.status`):
```
idle → initializing → restoring_session ─┐
                  ↓                       │
            awaiting_qr ──────────────────┤
                  ↓                       │
              connected ◀─────────────────┘
                  ↓                            (soft drop)
              disconnected ──schedule_reconnect──▶ initializing
                  ↓                            (hard logout)
              logged_out (terminal — requires new QR)
```

### 3.3 Campaign flow

```
POST /api/campaign/start
  │
  ├─▶ Sanitise + dedupe contacts (normalize phones)
  ├─▶ Create Campaign doc (status=queued, contacts=[…pending])
  └─▶ campaignWorker.ensureWorker(campaign._id, license_key)
        │
        └─▶ loop:
              waitForSession()       (poll until session connected)
              claimNextJob()         (atomic Mongo update)
              if red / not_on_whatsapp → skipJob
              sleep jitter           (delay_min..max, jittered)
              build message text     (variation + var expansion)
              manager.sendText/Media (typing simulation + serial chain)
              completeJob / failJob
              (continue until completed / paused / deleted)
```

### 3.4 Reconnect flow

```
connection.update → connection=close, lastDisconnect=err
       │
       ├─ statusCode in {loggedOut, replaced, forbidden} → terminal
       │    persist 'logged_out'; no reconnect; require fresh QR
       │
       └─ otherwise → soft drop
            persist 'disconnected'; emit
            reconnectAttempts < WA_RECONNECT_MAX?
                ├─ yes → setTimeout(delays[n]) → manager.create() again
                └─ no  → persist 'error'; stop
```

### 3.5 Queue + worker shutdown

```
SIGTERM (Render redeploy)
  │
  ├─▶ http server stop accepting new connections
  ├─▶ campaignWorker.stopAll() — workers exit their loops gracefully
  ├─▶ manager.shutdownAll()    — sock.end() for every session
  └─▶ disconnectDB()
       (15s force-exit watchdog)
```

Any work in-flight that didn't complete has its `contacts.locked_at` set;
when the new process boots, `queue.reclaimStale` flips it back to
`pending` after 2 min and a worker picks it up.

---

## 4. Cross-cutting

### Logging

JSON-line stdout in production (`logger.js`). Every line carries a `level`
and `ts`. Express requests have `rid` (request id) for correlation.
Inbound `X-Request-Id` is honoured and echoed in the response header.

### Rate limits

| Bucket     | Window  | Max | Key                |
|------------|---------|-----|--------------------|
| global     | 60s     | 300 | IP                 |
| auth       | 10 min  | 10  | IP (activate/login)|
| send       | 60s     | 60  | license_key        |

All in-process. For multi-instance you'd need a Redis store; not needed
on a single Render service.

### Compatibility surfaces

The API surface is fully decoupled from any specific client. Anything
that can speak HTTPS + JSON can drive it:

- Electron / desktop app (legacy)
- Web admin dashboard
- Mobile clients
- External integrations (webhooks, CRM bridges)
- CLI tools / Postman

Interactive docs at `/api/docs` (Swagger UI), raw spec at
`/api/docs/openapi.yaml`. A ready-to-import Postman collection lives at
`server/postman_collection.json`.
