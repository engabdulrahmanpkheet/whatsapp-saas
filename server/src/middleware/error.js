'use strict';

const logger = require('../utils/logger');
const { AppError } = require('../utils/AppError');

function notFoundHandler(_req, res) {
  res.status(404).json({ ok: false, error: 'Not found', code: 'NOT_FOUND' });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const isApp = err instanceof AppError;
  const status = err.status || (isApp ? err.status : 500);
  const code = err.code || (isApp ? err.code : 'INTERNAL');

  if (status === 503 || (status >= 500 && status < 600 && isApp)) {
    // 5xx that we deliberately raised (e.g. SERVICE_UNAVAILABLE) — warn only.
    logger.warn(
      { method: req.method, path: req.originalUrl, status, code, err: err.message },
      'service-level error'
    );
  } else if (status >= 500) {
    logger.error(
      { method: req.method, path: req.originalUrl, err: err.message, stack: err.stack, code },
      'unhandled request error'
    );
  } else {
    logger.warn(
      { method: req.method, path: req.originalUrl, status, code, err: err.message },
      'request error'
    );
  }

  const body = {
    ok: false,
    error: status >= 500 && !isApp ? 'Server error' : err.message || 'Error',
    code,
  };
  res.status(status).json(body);
}

module.exports = { notFoundHandler, errorHandler };
