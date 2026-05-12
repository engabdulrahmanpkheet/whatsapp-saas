'use strict';

const helmet = require('helmet');
const cors = require('cors');
const env = require('../config/env');

function applySecurity(app) {
  app.disable('x-powered-by');
  if (env.TRUST_PROXY) app.set('trust proxy', 1);

  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

  const allowAll = env.CORS_ORIGINS.includes('*');
  app.use(
    cors({
      origin: allowAll ? true : env.CORS_ORIGINS,
      credentials: false,
      methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    })
  );
}

module.exports = { applySecurity };
