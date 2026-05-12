'use strict';

const jwt = require('jsonwebtoken');
const env = require('../config/env');
const License = require('../models/license.model');
const generateLicenseKey = require('../utils/generateLicenseKey');

function signClientToken(licenseKey, fingerprint) {
  return jwt.sign(
    { license_key: licenseKey, fp: fingerprint },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN }
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

async function createLicense(input) {
  const days = Math.max(parseInt(input.days_valid, 10) || 30, 1);
  return License.create({
    license_key: generateLicenseKey('WA'),
    plan: input.plan || 'basic',
    max_messages_per_day: input.max_messages_per_day || 500,
    customer_name: input.customer_name || '',
    customer_email: input.customer_email || '',
    notes: input.notes || '',
    expires_at: new Date(Date.now() + days * 86_400_000),
  });
}

module.exports = { signClientToken, publicView, createLicense };
