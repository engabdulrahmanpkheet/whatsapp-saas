/**
 * utils/generateLicenseKey.js
 * Format: WA-XXXX-XXXX-XXXX-XXXX  (no 0/O/1/I)
 */
const crypto = require('crypto');

function generateLicenseKey(prefix = 'WA') {
  const groups = 4;
  const groupLen = 4;
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const parts = [prefix];
  for (let i = 0; i < groups; i++) {
    let segment = '';
    const bytes = crypto.randomBytes(groupLen);
    for (let j = 0; j < groupLen; j++) {
      segment += alphabet[bytes[j] % alphabet.length];
    }
    parts.push(segment);
  }
  return parts.join('-');
}

module.exports = generateLicenseKey;
