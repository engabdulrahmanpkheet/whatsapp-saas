/**
 * models/admin.model.js
 */
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const adminSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    password_hash: { type: String, required: true },
    role: { type: String, enum: ['admin', 'superadmin'], default: 'admin' },
    last_login_at: { type: Date, default: null },
  },
  { timestamps: true }
);

adminSchema.statics.hashPassword = function (plain) {
  return bcrypt.hash(plain, 10);
};
adminSchema.methods.verifyPassword = function (plain) {
  return bcrypt.compare(plain, this.password_hash);
};

module.exports = mongoose.model('Admin', adminSchema);
