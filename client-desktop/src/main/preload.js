/**
 * src/main/preload.js — v5 vetted IPC surface.
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // config
  getConfig: () => ipcRenderer.invoke('config:get'),
  setServer: (url) => ipcRenderer.invoke('config:set-server', url),

  // license
  activate:    (key) => ipcRenderer.invoke('license:activate', key),
  me:          ()    => ipcRenderer.invoke('license:me'),
  logout:      ()    => ipcRenderer.invoke('license:logout'),
  goDashboard: ()    => ipcRenderer.invoke('nav:dashboard'),

  // whatsapp lifecycle
  startWA:        () => ipcRenderer.invoke('wa:start'),
  stopWA:         () => ipcRenderer.invoke('wa:stop'),
  logoutWA:       () => ipcRenderer.invoke('wa:logout'),
  restartWA:      () => ipcRenderer.invoke('wa:restart'),
  clearWASession: () => ipcRenderer.invoke('wa:clear-session'),
  waState:        () => ipcRenderer.invoke('wa:state'),
  waInfo:         () => ipcRenderer.invoke('wa:info'),
  waProfilePic:   () => ipcRenderer.invoke('wa:profile-pic'),

  // window control
  showWA: () => ipcRenderer.invoke('wa:show'),
  hideWA: () => ipcRenderer.invoke('wa:hide'),

  // groups
  waListGroups:     () => ipcRenderer.invoke('wa:list-groups'),
  waGroupDetails:   (gid) => ipcRenderer.invoke('wa:group-details', gid),
  waSendGroup:      (gid, text) => ipcRenderer.invoke('wa:send-group', { gid, text }),
  waSendGroupMedia: (gid, media, caption) => ipcRenderer.invoke('wa:send-group-media', { gid, media, caption }),
  waExtractGroup:   (gid) => ipcRenderer.invoke('wa:extract-group', gid),
  waValidateBatch:  (phones, opts) => ipcRenderer.invoke('wa:validate-batch', { phones, opts }),

  // contacts + media
  pickFile:        () => ipcRenderer.invoke('contacts:pickFile'),
  pickMedia:       () => ipcRenderer.invoke('media:pick'),
  normalizePhones: (raw) => ipcRenderer.invoke('phones:normalize', raw),

  // blacklist
  blacklistList:   () => ipcRenderer.invoke('blacklist:list'),
  blacklistAdd:    (phone, note) => ipcRenderer.invoke('blacklist:add', { phone, note }),
  blacklistRemove: (phone) => ipcRenderer.invoke('blacklist:remove', phone),
  blacklistClear:  () => ipcRenderer.invoke('blacklist:clear'),
  blacklistCheck:  (phones) => ipcRenderer.invoke('blacklist:check', phones),

  // sent contacts log
  sentList:  () => ipcRenderer.invoke('sent:list'),
  sentClear: () => ipcRenderer.invoke('sent:clear'),

  // campaigns
  startCampaign:  (payload)        => ipcRenderer.invoke('campaign:start', payload),
  listCampaigns:  ()               => ipcRenderer.invoke('campaign:list'),
  getCampaign:    (id)             => ipcRenderer.invoke('campaign:get', id),
  getReport:      (id)             => ipcRenderer.invoke('campaign:report', id),
  setStatus:      (id, st)         => ipcRenderer.invoke('campaign:set-status', { id, status: st }),
  deleteCampaign: (id)             => ipcRenderer.invoke('campaign:delete', id),
  updateRisk:     (id, updates)    => ipcRenderer.invoke('campaign:update-risk', { id, updates }),

  // worker — v5 accepts options object: { campaignId, safeMode, simulateTyping }
  startWorker: (campaignId, opts = {}) => ipcRenderer.invoke('worker:start', { campaignId, ...opts }),
  stopWorker:  ()   => ipcRenderer.invoke('worker:stop'),

  // events
  on: (channel, handler) => {
    const allowed = [
      'wa:qr', 'wa:ready', 'wa:error', 'wa:disconnected', 'wa:account', 'wa:status', 'wa:returned',
      'worker:log', 'worker:done', 'worker:progress',
      'license:invalid',
      'validate:progress',
    ];
    if (!allowed.includes(channel)) return;
    const sub = (_e, data) => handler(data);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },
});
