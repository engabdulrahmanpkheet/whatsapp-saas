'use strict';

/**
 * MongoDB connection helper.
 *
 * Production hardening notes:
 * - connectDB() NEVER throws. Failures are logged and a background retry loop
 *   keeps trying so the HTTP server can stay up and serve /healthz.
 * - This is essential for Render/Railway: the platform probes / and /healthz
 *   before considering the deploy live. Crashing on the first Atlas hiccup
 *   makes the deploy never reach READY state.
 * - Route handlers that need DB will fail with a 503 if isHealthy() is false.
 */

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);
// Disable command buffering globally so DB-dependent handlers fail fast
// (with a clear error) instead of hanging for 10 s while Mongo is down.
mongoose.set('bufferCommands', false);

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

let started = false;
let lastError = '';

function attachListeners() {
  mongoose.connection.on('error', (err) => {
    lastError = err.message;
    logger.error({ err: err.message }, 'mongo error');
  });
  mongoose.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => {
    lastError = '';
    logger.info('mongo reconnected');
  });
}

async function tryConnectOnce() {
  if (!env.MONGO_URI) {
    throw new Error('MONGO_URI not configured');
  }
  await mongoose.connect(env.MONGO_URI, {
    serverSelectionTimeoutMS: 15_000,
    socketTimeoutMS: 45_000,
    maxPoolSize: env.MONGO_POOL_SIZE,
    family: 4,
  });
}

async function backgroundRetryLoop() {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (isHealthy()) {
      // Already connected (e.g. reconnect listener); idle until next disconnect.
      await new Promise((r) => setTimeout(r, 30_000));
      continue;
    }
    try {
      await tryConnectOnce();
      logger.info({ attempt: attempt + 1 }, 'mongo connected');
      attempt = 0;
    } catch (err) {
      lastError = err.message;
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      logger.warn(
        { attempt: attempt + 1, err: err.message, retry_in_ms: wait },
        'mongo connection failed; retrying in background'
      );
      attempt += 1;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

/**
 * Kick off DB connection. Resolves immediately; the actual connection happens
 * in the background. The HTTP server can start before DB is ready.
 */
function connectDB() {
  if (started) return;
  started = true;
  attachListeners();
  backgroundRetryLoop().catch((err) => {
    // Should never happen — the loop swallows its own errors.
    logger.error({ err: err.message }, 'mongo retry loop crashed');
  });
}

async function disconnectDB() {
  try {
    await mongoose.disconnect();
    logger.info('mongo disconnected (clean)');
  } catch (e) {
    logger.error({ err: e.message }, 'mongo disconnect error');
  }
}

function isHealthy() {
  return mongoose.connection.readyState === 1;
}

function lastErrorMessage() {
  return lastError;
}

/**
 * Round-trip ping against Mongo. Returns latency in ms or null if unreachable.
 * Used by /healthz/detailed — never throws.
 */
async function pingLatency() {
  if (!isHealthy()) return null;
  try {
    const start = process.hrtime.bigint();
    await mongoose.connection.db.admin().ping();
    return Number(process.hrtime.bigint() - start) / 1e6;
  } catch {
    return null;
  }
}

module.exports = { connectDB, disconnectDB, isHealthy, lastErrorMessage, pingLatency };
