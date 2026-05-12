'use strict';

const mongoose = require('mongoose');

const authStateSchema = new mongoose.Schema(
  {
    session_id: { type: String, required: true, index: true },
    key: { type: String, required: true },
    value: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  { timestamps: true }
);

authStateSchema.index({ session_id: 1, key: 1 }, { unique: true });

module.exports = mongoose.model('AuthState', authStateSchema);
