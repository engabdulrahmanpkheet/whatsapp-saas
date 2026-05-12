'use strict';

/**
 * Top-level router.
 *
 * Public/no-auth endpoints:
 *   GET /            — banner ("API is running 🚀")
 *   GET /healthz     — Render/standard healthcheck ("OK")
 *   GET /health      — JSON variant, alias of /healthz
 *   GET /api/health  — legacy alias kept for old clients
 *
 * Authenticated endpoints live under /api/* (license, admin, campaign) and
 * the new /session, /message namespaces.
 */

const express = require('express');

const healthCtrl = require('../controllers/health.controller');
const healthRoutes = require('./health.routes');
const licenseRoutes = require('./license.routes');
const adminRoutes = require('./admin.routes');
const campaignRoutes = require('./campaign.routes');
const sessionRoutes = require('./session.routes');
const messageRoutes = require('./message.routes');
const docsRoutes = require('./docs.routes');

const router = express.Router();

// Public, unconditionally-200 endpoints (platform healthchecks)
router.get('/', healthCtrl.root);
router.get('/healthz', healthCtrl.healthz);
router.get('/health', healthCtrl.healthzJson);
router.use('/healthz', healthRoutes); // exposes /healthz/detailed too

// Legacy API path kept for backwards-compat with the admin dashboard
router.use('/api/health', healthRoutes);
router.use('/api/license', licenseRoutes);
router.use('/api/admin', adminRoutes);
router.use('/api/campaign', campaignRoutes);

// New WhatsApp engine endpoints
router.use('/session', sessionRoutes);
router.use('/message', messageRoutes);

// Interactive API documentation (Swagger UI + raw OpenAPI spec).
router.use('/api/docs', docsRoutes);

module.exports = router;
