/**
 * controllers/admin.controller.js
 */
const jwt = require('jsonwebtoken');
const Admin = require('../models/admin.model');
const License = require('../models/license.model');
const Campaign = require('../models/campaign.model');
const generateLicenseKey = require('../utils/generateLicenseKey');

/** POST /api/admin/login */
exports.login = async (req, res, next) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) return res.status(400).json({ error: 'email and password required' });

    const admin = await Admin.findOne({ email: String(email).toLowerCase().trim() });
    if (!admin) return res.status(401).json({ error: 'Invalid credentials' });

    const ok = await admin.verifyPassword(password);
    if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

    admin.last_login_at = new Date();
    await admin.save();

    const token = jwt.sign(
      { adminId: admin._id.toString(), email: admin.email, role: admin.role },
      process.env.ADMIN_JWT_SECRET,
      { expiresIn: process.env.ADMIN_JWT_EXPIRES_IN || '7d' }
    );

    res.json({ ok: true, token, admin: { email: admin.email, role: admin.role } });
  } catch (e) { next(e); }
};

/** POST /api/admin/create-license  (single OR bulk via `count`) */
exports.createLicense = async (req, res, next) => {
  try {
    const {
      plan = 'basic',
      days_valid = 30,
      max_messages_per_day = 500,
      customer_name = '',
      customer_email = '',
      notes = '',
      count = 1,
    } = req.body || {};

    const safeCount = Math.min(Math.max(parseInt(count, 10) || 1, 1), 100);
    const days = Math.max(parseInt(days_valid, 10) || 30, 1);
    const expires_at = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    const created = [];
    for (let i = 0; i < safeCount; i++) {
      const lic = await License.create({
        license_key: generateLicenseKey('WA'),
        plan,
        max_messages_per_day,
        customer_name,
        customer_email,
        expires_at,
        notes,
      });
      created.push(lic);
    }

    res.status(201).json({ ok: true, count: created.length, licenses: created });
  } catch (e) { next(e); }
};

/** GET /api/admin/licenses?status=&q= */
exports.listLicenses = async (req, res, next) => {
  try {
    const { status, q } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (q) {
      const safe = String(q).toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      filter.$or = [
        { license_key: { $regex: safe, $options: 'i' } },
        { customer_name:  { $regex: q, $options: 'i' } },
        { customer_email: { $regex: q, $options: 'i' } },
      ];
    }

    const licenses = await License.find(filter).sort({ createdAt: -1 }).limit(500);
    for (const lic of licenses) {
      lic.refreshStatus();
      if (lic.isModified('status')) await lic.save();
    }
    res.json({ ok: true, count: licenses.length, licenses });
  } catch (e) { next(e); }
};

/** PATCH /api/admin/license/:key/revoke */
exports.revokeLicense = async (req, res, next) => {
  try {
    const key = String(req.params.key).toUpperCase();
    const lic = await License.findOneAndUpdate(
      { license_key: key },
      { status: 'revoked' },
      { new: true }
    );
    if (!lic) return res.status(404).json({ error: 'License not found' });
    res.json({ ok: true, license: lic });
  } catch (e) { next(e); }
};

/** POST /api/admin/reset-device  { license_key }  (also accepts /:key/reset-device) */
exports.resetDevice = async (req, res, next) => {
  try {
    const key = String(
      req.params.key || (req.body && req.body.license_key) || ''
    ).toUpperCase();
    if (!key) return res.status(400).json({ error: 'license_key required' });

    const lic = await License.findOneAndUpdate(
      { license_key: key },
      { device_fingerprint: null, activated_at: null, status: 'inactive' },
      { new: true }
    );
    if (!lic) return res.status(404).json({ error: 'License not found' });
    res.json({ ok: true, license: lic });
  } catch (e) { next(e); }
};

/** GET /api/admin/stats */
exports.stats = async (req, res, next) => {
  try {
    const [total, active, expired, revoked, inactive, totalCampaigns] = await Promise.all([
      License.countDocuments({}),
      License.countDocuments({ status: 'active' }),
      License.countDocuments({ status: 'expired' }),
      License.countDocuments({ status: 'revoked' }),
      License.countDocuments({ status: 'inactive' }),
      Campaign.countDocuments({}),
    ]);
    res.json({
      ok: true,
      stats: { total, active, expired, revoked, inactive, totalCampaigns },
    });
  } catch (e) { next(e); }
};

/** GET /api/admin/campaigns?license_key= */
exports.listCampaigns = async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.license_key) filter.license_key = String(req.query.license_key).toUpperCase();

    const items = await Campaign.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .select('-contacts'); // omit big array
    res.json({ ok: true, campaigns: items });
  } catch (e) { next(e); }
};
