/**
 * src/services/whatsapp.service.js — v4 (Singleton Manager)
 *
 * Responsibilities:
 *   - Own the SOLE puppeteer browser instance (singleton)
 *   - Boot fast: persistent userDataDir, optimized launch args, lock cleanup
 *   - Granular state machine for UI ("initializing", "restoring_session", "connected", etc.)
 *   - Auto-reconnect on transient drops; require user action on hard logout
 *   - Show / hide the puppeteer Chromium window via Chrome DevTools Protocol
 *   - Preserve all v3 send/media/group APIs (zero breakage)
 *
 * Fundamental note:
 *   We use whatsapp-web.js's puppeteer browser AS the WhatsApp UI surface.
 *   We CANNOT also load web.whatsapp.com inside an Electron BrowserView
 *   with the same session — Chromium IndexedDB cannot be open in two
 *   processes simultaneously. So: ONE browser, ONE session, made visible
 *   on demand and otherwise minimized.
 */
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const mime = require('mime-types');

// ---------- Speed-tuned Chromium args ----------
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-extensions',
  '--disable-default-apps',
  '--disable-background-networking',
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-sync',
  '--disable-translate',
  '--metrics-recording-only',
  '--mute-audio',
  '--no-pings',
  '--password-store=basic',
  '--use-mock-keychain',
  // Start window offscreen and reasonably sized; CDP repositions on demand
  '--window-size=1100,800',
  '--window-position=-32000,-32000',
];

// Chromium leaves these stale if it crashed; they cause "Browser already running"
const STALE_LOCK_FILES = ['SingletonLock', 'SingletonCookie', 'SingletonSocket', 'lockfile'];

// State machine
const STATES = Object.freeze({
  IDLE:            'idle',
  INITIALIZING:    'initializing',     // Booting puppeteer
  RESTORING:       'restoring_session',// Reusing saved session, syncing
  AWAITING_QR:     'awaiting_qr',      // No saved session, QR shown
  AUTHENTICATING:  'authenticating',   // QR scanned, waiting for ready
  CONNECTED:       'connected',
  RECONNECTING:    'reconnecting',
  DISCONNECTED:    'disconnected',     // Soft (network) — will auto-retry
  LOGGED_OUT:      'logged_out',       // Hard (user intent) — needs new QR
  ERROR:           'error',
});

class WhatsAppManager extends EventEmitter {
  constructor({ baseSessionDir }) {
    super();
    this.baseSessionDir = baseSessionDir;
    this.client = null;
    this._initPromise = null;
    this._state = STATES.IDLE;
    this._stateMessage = '';
    this._account = null;     // { phone, pushname, platform }
    this._lastQR = null;
    this._reconnectAttempts = 0;
    this._maxReconnectAttempts = 5;
    this._intentionalStop = false;
  }

  // ===== Public state accessors =====
  get state() { return this._state; }
  get account() { return this._account; }
  get isReady() { return this._state === STATES.CONNECTED; }

  _setState(state, message = '', extra = {}) {
    this._state = state;
    this._stateMessage = message;
    this.emit('state', { state, message, account: this._account, ...extra });
  }

  // ===== Lifecycle =====

  /**
   * Start (or reuse) the singleton browser. Idempotent — concurrent callers
   * await the same in-flight initialization promise.
   */
  async start() {
    if (this._state === STATES.CONNECTED) {
      this.emit('state', { state: this._state, account: this._account });
      return { ok: true };
    }
    if (this._initPromise) return this._initPromise;

    this._intentionalStop = false;
    this._initPromise = this._doStart()
      .catch((err) => {
        this._setState(STATES.ERROR, err.message);
        throw err;
      })
      .finally(() => { this._initPromise = null; });

    return this._initPromise;
  }

  async _doStart() {
    this._setState(STATES.INITIALIZING, 'Starting WhatsApp engine…');

    // 1) Clean up any stale Chromium lock files left from a previous crash
    this._cleanStaleLocks();

    // 2) Detect whether we have a saved session for nicer UX messaging
    const hasSession = this._hasExistingSession();
    if (hasSession) {
      this._setState(STATES.RESTORING, 'Restoring session…');
    }

    // 3) Build client with persistent session and optimized args
    this.client = new Client({
      authStrategy: new LocalAuth({
        clientId: 'default',
        dataPath: this.baseSessionDir,
      }),
      puppeteer: {
        headless: false,
        args: CHROMIUM_ARGS,
        defaultViewport: null,
        // Reasonable timeouts — keep low so users see errors faster
        timeout: 60_000,
      },
      // Faster auth detection
      qrMaxRetries: 5,
      // Skip heavy version probing each launch
      takeoverOnConflict: true,
      takeoverTimeoutMs: 10_000,
    });

    // 4) Wire events
    this._wireEvents();

    // 5) Initialize (spawns Chromium, opens web.whatsapp.com)
    try {
      await this.client.initialize();
    } catch (err) {
      // Common case: stale lock; retry once after cleaning
      if (/already running|SingletonLock|profile is in use/i.test(err.message)) {
        this._cleanStaleLocks(true);
        await this.client.initialize();
      } else {
        throw err;
      }
    }
  }

  _wireEvents() {
    this.client.on('qr', (qr) => {
      this._lastQR = qr;
      this._setState(STATES.AWAITING_QR, 'Scan QR code with your phone');
      this.emit('qr', qr);
    });

    this.client.on('loading_screen', (percent, message) => {
      // Fired during session restore / initial sync
      this._setState(
        STATES.RESTORING,
        `Loading ${percent}% — ${message || 'syncing chats'}`,
        { percent }
      );
    });

    this.client.on('authenticated', () => {
      this._lastQR = null;
      this._setState(STATES.AUTHENTICATING, 'Authenticated, finalizing…');
    });

    this.client.on('auth_failure', (msg) => {
      this._setState(STATES.ERROR, `Authentication failed: ${msg}`);
    });

    this.client.on('ready', async () => {
      this._reconnectAttempts = 0;
      // Best-effort window minimize (so user only sees Electron until they ask)
      this.hideWindow().catch(() => {});

      try {
        const info = this.client.info;
        this._account = {
          phone:    info?.wid?.user || '',
          wid:      info?.wid?._serialized || '',
          pushname: info?.pushname || '',
          platform: info?.platform || '',
        };
      } catch { this._account = null; }

      this._setState(STATES.CONNECTED, 'Connected', { account: this._account });
    });

    this.client.on('disconnected', (reason) => {
      this._account = null;
      const r = String(reason || '').toUpperCase();
      const hardLogout = r === 'LOGOUT' || r === 'CONFLICT' || r === 'UNPAIRED';

      if (this._intentionalStop || hardLogout) {
        this._setState(STATES.LOGGED_OUT, `Disconnected: ${reason}`);
        return;
      }

      // Soft drop — auto-reconnect
      this._setState(STATES.RECONNECTING, `Connection lost (${reason}). Reconnecting…`);
      this._scheduleReconnect();
    });
  }

  _scheduleReconnect() {
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      this._setState(STATES.ERROR, 'Reconnect failed after multiple attempts. Use Restart.');
      return;
    }
    this._reconnectAttempts++;
    const backoffMs = Math.min(30_000, 3_000 * this._reconnectAttempts);
    this.emit('log', `Auto-reconnect attempt ${this._reconnectAttempts}/${this._maxReconnectAttempts} in ${backoffMs / 1000}s`);

    setTimeout(async () => {
      try {
        // Best-effort destroy then re-init
        try { await this.client?.destroy(); } catch (_) {}
        this.client = null;
        await this.start();
      } catch (err) {
        this.emit('log', `Reconnect attempt failed: ${err.message}`);
        this._scheduleReconnect();
      }
    }, backoffMs);
  }

  /** Hard restart: destroy current browser, re-init */
  async restart() {
    this._intentionalStop = true;
    try { await this.client?.destroy(); } catch (_) {}
    this.client = null;
    this._account = null;
    this._cleanStaleLocks(true);
    this._intentionalStop = false;
    this._reconnectAttempts = 0;
    this._setState(STATES.INITIALIZING, 'Restarting…');
    return this.start();
  }

  /** User-initiated logout from WhatsApp (keeps session for next login? NO — drops it) */
  async logout() {
    this._intentionalStop = true;
    try { if (this.client) await this.client.logout(); } catch (_) {}
    try { if (this.client) await this.client.destroy(); } catch (_) {}
    this.client = null;
    this._account = null;
    this._setState(STATES.LOGGED_OUT, 'Logged out');
    return { ok: true };
  }

  /** Wipe local session — forces fresh QR on next start */
  async clearSession() {
    this._intentionalStop = true;
    try { if (this.client) await this.client.destroy(); } catch (_) {}
    this.client = null;
    this._account = null;

    // LocalAuth stores session at <baseSessionDir>/session-default
    const sessionDir = path.join(this.baseSessionDir, 'session-default');
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) {
      this.emit('log', `Failed to remove session dir: ${e.message}`);
    }
    this._setState(STATES.IDLE, 'Session cleared');
    return { ok: true };
  }

  /** Stop the browser without touching the session (e.g. on app close) */
  async stop() {
    this._intentionalStop = true;
    try { if (this.client) await this.client.destroy(); } catch (_) {}
    this.client = null;
    this._account = null;
    this._setState(STATES.IDLE, 'Stopped');
  }

  // ===== Window control via CDP =====

  /**
   * Overlay the puppeteer Chromium window directly on top of the Electron
   * window's bounds (looks like an embedded view).  Inject a floating
   * "Back to Dashboard" button that calls `onBack` in the Node/Electron
   * process — that handler is responsible for hiding this window and
   * re-showing the Electron window.
   */
  async showWindow(electronBounds = null, onBack = null) {
    if (!this.client?.pupPage) return { ok: false, error: 'Browser not running' };
    const page = this.client.pupPage;
    let cdp = null;
    try {
      cdp = await page.target().createCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');

      let bounds;
      if (electronBounds && Number.isFinite(electronBounds.x)) {
        // Overlay precisely on top of Electron window
        bounds = {
          left:   Math.max(0, Math.floor(electronBounds.x)),
          top:    Math.max(0, Math.floor(electronBounds.y)),
          width:  Math.max(900, Math.floor(electronBounds.width)),
          height: Math.max(700, Math.floor(electronBounds.height)),
          windowState: 'normal',
        };
      } else {
        bounds = { left: 80, top: 80, width: 1180, height: 800, windowState: 'normal' };
      }
      await cdp.send('Browser.setWindowBounds', { windowId, bounds });
      await page.bringToFront();

      // Expose back handler + inject floating button (idempotent)
      if (onBack) {
        try {
          if (!this._exposed_back) {
            await page.exposeFunction('__electronBackToDashboard__', async () => {
              try { await onBack(); } catch (_) {}
            });
            this._exposed_back = true;
          }
        } catch (_) { /* already exposed */ }

        await page.evaluate(() => {
          if (document.getElementById('__electron_back_btn__')) return;
          const btn = document.createElement('button');
          btn.id = '__electron_back_btn__';
          btn.textContent = '← Back to Dashboard';
          btn.style.cssText = [
            'position:fixed',
            'top:14px',
            'left:14px',
            'z-index:2147483647',
            'padding:10px 16px',
            'background:#25d366',
            'color:#0b0e13',
            'border:none',
            'border-radius:10px',
            'font:600 13px -apple-system,Segoe UI,Roboto,sans-serif',
            'cursor:pointer',
            'box-shadow:0 4px 16px rgba(0,0,0,0.35)',
          ].join(';');
          btn.onmouseenter = () => { btn.style.background = '#1fb558'; };
          btn.onmouseleave = () => { btn.style.background = '#25d366'; };
          btn.onclick = () => window.__electronBackToDashboard__ && window.__electronBackToDashboard__();
          document.body.appendChild(btn);
        });
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (cdp) { try { await cdp.detach(); } catch (_) {} }
    }
  }

  /** Minimize the puppeteer window so only Electron is visible. */
  async hideWindow() {
    if (!this.client?.pupPage) return { ok: false, error: 'Browser not running' };
    const page = this.client.pupPage;
    let cdp = null;
    try {
      cdp = await page.target().createCDPSession();
      const { windowId } = await cdp.send('Browser.getWindowForTarget');
      await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    } finally {
      if (cdp) { try { await cdp.detach(); } catch (_) {} }
    }
  }

  // ===== Internals =====

  _hasExistingSession() {
    try {
      const dir = path.join(this.baseSessionDir, 'session-default');
      if (!fs.existsSync(dir)) return false;
      const entries = fs.readdirSync(dir);
      return entries.length > 0;
    } catch { return false; }
  }

  _cleanStaleLocks(force = false) {
    try {
      const candidates = [
        this.baseSessionDir,
        path.join(this.baseSessionDir, 'session-default'),
      ];
      for (const dir of candidates) {
        if (!fs.existsSync(dir)) continue;
        for (const f of STALE_LOCK_FILES) {
          const p = path.join(dir, f);
          if (fs.existsSync(p)) {
            try { fs.unlinkSync(p); } catch (_) {}
          }
        }
        // Defensively remove nested ones too (Chromium nests locks per-profile)
        try {
          for (const sub of fs.readdirSync(dir)) {
            const subp = path.join(dir, sub);
            if (fs.statSync(subp).isDirectory()) {
              for (const f of STALE_LOCK_FILES) {
                const p = path.join(subp, f);
                if (fs.existsSync(p)) {
                  try { fs.unlinkSync(p); } catch (_) {}
                }
              }
            }
          }
        } catch (_) {}
      }
    } catch (e) {
      if (force) this.emit('log', `Lock cleanup error: ${e.message}`);
    }
  }

  // ===== Messaging — unchanged public API from v3 =====

  async getAccountInfo() {
    return this._account;
  }

  async isOnWhatsApp(phone) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    try {
      const numberId = await this.client.getNumberId(phone);
      return !!numberId;
    } catch { return false; }
  }

  async sendText(phone, text, opts = {}) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const numberId = await this.client.getNumberId(phone);
    if (!numberId) throw new Error('Number not on WhatsApp');
    const chatId = `${phone}@c.us`;

    // Optional typing simulation (anti-ban)
    if (opts.simulateTyping) {
      try {
        const chat = await this.client.getChatById(chatId);
        await chat.sendStateTyping();
        const typeMs = Math.max(800, Math.min(4000, (text || '').length * 40));
        await new Promise((r) => setTimeout(r, typeMs));
        await chat.clearState();
      } catch (_) { /* non-fatal */ }
    }

    return this.client.sendMessage(chatId, text, {
      linkPreview: opts.linkPreview !== false,
    });
  }

  async sendMedia(phone, media, caption = '', opts = {}) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const numberId = await this.client.getNumberId(phone);
    if (!numberId) throw new Error('Number not on WhatsApp');
    const chatId = `${phone}@c.us`;
    const mm = await this._buildMessageMedia(media);

    if (opts.simulateTyping) {
      try {
        const chat = await this.client.getChatById(chatId);
        await chat.sendStateTyping();
        await new Promise((r) => setTimeout(r, 1500));
        await chat.clearState();
      } catch (_) {}
    }

    return this.client.sendMessage(chatId, mm, {
      caption: caption || media.caption || '',
      sendMediaAsDocument: media.asDocument === true,
    });
  }

  /** Fetch profile picture URL for the connected account (or any chat id). */
  async getProfilePicUrl(targetWid = null) {
    if (!this.isReady) return null;
    try {
      const wid = targetWid || this._account?.wid;
      if (!wid) return null;
      return await this.client.getProfilePicUrl(wid);
    } catch { return null; }
  }

  /** Get a single group's full details including all participants. */
  async getGroupDetails(groupId) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const chat = await this.client.getChatById(groupId);
    if (!chat || !chat.isGroup) throw new Error('Not a group');

    const meId = this._account?.wid || '';
    const participants = chat.participants || chat.groupMetadata?.participants || [];
    const members = participants
      .map((p) => {
        const id = p.id?._serialized || p._serialized || '';
        const phone = (p.id?.user || '').toString();
        if (!id || id === meId) return null;
        return {
          id,
          phone,
          isAdmin: !!p.isAdmin,
          isSuperAdmin: !!p.isSuperAdmin,
        };
      })
      .filter(Boolean);

    let picUrl = null;
    try { picUrl = await this.client.getProfilePicUrl(groupId); } catch (_) {}

    return {
      id: chat.id._serialized,
      name: chat.name || '',
      description: chat.groupMetadata?.desc || '',
      participants_count: members.length,
      members,
      picUrl,
    };
  }

  async listGroups() {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const chats = await this.client.getChats();
    return chats
      .filter((c) => c.isGroup)
      .map((g) => ({
        id: g.id?._serialized || '',
        name: g.name || '',
        participants_count:
          g.participants?.length ||
          g.groupMetadata?.participants?.length ||
          0,
      }));
  }

  async sendToGroup(groupId, text) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    return this.client.sendMessage(groupId, text);
  }

  async sendMediaToGroup(groupId, media, caption = '') {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const mm = await this._buildMessageMedia(media);
    return this.client.sendMessage(groupId, mm, {
      caption: caption || media.caption || '',
      sendMediaAsDocument: media.asDocument === true,
    });
  }

  async extractGroupMembers(groupId) {
    if (!this.isReady) throw new Error('WhatsApp not ready');
    const chat = await this.client.getChatById(groupId);
    if (!chat || !chat.isGroup) throw new Error('Not a group');

    const meId = this._account?.wid || '';
    const participants = chat.participants || chat.groupMetadata?.participants || [];

    return participants
      .map((p) => {
        const id = p.id?._serialized || p._serialized || '';
        const phone = (p.id?.user || '').toString();
        return id && id !== meId ? { id, phone } : null;
      })
      .filter(Boolean);
  }

  async _buildMessageMedia(media) {
    if (!media) throw new Error('No media descriptor');
    if (media.type === 'path' && media.path) {
      if (!fs.existsSync(media.path)) throw new Error('Media file missing: ' + media.path);
      const mm = MessageMedia.fromFilePath(media.path);
      if (media.filename) mm.filename = media.filename;
      return mm;
    }
    if (media.type === 'url' && media.url) {
      const mm = await MessageMedia.fromUrl(media.url, { unsafeMime: true });
      if (media.filename) mm.filename = media.filename;
      return mm;
    }
    if (media.type === 'dataUrl' && media.dataUrl) {
      const m = /^data:([^;]+);base64,(.+)$/.exec(media.dataUrl);
      if (!m) throw new Error('Invalid data URL');
      const [, mimeType, b64] = m;
      const ext = mime.extension(mimeType) || 'bin';
      return new MessageMedia(mimeType, b64, media.filename || `attachment.${ext}`);
    }
    throw new Error('Unsupported media descriptor');
  }
}

module.exports = { WhatsAppManager, STATES };
