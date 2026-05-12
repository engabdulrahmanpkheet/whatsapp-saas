'use strict';

const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    name: { type: String, default: '' },
    vars: { type: Object, default: {} },
    status: {
      type: String,
      enum: ['pending', 'processing', 'sent', 'failed', 'skipped'],
      default: 'pending',
      index: true,
    },
    risk_level: {
      type: String,
      enum: ['green', 'yellow', 'red', 'unknown'],
      default: 'unknown',
    },
    on_whatsapp: { type: Boolean, default: null },
    attempts: { type: Number, default: 0 },
    error: { type: String, default: '' },
    sent_at: { type: Date, default: null },
    locked_at: { type: Date, default: null },
  },
  { _id: true }
);

const mediaSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['path', 'url', 'dataUrl'], default: 'url' },
    url: { type: String, default: '' },
    path: { type: String, default: '' },
    dataUrl: { type: String, default: '' },
    mime: { type: String, default: '' },
    filename: { type: String, default: '' },
    caption: { type: String, default: '' },
    asDocument: { type: Boolean, default: false },
  },
  { _id: false }
);

const warmupSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: false },
    day1: { type: Number, default: 50 },
    day_step: { type: Number, default: 50 },
    started_at: { type: Date, default: null },
  },
  { _id: false }
);

const campaignSchema = new mongoose.Schema(
  {
    license_key: { type: String, required: true, index: true, uppercase: true },
    name: { type: String, required: true, trim: true },
    message_template: { type: String, required: true },
    variations: { type: [String], default: [] },
    media: { type: mediaSchema, default: null },
    speed_mode: { type: String, enum: ['safe', 'medium', 'fast', 'custom'], default: 'medium' },
    delay_min_seconds: { type: Number, default: 8 },
    delay_max_seconds: { type: Number, default: 20 },
    warmup: { type: warmupSchema, default: () => ({}) },
    status: {
      type: String,
      enum: ['draft', 'queued', 'running', 'paused', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },
    contacts: [contactSchema],
    progress: {
      total: { type: Number, default: 0 },
      sent: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },
    sent_today: {
      date: { type: String, default: '' },
      count: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

campaignSchema.pre('save', function (next) {
  this.progress.total = this.contacts.length;
  this.progress.sent = this.contacts.filter((c) => c.status === 'sent').length;
  this.progress.failed = this.contacts.filter((c) => c.status === 'failed').length;
  this.progress.skipped = this.contacts.filter((c) => c.status === 'skipped').length;

  const done = this.progress.sent + this.progress.failed + this.progress.skipped;
  if (this.progress.total > 0 && done === this.progress.total) {
    this.status = 'completed';
  }
  next();
});

module.exports = mongoose.model('Campaign', campaignSchema);
