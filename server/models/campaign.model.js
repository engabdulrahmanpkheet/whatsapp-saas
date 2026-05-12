/**
 * models/campaign.model.js
 *
 * v3 additions:
 *  - media: { type, url|path|dataUrl, mime, filename, caption, asDocument }
 *  - variations: [string]  (random pick per send)
 *  - speed_mode: 'safe' | 'medium' | 'fast' | 'custom'
 *  - warmup: { enabled, day1, day_step, started_at }
 *  - contacts[].risk_level: 'green' | 'yellow' | 'red'
 *  - contacts[].on_whatsapp: boolean | null
 */
const mongoose = require('mongoose');

const contactSchema = new mongoose.Schema(
  {
    phone: { type: String, required: true },
    name:  { type: String, default: '' },
    vars:  { type: Object, default: {} },

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

    attempts:  { type: Number, default: 0 },
    error:     { type: String, default: '' },
    sent_at:   { type: Date,   default: null },
    locked_at: { type: Date,   default: null },
  },
  { _id: true }
);

const mediaSchema = new mongoose.Schema(
  {
    type:      { type: String, enum: ['path', 'url', 'dataUrl'], default: 'url' },
    url:       { type: String, default: '' },
    path:      { type: String, default: '' },     // server-stored absolute path
    dataUrl:   { type: String, default: '' },     // base64 data URL
    mime:      { type: String, default: '' },
    filename:  { type: String, default: '' },
    caption:   { type: String, default: '' },
    asDocument:{ type: Boolean, default: false },
  },
  { _id: false }
);

const warmupSchema = new mongoose.Schema(
  {
    enabled:    { type: Boolean, default: false },
    day1:       { type: Number,  default: 50 },   // messages allowed day 1
    day_step:   { type: Number,  default: 50 },   // increase per day
    started_at: { type: Date,    default: null },
  },
  { _id: false }
);

const campaignSchema = new mongoose.Schema(
  {
    license_key:      { type: String, required: true, index: true, uppercase: true },
    name:             { type: String, required: true, trim: true },
    message_template: { type: String, required: true },

    // v3 — list of alt templates; if non-empty, one is randomly chosen per send
    variations:       { type: [String], default: [] },

    // v3 — single media attached to all messages
    media:            { type: mediaSchema, default: null },

    // v3 — speed mode metadata for reporting
    speed_mode:       { type: String, enum: ['safe', 'medium', 'fast', 'custom'], default: 'medium' },

    delay_min_seconds: { type: Number, default: 8 },
    delay_max_seconds: { type: Number, default: 20 },

    // v3 — warm-up
    warmup:           { type: warmupSchema, default: () => ({}) },

    status: {
      type: String,
      enum: ['draft', 'queued', 'running', 'paused', 'completed', 'failed'],
      default: 'queued',
      index: true,
    },

    contacts: [contactSchema],
    progress: {
      total:   { type: Number, default: 0 },
      sent:    { type: Number, default: 0 },
      failed:  { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
    },

    sent_today: {
      date:  { type: String, default: '' },
      count: { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

campaignSchema.pre('save', function (next) {
  this.progress.total   = this.contacts.length;
  this.progress.sent    = this.contacts.filter((c) => c.status === 'sent').length;
  this.progress.failed  = this.contacts.filter((c) => c.status === 'failed').length;
  this.progress.skipped = this.contacts.filter((c) => c.status === 'skipped').length;

  const done = this.progress.sent + this.progress.failed + this.progress.skipped;
  if (this.progress.total > 0 && done === this.progress.total) {
    this.status = 'completed';
  }
  next();
});

module.exports = mongoose.model('Campaign', campaignSchema);
