/**
 * src/utils/fingerprint.js
 * Stable, hashed device fingerprint. Raw values never leave the machine.
 */
const crypto = require('crypto');
const os = require('os');

function getFingerprint() {
  const macs = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && !i.internal && i.mac && i.mac !== '00:00:00:00:00:00')
    .map((i) => i.mac)
    .sort();

  const cpu = (os.cpus()[0] || {}).model || '';
  const parts = [
    os.hostname(),
    os.platform(),
    os.arch(),
    os.totalmem().toString(),
    cpu,
    macs.join(','),
  ];

  return crypto.createHash('sha256').update(parts.join('||')).digest('hex');
}

module.exports = { getFingerprint };
