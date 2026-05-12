'use strict';

const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');
const License = require('../models/license.model');
const { signClientToken, publicView } = require('../services/license.service');
const { bad, notFound, forbidden } = require('../utils/AppError');

exports.activate = asyncHandler(async (req, res) => {
  const { license_key, device_fingerprint } = req.body || {};
  if (!license_key || !device_fingerprint) {
    throw bad('license_key and device_fingerprint are required');
  }

  const key = String(license_key).toUpperCase().trim();
  const fp = String(device_fingerprint).trim();

  const license = await License.findOne({ license_key: key });
  if (!license) throw notFound('License not found');

  license.refreshStatus();

  if (license.status === 'revoked') throw forbidden('License revoked');
  if (license.status === 'expired') {
    await license.save();
    throw forbidden('License expired');
  }

  if (!license.device_fingerprint) {
    license.device_fingerprint = fp;
    license.activated_at = new Date();
    license.status = 'active';
    await license.save();
  } else if (license.device_fingerprint !== fp) {
    throw forbidden('License is already bound to another device');
  } else {
    if (license.status !== 'active') license.status = 'active';
    await license.save();
  }

  const token = signClientToken(license.license_key, fp);
  res.json({ ok: true, token, license: publicView(license) });
});

exports.validate = asyncHandler(async (req, res) => {
  const { license_key, device_fingerprint } = req.body || {};
  if (!license_key || !device_fingerprint) {
    throw bad('license_key and device_fingerprint are required');
  }
  const key = String(license_key).toUpperCase().trim();
  const fp = String(device_fingerprint).trim();

  const license = await License.findOne({ license_key: key });
  if (!license) throw notFound('License not found');

  license.refreshStatus();
  if (license.isModified('status')) await license.save();

  const ok = license.status === 'active' && license.device_fingerprint === fp;
  if (!ok) {
    const reason =
      license.status === 'expired'
        ? 'License expired'
        : license.status === 'revoked'
        ? 'License revoked'
        : license.device_fingerprint && license.device_fingerprint !== fp
        ? 'License bound to another device'
        : 'License not active';
    throw forbidden(reason);
  }

  license.last_seen_at = new Date();
  await license.save();

  const token = signClientToken(license.license_key, fp);
  res.json({ ok: true, token, license: publicView(license) });
});

exports.me = asyncHandler(async (req, res) => {
  res.json({ ok: true, license: publicView(req.license) });
});

// Touch env so lint doesn't complain in unused-vars in some configs
void env;
