'use strict';

const EventEmitter = require('events');
const qrcode = require('qrcode');
const env = require('../config/env');
const logger = require('../utils/logger');
const SessionModel = require('../models/session.model');
const { useMongoAuthState, clearSession: clearAuthState } = require('./mongoAuthState');
const { toJid } = require('../utils/phone');

// Lazy require so the server can boot even if Baileys is temporarily unavailable
let baileys = null;
function loadBaileys() {
  if (baileys) return baileys;
  // eslint-disable-next-line global-require
  baileys = require('@whiskeysockets/baileys');
  return baileys;
}

const RECONNECT_DELAYS_MS = [3_000, 6_000, 9_000, 15_000, 30_000];

class WhatsAppManager extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map(); // sessionId -> { sock, status, qr, qrDataUrl, info, lastError, reconnectAttempts }
    this.starting = new Map(); // sessionId -> Promise (concurrent start guard)
    this.log = logger.child({ scope: 'wa' });
  }

  list() {
    const out = [];
    for (const [id, s] of this.sessions.entries()) {
      out.push({
        session_id: id,
        status: s.status,
        wa_id: s.info?.id || '',
        push_name: s.info?.name || '',
        has_qr: !!s.qr,
      });
    }
    return out;
  }

  get(sessionId) {
    return this.sessions.get(sessionId) || null;
  }

  async _updateDbStatus(sessionId, patch) {
    try {
      await SessionModel.updateOne({ session_id: sessionId }, { $set: patch }, { upsert: true });
    } catch (e) {
      this.log.warn({ sessionId, err: e.message }, 'session db update failed');
    }
  }

  async create({ sessionId, licenseKey }) {
    if (!sessionId) throw new Error('sessionId required');
    if (this.sessions.size >= env.WA_MAX_SESSIONS && !this.sessions.has(sessionId)) {
      throw new Error(`Max concurrent sessions reached (${env.WA_MAX_SESSIONS})`);
    }

    if (this.starting.has(sessionId)) return this.starting.get(sessionId);

    const promise = this._start(sessionId, licenseKey)
      .catch((e) => {
        this.log.error({ sessionId, err: e.message }, 'session start failed');
        throw e;
      })
      .finally(() => this.starting.delete(sessionId));

    this.starting.set(sessionId, promise);
    return promise;
  }

  async _start(sessionId, licenseKey) {
    const lib = loadBaileys();
    const {
      default: makeWASocket,
      DisconnectReason,
      fetchLatestBaileysVersion,
      Browsers,
    } = lib;

    let entry = this.sessions.get(sessionId);
    if (!entry) {
      entry = {
        sock: null,
        status: 'initializing',
        qr: '',
        qrDataUrl: '',
        qrAt: null,
        info: null,
        lastError: '',
        reconnectAttempts: 0,
        licenseKey,
      };
      this.sessions.set(sessionId, entry);
    } else {
      entry.status = 'initializing';
      entry.lastError = '';
    }

    await this._updateDbStatus(sessionId, {
      session_id: sessionId,
      license_key: licenseKey,
      status: 'initializing',
      last_error: '',
    });

    const { state, saveCreds } = await useMongoAuthState(sessionId, lib);
    let version;
    try {
      ({ version } = await fetchLatestBaileysVersion());
    } catch {
      version = undefined;
    }

    const sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: Browsers.macOS('WhatsApp SaaS'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false,
      logger: this._silentBaileysLogger(),
      connectTimeoutMs: 60_000,
      keepAliveIntervalMs: 25_000,
    });
    entry.sock = sock;

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        try {
          const dataUrl = await qrcode.toDataURL(qr);
          entry.qr = qr;
          entry.qrDataUrl = dataUrl;
          entry.qrAt = Date.now();
          entry.status = 'awaiting_qr';
          await this._updateDbStatus(sessionId, {
            status: 'awaiting_qr',
            qr,
            qr_at: new Date(),
          });
          this.emit('qr', { sessionId, qr, qrDataUrl: dataUrl });
        } catch (e) {
          this.log.warn({ sessionId, err: e.message }, 'qr render failed');
        }
      }

      if (connection === 'open') {
        entry.status = 'connected';
        entry.reconnectAttempts = 0;
        entry.qr = '';
        entry.qrDataUrl = '';
        entry.info = {
          id: sock.user?.id || '',
          name: sock.user?.name || sock.user?.verifiedName || '',
        };
        entry.lastError = '';
        await this._updateDbStatus(sessionId, {
          status: 'connected',
          qr: '',
          qr_at: null,
          wa_id: entry.info.id,
          push_name: entry.info.name,
          last_connected_at: new Date(),
          last_error: '',
          reconnect_attempts: 0,
        });
        this.emit('ready', { sessionId, info: entry.info });
        this.log.info({ sessionId, wa_id: entry.info.id }, 'session connected');
      }

      if (connection === 'close') {
        const err = lastDisconnect?.error;
        const code = err?.output?.statusCode;
        const reason = err?.message || 'closed';
        entry.lastError = reason;
        const isLoggedOut = code === DisconnectReason.loggedOut;
        const isReplaced = code === DisconnectReason.connectionReplaced;
        const isBanned = code === DisconnectReason.forbidden;
        entry.status = isLoggedOut || isReplaced || isBanned ? 'logged_out' : 'disconnected';

        await this._updateDbStatus(sessionId, {
          status: entry.status,
          last_disconnected_at: new Date(),
          last_error: reason,
          reconnect_attempts: entry.reconnectAttempts,
        });
        this.emit('disconnected', { sessionId, reason, code, fatal: entry.status === 'logged_out' });
        this.log.warn({ sessionId, code, reason }, 'session disconnected');

        if (!isLoggedOut && !isReplaced && !isBanned) {
          this._scheduleReconnect(sessionId);
        }
      }
    });

    return { sessionId, status: entry.status };
  }

  _scheduleReconnect(sessionId) {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    if (entry.reconnectAttempts >= env.WA_RECONNECT_MAX) {
      this.log.error({ sessionId }, 'session reconnect exhausted');
      entry.status = 'error';
      this._updateDbStatus(sessionId, { status: 'error', last_error: 'reconnect_exhausted' });
      return;
    }
    const delay = RECONNECT_DELAYS_MS[entry.reconnectAttempts] || 30_000;
    entry.reconnectAttempts += 1;
    setTimeout(() => {
      this.create({ sessionId, licenseKey: entry.licenseKey }).catch((e) =>
        this.log.error({ sessionId, err: e.message }, 'reconnect failed')
      );
    }, delay).unref();
  }

  _silentBaileysLogger() {
    const noop = () => {};
    const child = () => api;
    const api = {
      trace: noop,
      debug: noop,
      info: noop,
      warn: noop,
      error: (...args) => this.log.warn({ baileys: args }, 'baileys'),
      fatal: (...args) => this.log.error({ baileys: args }, 'baileys-fatal'),
      child,
      level: 'silent',
    };
    return api;
  }

  async qr(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return null;
    if (!s.qr || !s.qrAt) return null;
    if (Date.now() - s.qrAt > env.WA_QR_TTL_MS) return null;
    return { qr: s.qr, qrDataUrl: s.qrDataUrl, status: s.status };
  }

  status(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return { exists: false, status: 'idle' };
    return {
      exists: true,
      status: s.status,
      wa_id: s.info?.id || '',
      push_name: s.info?.name || '',
      has_qr: !!s.qr,
      last_error: s.lastError || '',
      reconnect_attempts: s.reconnectAttempts,
    };
  }

  async sendText(sessionId, phone, text) {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'connected' || !s.sock) {
      throw new Error('session_not_connected');
    }
    const jid = toJid(phone);
    if (!jid) throw new Error('invalid_phone');
    return s.sock.sendMessage(jid, { text: String(text || '') });
  }

  async sendMedia(sessionId, phone, media) {
    const s = this.sessions.get(sessionId);
    if (!s || s.status !== 'connected' || !s.sock) {
      throw new Error('session_not_connected');
    }
    const jid = toJid(phone);
    if (!jid) throw new Error('invalid_phone');

    const payload = buildMediaMessage(media);
    return s.sock.sendMessage(jid, payload);
  }

  async logout(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    try {
      if (s.sock) await s.sock.logout().catch(() => {});
    } finally {
      this.sessions.delete(sessionId);
      await clearAuthState(sessionId).catch(() => {});
      await this._updateDbStatus(sessionId, {
        status: 'logged_out',
        qr: '',
        qr_at: null,
        wa_id: '',
        push_name: '',
        last_disconnected_at: new Date(),
      });
    }
    return true;
  }

  async stop(sessionId) {
    const s = this.sessions.get(sessionId);
    if (!s) return false;
    try {
      if (s.sock?.end) s.sock.end(undefined);
    } catch {
      /* ignore */
    }
    this.sessions.delete(sessionId);
    await this._updateDbStatus(sessionId, { status: 'disconnected' });
    return true;
  }

  async shutdownAll() {
    const ids = Array.from(this.sessions.keys());
    await Promise.allSettled(ids.map((id) => this.stop(id)));
  }
}

function buildMediaMessage(media) {
  const caption = media.caption || '';
  if (media.dataUrl) {
    const m = /^data:([^;]+);base64,(.+)$/.exec(media.dataUrl);
    if (!m) throw new Error('invalid_dataUrl');
    const mime = m[1];
    const buf = Buffer.from(m[2], 'base64');
    return classifyMediaPayload(buf, mime, media);
  }
  if (media.url) {
    const mime = media.mime || '';
    return classifyMediaPayload({ url: media.url }, mime, media);
  }
  throw new Error('media_source_required');
}

function classifyMediaPayload(source, mime, media) {
  const caption = media.caption || '';
  const fileName = media.filename || '';
  if (media.asDocument || (mime && !/^image|^video|^audio/.test(mime))) {
    return { document: source, mimetype: mime || 'application/octet-stream', fileName, caption };
  }
  if (mime.startsWith('image')) return { image: source, mimetype: mime, caption };
  if (mime.startsWith('video')) return { video: source, mimetype: mime, caption };
  if (mime.startsWith('audio')) return { audio: source, mimetype: mime, ptt: false };
  return { document: source, fileName, mimetype: mime || 'application/octet-stream', caption };
}

const manager = new WhatsAppManager();
module.exports = manager;
