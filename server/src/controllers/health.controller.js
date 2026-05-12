'use strict';

const { isHealthy } = require('../config/db');
const manager = require('../whatsapp/manager');

exports.simple = (_req, res) => {
  res.json({ status: 'ok' });
};

exports.detailed = (_req, res) => {
  const sessions = manager.list();
  res.json({
    status: 'ok',
    ts: Date.now(),
    version: require('../../package.json').version,
    mongo: isHealthy() ? 'connected' : 'disconnected',
    sessions: {
      count: sessions.length,
      connected: sessions.filter((s) => s.status === 'connected').length,
    },
    uptime_sec: Math.floor(process.uptime()),
    node: process.version,
  });
};
