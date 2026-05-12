/**
 * middleware/auth.middleware.js
 *
 * Two distinct auth surfaces:
 *  - adminAuth   : verifies Admin JWT, signed with ADMIN_JWT_SECRET
 *  - clientAuth  : verifies Client (desktop) JWT issued at activation,
 *                  signed with JWT_SECRET, claims: { license_key, fp }
 */
const jwt = require('jsonwebtoken');
const License = require('../models/license.model');

function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : null;
}

function adminAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Missing token' });

    const payload = jwt.verify(token, process.env.ADMIN_JWT_SECRET);
    if (!payload?.adminId) return res.status(401).json({ error: 'Invalid token' });
    req.admin = payload;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

/**
 * clientAuth — protects every client (desktop) call.
 * The token is short-lived; the desktop refreshes via /license/validate.
 *
 * Token claims:
 *   { license_key, fp, iat, exp }
 *
 * On every request we re-load the license from DB and validate:
 *   - status is 'active'
 *   - expires_at not passed
 *   - device_fingerprint matches the one bound in the DB
 */
async function clientAuth(req, res, next) {
  try {
    const token = bearer(req);
    if (!token) return res.status(401).json({ error: 'Missing token' });

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    if (!payload?.license_key || !payload?.fp) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    const license = await License.findOne({ license_key: payload.license_key });
    if (!license) return res.status(403).json({ error: 'License not found' });

    license.refreshStatus();
    if (license.isModified('status')) await license.save();

    if (license.status === 'revoked') return res.status(403).json({ error: 'License revoked' });
    if (license.status === 'expired') return res.status(403).json({ error: 'License expired' });
    if (license.status !== 'active')  return res.status(403).json({ error: 'License inactive' });

    if (license.device_fingerprint !== payload.fp) {
      return res.status(403).json({ error: 'Token does not match bound device' });
    }

    // Update last_seen heartbeat (best-effort, no await)
    License.updateOne(
      { _id: license._id },
      { $set: { last_seen_at: new Date() } }
    ).catch(() => {});

    req.license = license;
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { adminAuth, clientAuth };
