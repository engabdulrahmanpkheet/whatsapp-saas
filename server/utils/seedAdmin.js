/**
 * utils/seedAdmin.js
 * Run: npm run seed:admin
 */
require('dotenv').config();

const connectDB = require('../config/db');
const Admin = require('../models/admin.model');

(async () => {
  try {
    await connectDB();
    const email = (process.env.ADMIN_EMAIL || 'admin@local.test').toLowerCase();
    const password = process.env.ADMIN_PASSWORD || 'admin123';

    const exists = await Admin.findOne({ email });
    if (exists) {
      console.log(`Admin already exists: ${email}`);
      process.exit(0);
    }
    const password_hash = await Admin.hashPassword(password);
    await Admin.create({ email, password_hash, role: 'superadmin' });
    console.log('✅ Admin created');
    console.log(`   Email:    ${email}`);
    console.log(`   Password: ${password}`);
    process.exit(0);
  } catch (e) {
    console.error('Seed failed:', e);
    process.exit(1);
  }
})();
