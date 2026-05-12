'use strict';

const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'superadmin'], default: 'admin' },
    last_login_at: { type: Date, default: null },

    // Brute-force protection. Reset on successful login.
    failed_login_count: { type: Number, default: 0 },
    locked_until: { type: Date, default: null, index: true },
  },
  { timestamps: true }
);

adminSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 12);
};

adminSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.password_hash);
};

adminSchema.methods.isLocked = function () {
  return !!this.locked_until && this.locked_until.getTime() > Date.now();
};

module.exports = mongoose.model('Admin', adminSchema);
