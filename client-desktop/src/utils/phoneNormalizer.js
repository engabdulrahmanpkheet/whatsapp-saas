/**
 * src/utils/phoneNormalizer.js
 *
 * Smart phone cleaning + validation with country-aware rules.
 * Default country: Egypt (EG). Other countries pass through with basic cleanup.
 *
 * Egypt rules:
 *   - Strip spaces, +, -, (), dots
 *   - Strip leading "00"  (00201… → 201…)
 *   - "01XXXXXXXXX" (11 digits, local mobile) → "201XXXXXXXXX" (12 digits)
 *   - "1XXXXXXXXX"  (10 digits, missing leading 0) → "201XXXXXXXXX"
 *   - Already "20XXXXXXXXXX" (12 digits) → kept
 *   - Mobile prefix must be 10/11/12/15 (Vodafone / Etisalat / Orange / WE)
 *   - Final length must be exactly 12 digits
 *
 * Returns { phone, valid, reason, original } so callers can show diagnostics.
 */

const DEFAULT_COUNTRY = 'EG';

// Egypt valid mobile prefixes (after country code 20)
const EG_VALID_PREFIXES = ['10', '11', '12', '15'];

function stripJunk(input) {
  return String(input || '').replace(/[^\d]/g, '');
}

function normalizeEG(raw) {
  let n = stripJunk(raw);

  if (!n) return { phone: '', valid: false, reason: 'empty', original: raw };

  // Strip "00" international prefix (00 20 ... → 20 ...)
  if (n.startsWith('00')) n = n.slice(2);

  // Cases
  if (n.startsWith('20')) {
    // Already country-coded; keep as-is
  } else if (n.startsWith('01') && n.length === 11) {
    // Local mobile (01X XXXX XXXX) → add country code, drop leading 0
    n = '20' + n.slice(1);
  } else if (n.startsWith('1') && n.length === 10) {
    // Missing leading 0 (1X XXXX XXXX)
    n = '20' + n;
  } else if (n.length === 12 && n.startsWith('20')) {
    // Defensive
  } else if (n.length >= 11 && n.length <= 13) {
    // Looks foreign / unknown — pass through cleanup but mark uncertain later
  }

  // Validate
  if (!n.startsWith('20')) {
    return { phone: n, valid: false, reason: 'not_egypt_country_code', original: raw };
  }
  if (n.length !== 12) {
    return { phone: n, valid: false, reason: `bad_length_${n.length}`, original: raw };
  }
  const prefix = n.slice(2, 4);
  if (!EG_VALID_PREFIXES.includes(prefix)) {
    return { phone: n, valid: false, reason: `unknown_prefix_${prefix}`, original: raw };
  }
  return { phone: n, valid: true, reason: 'ok', original: raw };
}

function normalizeGeneric(raw) {
  const n = stripJunk(raw).replace(/^00/, '');
  if (!n) return { phone: '', valid: false, reason: 'empty', original: raw };
  if (n.length < 8 || n.length > 15) {
    return { phone: n, valid: false, reason: `bad_length_${n.length}`, original: raw };
  }
  return { phone: n, valid: true, reason: 'ok', original: raw };
}

function normalize(raw, country = DEFAULT_COUNTRY) {
  if (country === 'EG') return normalizeEG(raw);
  return normalizeGeneric(raw);
}

/**
 * Process an array of {phone, name, vars} entries:
 * returns enriched entries with normalized phone + validation flags.
 * Also dedupes by final phone, preserving first occurrence.
 */
function normalizeBatch(contacts, country = DEFAULT_COUNTRY) {
  const seen = new Set();
  const out = [];
  let invalidCount = 0;
  let duplicateCount = 0;

  for (const c of contacts) {
    const result = normalize(c.phone, country);
    const entry = {
      ...c,
      phone: result.phone,
      original_phone: result.original,
      valid: result.valid,
      reason: result.reason,
    };
    if (!result.valid) {
      invalidCount++;
      out.push(entry);
      continue;
    }
    if (seen.has(result.phone)) {
      duplicateCount++;
      entry.valid = false;
      entry.reason = 'duplicate';
      out.push(entry);
      continue;
    }
    seen.add(result.phone);
    out.push(entry);
  }

  return {
    contacts: out,
    stats: {
      total: contacts.length,
      valid: out.filter((x) => x.valid).length,
      invalid: invalidCount,
      duplicates: duplicateCount,
    },
  };
}

module.exports = { normalize, normalizeBatch, DEFAULT_COUNTRY, EG_VALID_PREFIXES };
