'use strict';

const asyncHandler = require('../utils/asyncHandler');
const manager = require('../whatsapp/manager');
const { bad } = require('../utils/AppError');

exports.send = asyncHandler(async (req, res) => {
  const sessionId = String(req.license.license_key).toUpperCase();
  const { phone, text, media } = req.body || {};
  if (!phone) throw bad('phone required');
  if (!text && !media) throw bad('text or media required');

  const status = manager.status(sessionId);
  if (!status.exists || status.status !== 'connected') {
    return res.status(409).json({
      ok: false,
      error: 'WhatsApp session not connected',
      code: 'SESSION_NOT_CONNECTED',
      status: status.status,
    });
  }

  let result;
  if (media) {
    result = await manager.sendMedia(sessionId, phone, media);
    if (text && !media.caption) {
      // optional follow-up text if caption not supplied
      await manager.sendText(sessionId, phone, text);
    }
  } else {
    result = await manager.sendText(sessionId, phone, text);
  }

  res.json({
    ok: true,
    message_id: result?.key?.id || null,
    to: phone,
    timestamp: Date.now(),
  });
});
