'use strict';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const level = (process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug')).toLowerCase();
const threshold = LEVELS[level] || LEVELS.info;
const useJson = process.env.NODE_ENV === 'production';

function emit(lvl, ...args) {
  if (LEVELS[lvl] < threshold) return;
  const ts = new Date().toISOString();
  if (useJson) {
    let merged = { ts, level: lvl };
    let msg = '';
    for (const a of args) {
      if (a && typeof a === 'object' && !(a instanceof Error)) {
        merged = { ...merged, ...a };
      } else if (a instanceof Error) {
        merged.err = a.message;
        merged.stack = a.stack;
      } else {
        msg = msg ? `${msg} ${a}` : String(a);
      }
    }
    if (msg) merged.msg = msg;
    process.stdout.write(JSON.stringify(merged) + '\n');
  } else {
    const tag = `[${ts}] [${lvl.toUpperCase()}]`;
    // eslint-disable-next-line no-console
    console.log(tag, ...args);
  }
}

module.exports = {
  debug: (...a) => emit('debug', ...a),
  info: (...a) => emit('info', ...a),
  warn: (...a) => emit('warn', ...a),
  error: (...a) => emit('error', ...a),
  child: (bindings) => ({
    debug: (...a) => emit('debug', bindings, ...a),
    info: (...a) => emit('info', bindings, ...a),
    warn: (...a) => emit('warn', bindings, ...a),
    error: (...a) => emit('error', bindings, ...a),
  }),
};
