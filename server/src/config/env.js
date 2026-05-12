'use strict';

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

function validate() {
  const missing = REQUIRED.filter((k) => !process.env[k] || !String(process.env[k]).trim());
  if (missing.length) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}. ` +
        `Set them in Railway → Variables (or .env locally).`
    );
  }
  for (const k of ['JWT_SECRET', 'ADMIN_JWT_SECRET']) {
    if (String(process.env[k]).length < MIN_SECRET_LEN) {
      throw new Error(
        `${k} must be at least ${MIN_SECRET_LEN} characters. ` +
          `Generate one: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
      );
    }
  }
  if (process.env.JWT_SECRET === process.env.ADMIN_JWT_SECRET) {
    throw new Error('JWT_SECRET and ADMIN_JWT_SECRET must be different values');
  }
}

validate();

const env = Object.freeze({
  NODE_ENV: process.env.NODE_ENV || 'development',
  isProd: process.env.NODE_ENV === 'production',
  PORT: readInt(process.env.PORT, 4000),

  MONGO_URI: process.env.MONGO_URI,
  MONGO_POOL_SIZE: readInt(process.env.MONGO_POOL_SIZE, 10),

  JWT_SECRET: process.env.JWT_SECRET,
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '12h',

  ADMIN_JWT_SECRET: process.env.ADMIN_JWT_SECRET,
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

  WA_AUTH_STORE: (process.env.WA_AUTH_STORE || 'mongo').toLowerCase(), // 'mongo' | 'file'
  WA_AUTH_DIR: process.env.WA_AUTH_DIR || './.wa-auth',
  WA_MAX_SESSIONS: readInt(process.env.WA_MAX_SESSIONS, 50),
  WA_RECONNECT_MAX: readInt(process.env.WA_RECONNECT_MAX, 5),
  WA_QR_TTL_MS: readInt(process.env.WA_QR_TTL_MS, 60_000),

  RATE_GLOBAL_PER_MIN: readInt(process.env.RATE_GLOBAL_PER_MIN, 300),
  RATE_AUTH_PER_10MIN: readInt(process.env.RATE_AUTH_PER_10MIN, 10),
  RATE_SEND_PER_MIN: readInt(process.env.RATE_SEND_PER_MIN, 60),

  TRUST_PROXY: readBool(process.env.TRUST_PROXY, true),
});

module.exports = env;
