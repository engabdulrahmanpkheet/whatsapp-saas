'use strict';

/**
 * Centralised environment loader — production-safe.
 *
 * Design goals:
 *   1. NEVER throw or exit on missing / weak / malformed env. The HTTP server
 *      must boot so /healthz can answer and operators can debug.
 *   2. Categorise variables by criticality:
 *        CRITICAL      — without these the affected feature is unsafe to run.
 *                        Dependent endpoints will return 503; everything else
 *                        (including /, /healthz, /health) still works.
 *        RECOMMENDED   — should be set in production; defaults are loud.
 *        OPTIONAL      — tuning knobs; sensible defaults applied silently.
 *   3. Defensively sanitise values (trim, strip wrapping quotes) — pasting
 *      values into the Render/Railway UI commonly leaves stray "..." which
 *      otherwise silently breaks Atlas URIs and JWT secrets.
 *   4. Expose a `printStartupBanner()` so operators can immediately see what
 *      the running process actually sees, with secrets masked.
 *
 * This module has zero runtime dependencies (no logger) so it can be imported
 * from anywhere — including the logger itself — without circular issues.
 */

require('dotenv').config();

// ---------- value sanitisation ----------

/**
 * Common operator mistake on cloud dashboards: pasting a value with surrounding
 * quotes — `"mongodb+srv://..."` instead of `mongodb+srv://...`. dotenv strips
 * these locally but cloud platforms do not. Also strip whitespace.
 */
function clean(raw) {
  if (raw == null) return '';
  let v = String(raw).trim();
  if (
    (v.startsWith('"') && v.endsWith('"')) ||
    (v.startsWith("'") && v.endsWith("'"))
  ) {
    v = v.slice(1, -1).trim();
  }
  return v;
}

function readBool(raw, def = false) {
  const v = clean(raw).toLowerCase();
  if (v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(v);
}

function readInt(raw, def) {
  const v = clean(raw);
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function readList(raw, def = []) {
  const v = clean(raw);
  if (!v) return def;
  return v.split(',').map((s) => s.trim()).filter(Boolean);
}

// ---------- diagnostics collectors ----------

const missing = [];   // CRITICAL vars not set
const warnings = [];  // soft issues
const info = [];      // notable defaults applied

/**
 * Register a variable.
 *   level: 'critical' | 'recommended' | 'optional'
 */
function expect(name, value, level, hint = '') {
  const present = value !== '' && value != null;
  if (!present) {
    if (level === 'critical') missing.push(name);
    else if (level === 'recommended') {
      warnings.push(`${name} not set${hint ? ` — ${hint}` : ''}`);
    } else {
      info.push(`${name} using default`);
    }
  }
  return value;
}

// ---------- read + validate ----------

const NODE_ENV = clean(process.env.NODE_ENV) || 'development';
const isProd = NODE_ENV === 'production';

// PORT: Render injects 10000, Railway injects its own. Local dev gets 10000.
// Always honour process.env.PORT first.
const PORT = readInt(process.env.PORT, 10_000);

// --- CRITICAL: needed for the core product to be safe ---
const MONGO_URI = expect(
  'MONGO_URI',
  clean(process.env.MONGO_URI),
  'critical',
  'set the MongoDB Atlas connection string'
);

const JWT_SECRET = expect(
  'JWT_SECRET',
  clean(process.env.JWT_SECRET),
  'critical',
  'client auth will return 503 until set'
);

const ADMIN_JWT_SECRET = expect(
  'ADMIN_JWT_SECRET',
  clean(process.env.ADMIN_JWT_SECRET),
  'critical',
  'admin login will return 503 until set'
);

// --- secret strength checks (warn only — never fatal) ---
const MIN_SECRET_LEN = 24;

if (MONGO_URI) {
  if (!/^mongodb(\+srv)?:\/\//.test(MONGO_URI)) {
    warnings.push('MONGO_URI does not look like a valid mongodb:// or mongodb+srv:// URI');
  }
  if (/[<>]/.test(MONGO_URI)) {
    warnings.push('MONGO_URI contains "<" or ">" — likely a placeholder (e.g. <password>) that was not substituted');
  }
}

if (JWT_SECRET && JWT_SECRET.length < MIN_SECRET_LEN) {
  warnings.push(`JWT_SECRET is ${JWT_SECRET.length} chars — recommended at least ${MIN_SECRET_LEN}`);
}
if (ADMIN_JWT_SECRET && ADMIN_JWT_SECRET.length < MIN_SECRET_LEN) {
  warnings.push(`ADMIN_JWT_SECRET is ${ADMIN_JWT_SECRET.length} chars — recommended at least ${MIN_SECRET_LEN}`);
}
if (JWT_SECRET && ADMIN_JWT_SECRET && JWT_SECRET === ADMIN_JWT_SECRET) {
  warnings.push('JWT_SECRET and ADMIN_JWT_SECRET are identical — must differ');
}

// In production, a wildcard CORS origin is a soft footgun.
const corsRaw = clean(process.env.CORS_ORIGINS);
const CORS_ORIGINS = corsRaw ? readList(corsRaw) : ['*'];
if (isProd && CORS_ORIGINS.includes('*')) {
  warnings.push('CORS_ORIGINS is "*" in production — set explicit origins for tighter security');
}

// --- RECOMMENDED in production ---
const ADMIN_EMAIL = expect(
  'ADMIN_EMAIL',
  clean(process.env.ADMIN_EMAIL),
  isProd ? 'recommended' : 'optional',
  'used by `npm run seed:admin`'
) || 'admin@local.test';

const ADMIN_PASSWORD = expect(
  'ADMIN_PASSWORD',
  clean(process.env.ADMIN_PASSWORD),
  isProd ? 'recommended' : 'optional',
  'used by `npm run seed:admin`; admin user cannot be seeded without it'
);

// --- OPTIONAL: tunables, all have safe defaults ---
const env = ({
  NODE_ENV,
  isProd,
  PORT,

  MONGO_URI,
  MONGO_POOL_SIZE: readInt(process.env.MONGO_POOL_SIZE, 10),

  JWT_SECRET,
  JWT_EXPIRES_IN: clean(process.env.JWT_EXPIRES_IN) || '12h',

  ADMIN_JWT_SECRET,
  ADMIN_JWT_EXPIRES_IN: clean(process.env.ADMIN_JWT_EXPIRES_IN) || '7d',

  ADMIN_EMAIL,
  ADMIN_PASSWORD,

  CORS_ORIGINS,

  LOG_LEVEL: (clean(process.env.LOG_LEVEL) || (isProd ? 'info' : 'debug')).toLowerCase(),

  DEFAULT_MIN_DELAY_SEC: readInt(process.env.DEFAULT_MIN_DELAY_SEC, 8),
  DEFAULT_MAX_DELAY_SEC: readInt(process.env.DEFAULT_MAX_DELAY_SEC, 20),
  HARD_MIN_DELAY_SEC: readInt(process.env.HARD_MIN_DELAY_SEC, 5),

  WA_AUTH_STORE: (clean(process.env.WA_AUTH_STORE) || 'mongo').toLowerCase(),
  WA_AUTH_DIR: clean(process.env.WA_AUTH_DIR) || './.wa-auth',
  WA_MAX_SESSIONS: readInt(process.env.WA_MAX_SESSIONS, 50),
  WA_RECONNECT_MAX: readInt(process.env.WA_RECONNECT_MAX, 5),
  WA_QR_TTL_MS: readInt(process.env.WA_QR_TTL_MS, 60_000),
  WA_RESTORE_ON_BOOT: readBool(process.env.WA_RESTORE_ON_BOOT, true),

  RATE_GLOBAL_PER_MIN: readInt(process.env.RATE_GLOBAL_PER_MIN, 300),
  RATE_AUTH_PER_10MIN: readInt(process.env.RATE_AUTH_PER_10MIN, 10),
  RATE_SEND_PER_MIN: readInt(process.env.RATE_SEND_PER_MIN, 60),

  REQUEST_TIMEOUT_MS: readInt(process.env.REQUEST_TIMEOUT_MS, 30_000),

  TRUST_PROXY: readBool(process.env.TRUST_PROXY, true),

  // ---- diagnostics ----
  MISSING: Object.freeze(missing.slice()),
  WARNINGS: Object.freeze(warnings.slice()),
  INFO: Object.freeze(info.slice()),
  CONFIG_OK: missing.length === 0 && warnings.length === 0,
});

// Attach helpers BEFORE freezing.
env.printStartupBanner = () => printStartupBanner();
env.getDiagnostics = () => getDiagnostics();

Object.freeze(env);

// ---------- diagnostics helpers ----------

function mask(value) {
  if (!value) return '(not set)';
  const s = String(value);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`;
}

function maskMongoUri(uri) {
  if (!uri) return '(not set)';
  // mongodb+srv://user:pass@host/db?opts
  return uri.replace(/(mongodb(?:\+srv)?:\/\/)([^:@\/]+)(?::([^@\/]+))?@/i, (_m, scheme, user) => {
    return `${scheme}${user}:***@`;
  });
}

/**
 * Returns a safe-to-log object summarising what the process actually loaded.
 * Used by /healthz/detailed.
 */
function getDiagnostics() {
  return {
    NODE_ENV: env.NODE_ENV,
    PORT: env.PORT,
    LOG_LEVEL: env.LOG_LEVEL,
    MONGO_URI: maskMongoUri(env.MONGO_URI),
    JWT_SECRET: mask(env.JWT_SECRET),
    ADMIN_JWT_SECRET: mask(env.ADMIN_JWT_SECRET),
    JWT_EXPIRES_IN: env.JWT_EXPIRES_IN,
    ADMIN_JWT_EXPIRES_IN: env.ADMIN_JWT_EXPIRES_IN,
    ADMIN_EMAIL: env.ADMIN_EMAIL,
    ADMIN_PASSWORD: env.ADMIN_PASSWORD ? '(set)' : '(not set)',
    CORS_ORIGINS: env.CORS_ORIGINS,
    TRUST_PROXY: env.TRUST_PROXY,
    REQUEST_TIMEOUT_MS: env.REQUEST_TIMEOUT_MS,
    rate_limits: {
      global_per_min: env.RATE_GLOBAL_PER_MIN,
      auth_per_10min: env.RATE_AUTH_PER_10MIN,
      send_per_min: env.RATE_SEND_PER_MIN,
    },
    whatsapp: {
      auth_store: env.WA_AUTH_STORE,
      max_sessions: env.WA_MAX_SESSIONS,
      reconnect_max: env.WA_RECONNECT_MAX,
      restore_on_boot: env.WA_RESTORE_ON_BOOT,
    },
    missing: env.MISSING,
    warnings: env.WARNINGS,
    config_ok: env.CONFIG_OK,
  };
}

/**
 * Pretty multi-line banner printed at startup. Uses console.log so it works
 * even before the logger is initialised. Secrets are masked.
 */
function printStartupBanner() {
  const lines = [];
  lines.push('━'.repeat(64));
  lines.push('  WhatsApp SaaS API — startup diagnostics');
  lines.push('━'.repeat(64));
  lines.push(`  env:             ${env.NODE_ENV}`);
  lines.push(`  port:            ${env.PORT}`);
  lines.push(`  node:            ${process.version}`);
  lines.push(`  log level:       ${env.LOG_LEVEL}`);
  lines.push(`  mongo:           ${maskMongoUri(env.MONGO_URI)}`);
  lines.push(`  jwt secret:      ${mask(env.JWT_SECRET)}`);
  lines.push(`  admin secret:    ${mask(env.ADMIN_JWT_SECRET)}`);
  lines.push(`  cors origins:    ${env.CORS_ORIGINS.join(', ')}`);
  lines.push(`  trust proxy:     ${env.TRUST_PROXY}`);

  if (env.MISSING.length) {
    lines.push('');
    lines.push('  ⚠ MISSING (dependent endpoints will return 503):');
    for (const m of env.MISSING) lines.push(`     - ${m}`);
  }
  if (env.WARNINGS.length) {
    lines.push('');
    lines.push('  ⚠ Warnings:');
    for (const w of env.WARNINGS) lines.push(`     - ${w}`);
  }
  if (!env.MISSING.length && !env.WARNINGS.length) {
    lines.push('');
    lines.push('  ✅ Configuration OK');
  }
  lines.push('━'.repeat(64));

  // Plain console so the banner is readable even in JSON-log mode.
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
}

module.exports = env;
