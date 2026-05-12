/**
 * src/main/main.js — Electron main process (v5).
 *
 * Adds vs v4:
 *  - Worker retry+timeout system (max 2 retries; 60s timeout per send)
 *  - Worker watchdog (warns if no progress in 2min)
 *  - Per-attempt status logging (success / retrying N/2 / failed)
 *  - Blacklist enforcement before send
 *  - Auto-save sent contacts after every success
 *  - Group details IPC (full participants list)
 *  - Profile picture IPC
 *  - Embedded-overlay window mode: Electron hidden while WA visible,
 *    floating Back button injected into puppeteer page restores Electron
 */
const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const Store = require('electron-store');
const QRCode = require('qrcode');
const mime = require('mime-types');

const { getFingerprint } = require('../utils/fingerprint');
const { parseFile } = require('../utils/excelParser');
const { normalizeBatch } = require('../utils/phoneNormalizer');
const { buildJobMessage } = require('../services/messageBuilder');
const { ApiClient } = require('../services/api.service');
const { WhatsAppManager } = require('../services/whatsapp.service');
const blacklist = require('../utils/blacklist');
const sentLog = require('../utils/sentContacts');

// ---------- Single-instance lock ----------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); process.exit(0); }
app.on('second-instance', () => {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// ---------- Config ----------
const store = new Store({
  name: 'whatsapp-saas-client',
  defaults: { apiUrl: 'http://localhost:4000', licenseKey: '', token: '' },
});

const FINGERPRINT = getFingerprint();
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const WA_SESSION_DIR = path.join(app.getPath('userData'), 'wa-session');
fs.mkdirSync(WA_SESSION_DIR, { recursive: true });

let mainWindow = null;
let workerRunning = false;
let currentCampaignId = null;
let validateInterval = null;
let workerLastProgress = 0;
let workerWatchdog = null;

// ---------- Worker tunables (the campaign-stops fix lives here) ----------
const SEND_TIMEOUT_MS    = 60_000;     // hard cap per send
const MAX_RETRIES        = 2;          // per message
const RETRY_BACKOFF_MS   = 3_000;
const WORKER_STUCK_MS    = 120_000;    // log warning if no progress in 2 min

// ---------- API client ----------
const api = new ApiClient({
  getConfig: () => ({
    apiUrl: store.get('apiUrl'),
    token: store.get('token'),
    licenseKey: store.get('licenseKey'),
    fingerprint: FINGERPRINT,
  }),
  setToken: (newToken) => store.set('token', newToken),
});

// ---------- WhatsApp Manager (singleton) ----------
const wa = new WhatsAppManager({ baseSessionDir: WA_SESSION_DIR });

wa.on('state', async (info) => {
  // On first-ready, fetch profile picture and emit account event
  if (info.state === 'connected' && info.account) {
    try {
      const picUrl = await wa.getProfilePicUrl();
      send('wa:account', { ...info.account, picUrl });
    } catch (_) {
      send('wa:account', info.account);
    }
  }
  send('wa:status', info);
  if (info.state === 'connected')             send('wa:ready');
  else if (info.state === 'logged_out' ||
           info.state === 'disconnected')      send('wa:disconnected');
  else if (info.state === 'error')             send('wa:error', info.message || 'Unknown error');
});

wa.on('qr', async (qr) => {
  try {
    const dataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 320 });
    send('wa:qr', dataUrl);
  } catch (e) { send('wa:error', 'QR encode failed: ' + e.message); }
});

wa.on('log', (msg) => send('worker:log', `[wa] ${msg}`));

// ---------- Window helpers ----------
function createWindow(view) {
  mainWindow = new BrowserWindow({
    width: 1280, height: 820, minWidth: 1080, minHeight: 660,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(RENDERER_DIR, view));
  mainWindow.on('closed', () => (mainWindow = null));
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url); return { action: 'deny' };
  });
}

function routeToInitialView() {
  const lk = store.get('licenseKey');
  const tok = store.get('token');
  createWindow(lk && tok ? 'dashboard.html' : 'login.html');

  if (lk && tok) {
    mainWindow.webContents.once('did-finish-load', () => {
      const sessionExists = fs.existsSync(path.join(WA_SESSION_DIR, 'session-default'));
      if (sessionExists) wa.start().catch((e) => send('wa:error', e.message));
    });
  }
}

app.whenReady().then(routeToInitialView);

app.on('window-all-closed', async () => {
  if (validateInterval) clearInterval(validateInterval);
  if (workerWatchdog) clearInterval(workerWatchdog);
  await wa.stop().catch(() => {});
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) routeToInitialView();
});

// ---------- Helpers ----------
function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

function withTimeout(promise, ms, label = 'operation') {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

function startPeriodicValidate() {
  if (validateInterval) clearInterval(validateInterval);
  validateInterval = setInterval(async () => {
    const lk = store.get('licenseKey');
    if (!lk) return;
    try {
      const data = await api.validate(lk, FINGERPRINT);
      if (data.ok && data.token) store.set('token', data.token);
    } catch (e) {
      send('license:invalid', e.response?.data?.error || e.message);
    }
  }, 10 * 60 * 1000);
}

// ============================================================
// IPC: Config, License (unchanged from v4)
// ============================================================
ipcMain.handle('config:get', () => ({
  apiUrl: store.get('apiUrl'),
  licenseKey: store.get('licenseKey'),
  fingerprint: FINGERPRINT,
  hasToken: !!store.get('token'),
}));
ipcMain.handle('config:set-server', (_, url) => {
  const u = String(url || '').trim().replace(/\/+$/, '') || 'http://localhost:4000';
  store.set('apiUrl', u);
  return u;
});

ipcMain.handle('license:activate', async (_, licenseKey) => {
  try {
    const key = String(licenseKey || '').trim().toUpperCase();
    if (!key) return { ok: false, error: 'License key required' };
    const data = await api.activate(key, FINGERPRINT);
    if (data.ok) {
      store.set('licenseKey', data.license.license_key);
      store.set('token', data.token);
      startPeriodicValidate();
    }
    return data;
  } catch (e) { return { ok: false, error: e.response?.data?.error || e.message }; }
});

ipcMain.handle('license:me', async () => {
  try { return await api.me(); }
  catch (e) {
    if (e.code === 'REACTIVATION_REQUIRED') return { ok: false, error: 'REACTIVATION_REQUIRED' };
    return { ok: false, error: e.response?.data?.error || e.message };
  }
});

ipcMain.handle('license:logout', async () => {
  store.set('licenseKey', '');
  store.set('token', '');
  if (validateInterval) clearInterval(validateInterval);
  await wa.stop().catch(() => {});
  workerRunning = false;
  if (mainWindow) mainWindow.loadFile(path.join(RENDERER_DIR, 'login.html'));
  return { ok: true };
});

ipcMain.handle('nav:dashboard', () => {
  if (mainWindow) {
    mainWindow.loadFile(path.join(RENDERER_DIR, 'dashboard.html'));
    startPeriodicValidate();
    mainWindow.webContents.once('did-finish-load', () => {
      const sessionExists = fs.existsSync(path.join(WA_SESSION_DIR, 'session-default'));
      if (sessionExists) wa.start().catch((e) => send('wa:error', e.message));
    });
  }
});

// ============================================================
// IPC: WhatsApp lifecycle
// ============================================================
ipcMain.handle('wa:start',         async () => { try { return await wa.start() || { ok: true }; } catch (e) { return { ok: false, error: e.message }; }});
ipcMain.handle('wa:stop',          async () => { await wa.stop(); return { ok: true }; });
ipcMain.handle('wa:logout',        async () => wa.logout());
ipcMain.handle('wa:restart',       async () => { try { await wa.restart(); return { ok: true }; } catch (e) { return { ok: false, error: e.message }; }});
ipcMain.handle('wa:clear-session', async () => wa.clearSession());
ipcMain.handle('wa:state',         ()       => ({ state: wa.state, account: wa.account }));
ipcMain.handle('wa:info',          async () => wa.isReady ? { ok: true, info: wa.account } : { ok: false, error: 'Not connected' });
ipcMain.handle('wa:profile-pic',   async () => {
  const url = await wa.getProfilePicUrl();
  return { ok: true, picUrl: url };
});

// Embedded-overlay mode: hide Electron, show puppeteer at Electron's bounds with a Back button injected
ipcMain.handle('wa:show', async () => {
  if (!mainWindow) return { ok: false, error: 'No window' };
  const bounds = mainWindow.getBounds();

  const onBack = async () => {
    try { await wa.hideWindow(); } catch (_) {}
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
      mainWindow.focus();
      send('wa:returned');
    }
  };

  const r = await wa.showWindow(bounds, onBack);
  if (r.ok && mainWindow && !mainWindow.isDestroyed()) {
    // Hide Electron behind puppeteer for true overlay feel
    mainWindow.hide();
  }
  return r;
});

ipcMain.handle('wa:hide', async () => {
  const r = await wa.hideWindow();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
  }
  return r;
});

// ============================================================
// IPC: Groups (with full details)
// ============================================================
ipcMain.handle('wa:list-groups', async () => {
  try {
    if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
    const groups = await wa.listGroups();
    return { ok: true, groups };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('wa:group-details', async (_, gid) => {
  try {
    if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
    const details = await wa.getGroupDetails(gid);
    return { ok: true, details };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('wa:send-group', async (_, { gid, text }) => {
  try {
    if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
    await wa.sendToGroup(gid, text);
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('wa:send-group-media', async (_, { gid, media, caption }) => {
  try {
    if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
    await wa.sendMediaToGroup(gid, media, caption || '');
    return { ok: true };
  } catch (e) { return { ok: false, error: e.message }; }
});

ipcMain.handle('wa:extract-group', async (_, gid) => {
  try {
    if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
    const members = await wa.extractGroupMembers(gid);
    return { ok: true, members };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
// IPC: Number validation (batch)
// ============================================================
ipcMain.handle('wa:validate-batch', async (_, { phones, opts }) => {
  if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
  if (!Array.isArray(phones) || !phones.length) return { ok: false, error: 'phones[] required' };

  const max = Math.min(phones.length, opts?.max || 1000);
  const results = [];
  for (let i = 0; i < max; i++) {
    const phone = phones[i];
    try {
      const onWA = await wa.isOnWhatsApp(phone);
      results.push({ phone, on_whatsapp: onWA, risk_level: onWA ? 'green' : 'red' });
    } catch (e) {
      results.push({ phone, on_whatsapp: null, risk_level: 'yellow', error: e.message });
    }
    if (i % 10 === 0 || i === max - 1) send('validate:progress', { done: i + 1, total: max });
    await sleep(120);
  }
  return { ok: true, results };
});

// ============================================================
// IPC: Excel/CSV + media + normalize
// ============================================================
ipcMain.handle('contacts:pickFile', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select contacts file',
    filters: [{ name: 'Excel/CSV', extensions: ['xlsx', 'xls', 'csv'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const result = parseFile(r.filePaths[0], 'EG');
    return { ok: true, filename: path.basename(r.filePaths[0]), contacts: result.contacts, stats: result.stats };
  } catch (e) { return { ok: false, error: 'Failed to parse: ' + e.message }; }
});

ipcMain.handle('phones:normalize', (_, raw) => {
  if (!Array.isArray(raw)) return { ok: false, error: 'raw must be array' };
  return { ok: true, ...normalizeBatch(raw, 'EG') };
});

ipcMain.handle('media:pick', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Select media file',
    filters: [
      { name: 'Images',    extensions: ['jpg','jpeg','png','gif','webp'] },
      { name: 'Videos',    extensions: ['mp4','mov','avi','mkv','webm'] },
      { name: 'Documents', extensions: ['pdf','doc','docx','xls','xlsx','ppt','pptx','txt','zip'] },
      { name: 'All files', extensions: ['*'] },
    ],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { ok: false, canceled: true };
  try {
    const filePath = r.filePaths[0];
    const stat = fs.statSync(filePath);
    const MAX = 16 * 1024 * 1024;
    if (stat.size > MAX) return { ok: false, error: `File too large (max ${(MAX/1024/1024).toFixed(0)}MB)` };
    const buf = fs.readFileSync(filePath);
    const mimeType = mime.lookup(filePath) || 'application/octet-stream';
    const dataUrl = `data:${mimeType};base64,${buf.toString('base64')}`;
    const filename = path.basename(filePath);
    const kind = mimeType.startsWith('image/') ? 'image' : mimeType.startsWith('video/') ? 'video' : 'file';
    return { ok: true, media: { type: 'dataUrl', dataUrl, mime: mimeType, filename, size: stat.size, kind } };
  } catch (e) { return { ok: false, error: e.message }; }
});

// ============================================================
// IPC: Blacklist
// ============================================================
ipcMain.handle('blacklist:list',  ()                  => ({ ok: true, items: blacklist.listWithNotes() }));
ipcMain.handle('blacklist:add',   (_, { phone, note }) => ({ ok: blacklist.add(phone, note) }));
ipcMain.handle('blacklist:remove',(_, phone)           => ({ ok: blacklist.remove(phone) }));
ipcMain.handle('blacklist:clear', ()                   => { blacklist.clear(); return { ok: true }; });
ipcMain.handle('blacklist:check', (_, phones)          => {
  const arr = Array.isArray(phones) ? phones : [];
  return { ok: true, blocked: arr.filter((p) => blacklist.isBlocked(p)) };
});

// ============================================================
// IPC: Sent contacts log
// ============================================================
ipcMain.handle('sent:list',  () => ({ ok: true, entries: sentLog.list(), count: sentLog.count() }));
ipcMain.handle('sent:clear', () => { sentLog.clear(); return { ok: true }; });

// ============================================================
// IPC: Campaigns
// ============================================================
const wrap = (p) => p.then((d) => d).catch((e) => {
  if (e.code === 'REACTIVATION_REQUIRED') return { ok: false, error: 'REACTIVATION_REQUIRED' };
  return { ok: false, error: e.response?.data?.error || e.message };
});

ipcMain.handle('campaign:start',       (_, payload)        => wrap(api.startCampaign(payload)));
ipcMain.handle('campaign:list',        ()                  => wrap(api.listCampaigns()));
ipcMain.handle('campaign:get',         (_, id)             => wrap(api.getCampaign(id)));
ipcMain.handle('campaign:report',      (_, id)             => wrap(api.getReport(id)));
ipcMain.handle('campaign:set-status',  (_, { id, status }) => wrap(api.setStatus(id, status)));
ipcMain.handle('campaign:delete',      (_, id)             => wrap(api.deleteCampaign(id)));
ipcMain.handle('campaign:update-risk', (_, { id, updates }) => wrap(api.updateRisk(id, updates)));

// ============================================================
// IPC: Worker (with retry, timeout, watchdog)
// ============================================================
ipcMain.handle('worker:start', async (_, opts) => {
  const campaignId   = typeof opts === 'string' ? opts : opts?.campaignId;
  const safeMode     = typeof opts === 'object' && opts ? !!opts.safeMode : false;
  const simulateType = typeof opts === 'object' && opts ? !!opts.simulateTyping : false;

  if (!campaignId) return { ok: false, error: 'campaignId required' };
  if (!wa.isReady) return { ok: false, error: 'WhatsApp not connected' };
  if (workerRunning) return { ok: false, error: 'Worker already running for ' + currentCampaignId };

  workerRunning = true;
  currentCampaignId = campaignId;
  workerLastProgress = Date.now();

  startWatchdog();
  runWorkerLoop(campaignId, { safeMode, simulateType }).catch((e) => {
    send('worker:log', `Fatal: ${e.message}`);
    stopWorker();
  });
  return { ok: true };
});

ipcMain.handle('worker:stop', async () => { stopWorker(); return { ok: true }; });

function stopWorker() {
  workerRunning = false;
  currentCampaignId = null;
  if (workerWatchdog) { clearInterval(workerWatchdog); workerWatchdog = null; }
}

function startWatchdog() {
  if (workerWatchdog) clearInterval(workerWatchdog);
  workerWatchdog = setInterval(() => {
    if (!workerRunning) return;
    const idleMs = Date.now() - workerLastProgress;
    if (idleMs > WORKER_STUCK_MS) {
      send('worker:log', `⚠ Worker idle for ${(idleMs/1000).toFixed(0)}s. WhatsApp ready=${wa.isReady}, state=${wa.state}`);
      workerLastProgress = Date.now(); // Reset so we don't spam
    }
  }, 30_000);
}

async function runWorkerLoop(campaignId, runOpts) {
  send('worker:log', `▶ Worker started for campaign ${campaignId}`);
  send('worker:log', `   Mode: safeMode=${runOpts.safeMode} simulateTyping=${runOpts.simulateType}`);

  while (workerRunning) {
    // 1) Fetch next job
    let response = null;
    try {
      response = await api.nextJob(campaignId);
    } catch (e) {
      if (e.code === 'REACTIVATION_REQUIRED') {
        send('worker:log', '✗ License invalid. Worker stopped.');
        send('license:invalid', 'Re-activation required');
        break;
      }
      send('worker:log', `Network error fetching job: ${e.message}. Retrying in 5s.`);
      await sleep(5000);
      continue;
    }

    if (!response.ok) { send('worker:log', `Server error: ${response.error || 'unknown'}`); break; }

    if (!response.job) {
      if (response.reason === 'paused')               { send('worker:log', '⏸ Campaign paused. Stopping worker.'); break; }
      if (response.reason === 'daily_quota_reached')  { send('worker:log', `⛔ Daily quota reached${response.warmup ? ' (warm-up)' : ''}: ${response.limit}/day.`); break; }
      send('worker:log', '✅ No more pending contacts. Campaign complete.');
      send('worker:done');
      stopWorker();
      break;
    }

    const job = response.job;
    workerLastProgress = Date.now();

    // 2) Pre-flight skips
    if (job.risk_level === 'red' || (runOpts.safeMode && job.risk_level !== 'green')) {
      const reason = job.risk_level === 'red' ? 'risk_red' : 'safe_mode_filter';
      send('worker:log', `⊘ Skipping ${job.phone} (${reason})`);
      try { await api.skipJob(campaignId, { contact_id: job.contact_id, reason }); } catch (_) {}
      continue;
    }
    if (blacklist.isBlocked(job.phone)) {
      send('worker:log', `⊘ Skipping ${job.phone} (blacklisted)`);
      try { await api.skipJob(campaignId, { contact_id: job.contact_id, reason: 'blacklisted' }); } catch (_) {}
      continue;
    }

    // 3) Wait for WA reconnect if needed (up to 60s)
    if (!wa.isReady) {
      send('worker:log', `… waiting for WhatsApp to reconnect`);
      const waitStart = Date.now();
      while (!wa.isReady && Date.now() - waitStart < 60_000 && workerRunning) await sleep(2000);
      if (!wa.isReady) {
        send('worker:log', '✗ WhatsApp not reconnecting. Stopping worker.');
        try { await api.skipJob(campaignId, { contact_id: job.contact_id, reason: 'wa_disconnected' }); } catch (_) {}
        break;
      }
    }

    // 4) Build message
    const built = buildJobMessage(job, job);
    const finalText = built.text;
    const media = built.media;

    // 5) Send with retry + timeout
    let success = false;
    let lastErr = null;
    for (let attempt = 0; attempt <= MAX_RETRIES && workerRunning; attempt++) {
      try {
        const sendPromise = media
          ? wa.sendMedia(job.phone, media, finalText, { simulateTyping: runOpts.simulateType })
          : wa.sendText(job.phone, finalText, { simulateTyping: runOpts.simulateType });

        await withTimeout(sendPromise, SEND_TIMEOUT_MS, 'send');
        success = true;

        send('worker:log', attempt === 0
          ? `✓ Sent to ${job.phone}${media ? ' (with media)' : ''}`
          : `✓ Sent to ${job.phone} on retry ${attempt}/${MAX_RETRIES}`);
        break;
      } catch (e) {
        lastErr = e;
        const isLast = attempt === MAX_RETRIES;
        if (isLast) {
          send('worker:log', `✗ ${job.phone} FAILED after ${MAX_RETRIES} retries: ${e.message}`);
        } else {
          send('worker:log', `↻ ${job.phone} retry ${attempt + 1}/${MAX_RETRIES}: ${e.message}`);
          await sleep(RETRY_BACKOFF_MS);
          // If WA dropped during the send attempt, wait for reconnect
          if (!wa.isReady) {
            const waitStart = Date.now();
            while (!wa.isReady && Date.now() - waitStart < 60_000 && workerRunning) await sleep(2000);
          }
        }
      }
    }

    // 6) Report result + auto-save sent contacts
    if (success) {
      sentLog.record(job.phone, job.name || '', '');
      try { await api.reportJob(campaignId, { contact_id: job.contact_id, success: true }); }
      catch (_) { send('worker:log', `(warning) failed to report success for ${job.phone}`); }
    } else {
      try { await api.reportJob(campaignId, { contact_id: job.contact_id, success: false, error: lastErr?.message || 'send failed' }); }
      catch (_) {}
    }

    workerLastProgress = Date.now();
    send('worker:progress', { campaign_id: campaignId });

    // 7) Random inter-message delay
    if (workerRunning) {
      const delay = randInt((job.delay_min_seconds || 8) * 1000, (job.delay_max_seconds || 20) * 1000);
      send('worker:log', `… waiting ${(delay/1000).toFixed(1)}s (${job.speed_mode || 'custom'} mode)`);
      await sleep(delay);
    }
  }

  if (!workerRunning) send('worker:log', '⏹ Worker stopped.');
}
