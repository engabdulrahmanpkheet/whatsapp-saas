'use strict';

const env = require('./config/env');
const logger = require('./utils/logger');
const { connectDB, disconnectDB } = require('./config/db');
const manager = require('./whatsapp/manager');
const buildApp = require('./app');

async function main() {
  process.on('uncaughtException', (err) => {
    logger.error({ err: err.message, stack: err.stack }, 'uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error({ err: err.message, stack: err.stack }, 'unhandledRejection');
  });

  await connectDB();

  const app = buildApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'api listening');
  });

  // Keep-alive tuning friendly to Railway / proxies
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

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

main().catch((err) => {
  logger.error({ err: err.message, stack: err.stack }, 'fatal startup error');
  process.exit(1);
});
