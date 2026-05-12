'use strict';

const mongoose = require('mongoose');

const sessionSchema = new mongoose.Schema(
  {
    session_id: { type: String, required: true, unique: true, index: true },
    license_key: { type: String, required: true, index: true, uppercase: true },

    status: {
      type: String,
      enum: ['idle', 'initializing', 'awaiting_qr', 'connected', 'disconnected', 'logged_out', 'error'],
      default: 'idle',
      index: true,
    },
    qr: { type: String, default: '' },
    qr_at: { type: Date, default: null },

    wa_id: { type: String, default: '' },
    push_name: { type: String, default: '' },

    last_connected_at: { type: Date, default: null },
    last_disconnected_at: { type: Date, default: null },
    last_error: { type: String, default: '' },

    reconnect_attempts: { type: Number, default: 0 },
  },
  { timestamps: true }
);

// Hot lookups: by tenant, and by status for the boot-restore scan.
sessionSchema.index({ license_key: 1, status: 1 });
sessionSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model('Session', sessionSchema);
