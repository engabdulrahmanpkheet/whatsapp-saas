'use strict';

const asyncHandler = require('../utils/asyncHandler');
const env = require('../config/env');
const Campaign = require('../models/campaign.model');
const queue = require('../services/queue.service');
const { bad, notFound } = require('../utils/AppError');
const { normalize: normalizePhone } = require('../utils/phone');

const SPEED_MODE_DELAYS = {
  safe: { min: 15, max: 30 },
  medium: { min: 8, max: 15 },
  fast: { min: 3, max: 7 },
};

function applySpeedMode(speed_mode, dmin, dmax) {
  if (speed_mode && SPEED_MODE_DELAYS[speed_mode]) {
    return { ...SPEED_MODE_DELAYS[speed_mode], speed_mode };
  }
  return {
    min: Number.isFinite(+dmin) ? +dmin : env.DEFAULT_MIN_DELAY_SEC,
    max: Number.isFinite(+dmax) ? +dmax : env.DEFAULT_MAX_DELAY_SEC,
    speed_mode: 'custom',
  };
}

function sanitizeMedia(input) {
  if (!input || typeof input !== 'object') return null;
  if (!['path', 'url', 'dataUrl'].includes(input.type)) return null;
  return {
    type: input.type,
    url: input.url || '',
    path: input.path || '',
    dataUrl: input.dataUrl || '',
    mime: input.mime || '',
    filename: input.filename || '',
    caption: input.caption || '',
    asDocument: !!input.asDocument,
  };
}

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

exports.start = asyncHandler(async (req, res) => {
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

  if (!name || !message_template) throw bad('name and message_template are required');
  if (!Array.isArray(contacts) || !contacts.length) {
    throw bad('contacts must be a non-empty array');
  }

  const seen = new Set();
  const cleaned = [];
  for (const c of contacts) {
    const phone = normalizePhone(c.phone);
    if (!phone || phone.length < 7 || seen.has(phone)) continue;
    seen.add(phone);
    cleaned.push({
      phone,
      name: String(c.name || '').trim(),
      vars: c.vars && typeof c.vars === 'object' ? c.vars : {},
      risk_level: ['green', 'yellow', 'red', 'unknown'].includes(c.risk_level)
        ? c.risk_level
        : 'unknown',
      on_whatsapp: c.on_whatsapp == null ? null : !!c.on_whatsapp,
      status: 'pending',
    });
  }
  if (!cleaned.length) throw bad('No valid contacts after sanitization');

  const speed = applySpeedMode(speed_mode, delay_min_seconds, delay_max_seconds);
  const dmin = Math.max(env.HARD_MIN_DELAY_SEC, speed.min);
  const dmax = Math.max(dmin, speed.max);

  const cleanVariations = Array.isArray(variations)
    ? variations.map((s) => String(s || '')).filter((s) => s.trim()).slice(0, 10)
    : [];

  const cleanWarmup =
    warmup && typeof warmup === 'object'
      ? {
          enabled: !!warmup.enabled,
          day1: Math.max(1, parseInt(warmup.day1 || 50, 10)),
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
});

exports.list = asyncHandler(async (req, res) => {
  const items = await Campaign.find({ license_key: req.license.license_key })
    .sort({ createdAt: -1 })
    .limit(100)
    .select('-contacts');
  res.json({ ok: true, campaigns: items });
});

exports.getOne = asyncHandler(async (req, res) => {
  const id = req.params.id || req.query.id;
  if (!id) throw bad('id required');
  const c = await Campaign.findOne({ _id: id, license_key: req.license.license_key });
  if (!c) throw notFound('Campaign not found');
  res.json({ ok: true, campaign: c });
});

exports.report = asyncHandler(async (req, res) => {
  const c = await Campaign.findOne({
    _id: req.params.id,
    license_key: req.license.license_key,
  });
  if (!c) throw notFound('Campaign not found');
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
});

exports.updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body || {};
  if (!['paused', 'running', 'queued'].includes(status)) throw bad('Invalid status');
  const c = await Campaign.findOneAndUpdate(
    { _id: req.params.id, license_key: req.license.license_key },
    { status },
    { new: true }
  );
  if (!c) throw notFound('Campaign not found');
  res.json({ ok: true, campaign: summary(c) });
});

exports.updateRisk = asyncHandler(async (req, res) => {
  const { updates } = req.body || {};
  if (!Array.isArray(updates) || !updates.length) throw bad('updates array required');
  const c = await Campaign.findOne({
    _id: req.params.id,
    license_key: req.license.license_key,
  });
  if (!c) throw notFound('Campaign not found');
  const map = new Map(updates.map((u) => [normalizePhone(u.phone), u]));
  let touched = 0;
  for (const ct of c.contacts) {
    const u = map.get(ct.phone);
    if (!u) continue;
    if (['green', 'yellow', 'red', 'unknown'].includes(u.risk_level)) {
      ct.risk_level = u.risk_level;
      touched += 1;
    }
    if (typeof u.on_whatsapp === 'boolean') ct.on_whatsapp = u.on_whatsapp;
  }
  await c.save();
  res.json({ ok: true, touched, campaign: summary(c) });
});

exports.remove = asyncHandler(async (req, res) => {
  const r = await Campaign.deleteOne({
    _id: req.params.id,
    license_key: req.license.license_key,
  });
  if (!r.deletedCount) throw notFound('Campaign not found');
  res.json({ ok: true });
});

exports.next = asyncHandler(async (req, res) => {
  const result = await queue.claimNextJob(req.license.license_key, req.params.id);
  if (result === null) return res.json({ ok: true, job: null });
  if (result.error) {
    return res.json({
      ok: true,
      job: null,
      reason: result.error,
      limit: result.limit,
      warmup: result.warmup,
    });
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
});

exports.reportJob = asyncHandler(async (req, res) => {
  const { contact_id, success, error = '' } = req.body || {};
  if (!contact_id) throw bad('contact_id required');
  const updated = success
    ? await queue.completeJob(req.license.license_key, req.params.id, contact_id)
    : await queue.failJob(req.license.license_key, req.params.id, contact_id, error);
  if (!updated) throw notFound('Job not found');
  res.json({ ok: true, progress: updated.progress, status: updated.status });
});

exports.skip = asyncHandler(async (req, res) => {
  const { contact_id, reason = 'risk' } = req.body || {};
  if (!contact_id) throw bad('contact_id required');
  const updated = await queue.skipJob(
    req.license.license_key,
    req.params.id,
    contact_id,
    reason
  );
  if (!updated) throw notFound('Job not found');
  res.json({ ok: true, progress: updated.progress, status: updated.status });
});
