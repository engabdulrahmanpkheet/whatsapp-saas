'use strict';

/**
 * Auth middleware.
 *
 * Production hardening notes:
 * - If JWT secrets aren't configured we DO NOT silently accept tokens.
 *   We return 503 SERVICE_UNAVAILABLE so misconfiguration is obvious.
 * - DB-dependent paths (clientAuth) return 503 if Mongo is currently down,
 *   instead of hanging on a buffered query.
 */

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const License = require('../models/license.model');
const { isHealthy } = require('../config/db');
const { unauthorized, forbidden, AppError } = require('../utils/AppError');

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

function unavailable(reason) {
  return new AppError(reason, 503, 'SERVICE_UNAVAILABLE');
}

function adminAuth(req, _res, next) {
  if (!env.ADMIN_JWT_SECRET) return next(unavailable('Admin auth not configured'));
  const token = bearer(req);
  if (!token) return next(unauthorized('Missing token'));
  try {
    const payload = jwt.verify(token, env.ADMIN_JWT_SECRET);
    if (!payload?.adminId) return next(unauthorized('Invalid token'));
    req.admin = payload;
    return next();
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
}

async function clientAuth(req, _res, next) {
  if (!env.JWT_SECRET) return next(unavailable('Client auth not configured'));
  if (!isHealthy()) return next(unavailable('Database temporarily unavailable'));

  const token = bearer(req);
  if (!token) return next(unauthorized('Missing token'));

  let payload;
  try {
    payload = jwt.verify(token, env.JWT_SECRET);
  } catch {
    return next(unauthorized('Invalid or expired token'));
  }
  if (!payload?.license_key || !payload?.fp) {
    return next(unauthorized('Invalid token payload'));
  }

  const license = await License.findOne({ license_key: payload.license_key });
  if (!license) return next(forbidden('License not found'));

  license.refreshStatus();
  if (license.isModified('status')) await license.save();

  if (license.status === 'revoked') return next(forbidden('License revoked'));
  if (license.status === 'expired') return next(forbidden('License expired'));
  if (license.status !== 'active') return next(forbidden('License inactive'));
  if (license.device_fingerprint !== payload.fp) {
    return next(forbidden('Token does not match bound device'));
  }

  License.updateOne({ _id: license._id }, { $set: { last_seen_at: new Date() } }).catch(() => {});
  req.license = license;
  next();
}

module.exports = { adminAuth, clientAuth };
