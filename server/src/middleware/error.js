'use strict';

/**
 * Central error + 404 handlers.
 *
 * All API failures use a consistent shape:
 *   { ok: false, error: string, code: string, request_id?: string }
 *
 * - 5xx errors that we deliberately raised (e.g. AppError 503) log at WARN
 *   without stack — they are operator information, not bugs.
 * - 5xx errors we did NOT raise are logged at ERROR with stack — those are
 *   real bugs to fix.
 * - 4xx logs at WARN, single-line.
 */

const logger = require('../utils/logger');
const { AppError } = require('../utils/AppError');

function notFoundHandler(req, res) {
  res.status(404).json({
    ok: false,
    error: 'Not found',
    code: 'NOT_FOUND',
    request_id: req.id,
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  const isApp = err instanceof AppError;
  const status = err.status || (isApp ? err.status : 500);
  const code = err.code || (isApp ? err.code : 'INTERNAL');

  const ctx = {
    rid: req.id,
    method: req.method,
    path: req.originalUrl,
    status,
    code,
  };

  if (status === 503 || (status >= 500 && status < 600 && isApp)) {
    logger.warn({ ...ctx, err: err.message }, 'service-level error');
  } else if (status >= 500) {
    logger.error({ ...ctx, err: err.message, stack: err.stack }, 'unhandled request error');
  } else {
    logger.warn({ ...ctx, err: err.message }, 'request error');
  }

  if (res.headersSent) return;

  res.status(status).json({
    ok: false,
    error: status >= 500 && !isApp ? 'Server error' : err.message || 'Error',
    code,
    request_id: req.id,
  });
}

module.exports = { notFoundHandler, errorHandler };
