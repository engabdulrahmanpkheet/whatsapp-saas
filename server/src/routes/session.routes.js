'use strict';

const express = require('express');
const ctrl = require('../controllers/session.controller');
const { clientAuth } = require('../middleware/auth');

const router = express.Router();
router.use(clientAuth);

router.post('/create', ctrl.create);
router.get('/:id/qr', ctrl.qr);
router.get('/:id/status', ctrl.status);
router.post('/:id/logout', ctrl.logout);

module.exports = router;
