'use strict';

/**
 * Swagger UI + raw OpenAPI spec.
 *
 *   GET /api/docs            → interactive Swagger UI
 *   GET /api/docs/openapi.yaml  → raw spec
 *   GET /api/docs/openapi.json  → raw spec (JSON)
 *
 * The spec lives at server/openapi.yaml so non-Node consumers can fetch it
 * directly.
 */

const path = require('path');
const fs = require('fs');
const express = require('express');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');
const logger = require('../utils/logger');

const SPEC_PATH = path.resolve(__dirname, '..', '..', 'openapi.yaml');

let spec;
try {
  spec = yaml.load(fs.readFileSync(SPEC_PATH, 'utf8'));
} catch (err) {
  logger.warn({ err: err.message, path: SPEC_PATH }, 'openapi.yaml not loadable — docs will 503');
  spec = null;
}

const router = express.Router();

router.get('/openapi.yaml', (_req, res) => {
  if (!spec) return res.status(503).type('text/plain').send('openapi.yaml not available');
  res.type('text/yaml').sendFile(SPEC_PATH);
});

router.get('/openapi.json', (_req, res) => {
  if (!spec) return res.status(503).json({ ok: false, error: 'openapi.yaml not available' });
  res.json(spec);
});

if (spec) {
  router.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'WhatsApp SaaS API — Docs',
      customCss: '.topbar { display: none; }',
      swaggerOptions: {
        docExpansion: 'list',
        defaultModelsExpandDepth: 0,
        tryItOutEnabled: true,
        persistAuthorization: true,
      },
    })
  );
}

module.exports = router;
