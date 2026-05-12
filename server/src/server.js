'use strict';

/**
 * Production entry point.
 *
 * Startup order (intentional, for platform compatibility):
 *   1. install global crash handlers (uncaughtException, unhandledRejection)
 *   2. build the express app and start app.listen()
 *      → /, /healthz, /health respond 200 immediately so Render/Railway
 *        consider the deploy alive even while step 3+ are still running.
 *   3. kick off MongoDB connection in the background (retries forever).
 *   4. kick off WhatsApp session restoration in the background.
 *
 * No recoverable error in steps 3 or 4 causes process exit. The server stays
 * up; affected endpoints return 503 until their backend is ready.
 */

const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB, isHealthy } = require('./config/db');
const manager = require('./whatsapp/manager');
const SessionModel = require('./models/session.model');
const buildApp = require('./app');

// ---------- global crash protection ----------
process.on('uncaughtException', (err) => {
  logger.error({ err: err.message, stack: err.stack }, 'uncaughtException — keeping process alive');
});
process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error({ err: err.message, stack: err.stack }, 'unhandledRejection — keeping process alive');
});

function startupBanner() {
  logger.info(
    { env: env.NODE_ENV, port: env.PORT, node: process.version, version: require('../package.json').version },
    'starting WhatsApp SaaS API'
  );
  if (env.MISSING.length) {
    logger.warn(
      { missing: env.MISSING },
      'required environment variables not set — dependent endpoints will return 503'
    );
  }
  for (const w of env.WARNINGS) logger.warn(w);
}

async function restoreSessionsAsync() {
  if (!env.WA_RESTORE_ON_BOOT) {
    logger.info('WA_RESTORE_ON_BOOT disabled — skipping session restoration');
    return;
  }
  // Wait briefly for Mongo to come up, then restore previously-connected sessions.
  for (let i = 0; i < 30; i++) {
    if (isHealthy()) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  if (!isHealthy()) {
    logger.warn('mongo not ready after 30 s — skipping session restoration');
    return;
  }
  try {
    const survivors = await SessionModel.find({ status: { $in: ['connected', 'awaiting_qr'] } })
      .limit(env.WA_MAX_SESSIONS)
      .lean();
    if (!survivors.length) {
      logger.info('no WhatsApp sessions to restore');
      return;
    }
    logger.info({ count: survivors.length }, 'restoring WhatsApp sessions');
    for (const s of survivors) {
      manager
        .create({ sessionId: s.session_id, licenseKey: s.license_key })
        .catch((err) => logger.warn({ sessionId: s.session_id, err: err.message }, 'restore failed'));
    }
  } catch (err) {
    logger.warn({ err: err.message }, 'session restoration scan failed (non-fatal)');
  }
}

function main() {
  startupBanner();

  // 2. Build + listen FIRST so healthchecks pass immediately.
  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT }, `✅ API listening on port ${env.PORT}`);
    logger.info(`🌍 Environment: ${env.NODE_ENV}`);
    logger.info(`🩺 Healthcheck: GET /healthz → 200 "OK"`);
  });

  // Keep-alive friendly to proxies (Railway/Render)
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  // 3. Kick off DB connection (non-blocking, retries forever).
  connectDB();
  // Log connection success once when it transpires.
  const mongoCheck = setInterval(() => {
    if (isHealthy()) {
      logger.info('✅ MongoDB connected');
      clearInterval(mongoCheck);
    }
  }, 1_000);
  mongoCheck.unref();

  // 4. Restore WhatsApp sessions in the background after the server is live.
  restoreSessionsAsync().catch((err) =>
    logger.warn({ err: err.message }, 'session restoration crashed (non-fatal)')
  );

  // ---------- graceful shutdown ----------
  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutdown initiated');

    server.close(() => logger.info('http server closed'));
    const forceExit = setTimeout(() => {
      logger.warn('force exit after timeout');
      process.exit(0);
    }, 15_000).unref();

    try {
      await manager.shutdownAll();
    } catch (e) {
      logger.warn({ err: e.message }, 'manager shutdown error');
    }
    try {
      await disconnectDB();
    } catch (e) {
      logger.warn({ err: e.message }, 'db disconnect error');
    }
    clearTimeout(forceExit);
    process.exit(0);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
