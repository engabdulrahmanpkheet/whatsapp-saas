/**
 * controllers/license.controller.js
 */
const jwt = require('jsonwebtoken');
const License = require('../models/license.model');

function signClientToken(licenseKey, fingerprint) {
  return jwt.sign(
    { license_key: licenseKey, fp: fingerprint },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '12h' }
  );
}

function publicView(l) {
  return {
    license_key: l.license_key,
    plan: l.plan,
    status: l.status,
    expires_at: l.expires_at,
    activated_at: l.activated_at,
    max_messages_per_day: l.max_messages_per_day,
  };
}

/**
 * POST /api/license/activate
 * Body: { license_key, device_fingerprint }
 *
 * Returns: { ok, token, license }
 *  - First-time activation binds device.
 *  - Same device → idempotent (re-issues token).
 *  - Different device → 403.
 */
exports.activateLicense = async (req, res, next) => {
  try {
    const { license_key, device_fingerprint } = req.body || {};
    if (!license_key || !device_fingerprint) {
      return res.status(400).json({ error: 'license_key and device_fingerprint are required' });
    }

    const key = String(license_key).toUpperCase().trim();
    const fp  = String(device_fingerprint).trim();

    const license = await License.findOne({ license_key: key });
    if (!license) return res.status(404).json({ error: 'License not found' });

    license.refreshStatus();

    if (license.status === 'revoked') return res.status(403).json({ error: 'License revoked' });
    if (license.status === 'expired') {
      await license.save();
      return res.status(403).json({ error: 'License expired' });
    }

    if (!license.device_fingerprint) {
      license.device_fingerprint = fp;
      license.activated_at = new Date();
      license.status = 'active';
      await license.save();
    } else if (license.device_fingerprint !== fp) {
      return res.status(403).json({ error: 'License is already bound to another device' });
    } else {
      if (license.status !== 'active') license.status = 'active';
      await license.save();
    }

    const token = signClientToken(license.license_key, fp);
    return res.json({ ok: true, token, license: publicView(license) });
  } catch (e) {
    next(e);
  }
};

/**
 * POST /api/license/validate
 * Body: { license_key, device_fingerprint }
 *
 * Used by the desktop app:
 *  - on startup
 *  - periodically (every X minutes)
 * Returns a fresh token if valid (token rotation).
 */
exports.validateLicense = async (req, res, next) => {
  try {
    const { license_key, device_fingerprint } = req.body || {};
    if (!license_key || !device_fingerprint) {
      return res.status(400).json({ error: 'license_key and device_fingerprint are required' });
    }

    const key = String(license_key).toUpperCase().trim();
    const fp  = String(device_fingerprint).trim();

    const license = await License.findOne({ license_key: key });
    if (!license) return res.status(404).json({ error: 'License not found' });

    license.refreshStatus();
    if (license.isModified('status')) await license.save();

    const ok =
      license.status === 'active' &&
      license.device_fingerprint === fp;

    if (!ok) {
      return res.status(403).json({
        ok: false,
        status: license.status,
        error:
          license.status === 'expired' ? 'License expired'
          : license.status === 'revoked' ? 'License revoked'
          : license.device_fingerprint && license.device_fingerprint !== fp
            ? 'License bound to another device'
            : 'License not active',
      });
    }

    license.last_seen_at = new Date();
    await license.save();

    const token = signClientToken(license.license_key, fp);
    return res.json({ ok: true, token, license: publicView(license) });
  } catch (e) {
    next(e);
  }
};

/** GET /api/license/me  (clientAuth) */
exports.me = async (req, res) => {
  return res.json({ ok: true, license: publicView(req.license) });
};
