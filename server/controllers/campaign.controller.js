/**
 * controllers/campaign.controller.js
 *
 * v3 additions:
 *  - Accepts media, variations, speed_mode, warmup on /start
 *  - Accepts contact-level risk_level + on_whatsapp on /start
 *  - Returns media + variations to worker on /next
 *  - /skip endpoint for skipping unsafe contacts
 *  - /report endpoint includes per-contact breakdown
 *  - PATCH /:id/risk to update risk levels client-side after validation
 */
const Campaign = require('../models/campaign.model');
const queue = require('../services/queue.service');

const HARD_MIN = parseInt(process.env.HARD_MIN_DELAY_SEC || '5', 10);
const DEF_MIN  = parseInt(process.env.DEFAULT_MIN_DELAY_SEC || '8', 10);
const DEF_MAX  = parseInt(process.env.DEFAULT_MAX_DELAY_SEC || '20', 10);

const SPEED_MODE_DELAYS = {
  safe:   { min: 15, max: 30 },
  medium: { min: 8,  max: 15 },
  fast:   { min: 3,  max: 7  },
};

const normalizePhone = (p) => String(p || '').replace(/\D/g, '');

function applySpeedMode(speed_mode, dmin, dmax) {
  if (speed_mode && SPEED_MODE_DELAYS[speed_mode]) {
    return { ...SPEED_MODE_DELAYS[speed_mode], speed_mode };
  }
  return {
    min: Number.isFinite(+dmin) ? +dmin : DEF_MIN,
    max: Number.isFinite(+dmax) ? +dmax : DEF_MAX,
    speed_mode: 'custom',
  };
}

function sanitizeMedia(input) {
  if (!input || typeof input !== 'object') return null;
  const t = input.type;
  if (!['path', 'url', 'dataUrl'].includes(t)) return null;
  return {
    type: t,
    url: input.url || '',
    path: input.path || '',
    dataUrl: input.dataUrl || '',
    mime: input.mime || '',
    filename: input.filename || '',
    caption: input.caption || '',
    asDocument: !!input.asDocument,
  };
}

/** POST /api/campaign/start */
exports.start = async (req, res, next) => {
  try {
    const license = req.license;
    const {
      name,
      message_template,
      contacts = [],
      delay_min_seconds,
      delay_max_seconds,
      speed_mode,
      variations = [],
      media,
      warmup,
    } = req.body || {};

    if (!name || !message_template) {
      return res.status(400).json({ error: 'name and message_template are required' });
    }
    if (!Array.isArray(contacts) || !contacts.length) {
      return res.status(400).json({ error: 'contacts must be a non-empty array' });
    }

    const seen = new Set();
    const cleaned = [];
    for (const c of contacts) {
      const phone = normalizePhone(c.phone);
      if (!phone || phone.length < 7 || seen.has(phone)) continue;
      seen.add(phone);
      cleaned.push({
        phone,
        name: (c.name || '').toString().trim(),
        vars: c.vars && typeof c.vars === 'object' ? c.vars : {},
        risk_level:  ['green','yellow','red','unknown'].includes(c.risk_level) ? c.risk_level : 'unknown',
        on_whatsapp: c.on_whatsapp == null ? null : !!c.on_whatsapp,
        status: 'pending',
      });
    }
    if (!cleaned.length) return res.status(400).json({ error: 'No valid contacts after sanitization' });

    const speed = applySpeedMode(speed_mode, delay_min_seconds, delay_max_seconds);
    let dmin = Math.max(HARD_MIN, speed.min);
    let dmax = Math.max(dmin, speed.max);

    const cleanVariations = Array.isArray(variations)
      ? variations.map((s) => String(s || '')).filter((s) => s.trim()).slice(0, 10)
      : [];

    const cleanWarmup = warmup && typeof warmup === 'object'
      ? {
          enabled:  !!warmup.enabled,
          day1:     Math.max(1, parseInt(warmup.day1 || 50, 10)),
          day_step: Math.max(0, parseInt(warmup.day_step || 50, 10)),
          started_at: null,
        }
      : { enabled: false, day1: 50, day_step: 50, started_at: null };

    const campaign = await Campaign.create({
      license_key: license.license_key,
      name,
      message_template,
      variations: cleanVariations,
      media: sanitizeMedia(media),
      speed_mode: speed.speed_mode,
      delay_min_seconds: dmin,
      delay_max_seconds: dmax,
      warmup: cleanWarmup,
      contacts: cleaned,
      status: 'queued',
    });

    res.status(201).json({ ok: true, campaign: summary(campaign) });
  } catch (e) { next(e); }
};

/** GET /api/campaign  (list mine, lite) */
exports.list = async (req, res, next) => {
  try {
    const items = await Campaign.find({ license_key: req.license.license_key })
      .sort({ createdAt: -1 })
      .limit(100)
      .select('-contacts');
    res.json({ ok: true, campaigns: items });
  } catch (e) { next(e); }
};

/** GET /api/campaign/status?id=  OR  GET /api/campaign/:id */
exports.getOne = async (req, res, next) => {
  try {
    const id = req.params.id || req.query.id;
    if (!id) return res.status(400).json({ error: 'id required' });

    const c = await Campaign.findOne({ _id: id, license_key: req.license.license_key });
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ ok: true, campaign: c });
  } catch (e) { next(e); }
};

/** GET /api/campaign/:id/report — sent / failed / skipped breakdown */
exports.report = async (req, res, next) => {
  try {
    const c = await Campaign.findOne({
      _id: req.params.id, license_key: req.license.license_key,
    });
    if (!c) return res.status(404).json({ error: 'Campaign not found' });

    const buckets = { sent: [], failed: [], skipped: [], pending: [] };
    for (const ct of c.contacts) {
      const item = {
        phone: ct.phone,
        name: ct.name,
        risk_level: ct.risk_level,
        sent_at: ct.sent_at,
        error: ct.error || '',
      };
      if (buckets[ct.status]) buckets[ct.status].push(item);
    }
    res.json({
      ok: true,
      campaign: { _id: c._id, name: c.name, status: c.status, progress: c.progress },
      buckets,
    });
  } catch (e) { next(e); }
};

/** PATCH /api/campaign/:id/status  { status: 'paused' | 'running' | 'queued' } */
exports.updateStatus = async (req, res, next) => {
  try {
    const { status } = req.body || {};
    if (!['paused', 'running', 'queued'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const c = await Campaign.findOneAndUpdate(
      { _id: req.params.id, license_key: req.license.license_key },
      { status }, { new: true }
    );
    if (!c) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ ok: true, campaign: summary(c) });
  } catch (e) { next(e); }
};

/** PATCH /api/campaign/:id/risk  { updates: [{phone, risk_level, on_whatsapp}] } */
exports.updateRisk = async (req, res, next) => {
  try {
    const { updates } = req.body || {};
    if (!Array.isArray(updates) || !updates.length) {
      return res.status(400).json({ error: 'updates array required' });
    }
    const c = await Campaign.findOne({
      _id: req.params.id, license_key: req.license.license_key,
    });
    if (!c) return res.status(404).json({ error: 'Campaign not found' });

    const map = new Map(updates.map((u) => [normalizePhone(u.phone), u]));
    let touched = 0;
    for (const ct of c.contacts) {
      const u = map.get(ct.phone);
      if (!u) continue;
      if (['green', 'yellow', 'red', 'unknown'].includes(u.risk_level)) {
        ct.risk_level = u.risk_level; touched++;
      }
      if (typeof u.on_whatsapp === 'boolean') ct.on_whatsapp = u.on_whatsapp;
    }
    await c.save();
    res.json({ ok: true, touched, campaign: summary(c) });
  } catch (e) { next(e); }
};

/** DELETE /api/campaign/:id */
exports.remove = async (req, res, next) => {
  try {
    const r = await Campaign.deleteOne({ _id: req.params.id, license_key: req.license.license_key });
    if (!r.deletedCount) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ ok: true });
  } catch (e) { next(e); }
};

// ---------- Worker endpoints ----------

/** GET /api/campaign/:id/next */
exports.next = async (req, res, next) => {
  try {
    const result = await queue.claimNextJob(req.license.license_key, req.params.id);

    if (result === null) return res.json({ ok: true, job: null });
    if (result.error) {
      return res.json({ ok: true, job: null, reason: result.error, limit: result.limit, warmup: result.warmup });
    }

    const { campaign, contact } = result;
    res.json({
      ok: true,
      job: {
        campaign_id: campaign._id,
        contact_id: contact._id,
        phone: contact.phone,
        name: contact.name,
        vars: contact.vars,
        risk_level: contact.risk_level,
        message_template: campaign.message_template,
        variations: campaign.variations || [],
        media: campaign.media || null,
        delay_min_seconds: campaign.delay_min_seconds,
        delay_max_seconds: campaign.delay_max_seconds,
        speed_mode: campaign.speed_mode,
      },
    });
  } catch (e) { next(e); }
};

/** POST /api/campaign/:id/report  { contact_id, success, error } */
exports.reportJob = async (req, res, next) => {
  try {
    const { contact_id, success, error = '' } = req.body || {};
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });

    const updated = success
      ? await queue.completeJob(req.license.license_key, req.params.id, contact_id)
      : await queue.failJob(req.license.license_key, req.params.id, contact_id, error);

    if (!updated) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true, progress: updated.progress, status: updated.status });
  } catch (e) { next(e); }
};

/** POST /api/campaign/:id/skip  { contact_id, reason } */
exports.skip = async (req, res, next) => {
  try {
    const { contact_id, reason = 'risk' } = req.body || {};
    if (!contact_id) return res.status(400).json({ error: 'contact_id required' });
    const updated = await queue.skipJob(req.license.license_key, req.params.id, contact_id, reason);
    if (!updated) return res.status(404).json({ error: 'Job not found' });
    res.json({ ok: true, progress: updated.progress, status: updated.status });
  } catch (e) { next(e); }
};

// ---------- helpers ----------
function summary(c) {
  return {
    _id: c._id,
    name: c.name,
    status: c.status,
    progress: c.progress,
    delay_min_seconds: c.delay_min_seconds,
    delay_max_seconds: c.delay_max_seconds,
    speed_mode: c.speed_mode,
    has_media: !!c.media,
    variations_count: (c.variations || []).length,
    warmup: c.warmup,
    sent_today: c.sent_today,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
