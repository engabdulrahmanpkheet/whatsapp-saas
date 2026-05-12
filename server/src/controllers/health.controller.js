'use strict';

/**
 * Public health endpoints.
 *
 * - / and /healthz must respond 200 unconditionally so platform healthchecks
 *   (Render, Railway, Docker HEALTHCHECK, load balancers) succeed even while
 *   Mongo or WhatsApp sessions are still initializing.
 * - /healthz/detailed exposes diagnostics for operators: memory, uptime,
 *   Mongo ping latency, session counters, masked config. Still returns 200.
 */

const env = require('../config/env');
const { isHealthy, lastErrorMessage, pingLatency } = require('../config/db');
const manager = require('../whatsapp/manager');
const campaignWorker = require('../services/campaign.worker');

exports.root = (_req, res) => {
  res.status(200).type('text/plain').send('API is running 🚀');
};

exports.healthz = (_req, res) => {
  res.status(200).type('text/plain').send('OK');
};

exports.healthzJson = (_req, res) => {
  res.status(200).json({ status: 'ok' });
};

exports.detailed = async (_req, res) => {
  const sessions = manager.list();
  const mem = process.memoryUsage();
  const latency = await pingLatency();

  res.status(200).json({
    status: 'ok',
    ts: Date.now(),
    version: require('../../package.json').version,
    mongo: {
      connected: isHealthy(),
      latency_ms: latency,
      last_error: lastErrorMessage() || null,
    },
    sessions: {
      count: sessions.length,
      connected: sessions.filter((s) => s.status === 'connected').length,
      awaiting_qr: sessions.filter((s) => s.status === 'awaiting_qr').length,
      disconnected: sessions.filter((s) => s.status === 'disconnected').length,
    },
    workers: {
      campaign_active: campaignWorker.activeWorkers().length,
    },
    memory: {
      rss_mb: +(mem.rss / 1024 / 1024).toFixed(1),
      heap_used_mb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      heap_total_mb: +(mem.heapTotal / 1024 / 1024).toFixed(1),
      external_mb: +(mem.external / 1024 / 1024).toFixed(1),
    },
    uptime_sec: Math.floor(process.uptime()),
    node: process.version,
    config: env.getDiagnostics(),
  });
};
