'use strict';

const express = require('express');
const ctrl = require('../controllers/license.controller');
const { clientAuth } = require('../middleware/auth');
const { authLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.post('/activate', authLimiter, ctrl.activate);
router.post('/validate', authLimiter, ctrl.validate);
router.get('/me', clientAuth, ctrl.me);

module.exports = router;
