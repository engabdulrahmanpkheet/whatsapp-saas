'use strict';

/**
 * Express app factory.
 *
 * Production hardening notes:
 * - Per-request socket timeout (default 30 s) so a stuck upstream (Mongo,
 *   Baileys) can't hold connections forever.
 * - All errors funnel through a single error middleware; route handlers
 *   are wrapped in asyncHandler so unhandled rejections don't kill workers.
 */

const express = require('express');
const morgan = require('morgan');

const env = require('./config/env');
const logger = require('./utils/logger');
const { applySecurity } = require('./middleware/security');
const { globalLimiter } = require('./middleware/rateLimit');
const { notFoundHandler, errorHandler } = require('./middleware/error');
const routes = require('./routes');

function buildApp() {
  const app = express();

  applySecurity(app);

  // Per-request timeout — protects the event loop from hung downstreams.
  app.use((req, res, next) => {
    req.setTimeout(env.REQUEST_TIMEOUT_MS, () => {
      if (!res.headersSent) {
        res.status(503).json({ ok: false, error: 'Request timeout', code: 'TIMEOUT' });
      }
    });
    next();
  });

  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  if (!env.isProd) {
    app.use(morgan('dev'));
  } else {
    app.use(
      morgan('combined', {
        stream: { write: (line) => logger.info({ http: line.trim() }) },
      })
    );
  }

  app.use(globalLimiter);
  app.use(routes);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

module.exports = buildApp;
