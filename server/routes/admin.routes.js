/**
 * routes/admin.routes.js
 */
const express = require('express');
const ctrl = require('../controllers/admin.controller');
const { adminAuth } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/login', ctrl.login);

router.get('/stats',     adminAuth, ctrl.stats);
router.get('/licenses',  adminAuth, ctrl.listLicenses);
router.get('/campaigns', adminAuth, ctrl.listCampaigns);

router.post('/create-license', adminAuth, ctrl.createLicense);

router.patch('/license/:key/revoke',       adminAuth, ctrl.revokeLicense);
router.patch('/license/:key/reset-device', adminAuth, ctrl.resetDevice);
router.post ('/reset-device',              adminAuth, ctrl.resetDevice);

module.exports = router;
