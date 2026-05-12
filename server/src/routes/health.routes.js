'use strict';

const express = require('express');
const ctrl = require('../controllers/health.controller');

const router = express.Router();
router.get('/', ctrl.simple);
router.get('/detailed', ctrl.detailed);
module.exports = router;
