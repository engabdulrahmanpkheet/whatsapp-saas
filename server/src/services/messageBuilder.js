'use strict';

/**
 * Build the outgoing message text for a campaign job.
 *
 * - If `variations` is non-empty, pick a random alt template (anti-ban: keeps
 *   message fingerprints from looking identical across recipients).
 * - Expand `{{var}}` placeholders from contact.vars + contact.name + phone.
 * - Trim trailing whitespace.
 */

const PLACEHOLDER = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}/g;

function pickTemplate(template, variations) {
  if (!Array.isArray(variations) || variations.length === 0) return template;
  const all = [template, ...variations].filter((s) => s && String(s).trim());
  if (!all.length) return template;
  return all[Math.floor(Math.random() * all.length)];
}

function expand(template, contact) {
  const vars = {
    name: contact.name || '',
    phone: contact.phone || '',
    ...(contact.vars && typeof contact.vars === 'object' ? contact.vars : {}),
  };
  return String(template || '').replace(PLACEHOLDER, (_m, key) => {
    return vars[key] != null ? String(vars[key]) : '';
  });
}

function buildText(campaign, contact) {
  const chosen = pickTemplate(campaign.message_template, campaign.variations);
  return expand(chosen, contact).trim();
}

module.exports = { buildText, pickTemplate, expand };
