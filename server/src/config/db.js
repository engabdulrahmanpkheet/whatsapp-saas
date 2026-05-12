'use strict';

const mongoose = require('mongoose');
const env = require('./env');
const logger = require('../utils/logger');

mongoose.set('strictQuery', true);

const MAX_ATTEMPTS = 5;
const BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

async function connectWithRetry() {
  let lastErr;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      await mongoose.connect(env.MONGO_URI, {
        serverSelectionTimeoutMS: 15_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: env.MONGO_POOL_SIZE,
        family: 4,
      });
      logger.info({ attempt: attempt + 1 }, 'mongo connected');
      return;
    } catch (err) {
      lastErr = err;
      const wait = BACKOFF_MS[attempt] || 16_000;
      logger.warn(
        { attempt: attempt + 1, err: err.message, retry_in_ms: wait },
        'mongo connection failed, retrying'
      );
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastErr || new Error('mongo: exhausted retries');
}

function attachListeners() {
  mongoose.connection.on('error', (err) => logger.error({ err: err.message }, 'mongo error'));
  mongoose.connection.on('disconnected', () => logger.warn('mongo disconnected'));
  mongoose.connection.on('reconnected', () => logger.info('mongo reconnected'));
}

async function connectDB() {
  attachListeners();
  await connectWithRetry();
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

module.exports = { connectDB, disconnectDB, isHealthy };
