'use strict';

function normalize(raw) {
  let s = String(raw == null ? '' : raw).replace(/\D+/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = s.slice(2);
  if (s.startsWith('0') && s.length === 11) s = '20' + s.slice(1);
  return s;
}

function toJid(phone) {
  const n = normalize(phone);
  if (!n) return '';
  return `${n}@s.whatsapp.net`;
}

module.exports = { normalize, toJid };
