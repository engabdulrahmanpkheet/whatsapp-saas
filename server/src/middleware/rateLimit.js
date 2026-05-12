'use strict';

const rateLimit = require('express-rate-limit');
const env = require('../config/env');

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.RATE_GLOBAL_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: env.RATE_AUTH_PER_10MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, error: 'Too many auth attempts. Try again later.', code: 'TOO_MANY' },
});

const sendLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: env.RATE_SEND_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => (req.license && req.license.license_key) || req.ip,
  message: { ok: false, error: 'Send rate limit exceeded', code: 'TOO_MANY' },
});

module.exports = { globalLimiter, authLimiter, sendLimiter };
