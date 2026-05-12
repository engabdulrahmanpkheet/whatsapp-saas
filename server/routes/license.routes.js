/**
 * routes/license.routes.js
 */
const express = require('express');
const ctrl = require('../controllers/license.controller');
const { clientAuth } = require('../middleware/auth.middleware');

const router = express.Router();

router.post('/activate', ctrl.activateLicense);
router.post('/validate', ctrl.validateLicense);
router.get('/me', clientAuth, ctrl.me);

module.exports = router;
