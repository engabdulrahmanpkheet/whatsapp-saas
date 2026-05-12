'use strict';

const asyncHandler = require('../utils/asyncHandler');
const manager = require('../whatsapp/manager');
const SessionModel = require('../models/session.model');
const { bad, notFound } = require('../utils/AppError');

/**
 * The session_id is derived from the authenticated license:
 *   session_id = license_key
 * This guarantees one session per license and prevents cross-tenant access.
 */
function sessionIdFor(req) {
  return String(req.license.license_key).toUpperCase();
}

exports.create = asyncHandler(async (req, res) => {
  const sessionId = sessionIdFor(req);
  const result = await manager.create({
    sessionId,
    licenseKey: req.license.license_key,
  });
  res.status(201).json({ ok: true, session_id: sessionId, ...result });
});

exports.qr = asyncHandler(async (req, res) => {
  const sessionId = sessionIdFor(req);
  const requested = String(req.params.id || sessionId).toUpperCase();
  if (requested !== sessionId) throw notFound('Session not found');

  const result = await manager.qr(sessionId);
  if (!result) {
    const status = manager.status(sessionId);
    return res.json({
      ok: true,
      session_id: sessionId,
      qr: null,
      qrDataUrl: null,
      status: status.status,
      message:
        status.status === 'connected'
          ? 'Already connected — no QR needed'
          : status.status === 'idle' || !status.exists
          ? 'Session not started. POST /session/create first.'
          : 'QR not ready or expired. Try again shortly.',
    });
  }
  res.json({
    ok: true,
    session_id: sessionId,
    qr: result.qr,
    qrDataUrl: result.qrDataUrl,
    status: result.status,
  });
});

exports.status = asyncHandler(async (req, res) => {
  const sessionId = sessionIdFor(req);
  const requested = String(req.params.id || sessionId).toUpperCase();
  if (requested !== sessionId) throw notFound('Session not found');

  const mem = manager.status(sessionId);
  const db = await SessionModel.findOne({ session_id: sessionId }).lean();
  res.json({
    ok: true,
    session_id: sessionId,
    ...mem,
    persisted: db
      ? {
          status: db.status,
          last_connected_at: db.last_connected_at,
          last_disconnected_at: db.last_disconnected_at,
          last_error: db.last_error,
        }
      : null,
  });
});

exports.logout = asyncHandler(async (req, res) => {
  const sessionId = sessionIdFor(req);
  await manager.logout(sessionId);
  res.json({ ok: true, session_id: sessionId, status: 'logged_out' });
});

exports.list = asyncHandler(async (_req, res) => {
  // Admin-only — exposes all in-memory sessions
  res.json({ ok: true, sessions: manager.list() });
});

// Admin variant: act on a session by its id (which equals a license_key)
exports.adminStatus = asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  if (!id) throw bad('session id required');
  const mem = manager.status(id);
  const db = await SessionModel.findOne({ session_id: id }).lean();
  res.json({ ok: true, session_id: id, ...mem, persisted: db || null });
});

exports.adminLogout = asyncHandler(async (req, res) => {
  const id = String(req.params.id || '').toUpperCase();
  if (!id) throw bad('session id required');
  await manager.logout(id);
  res.json({ ok: true, session_id: id, status: 'logged_out' });
});
