/**
 * app.js — Express server entry point
 */
require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const connectDB = require('./config/db');

const licenseRoutes = require('./routes/license.routes');
const adminRoutes = require('./routes/admin.routes');
const campaignRoutes = require('./routes/campaign.routes');

const app = express();

// Trust proxy (Render, Railway, nginx) so rate-limit + IP logging work
app.set('trust proxy', 1);

// ---------- Security & utility middleware ----------
app.use(helmet());

const corsOrigins = (process.env.CORS_ORIGINS || '*')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: corsOrigins.includes('*') ? true : corsOrigins,
    credentials: false,
  })
);

// 25 MB allows base64-encoded images/short videos in campaign payloads
app.use(express.json({ limit: '25mb' }));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Global rate limit
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Strict limiter for license activation (anti brute-force)
const activationLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many activation attempts. Try again later.' },
});

// ---------- Health ----------
app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: Date.now(), version: '2.0.0' });
});

// ---------- Routes ----------
app.use('/api/license/activate', activationLimiter);
app.use('/api/license', licenseRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/campaign', campaignRoutes);

// ---------- 404 ----------
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ---------- Error handler ----------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[ERROR]', err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Server error' });
});

// ---------- Boot ----------
const PORT = process.env.PORT || 4000;

(async () => {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`✅ API listening on port ${PORT}`);
      console.log(`   Health:  ${process.env.PUBLIC_API_URL || `http://localhost:${PORT}`}/api/health`);
    });
  } catch (e) {
    console.error('❌ Failed to start server:', e);
    process.exit(1);
  }
})();

module.exports = app;
