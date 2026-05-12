'use strict';

const express = require('express');
const ctrl = require('../controllers/message.controller');
const { clientAuth } = require('../middleware/auth');
const { sendLimiter } = require('../middleware/rateLimit');

const router = express.Router();
router.use(clientAuth);

router.post('/send', sendLimiter, ctrl.send);

module.exports = router;
