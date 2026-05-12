/**
 * routes/campaign.routes.js
 * All campaign endpoints require a valid client (desktop) JWT.
 */
const express = require('express');
const ctrl = require('../controllers/campaign.controller');
const { clientAuth } = require('../middleware/auth.middleware');

const router = express.Router();
router.use(clientAuth);

router.post('/start',   ctrl.start);          // POST /api/campaign/start
router.get ('/status',  ctrl.getOne);         // GET  /api/campaign/status?id=...
router.get ('/',        ctrl.list);

router.get   ('/:id',          ctrl.getOne);
router.get   ('/:id/report',   ctrl.report);   // v3 - per-contact breakdown
router.patch ('/:id/status',   ctrl.updateStatus);
router.patch ('/:id/risk',     ctrl.updateRisk); // v3 - bulk risk updates
router.delete('/:id',          ctrl.remove);

// Worker endpoints
router.get ('/:id/next',   ctrl.next);
router.post('/:id/report', ctrl.reportJob);
router.post('/:id/skip',   ctrl.skip);          // v3 - skip risky/non-WA contacts

module.exports = router;
