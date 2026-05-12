'use strict';

const { bad } = require('../utils/AppError');

function pickError(result) {
  const issue = result.error.issues[0];
  const path = issue.path.length ? issue.path.join('.') : 'body';
  return `${path}: ${issue.message}`;
}

function validate(schema, source = 'body') {
  return (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) return next(bad(pickError(result), 'VALIDATION'));
    req[source] = result.data;
    next();
  };
}

module.exports = { validate };
