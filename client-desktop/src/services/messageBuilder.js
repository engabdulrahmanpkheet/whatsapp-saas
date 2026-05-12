/**
 * src/services/messageBuilder.js
 *
 * Builds the final message + media payload for a job.
 * Supports:
 *  - Template variables: {{name}}, {{phone}}, plus any custom var
 *  - Message variation: pick a random variation if list provided
 *  - Media: passes through media descriptor (path/url/mime) — actual send
 *           happens in whatsapp.service via MessageMedia.fromFilePath / fromUrl
 */

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function applyTemplate(template, contact) {
  let text = String(template || '');
  text = text.replace(/\{\{\s*name\s*\}\}/gi, contact.name || '');
  text = text.replace(/\{\{\s*phone\s*\}\}/gi, contact.phone || '');

  if (contact.vars && typeof contact.vars === 'object') {
    for (const [k, v] of Object.entries(contact.vars)) {
      text = text.replace(
        new RegExp(`\\{\\{\\s*${escapeRegex(k)}\\s*\\}\\}`, 'gi'),
        String(v == null ? '' : v)
      );
    }
  }
  return text;
}

/**
 * Build a job payload from a campaign + contact.
 * @param {object} job  - { message_template, variations[], media{}, ... }
 * @param {object} contact - { name, phone, vars }
 * @returns {{ text: string, media: object|null }}
 */
function buildJobMessage(job, contact) {
  // Pick base template — variations override message_template if non-empty
  let template = job.message_template || '';
  if (Array.isArray(job.variations) && job.variations.length > 0) {
    const pool = job.variations.filter((v) => v && v.trim());
    if (pool.length) {
      template = pool[Math.floor(Math.random() * pool.length)];
    }
  }

  const text = applyTemplate(template, contact);
  const media = job.media && (job.media.url || job.media.path || job.media.dataUrl)
    ? job.media
    : null;

  return { text, media };
}

module.exports = { applyTemplate, buildJobMessage };
