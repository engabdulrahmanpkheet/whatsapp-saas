'use strict';

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
