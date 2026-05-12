'use strict';

const express = require('express');

const healthRoutes = require('./health.routes');
const licenseRoutes = require('./license.routes');
const adminRoutes = require('./admin.routes');
const campaignRoutes = require('./campaign.routes');
const sessionRoutes = require('./session.routes');
const messageRoutes = require('./message.routes');

const router = express.Router();

// Root health (Railway healthcheck)
router.use('/health', healthRoutes);

// Legacy API path kept for backwards-compat with admin dashboard
router.use('/api/health', healthRoutes);
router.use('/api/license', licenseRoutes);
router.use('/api/admin', adminRoutes);
router.use('/api/campaign', campaignRoutes);

// New WhatsApp engine endpoints
router.use('/session', sessionRoutes);
router.use('/message', messageRoutes);

module.exports = router;
