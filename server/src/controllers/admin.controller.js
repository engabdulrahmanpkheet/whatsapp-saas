'use strict';

const jwt = require('jsonwebtoken');
const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');
const Admin = require('../models/admin.model');
const License = require('../models/license.model');
const Campaign = require('../models/campaign.model');
const SessionModel = require('../models/session.model');
const { createLicense } = require('../services/license.service');
const { bad, unauthorized, notFound, forbidden, AppError } = require('../utils/AppError');

// Lockout policy: 5 failures → 15 min lock. Resets on any successful login.
const LOGIN_FAIL_LIMIT = 5;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

exports.login = asyncHandler(async (req, res) => {
  if (!env.ADMIN_JWT_SECRET) {
    throw new AppError('Admin auth not configured (ADMIN_JWT_SECRET missing)', 503, 'SERVICE_UNAVAILABLE');
  }
  const { email, password } = req.body || {};
  if (!email || !password) throw bad('email and password required');

  const admin = await Admin.findOne({ email: String(email).toLowerCase().trim() });
  // Generic message — don't leak whether the email exists.
  if (!admin) throw unauthorized('Invalid credentials');

  if (admin.isLocked()) {
    const minutes = Math.ceil((admin.locked_until.getTime() - Date.now()) / 60_000);
    throw forbidden(`Account locked. Try again in ${minutes} minute(s).`, 'ACCOUNT_LOCKED');
  }

  const ok = await admin.verifyPassword(password);
  if (!ok) {
    admin.failed_login_count = (admin.failed_login_count || 0) + 1;
    if (admin.failed_login_count >= LOGIN_FAIL_LIMIT) {
      admin.locked_until = new Date(Date.now() + LOGIN_LOCK_MS);
      admin.failed_login_count = 0;
    }
    await admin.save();
    throw unauthorized('Invalid credentials');
  }

  admin.last_login_at = new Date();
  admin.failed_login_count = 0;
  admin.locked_until = null;
  await admin.save();

  const token = jwt.sign(
    {
      adminId: admin._id.toString(),
      email: admin.email,
      role: admin.role,
      // Standard JWT claims so future verifiers can pin the audience/issuer.
      iss: 'whatsapp-saas-api',
      aud: 'admin',
    },
    env.ADMIN_JWT_SECRET,
    { expiresIn: env.ADMIN_JWT_EXPIRES_IN }
  );

  res.json({ ok: true, token, admin: { email: admin.email, role: admin.role } });
});

exports.createLicense = asyncHandler(async (req, res) => {
  const count = Math.min(Math.max(parseInt(req.body?.count, 10) || 1, 1), 100);
  const created = [];
  for (let i = 0; i < count; i++) {
    const lic = await createLicense(req.body || {});
    created.push(lic);
  }
  res.status(201).json({ ok: true, count: created.length, licenses: created });
});

exports.listLicenses = asyncHandler(async (req, res) => {
  const { status, q } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (q) {
    const safe = String(q).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.$or = [
      { license_key: { $regex: safe, $options: 'i' } },
      { customer_name: { $regex: q, $options: 'i' } },
      { customer_email: { $regex: q, $options: 'i' } },
    ];
  }
  const licenses = await License.find(filter).sort({ createdAt: -1 }).limit(500);
  for (const lic of licenses) {
    lic.refreshStatus();
    if (lic.isModified('status')) await lic.save();
  }
  res.json({ ok: true, count: licenses.length, licenses });
});

exports.revokeLicense = asyncHandler(async (req, res) => {
  const key = String(req.params.key).toUpperCase();
  const lic = await License.findOneAndUpdate(
    { license_key: key },
    { status: 'revoked' },
    { new: true }
  );
  if (!lic) throw notFound('License not found');
  res.json({ ok: true, license: lic });
});

exports.resetDevice = asyncHandler(async (req, res) => {
  const key = String(req.params.key || req.body?.license_key || '').toUpperCase();
  if (!key) throw bad('license_key required');
  const lic = await License.findOneAndUpdate(
    { license_key: key },
    { device_fingerprint: null, activated_at: null, status: 'inactive' },
    { new: true }
  );
  if (!lic) throw notFound('License not found');
  res.json({ ok: true, license: lic });
});

exports.stats = asyncHandler(async (_req, res) => {
  const [total, active, expired, revoked, inactive, totalCampaigns, totalSessions] =
    await Promise.all([
      License.countDocuments({}),
      License.countDocuments({ status: 'active' }),
      License.countDocuments({ status: 'expired' }),
      License.countDocuments({ status: 'revoked' }),
      License.countDocuments({ status: 'inactive' }),
      Campaign.countDocuments({}),
      SessionModel.countDocuments({}),
    ]);
  res.json({
    ok: true,
    stats: { total, active, expired, revoked, inactive, totalCampaigns, totalSessions },
  });
});

exports.listCampaigns = asyncHandler(async (req, res) => {
  const filter = {};
  if (req.query.license_key) filter.license_key = String(req.query.license_key).toUpperCase();
  const items = await Campaign.find(filter).sort({ createdAt: -1 }).limit(200).select('-contacts');
  res.json({ ok: true, campaigns: items });
});
