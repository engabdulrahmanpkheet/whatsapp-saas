/**
 * src/utils/excelParser.js
 * Reads .xlsx / .xls / .csv and returns enriched contact entries.
 *
 * Output: { contacts:[ { phone, name, vars, valid, reason, original_phone } ], stats }
 *
 * Recognized columns (case-insensitive): phone | mobile | number | whatsapp,
 *                                        name  | full name | contact
 * Any other column becomes a template variable usable as {{column_name}}.
 */
const XLSX = require('xlsx');
const { normalizeBatch } = require('./phoneNormalizer');

const PHONE_KEYS = ['phone', 'mobile', 'number', 'whatsapp', 'tel', 'telephone'];
const NAME_KEYS  = ['name', 'full name', 'contact', 'fullname'];

function pickKey(row, candidates) {
  const keys = Object.keys(row);
  for (const k of keys) {
    if (candidates.includes(k.toLowerCase().trim())) return k;
  }
  return null;
}

function parseFile(filepath, country = 'EG') {
  const wb = XLSX.readFile(filepath, { cellDates: false });
  const sheetName = wb.SheetNames[0];
  if (!sheetName) return { contacts: [], stats: { total: 0, valid: 0, invalid: 0, duplicates: 0 } };

  const sheet = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
  if (!rows.length) return { contacts: [], stats: { total: 0, valid: 0, invalid: 0, duplicates: 0 } };

  const phoneKey = pickKey(rows[0], PHONE_KEYS);
  const nameKey  = pickKey(rows[0], NAME_KEYS);

  const raw = [];
  for (const row of rows) {
    const rawPhone = phoneKey ? row[phoneKey] : Object.values(row)[0];
    const name = nameKey ? String(row[nameKey] || '').trim() : '';

    const vars = {};
    for (const k of Object.keys(row)) {
      if (k === phoneKey || k === nameKey) continue;
      const v = row[k];
      if (v !== '' && v != null) {
        vars[k.toLowerCase().trim().replace(/\s+/g, '_')] = String(v);
      }
    }
    raw.push({ phone: rawPhone, name, vars });
  }

  // Normalize + dedupe + validate
  return normalizeBatch(raw, country);
}

module.exports = { parseFile };
