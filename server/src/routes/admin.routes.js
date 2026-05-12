'use strict';

const express = require('express');
const ctrl = require('../controllers/admin.controller');
const session = require('../controllers/session.controller');
const { adminAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.post('/login', authLimiter, ctrl.login);

router.get('/stats', adminAuth, ctrl.stats);
router.get('/licenses', adminAuth, ctrl.listLicenses);
router.get('/campaigns', adminAuth, ctrl.listCampaigns);

router.post('/create-license', adminAuth, ctrl.createLicense);
router.patch('/license/:key/revoke', adminAuth, ctrl.revokeLicense);
router.patch('/license/:key/reset-device', adminAuth, ctrl.resetDevice);
router.post('/reset-device', adminAuth, ctrl.resetDevice);

router.get('/sessions', adminAuth, session.list);
router.get('/sessions/:id', adminAuth, session.adminStatus);
router.post('/sessions/:id/logout', adminAuth, session.adminLogout);

module.exports = router;
