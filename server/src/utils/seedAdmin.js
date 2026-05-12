'use strict';

const env = require('../config/env');
const logger = require('./logger');
const { connectDB, disconnectDB } = require('../config/db');
const Admin = require('../models/admin.model');

(async () => {
  try {
    await connectDB();
    const email = env.ADMIN_EMAIL.toLowerCase();
    const password = env.ADMIN_PASSWORD;
    if (!password) {
      logger.error('ADMIN_PASSWORD not set — cannot seed');
      process.exit(1);
    }
    const exists = await Admin.findOne({ email });
    if (exists) {
      logger.info({ email }, 'admin already exists');
      await disconnectDB();
      process.exit(0);
    }
    const password_hash = await Admin.hashPassword(password);
    await Admin.create({ email, password_hash, role: 'superadmin' });
    logger.info({ email }, 'admin created');
    await disconnectDB();
    process.exit(0);
  } catch (e) {
    logger.error({ err: e.message, stack: e.stack }, 'seed failed');
    process.exit(1);
  }
})();
