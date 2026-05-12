'use strict';

/**
 * Centralised, validated environment loader.
 *
 * Production hardening notes:
 * - This module NEVER throws on missing variables. It logs warnings and
 *   exposes `env.MISSING` so other modules (auth, controllers) can decide
 *   what to do (e.g. return 503 instead of forging signatures).
 * - The reason: Render / Railway healthchecks must pass before we can debug
 *   missing variables. Crashing at boot makes the deploy invisible.
 * - Critical secrets that ARE present are still strength-checked.
 */

require('dotenv').config();

const REQUIRED = ['MONGO_URI', 'JWT_SECRET', 'ADMIN_JWT_SECRET'];
const MIN_SECRET_LEN = 24;

function readBool(v, def = false) {
  if (v == null) return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function readInt(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const missing = [];
const warnings = [];

for (const k of REQUIRED) {
  if (!process.env[k] || !String(process.env[k]).trim()) missing.push(k);
}

if (process.env.JWT_SECRET && String(process.env.JWT_SECRET).length < MIN_SECRET_LEN) {
  warnings.push(`JWT_SECRET is shorter than ${MIN_SECRET_LEN} chars — tokens are guessable`);
}
if (process.env.ADMIN_JWT_SECRET && String(process.env.ADMIN_JWT_SECRET).length < MIN_SECRET_LEN) {
  warnings.push(`ADMIN_JWT_SECRET is shorter than ${MIN_SECRET_LEN} chars — admin tokens are guessable`);
}
if (
  process.env.JWT_SECRET &&
  process.env.ADMIN_JWT_SECRET &&
  process.env.JWT_SECRET === process.env.ADMIN_JWT_SECRET
) {
  warnings.push('JWT_SECRET and ADMIN_JWT_SECRET are identical — must differ');
}

// PORT default: Render uses 10000 internally; Railway injects PORT explicitly.
const PORT = readInt(process.env.PORT, 10_000);

const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  PORT,

  MONGO_URI: process.env.MONGO_URI || '',
  MONGO_POOL_SIZE: readInt(process.env.MONGO_POOL_SIZE, 10),

  JWT_SECRET: process.env.JWT_SECRET || '',
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',

  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET || '',
  ADMIN_JWT_EXPIRES_IN: process.env.ADMIN_JWT_EXPIRES_IN || '7d',

  ADMIN_EMAIL: process.env.ADMIN_EMAIL || 'admin@local.test',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',

  CORS_ORIGINS: (process.env.CORS_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),

  LOG_LEVEL: process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),

  DEFAULT_MIN_DELAY_SEC: readInt(process.env.DEFAULT_MIN_DELAY_SEC, 8),
  DEFAULT_MAX_DELAY_SEC: readInt(process.env.DEFAULT_MAX_DELAY_SEC, 20),
  HARD_MIN_DELAY_SEC: readInt(process.env.HARD_MIN_DELAY_SEC, 5),

  WA_AUTH_STORE: (process.env.WA_AUTH_STORE || 'mongo').toLowerCase(),
  WA_AUTH_DIR: process.env.WA_AUTH_DIR || './.wa-auth',
  WA_MAX_SESSIONS: readInt(process.env.WA_MAX_SESSIONS, 50),
  WA_RECONNECT_MAX: readInt(process.env.WA_RECONNECT_MAX, 5),
  WA_QR_TTL_MS: readInt(process.env.WA_QR_TTL_MS, 60_000),
  WA_RESTORE_ON_BOOT: readBool(process.env.WA_RESTORE_ON_BOOT, true),

  RATE_GLOBAL_PER_MIN: readInt(process.env.RATE_GLOBAL_PER_MIN, 300),
  RATE_AUTH_PER_10MIN: readInt(process.env.RATE_AUTH_PER_10MIN, 10),
  RATE_SEND_PER_MIN: readInt(process.env.RATE_SEND_PER_MIN, 60),

  REQUEST_TIMEOUT_MS: readInt(process.env.REQUEST_TIMEOUT_MS, 30_000),

  TRUST_PROXY: readBool(process.env.TRUST_PROXY, true),

  // Diagnostics — used by /healthz/detailed and startup banner
  MISSING: missing,
  WARNINGS: warnings,
  CONFIG_OK: missing.length === 0 && warnings.length === 0,
});

module.exports = env;
