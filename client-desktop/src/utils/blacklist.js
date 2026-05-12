/**
 * src/utils/blacklist.js — Persistent blacklist of phone numbers.
 * Storage: electron-store. Phone is normalized before lookup/insert.
 */
const Store = require('electron-store');

const store = new Store({ name: 'whatsapp-saas-blacklist', defaults: { phones: [] } });
const norm = (p) => String(p || '').replace(/\D/g, '');

function getAll() {
  return store.get('phones') || [];
}

function isBlocked(phone) {
  const n = norm(phone);
  return getAll().includes(n);
}

function add(phone, note = '') {
  const n = norm(phone);
  if (!n) return false;
  const cur = store.get('phones') || [];
  if (cur.includes(n)) return false;
  cur.unshift(n);
  store.set('phones', cur);
  if (note) {
    const notes = store.get('notes') || {};
    notes[n] = note;
    store.set('notes', notes);
  }
  return true;
}

function remove(phone) {
  const n = norm(phone);
  const cur = store.get('phones') || [];
  const next = cur.filter((p) => p !== n);
  store.set('phones', next);
  return cur.length !== next.length;
}

function clear() {
  store.set('phones', []);
  store.set('notes', {});
}

function listWithNotes() {
  const phones = getAll();
  const notes = store.get('notes') || {};
  return phones.map((p) => ({ phone: p, note: notes[p] || '' }));
}

module.exports = { getAll, isBlocked, add, remove, clear, listWithNotes };
