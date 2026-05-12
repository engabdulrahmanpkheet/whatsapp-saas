'use strict';

/**
 * Public health endpoints.
 *
 * - / and /healthz must respond 200 unconditionally so platform healthchecks
 *   (Render, Railway, Docker HEALTHCHECK, load balancers) succeed even while
 *   Mongo or WhatsApp sessions are still initializing.
 * - /healthz/detailed exposes diagnostics (Mongo state, session counters,
 *   missing env vars) for operators. It still returns 200 — operators look at
 *   the body, not the status code.
 */

const env = require('../config/env');
const { isHealthy, lastErrorMessage } = require('../config/db');
const manager = require('../whatsapp/manager');

exports.root = (_req, res) => {
  res.status(200).send('API is running 🚀');
};

exports.healthz = (_req, res) => {
  res.status(200).send('OK');
};

exports.healthzJson = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

exports.detailed = (_req, res) => {
  const sessions = manager.list();
  const diagnostics = env.getDiagnostics();
  res.status(200).json({
    status: 'ok',
    ts: Date.now(),
    version: require('../../package.json').version,
    mongo: {
      connected: isHealthy(),
      last_error: lastErrorMessage() || null,
    },
    sessions: {
      count: sessions.length,
      connected: sessions.filter((s) => s.status === 'connected').length,
    },
    uptime_sec: Math.floor(process.uptime()),
    node: process.version,
    // Full env diagnostics (secrets masked) — operators can see what the
    // process actually loaded without inspecting Render/Railway dashboards.
    config: diagnostics,
  });
};
