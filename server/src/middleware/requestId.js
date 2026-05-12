'use strict';

/**
 * Per-request correlation id.
 *
 * Honours an inbound `X-Request-Id` if present (so callers / upstream proxies
 * can correlate). Otherwise generates a short random id. Always echoed back
 * in the response header and attached to req for the logger / error handler.
 */

const crypto = require('crypto');

const HEADER = 'x-request-id';

function newId() {
  return crypto.randomBytes(8).toString('hex');
}

function requestId(req, res, next) {
  const incoming = req.headers[HEADER];
  const id = (incoming && String(incoming).slice(0, 64)) || newId();
  req.id = id;
  res.setHeader('X-Request-Id', id);

  // Track start time so the error handler / access logs can include duration.
  req._startNs = process.hrtime.bigint();
  next();
}

module.exports = requestId;
