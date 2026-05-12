'use strict';

const express = require('express');
const ctrl = require('../controllers/campaign.controller');
const { clientAuth } = require('../middleware/auth');

const router = express.Router();
router.use(clientAuth);

router.post('/start', ctrl.start);
router.get('/status', ctrl.getOne);
router.get('/', ctrl.list);

router.get('/:id', ctrl.getOne);
router.get('/:id/report', ctrl.report);
router.patch('/:id/status', ctrl.updateStatus);
router.patch('/:id/risk', ctrl.updateRisk);
router.delete('/:id', ctrl.remove);

router.get('/:id/next', ctrl.next);
router.post('/:id/report', ctrl.reportJob);
router.post('/:id/skip', ctrl.skip);

module.exports = router;
