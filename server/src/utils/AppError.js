'use strict';

class AppError extends Error {
  constructor(message, status = 500, code = 'INTERNAL') {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = status < 500;
  }
}

const bad = (msg, code = 'BAD_REQUEST') => new AppError(msg, 400, code);
const unauthorized = (msg = 'Unauthorized', code = 'UNAUTHORIZED') => new AppError(msg, 401, code);
const forbidden = (msg = 'Forbidden', code = 'FORBIDDEN') => new AppError(msg, 403, code);
const notFound = (msg = 'Not found', code = 'NOT_FOUND') => new AppError(msg, 404, code);
const conflict = (msg = 'Conflict', code = 'CONFLICT') => new AppError(msg, 409, code);
const tooMany = (msg = 'Too many requests', code = 'TOO_MANY') => new AppError(msg, 429, code);

module.exports = { AppError, bad, unauthorized, forbidden, notFound, conflict, tooMany };
