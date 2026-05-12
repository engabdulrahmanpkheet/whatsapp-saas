'use strict';

const express = require('express');
const ctrl = require('../controllers/health.controller');

const router = express.Router();

// Both Render (`/healthz` convention) and Railway use plain text "OK"
// responses; clients that want JSON can hit /health (alias).
router.get('/', ctrl.healthz);
router.get('/detailed', ctrl.detailed);

module.exports = router;
