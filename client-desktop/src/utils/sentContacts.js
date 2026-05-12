/**
 * src/utils/sentContacts.js — Persistent log of phones we've successfully sent to.
 * Used by Auto-Save Contacts feature. Capped at 10k entries (FIFO).
 */
const Store = require('electron-store');

const store = new Store({ name: 'whatsapp-saas-sent', defaults: { entries: [] } });
const MAX = 10_000;
const norm = (p) => String(p || '').replace(/\D/g, '');

function record(phone, name = '', campaignName = '') {
  const n = norm(phone);
  if (!n) return false;
  const entries = store.get('entries') || [];
  const now = Date.now();

  // Update existing entry timestamp instead of duplicating
  const idx = entries.findIndex((e) => e.phone === n);
  if (idx !== -1) {
    entries[idx] = { phone: n, name: name || entries[idx].name, campaign: campaignName, ts: now };
  } else {
    entries.unshift({ phone: n, name, campaign: campaignName, ts: now });
    if (entries.length > MAX) entries.length = MAX;
  }
  store.set('entries', entries);
  return true;
}

function list() { return store.get('entries') || []; }
function clear() { store.set('entries', []); }
function count() { return (store.get('entries') || []).length; }

module.exports = { record, list, clear, count };
