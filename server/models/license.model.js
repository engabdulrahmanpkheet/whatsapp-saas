/**
 * models/license.model.js
 */
const mongoose = require('mongoose');

const licenseSchema = new mongoose.Schema(
  {
    license_key: {
      type: String, required: true, unique: true, index: true,
      uppercase: true, trim: true,
    },
    customer_name:  { type: String, default: '' },
    customer_email: { type: String, default: '' },
    device_fingerprint: { type: String, default: null, index: true },

    plan: { type: String, enum: ['basic', 'pro', 'enterprise'], default: 'basic' },
    max_messages_per_day: { type: Number, default: 500 },

    expires_at: { type: Date, required: true },
    activated_at: { type: Date, default: null },
    last_seen_at: { type: Date, default: null },

    status: {
      type: String,
      enum: ['inactive', 'active', 'expired', 'revoked'],
      default: 'inactive',
      index: true,
    },
    notes: { type: String, default: '' },
  },
  { timestamps: true }
);

// Re-evaluate status on read
licenseSchema.methods.refreshStatus = function () {
  if (this.status === 'revoked') return this;
  if (this.expires_at && this.expires_at.getTime() < Date.now()) {
    this.status = 'expired';
  }
  return this;
};

module.exports = mongoose.model('License', licenseSchema);
