# WhatsApp Campaign SaaS — v2

A complete, production-ready SaaS for WhatsApp marketing campaigns with a strict
client/server separation and device-bound licensing.

```
whatsapp-saas-v2/
├── server/             # Cloud backend (Node.js + Express + MongoDB Atlas)
├── admin-dashboard/    # Web admin panel (static HTML/JS)
├── client-desktop/     # Customer desktop app (Electron)
├── render.yaml         # 1-click deploy to Render
├── Dockerfile          # Container build for any VPS / cloud
├── ecosystem.config.js # PM2 config for VPS deploys
└── sample-contacts.csv # Sample input file for testing
```

---

## Architecture

```
              ┌──────────────────────────────┐
              │       MongoDB Atlas           │
              │  (cloud-hosted, 100% remote)  │
              └──────────┬───────────────────┘
                         │
              ┌──────────▼───────────────────┐
              │   Cloud Backend (Express)     │
              │  • License system + JWT       │
              │  • Campaign queue             │
              │  • Daily quota enforcement    │
              │  • Admin APIs                 │
              └─────┬───────────────────┬─────┘
                    │                   │
       ┌────────────▼──────┐   ┌────────▼─────────────────┐
       │ Admin Dashboard    │   │ Client Desktop App        │
       │ (web)              │   │ (Electron — installer)    │
       │  • Login           │   │  • License activation     │
       │  • Create licenses │   │  • Device fingerprint     │
       │  • Reset / revoke  │   │  • WhatsApp Web client    │
       │  • Monitor         │   │  • Excel/CSV import       │
       └────────────────────┘   │  • Queue worker           │
                                └──────────────────────────┘
```

**Strict separation enforced:**
- Customer machine stores ONLY: license key, JWT (short-lived, rotating), server URL, and the WhatsApp Web puppeteer profile.
- All campaigns, contacts, queue state, quotas, and licenses live exclusively on the server.
- Every client→server request is authenticated with a JWT that re-validates the bound device on every call.

---

## API surface

### Public
| Method | Path                      | Purpose                          |
|--------|---------------------------|----------------------------------|
| GET    | `/api/health`             | Health check                     |
| POST   | `/api/license/activate`   | Bind license to device → JWT     |
| POST   | `/api/license/validate`   | Refresh JWT / check status       |
| POST   | `/api/admin/login`        | Admin login → JWT                |

### Client (requires client JWT)
| Method | Path                          | Purpose                 |
|--------|-------------------------------|-------------------------|
| GET    | `/api/license/me`             | License info            |
| POST   | `/api/campaign/start`         | Create + queue campaign |
| GET    | `/api/campaign`               | List my campaigns       |
| GET    | `/api/campaign/status?id=`    | Get one (server-spec)   |
| GET    | `/api/campaign/:id`           | Get one                 |
| PATCH  | `/api/campaign/:id/status`    | Pause / resume          |
| DELETE | `/api/campaign/:id`           | Delete                  |
| GET    | `/api/campaign/:id/next`      | Worker: claim next job  |
| POST   | `/api/campaign/:id/report`    | Worker: report result   |

### Admin (requires admin JWT)
| Method | Path                                       | Purpose         |
|--------|--------------------------------------------|-----------------|
| GET    | `/api/admin/stats`                         | License counters|
| GET    | `/api/admin/licenses?status=&q=`           | List licenses   |
| GET    | `/api/admin/campaigns?license_key=`        | All campaigns   |
| POST   | `/api/admin/create-license`                | Create license(s)|
| PATCH  | `/api/admin/license/:key/revoke`           | Revoke          |
| PATCH  | `/api/admin/license/:key/reset-device`     | Unbind device   |
| POST   | `/api/admin/reset-device`                  | Unbind (body form) |

---

## 1. Run the backend locally

### Prerequisites
- Node.js 18+
- MongoDB — either local (`mongod`) or a free MongoDB Atlas cluster

### Steps
```bash
cd server
cp .env.example .env
```

Edit `server/.env`:
```
MONGO_URI=mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/whatsapp_saas
JWT_SECRET=<generate with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))">
ADMIN_JWT_SECRET=<another long random string>
ADMIN_EMAIL=admin@yourdomain.com
ADMIN_PASSWORD=<strong password>
CORS_ORIGINS=http://localhost:3000
```

```bash
npm install
npm run seed:admin     # creates the admin user from .env
npm start              # → http://localhost:4000
```

Verify:
```bash
curl http://localhost:4000/api/health
# {"ok":true,"ts":...,"version":"2.0.0"}
```

---

## 2. Deploy the backend to the cloud

### Option A — Render.com (recommended for fastest start)
1. Push this repo to GitHub.
2. In Render, click **New → Blueprint**, point it at the repo. Render will read `render.yaml` automatically.
3. Set the secrets that Render asks for:
   - `MONGO_URI` — your Atlas connection string
   - `ADMIN_EMAIL`, `ADMIN_PASSWORD` — initial admin
   - `CORS_ORIGINS` — your dashboard URL, e.g. `https://admin.yourdomain.com`
4. Deploy. Render gives you a public URL like `https://whatsapp-saas-api.onrender.com`.
5. SSH into the deploy or open Render's shell and run:
   ```bash
   cd server && npm run seed:admin
   ```
   (Or run it once locally pointing at the same Atlas DB.)

### Option B — Any VPS (Ubuntu / DigitalOcean / Hetzner)
```bash
# On the VPS
git clone <your-repo> && cd whatsapp-saas-v2
cd server && cp .env.example .env && nano .env   # set production values

npm install
npm run seed:admin

# Persistent process via PM2
sudo npm install -g pm2
pm2 start ../ecosystem.config.js
pm2 save && pm2 startup    # auto-start on reboot
```

Put nginx in front for HTTPS:
```nginx
server {
  listen 443 ssl http2;
  server_name api.yourdomain.com;
  # ssl_certificate ... (use certbot)

  location / {
    proxy_pass http://127.0.0.1:4000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}
```

### Option C — Docker
```bash
docker build -t whatsapp-saas-api .
docker run -d --name wa-api -p 4000:4000 \
  -e MONGO_URI="mongodb+srv://..." \
  -e JWT_SECRET="..." \
  -e ADMIN_JWT_SECRET="..." \
  -e ADMIN_EMAIL="admin@you.com" \
  -e ADMIN_PASSWORD="..." \
  -e CORS_ORIGINS="https://admin.yourdomain.com" \
  whatsapp-saas-api
```

---

## 3. Run the admin dashboard

It's a static SPA — point it at any web server.

### Locally
```bash
cd admin-dashboard
npm start              # → http://localhost:3000/login.html
```

### Production
- Upload the contents of `admin-dashboard/` to any static host:
  - **Netlify / Vercel / Cloudflare Pages** — drag-drop the folder
  - **S3 + CloudFront** — `aws s3 sync ./admin-dashboard s3://your-bucket`
  - **nginx** — serve from `/var/www/admin/`

### Login
- URL: `/login.html`
- API URL field: paste your backend URL (e.g. `https://api.yourdomain.com`)
- Email/password: whatever you set in `ADMIN_EMAIL` / `ADMIN_PASSWORD`

### Admin actions
- **Create license** (single or bulk up to 100, with plan, validity, daily limit, customer info)
- **Revoke** any license instantly
- **Reset device** — unbinds a license so the customer can re-activate (e.g. after hardware change)
- **Monitor campaigns** across all customers
- **Search/filter** by license key, customer name/email, status

---

## 4. Build the desktop app (.exe / .dmg / AppImage)

The customer installs ONE installer. No DB, no backend on the customer machine.

### Run in dev mode
```bash
cd client-desktop
npm install
npm start              # opens the Electron window
```

### Build a Windows installer (.exe)
On Windows or via GitHub Actions:
```bash
cd client-desktop
npm install
npm run build:win
# Output: client-desktop/dist/WhatsAppCampaignPro-Setup-2.0.0.exe
```

### Build for macOS (.dmg) — must run on a Mac
```bash
npm run build:mac
# Output: client-desktop/dist/WhatsAppCampaignPro-2.0.0.dmg
```

### Build for Linux (.AppImage)
```bash
npm run build:linux
# Output: client-desktop/dist/WhatsAppCampaignPro-2.0.0.AppImage
```

### Cross-build Windows from macOS / Linux
Install `wine` first:
```bash
# macOS
brew install --cask wine-stable

# Ubuntu
sudo apt install wine64

cd client-desktop && npm run build:win
```

### Code signing (recommended for production)
Without signing, Windows shows a SmartScreen warning. To fix:
1. Buy a code-signing certificate (e.g. Sectigo, DigiCert).
2. Set env vars before building:
   ```bash
   export CSC_LINK="path/to/cert.pfx"
   export CSC_KEY_PASSWORD="cert_password"
   npm run build:win
   ```

### Customer installation flow
1. Download `WhatsAppCampaignPro-Setup-x.x.x.exe`
2. Install with one click (NSIS installer with desktop + Start menu shortcuts)
3. Launch app → enter **Server URL** (your API) and **License Key**
4. Activate → device is permanently bound to this license
5. Connect WhatsApp by scanning QR
6. Create a campaign:
   - Type message with `{{name}}`, `{{phone}}`, or any custom Excel column
   - Either upload `.xlsx` / `.csv` OR paste contacts manually
   - Set delay range (min 5 seconds, default 8–20)
7. Start sending — desktop pulls jobs from the server one at a time

---

## Excel/CSV format

Required column: `phone` (or `mobile`, `number`, `whatsapp`, `tel`).
Optional: `name` (or `full name`, `contact`).
Any other column becomes a template variable usable as `{{column_name}}`.

Example `contacts.xlsx`:
| phone         | name    | company  |
|---------------|---------|----------|
| 201001234567  | Ahmed   | Acme Co  |
| 201112223344  | Sara    | Globex   |

Template:
```
Hi {{name}}, your demo with {{company}} is confirmed.
```

---

## Security checklist (before going live)

- [ ] Replace `JWT_SECRET` and `ADMIN_JWT_SECRET` with long random strings
- [ ] Run API behind HTTPS (Cloudflare / nginx + certbot / Render auto-TLS)
- [ ] Set `CORS_ORIGINS` to ONLY your admin dashboard URL — not `*`
- [ ] Lock MongoDB Atlas IP allowlist to your server IPs only
- [ ] Use a strong `ADMIN_PASSWORD` and rotate it periodically
- [ ] Add Cloudflare in front of `/api/admin/*` for extra IP filtering
- [ ] Consider increasing `HARD_MIN_DELAY_SEC` to 10+ to reduce ban risk
- [ ] Code-sign the desktop installer (otherwise Windows SmartScreen blocks it)

---

## Anti-ban guidelines (READ THIS)

WhatsApp Web is unofficial. Bulk sending without these precautions = account banned.

1. **Warm new numbers slowly** — first day: 50 messages. Week 1: max 200/day. Then scale.
2. **Random delays** — the system enforces `HARD_MIN_DELAY_SEC` (default 5s, recommend 10s+). Higher = safer.
3. **Daily quota** — set `max_messages_per_day` per license conservatively (server enforces it).
4. **Only message opted-in users** — cold-blasting unconsented numbers gets banned within hours.
5. **Vary message content** — using `{{name}}` and template vars helps; identical messages trigger spam detection faster.
6. **No links in first messages to new contacts** — adds risk.
7. **Use a business number** (not personal). Recovery is easier if banned.

---

## Troubleshooting

**"License is already bound to another device"**
→ Admin: open dashboard → find the license → click **Reset device** → customer can re-activate.

**Desktop says `REACTIVATION_REQUIRED`**
→ JWT expired and refresh failed (license revoked / expired / re-bound). Customer logs out and re-activates.

**QR code never appears**
→ Puppeteer/Chromium failed to download during `npm install`. On Linux, install:
```bash
sudo apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libxss1 libasound2 \
  libxshmfence1 libgbm1 libdrm2 libxkbcommon0 libpangocairo-1.0-0 libcairo2 \
  libpango-1.0-0 libgtk-3-0
```

**Backend on Render sleeps / cold starts**
→ Free tier sleeps after 15 min idle. Upgrade to "Starter" ($7/mo) or use a different host. Set up a cron-job.org ping every 10 min to keep awake on free tier.

**Excel parsing returns 0 contacts**
→ Make sure the first row contains a header named `phone` (or one of the alternatives). Phones must be at least 7 digits. International format without `+`.

---

## Compliance reminder

This software is a tool. You are responsible for ensuring every recipient
has opted in and that your usage complies with local law (GDPR, CCPA, telecom regulations)
and WhatsApp's Terms of Service. For high-volume legitimate marketing,
consider migrating to the **WhatsApp Business API** (Meta-approved) — the
codebase here can be adapted by replacing `whatsapp.service.js`.

---

## License model summary

| Field                   | Notes                                              |
|-------------------------|----------------------------------------------------|
| `license_key`           | `WA-XXXX-XXXX-XXXX-XXXX` (Crockford-style alphabet) |
| `device_fingerprint`    | SHA-256 of MAC + hostname + CPU + RAM + OS         |
| `expires_at`            | Hard expiry; auto-flips status to `expired`        |
| `status`                | `inactive` → `active` → `expired` / `revoked`      |
| `max_messages_per_day`  | Per-license daily quota (UTC reset)                |
| `plan`                  | `basic` / `pro` / `enterprise` (informational)     |
| `customer_name/email`   | Admin reference                                    |
