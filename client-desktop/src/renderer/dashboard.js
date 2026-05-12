/* renderer/dashboard.js — v3 */
(function () {

  // ============== Page state ==============
  // Master contact list (across pages); each: { phone, name, vars, valid, reason, original_phone, risk_level, on_whatsapp, _selected }
  let contacts = [];
  let attachedMedia = null;       // for new campaign
  let attachedGroupMedia = null;  // for group send
  let currentCampaign = null;
  let currentReport = null;       // { buckets: {...} }
  let selectedGroup = null;
  let groupsCache = [];

  // ============== Navigation ==============
  const pages = {
    WA:        document.getElementById('pageWA'),
    Contacts:  document.getElementById('pageContacts'),
    New:       document.getElementById('pageNew'),
    Campaigns: document.getElementById('pageCampaigns'),
    Groups:    document.getElementById('pageGroups'),
    Blacklist: document.getElementById('pageBlacklist'),
  };
  const navs = {
    WA:        document.getElementById('navWA'),
    Contacts:  document.getElementById('navContacts'),
    New:       document.getElementById('navNew'),
    Campaigns: document.getElementById('navCampaigns'),
    Groups:    document.getElementById('navGroups'),
    Blacklist: document.getElementById('navBlacklist'),
  };
  function show(name) {
    Object.entries(pages).forEach(([k, el]) => (el.style.display = k === name ? 'block' : 'none'));
    Object.entries(navs).forEach(([k, el]) => el.classList.toggle('active', k === name));
    if (name === 'Campaigns') loadCampaigns();
    if (name === 'New')       refreshNCContactsInfo();
    if (name === 'Blacklist') { loadBlacklist(); loadSentLog(); }
  }
  Object.keys(navs).forEach((k) => navs[k].addEventListener('click', () => show(k)));

  // ============== License banner / info ==============
  const banner = document.getElementById('licBanner');
  const licInfo = document.getElementById('licInfo');

  async function refreshLicenseInfo() {
    const r = await window.api.me();
    if (!r.ok) {
      if (r.error === 'REACTIVATION_REQUIRED' || /revoked|expired|bound/i.test(r.error || '')) {
        banner.style.display = 'block';
        banner.innerHTML = `License problem: <strong>${esc(r.error || 'invalid')}</strong>. Please contact your administrator.`;
      }
      return;
    }
    const lic = r.license;
    banner.style.display = 'none';
    const exp = new Date(lic.expires_at).toLocaleDateString();
    licInfo.innerHTML = `
      <div>License: <span style="color:#e6e9ef">${lic.license_key.split('-').slice(0,2).join('-')}-…</span></div>
      <div>Plan: ${lic.plan} • Expires ${exp}</div>
      <div>Daily limit: ${lic.max_messages_per_day || '∞'}</div>`;
  }
  refreshLicenseInfo();

  window.api.on('license:invalid', (err) => {
    banner.style.display = 'block';
    banner.innerHTML = `License became invalid: <strong>${esc(err)}</strong>. Please reactivate.`;
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    if (!confirm('Logout from this device session?')) return;
    await window.api.logout();
  });

  // ============== WhatsApp connection ==============
  const waStatusEl = document.getElementById('waStatus');
  const qrCard = document.getElementById('qrCard');
  const qrContainer = document.getElementById('qrContainer');
  const qrImg = document.getElementById('qrImg');
  const waMsg = document.getElementById('waMsg');
  const accountCard = document.getElementById('accountCard');
  const accName = document.getElementById('accName');
  const accPhone = document.getElementById('accPhone');

  // v4 elements
  const waStatusBanner   = document.getElementById('waStatusBanner');
  const waStatusTitle    = document.getElementById('waStatusTitle');
  const waStatusSubtitle = document.getElementById('waStatusSubtitle');
  const waSpinner        = document.getElementById('waSpinner');
  const waStatusProgress = document.getElementById('waStatusProgress');
  const waStatusProgressBar = document.getElementById('waStatusProgressBar');
  const waViewBtn  = document.getElementById('waViewBtn');
  const waBackBtn  = document.getElementById('waBackBtn');
  const waRestartBtn = document.getElementById('waRestartBtn');
  const waClearBtn   = document.getElementById('waClearBtn');
  const waClearBtn2  = document.getElementById('waClearBtn2');

  // Map state → label + dot color + spinner visible
  const STATE_UI = {
    idle:              { label: 'disconnected',     dot: '',      busy: false, hideAll: true  },
    initializing:      { label: 'initializing…',    dot: 'amber', busy: true,  hint: 'Starting WhatsApp engine…' },
    restoring_session: { label: 'restoring session…', dot: 'amber', busy: true, hint: 'Loading saved session…' },
    awaiting_qr:       { label: 'scan QR',          dot: 'amber', busy: false, hint: 'Scan the QR code with your phone' },
    authenticating:    { label: 'authenticating…',  dot: 'amber', busy: true,  hint: 'Linking your device…' },
    connected:         { label: 'connected',        dot: 'green', busy: false, hint: '' },
    reconnecting:      { label: 'reconnecting…',    dot: 'amber', busy: true,  hint: 'Connection lost — auto-recovering' },
    disconnected:      { label: 'disconnected',     dot: 'red',   busy: false, hint: '' },
    logged_out:        { label: 'logged out',       dot: 'red',   busy: false, hint: 'Click Connect to scan a new QR' },
    error:             { label: 'error',            dot: 'red',   busy: false, hint: '' },
  };

  function setWAStatus(state, message, percent) {
    const ui = STATE_UI[state] || STATE_UI.idle;

    // Sidebar pill
    waStatusEl.innerHTML = `<span class="dot ${ui.dot}"></span><span>WhatsApp: ${esc(ui.label)}</span>`;

    // Top banner
    if (ui.hideAll) {
      waStatusBanner.style.display = 'none';
    } else {
      waStatusBanner.style.display = 'block';
      waStatusBanner.className = `status-banner banner-${ui.dot || 'gray'}`;
      waStatusTitle.textContent = ui.label.charAt(0).toUpperCase() + ui.label.slice(1);
      waStatusSubtitle.textContent = message || ui.hint || '';
      waSpinner.style.display = ui.busy ? 'inline-block' : 'none';

      // Progress bar (only for restoring_session with percent)
      if (state === 'restoring_session' && Number.isFinite(percent)) {
        waStatusProgress.style.display = 'block';
        waStatusProgressBar.style.width = percent + '%';
      } else {
        waStatusProgress.style.display = 'none';
      }
    }

    // QR vs account card visibility
    const isConnected = state === 'connected';
    const showQR = state === 'awaiting_qr';

    if (isConnected) {
      qrCard.style.display = 'none';
      accountCard.style.display = 'block';
      qrContainer.style.display = 'none';
    } else if (showQR) {
      qrCard.style.display = 'block';
      accountCard.style.display = 'none';
      qrContainer.style.display = 'grid';
    } else if (state === 'idle' || state === 'logged_out' || state === 'error' || state === 'disconnected') {
      qrCard.style.display = 'block';
      accountCard.style.display = 'none';
      qrContainer.style.display = 'none';
      waClearBtn2.style.display = state === 'error' ? 'inline-block' : 'none';
    }
    // For initializing / restoring / authenticating / reconnecting we leave the cards alone

    document.getElementById('ctValidateBtn').disabled = !isConnected;
  }

  setWAStatus('idle');

  function setAvatar(account) {
    if (!account) return;
    accName.textContent = account.pushname || '(no name)';
    accPhone.textContent = account.phone ? '+' + account.phone : '';
    const img = document.getElementById('accAvatar');
    const fallback = document.getElementById('accAvatarFallback');
    if (account.picUrl) {
      img.src = account.picUrl;
      img.style.display = 'block';
      fallback.style.display = 'none';
    } else {
      img.style.display = 'none';
      fallback.style.display = 'grid';
    }
  }

  // Listen to granular state from main
  window.api.on('wa:status', (info) => {
    setWAStatus(info.state, info.message, info.percent);
    if (info.state === 'connected' && info.account) {
      setAvatar(info.account);
      waBackBtn.style.display = 'none';
    }
  });

  // Fetch initial state on page load
  (async () => {
    const r = await window.api.waState();
    if (r && r.state) {
      setWAStatus(r.state, '', null);
      if (r.state === 'connected' && r.account) {
        setAvatar(r.account);
        // Also try to fetch profile picture if not already loaded
        const pic = await window.api.waProfilePic();
        if (pic.ok && pic.picUrl) setAvatar({ ...r.account, picUrl: pic.picUrl });
      }
    }
  })();

  // Buttons
  document.getElementById('waStartBtn').addEventListener('click', async () => {
    waMsg.textContent = 'Starting WhatsApp client…';
    const r = await window.api.startWA();
    if (!r.ok) waMsg.textContent = 'Error: ' + r.error;
  });

  document.getElementById('waDisconnectBtn').addEventListener('click', async () => {
    if (!confirm('Disconnect WhatsApp on this device? You will need to scan a new QR to reconnect.')) return;
    await window.api.logoutWA();
  });

  waViewBtn.addEventListener('click', async () => {
    const r = await window.api.showWA();
    if (r.ok) {
      waBackBtn.style.display = 'inline-block';
    } else {
      alert(r.error || 'Failed to show WhatsApp window');
    }
  });

  waBackBtn.addEventListener('click', async () => {
    await window.api.hideWA();
    waBackBtn.style.display = 'none';
  });

  waRestartBtn.addEventListener('click', async () => {
    if (!confirm('Restart WhatsApp engine?\n(Keeps session — no QR rescan needed.)')) return;
    waBackBtn.style.display = 'none';
    const r = await window.api.restartWA();
    if (!r.ok) alert(r.error);
  });

  async function handleClearSession() {
    if (!confirm('Clear local WhatsApp session?\nThis logs you out and you will need to scan a new QR.')) return;
    await window.api.clearWASession();
  }
  waClearBtn.addEventListener('click', handleClearSession);
  waClearBtn2.addEventListener('click', handleClearSession);

  // QR event still arrives on awaiting_qr state — render it
  window.api.on('wa:qr', (dataUrl) => {
    qrImg.src = dataUrl;
    qrContainer.style.display = 'grid';
    waMsg.textContent = 'Scan this QR code with your phone.';
  });
  // Backward-compat events still fire — keep handlers harmless
  window.api.on('wa:ready', () => { waMsg.textContent = ''; });
  window.api.on('wa:account', (info) => {
    if (info) setAvatar(info);
  });
  window.api.on('wa:returned', () => {
    waBackBtn.style.display = 'none';
  });
  window.api.on('wa:error', (m) => { waMsg.textContent = 'Error: ' + m; });
  window.api.on('wa:disconnected', () => {});

  // ============== Contacts page ==============
  const ctRows = document.getElementById('ctRows');
  const ctSummary = document.getElementById('ctSummary');
  const ctFilter = document.getElementById('ctFilter');
  const ctSelectAll = document.getElementById('ctSelectAll');
  const ctSelectedCount = document.getElementById('ctSelectedCount');

  document.getElementById('ctPickFile').addEventListener('click', async () => {
    const r = await window.api.pickFile();
    if (r.canceled) return;
    if (!r.ok) { alert(r.error || 'Failed'); return; }
    contacts = r.contacts.map((c) => ({ ...c, risk_level: 'unknown', _selected: c.valid }));
    ctSummary.style.display = 'block';
    ctSummary.innerHTML = `Loaded <strong>${r.stats.total}</strong> rows from <code>${esc(r.filename)}</code> — <strong>${r.stats.valid}</strong> valid, ${r.stats.invalid} invalid, ${r.stats.duplicates} duplicates.`;
    renderContacts();
  });

  // Manual paste
  const pasteModal = document.getElementById('pasteModal');
  document.getElementById('ctPasteBtn').addEventListener('click', () => { pasteModal.style.display = 'grid'; });
  document.getElementById('pasteCancel').addEventListener('click', () => { pasteModal.style.display = 'none'; });
  document.getElementById('pasteApply').addEventListener('click', async () => {
    const lines = document.getElementById('ctPasteArea').value.split('\n').map(l => l.trim()).filter(Boolean);
    const raw = lines.map((line) => {
      const [p, n] = line.split(',').map(s => (s || '').trim());
      return { phone: p, name: n || '', vars: {} };
    });
    const r = await window.api.normalizePhones(raw);
    if (!r.ok) { alert(r.error); return; }
    contacts = r.contacts.map((c) => ({ ...c, risk_level: 'unknown', _selected: c.valid }));
    ctSummary.style.display = 'block';
    ctSummary.innerHTML = `Pasted <strong>${r.stats.total}</strong> entries — <strong>${r.stats.valid}</strong> valid, ${r.stats.invalid} invalid, ${r.stats.duplicates} duplicates.`;
    pasteModal.style.display = 'none';
    document.getElementById('ctPasteArea').value = '';
    renderContacts();
  });

  document.getElementById('ctClearBtn').addEventListener('click', () => {
    if (!contacts.length) return;
    if (!confirm('Clear all loaded contacts?')) return;
    contacts = [];
    ctSummary.style.display = 'none';
    renderContacts();
  });

  ctFilter.addEventListener('change', renderContacts);

  ctSelectAll.addEventListener('change', () => {
    const checked = ctSelectAll.checked;
    contacts.forEach((c) => { if (c.valid) c._selected = checked; });
    renderContacts();
  });

  function renderContacts() {
    refreshNCContactsInfo();
    if (!contacts.length) {
      ctRows.innerHTML = '<tr><td colspan="6" class="muted">No contacts loaded.</td></tr>';
      ctSelectedCount.textContent = '0';
      return;
    }
    const f = ctFilter.value;
    const filtered = contacts.filter((c) => {
      if (f === 'valid')   return c.valid;
      if (f === 'invalid') return !c.valid;
      if (['green','yellow','red'].includes(f)) return c.risk_level === f;
      return true;
    });

    ctRows.innerHTML = filtered.map((c, idx) => {
      const i = contacts.indexOf(c);
      const validBadge = c.valid
        ? '<span class="tag green-tag">valid</span>'
        : `<span class="tag red-tag" title="${esc(c.reason)}">${esc(c.reason)}</span>`;
      const riskBadge =
        c.risk_level === 'green'  ? '<span class="risk-dot green"></span> Safe'
        : c.risk_level === 'yellow' ? '<span class="risk-dot amber"></span> Medium'
        : c.risk_level === 'red'    ? '<span class="risk-dot red"></span> High'
        : '<span class="risk-dot"></span> Unknown';
      return `<tr data-i="${i}" class="${!c.valid ? 'row-invalid' : ''} ${c.risk_level === 'red' ? 'row-risky' : ''}">
        <td><input type="checkbox" class="ct-sel" data-i="${i}" ${c._selected ? 'checked' : ''} ${!c.valid ? 'disabled' : ''}></td>
        <td><span class="code">${esc(c.phone)}</span></td>
        <td class="muted">${esc(c.original_phone || '')}</td>
        <td>${esc(c.name || '')}</td>
        <td>${validBadge}</td>
        <td>${riskBadge}</td>
      </tr>`;
    }).join('');

    ctRows.querySelectorAll('.ct-sel').forEach((cb) => {
      cb.addEventListener('change', () => {
        contacts[+cb.dataset.i]._selected = cb.checked;
        updateSelectedCount();
      });
    });
    updateSelectedCount();
  }
  function updateSelectedCount() {
    const n = contacts.filter((c) => c._selected && c.valid).length;
    ctSelectedCount.textContent = n;
    refreshNCContactsInfo();
  }

  // Validate against WhatsApp
  document.getElementById('ctValidateBtn').addEventListener('click', async () => {
    const valids = contacts.filter((c) => c.valid);
    if (!valids.length) return alert('No valid contacts to check.');
    if (valids.length > 200 && !confirm(`This will check ${valids.length} numbers and may take ~${Math.round(valids.length * 0.4)}s. Continue?`)) return;

    const phones = valids.map((c) => c.phone);
    document.getElementById('ctValidateProgress').style.display = 'block';
    document.getElementById('ctValidateBar').style.width = '0%';
    document.getElementById('ctValidateBtn').disabled = true;

    const r = await window.api.waValidateBatch(phones, { max: phones.length });
    document.getElementById('ctValidateBtn').disabled = false;

    if (!r.ok) { alert(r.error); document.getElementById('ctValidateProgress').style.display = 'none'; return; }

    // Apply results
    const map = new Map(r.results.map((x) => [x.phone, x]));
    for (const c of contacts) {
      const m = map.get(c.phone);
      if (m) { c.on_whatsapp = m.on_whatsapp; c.risk_level = m.risk_level; }
    }
    document.getElementById('ctValidateLabel').textContent = `Done — ${r.results.filter(x => x.on_whatsapp).length}/${r.results.length} on WhatsApp.`;
    document.getElementById('ctValidateBar').style.width = '100%';
    setTimeout(() => { document.getElementById('ctValidateProgress').style.display = 'none'; }, 2500);
    renderContacts();
  });

  window.api.on('validate:progress', ({ done, total }) => {
    const pct = total ? Math.round((done / total) * 100) : 0;
    document.getElementById('ctValidateLabel').textContent = `Checking ${done}/${total}…`;
    document.getElementById('ctValidateBar').style.width = pct + '%';
  });

  // ============== New campaign page ==============
  const ncSpeed = document.getElementById('ncSpeed');
  const ncSpeedNote = document.getElementById('ncSpeedNote');
  const ncCustomDelays = document.getElementById('ncCustomDelays');

  const SPEED_NOTES = {
    safe:   { class: 'speed-note green', text: '🔒 Safest mode (15-25s). Recommended for new accounts.' },
    medium: { class: 'speed-note amber', text: '✅ Normal mode (8-15s). Recommended default.' },
    fast:   { class: 'speed-note red',   text: '⚠ HIGH BAN RISK (3-5s). Only for tested numbers.' },
    custom: { class: 'speed-note',       text: 'Custom delays. Server enforces a 5-second hard minimum.' },
  };
  function applySpeedNote() {
    const v = ncSpeed.value;
    ncSpeedNote.className = SPEED_NOTES[v].class;
    ncSpeedNote.textContent = SPEED_NOTES[v].text;
    ncCustomDelays.style.display = v === 'custom' ? 'flex' : 'none';
  }
  ncSpeed.addEventListener('change', applySpeedNote);
  applySpeedNote();

  // Warm-up toggle
  document.getElementById('ncWarmup').addEventListener('change', (e) => {
    document.getElementById('ncWarmupRow').style.display = e.target.checked ? 'flex' : 'none';
  });

  // Variations
  document.getElementById('ncAddVar').addEventListener('click', () => addVariationRow());
  function addVariationRow(text = '') {
    const wrap = document.getElementById('ncVariations');
    const row = document.createElement('div');
    row.className = 'variation-row';
    row.innerHTML = `
      <textarea rows="2" placeholder="Variation message — uses same {{vars}}">${esc(text)}</textarea>
      <button class="secondary remove-var">✕</button>`;
    row.querySelector('.remove-var').addEventListener('click', () => row.remove());
    wrap.appendChild(row);
  }
  function getVariations() {
    return Array.from(document.querySelectorAll('#ncVariations textarea'))
      .map((t) => t.value.trim()).filter(Boolean);
  }

  // Media picker (campaign)
  document.getElementById('ncPickMedia').addEventListener('click', async () => {
    const r = await window.api.pickMedia();
    if (r.canceled) return;
    if (!r.ok) { alert(r.error); return; }
    attachedMedia = r.media;
    document.getElementById('ncMediaName').textContent = `${r.media.filename} (${humanSize(r.media.size)})`;
    document.getElementById('ncRemoveMedia').style.display = 'inline-block';

    const preview = document.getElementById('ncMediaPreview');
    preview.style.display = 'block';
    if (r.media.kind === 'image') {
      preview.innerHTML = `<img src="${r.media.dataUrl}" class="media-preview-img">`;
    } else if (r.media.kind === 'video') {
      preview.innerHTML = `<video src="${r.media.dataUrl}" class="media-preview-img" controls></video>`;
    } else {
      preview.innerHTML = `<div class="file-preview">📄 ${esc(r.media.filename)}</div>`;
    }
  });
  document.getElementById('ncRemoveMedia').addEventListener('click', () => {
    attachedMedia = null;
    document.getElementById('ncMediaName').textContent = 'No file attached';
    document.getElementById('ncRemoveMedia').style.display = 'none';
    document.getElementById('ncMediaPreview').style.display = 'none';
    document.getElementById('ncMediaPreview').innerHTML = '';
  });

  function refreshNCContactsInfo() {
    const sel = contacts.filter((c) => c._selected && c.valid);
    const info = document.getElementById('ncContactsInfo');
    if (!info) return;
    if (!sel.length) {
      info.innerHTML = `No contacts selected. Go to <strong>Contacts</strong> tab to import or paste.`;
      return;
    }
    const greens = sel.filter((c) => c.risk_level === 'green').length;
    const yellows = sel.filter((c) => c.risk_level === 'yellow').length;
    const reds = sel.filter((c) => c.risk_level === 'red').length;
    info.innerHTML = `
      <strong>${sel.length}</strong> contacts selected
      ${greens ? `• <span style="color:var(--accent)">${greens} safe</span>` : ''}
      ${yellows ? `• <span style="color:var(--warn)">${yellows} medium</span>` : ''}
      ${reds ? `• <span style="color:var(--danger)">${reds} risky</span>` : ''}`;
  }

  // Preview-then-confirm flow
  let pendingPayload = null;
  let pendingUiOpts = null;

  document.getElementById('ncCreateBtn').addEventListener('click', async () => {
    const msg = document.getElementById('ncMsg');
    const name = document.getElementById('ncName').value.trim();
    const message_template = document.getElementById('ncMessage').value;
    const speed_mode = ncSpeed.value;

    if (!name) { msg.className='error'; msg.textContent='Name is required.'; return; }
    if (!message_template.trim()) { msg.className='error'; msg.textContent='Message is required.'; return; }

    let selected = contacts.filter((c) => c._selected && c.valid);
    const safeOnly = document.getElementById('ncSafeOnly').checked;
    if (safeOnly) selected = selected.filter((c) => c.risk_level === 'green');

    // Filter blacklisted (local)
    const blockCheck = await window.api.blacklistCheck(selected.map((c) => c.phone));
    let blockedCount = 0;
    if (blockCheck.ok && blockCheck.blocked.length) {
      const blockSet = new Set(blockCheck.blocked);
      const before = selected.length;
      selected = selected.filter((c) => !blockSet.has(c.phone));
      blockedCount = before - selected.length;
    }

    if (!selected.length) { msg.className='error'; msg.textContent='No contacts to send to (after filters).'; return; }

    const payload = {
      name,
      message_template,
      speed_mode,
      contacts: selected.map((c) => ({
        phone: c.phone, name: c.name, vars: c.vars,
        risk_level: c.risk_level || 'unknown',
        on_whatsapp: c.on_whatsapp,
      })),
      variations: getVariations(),
      media: attachedMedia,
    };

    if (speed_mode === 'custom') {
      payload.delay_min_seconds = parseInt(document.getElementById('ncDelayMin').value, 10);
      payload.delay_max_seconds = parseInt(document.getElementById('ncDelayMax').value, 10);
    }

    if (document.getElementById('ncWarmup').checked) {
      payload.warmup = {
        enabled: true,
        day1: parseInt(document.getElementById('ncWarmupDay1').value, 10) || 20,
        day_step: parseInt(document.getElementById('ncWarmupStep').value, 10) || 30,
      };
    }

    pendingPayload = payload;
    pendingUiOpts = {
      safeMode: safeOnly,
      simulateTyping: document.getElementById('ncSimulateTyping').checked,
    };

    // Build preview
    const sample = selected[0];
    const variations = getVariations();
    const baseTemplate = variations.length ? variations[0] : message_template;
    const previewText = renderTemplate(baseTemplate, sample);

    document.getElementById('pvCount').textContent = selected.length;
    const speedLabels = { safe: 'Safe (15-25s)', medium: 'Normal (8-15s)', fast: 'Fast (3-5s) ⚠', custom: 'Custom' };
    document.getElementById('pvSpeed').textContent = speedLabels[speed_mode] || speed_mode;

    // ETA: avg delay × count
    const avgDelay = { safe: 20, medium: 11.5, fast: 4, custom: 11 }[speed_mode] || 11;
    const etaSec = selected.length * avgDelay;
    document.getElementById('pvETA').textContent = formatDuration(etaSec);

    document.getElementById('pvMedia').textContent = attachedMedia ? `Yes (${attachedMedia.kind})` : 'No';
    document.getElementById('pvText').textContent = previewText || '(empty)';

    const warn = document.getElementById('pvWarn');
    const warnings = [];
    if (speed_mode === 'fast') warnings.push('⚠ Fast mode has high ban risk.');
    if (blockedCount) warnings.push(`${blockedCount} blacklisted number${blockedCount > 1 ? 's' : ''} were excluded.`);
    if (selected.some((c) => c.risk_level === 'red')) warnings.push('Some contacts are marked HIGH RISK and will be skipped at send time.');
    if (warnings.length) {
      warn.style.display = 'block';
      warn.innerHTML = warnings.map((w) => esc(w)).join('<br>');
    } else {
      warn.style.display = 'none';
    }

    msg.textContent = '';
    document.getElementById('previewModal').style.display = 'grid';
  });

  document.getElementById('pvClose').addEventListener('click', () => {
    document.getElementById('previewModal').style.display = 'none';
  });
  document.getElementById('pvCancel').addEventListener('click', () => {
    document.getElementById('previewModal').style.display = 'none';
  });
  document.getElementById('pvConfirm').addEventListener('click', async () => {
    if (!pendingPayload) return;
    const msg = document.getElementById('ncMsg');
    document.getElementById('previewModal').style.display = 'none';
    msg.className='muted'; msg.textContent='Creating…';
    const r = await window.api.startCampaign(pendingPayload);
    if (r.ok) {
      msg.className='success';
      msg.textContent = `Created with ${r.campaign.progress.total} contacts.`;
      // Stash UI opts on the campaign so Run button uses them
      r.campaign._uiSafeMode = pendingUiOpts.safeMode;
      r.campaign._uiSimulateTyping = pendingUiOpts.simulateTyping;
      pendingPayload = null;
      // Reset
      document.getElementById('ncName').value = '';
      document.getElementById('ncMessage').value = '';
      document.getElementById('ncVariations').innerHTML = '';
      document.getElementById('ncRemoveMedia').click();
      setTimeout(() => show('Campaigns'), 800);
    } else {
      msg.className='error';
      msg.textContent = r.error || 'Failed to create campaign';
    }
  });

  function renderTemplate(tpl, contact) {
    let text = String(tpl || '');
    text = text.replace(/\{\{\s*name\s*\}\}/gi, contact?.name || '');
    text = text.replace(/\{\{\s*phone\s*\}\}/gi, contact?.phone || '');
    if (contact?.vars && typeof contact.vars === 'object') {
      for (const [k, v] of Object.entries(contact.vars)) {
        text = text.replace(new RegExp(`\\{\\{\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\}\\}`, 'gi'), String(v == null ? '' : v));
      }
    }
    return text;
  }

  function formatDuration(sec) {
    if (sec < 60) return `${Math.round(sec)}s`;
    if (sec < 3600) return `${Math.round(sec / 60)}m`;
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  // ============== Campaigns list + detail ==============
  const campaignsBody = document.getElementById('campaignsBody');

  async function loadCampaigns() {
    campaignsBody.innerHTML = '<tr><td colspan="7" class="muted">Loading…</td></tr>';
    const r = await window.api.listCampaigns();
    if (!r.ok) {
      campaignsBody.innerHTML = `<tr><td colspan="7" class="error">${esc(r.error || 'Failed')}</td></tr>`;
      return;
    }
    if (!r.campaigns.length) {
      campaignsBody.innerHTML = '<tr><td colspan="7" class="muted">No campaigns yet.</td></tr>';
      return;
    }
    campaignsBody.innerHTML = r.campaigns.map((c) => {
      const total = c.progress?.total || 0;
      const done = (c.progress?.sent || 0) + (c.progress?.failed || 0) + (c.progress?.skipped || 0);
      const pct = total ? Math.round((done / total) * 100) : 0;
      const today = c.sent_today?.count || 0;
      const speed = c.speed_mode || 'custom';
      return `<tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td><span class="tag ${c.status}">${c.status}</span></td>
        <td><span class="speed-badge ${speed}">${speed}</span></td>
        <td>${done}/${total} (${pct}%)</td>
        <td>${today}</td>
        <td class="muted">${new Date(c.createdAt).toLocaleString()}</td>
        <td><button class="secondary" data-id="${c._id}">Open</button></td>
      </tr>`;
    }).join('');
    campaignsBody.querySelectorAll('button[data-id]').forEach((b) =>
      b.addEventListener('click', () => openCampaign(b.dataset.id))
    );
  }

  const cd = {
    panel: document.getElementById('campaignDetail'),
    name: document.getElementById('cdName'),
    status: document.getElementById('cdStatus'),
    progressText: document.getElementById('cdProgressText'),
    progressBar: document.getElementById('cdProgressBar'),
    total: document.getElementById('cdTotal'),
    sent: document.getElementById('cdSent'),
    failed: document.getElementById('cdFailed'),
    skipped: document.getElementById('cdSkipped'),
    remaining: document.getElementById('cdRemaining'),
    logs: document.getElementById('cdLogs'),
  };

  async function openCampaign(id) {
    const r = await window.api.getCampaign(id);
    if (!r.ok) return alert(r.error || 'Failed');
    currentCampaign = r.campaign;
    renderCampaign();
    cd.panel.style.display = 'block';
    cd.logs.textContent = '';
  }

  function renderCampaign() {
    const c = currentCampaign;
    cd.name.textContent = c.name;
    cd.status.innerHTML = `<span class="tag ${c.status}">${c.status}</span>`;
    const total = c.progress?.total || 0;
    const sent = c.progress?.sent || 0;
    const failed = c.progress?.failed || 0;
    const skipped = c.progress?.skipped || 0;
    const done = sent + failed + skipped;
    const remaining = Math.max(0, total - done);
    const pct = total ? Math.round((done / total) * 100) : 0;
    cd.progressText.textContent = `${done}/${total} processed (${pct}%)`;
    cd.progressBar.style.width = pct + '%';
    cd.total.textContent = total;
    cd.sent.textContent = sent;
    cd.failed.textContent = failed;
    cd.skipped.textContent = skipped;
    cd.remaining.textContent = remaining;
  }

  document.getElementById('cdRefreshBtn').addEventListener('click', async () => {
    if (!currentCampaign) return;
    const r = await window.api.getCampaign(currentCampaign._id);
    if (r.ok) { currentCampaign = r.campaign; renderCampaign(); }
  });
  document.getElementById('cdRunBtn').addEventListener('click', async () => {
    if (!currentCampaign) return;
    // Read user prefs persisted on the campaign creation; default to safe behavior
    const opts = {
      safeMode:       !!currentCampaign._uiSafeMode,
      simulateTyping: currentCampaign._uiSimulateTyping !== false,
    };
    const r = await window.api.startWorker(currentCampaign._id, opts);
    if (!r.ok) appendLog('Cannot start: ' + r.error);
  });
  document.getElementById('cdStopBtn').addEventListener('click', () => window.api.stopWorker());
  document.getElementById('cdDeleteBtn').addEventListener('click', async () => {
    if (!currentCampaign) return;
    if (!confirm(`Delete campaign "${currentCampaign.name}"?`)) return;
    const r = await window.api.deleteCampaign(currentCampaign._id);
    if (r.ok) { currentCampaign = null; cd.panel.style.display = 'none'; loadCampaigns(); }
    else alert(r.error || 'Delete failed');
  });

  // Report modal
  const reportModal = document.getElementById('reportModal');
  document.getElementById('cdReportBtn').addEventListener('click', async () => {
    if (!currentCampaign) return;
    const r = await window.api.getReport(currentCampaign._id);
    if (!r.ok) return alert(r.error);
    currentReport = r;
    document.getElementById('rmTitle').textContent = `Report — ${currentCampaign.name}`;
    showBucket('sent');
    reportModal.style.display = 'grid';
  });
  document.getElementById('rmClose').addEventListener('click', () => { reportModal.style.display = 'none'; });
  document.querySelectorAll('#reportModal .tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('#reportModal .tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      showBucket(t.dataset.bucket);
    });
  });
  function showBucket(name) {
    const items = currentReport.buckets[name] || [];
    const rows = document.getElementById('rmRows');
    if (!items.length) {
      rows.innerHTML = `<tr><td colspan="4" class="muted">No ${name} contacts.</td></tr>`;
      return;
    }
    rows.innerHTML = items.map((it) => {
      const detail = name === 'sent' && it.sent_at ? new Date(it.sent_at).toLocaleString()
                   : it.error || '—';
      return `<tr>
        <td><span class="code">${esc(it.phone)}</span></td>
        <td>${esc(it.name || '')}</td>
        <td><span class="risk-dot ${it.risk_level === 'green' ? 'green' : it.risk_level === 'red' ? 'red' : it.risk_level === 'yellow' ? 'amber' : ''}"></span> ${esc(it.risk_level || 'unknown')}</td>
        <td class="muted">${esc(detail)}</td>
      </tr>`;
    }).join('');
  }
  document.getElementById('rmExportBtn').addEventListener('click', () => {
    if (!currentReport) return;
    const lines = [['bucket', 'phone', 'name', 'risk', 'sent_at', 'error']];
    for (const [bucket, items] of Object.entries(currentReport.buckets)) {
      for (const it of items) lines.push([bucket, it.phone, it.name || '', it.risk_level || '', it.sent_at || '', it.error || '']);
    }
    const csv = lines.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `report-${currentCampaign.name}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  function appendLog(line) {
    cd.logs.textContent += `[${new Date().toLocaleTimeString()}] ${line}\n`;
    cd.logs.scrollTop = cd.logs.scrollHeight;
  }
  window.api.on('worker:log', (line) => appendLog(line));
  window.api.on('worker:done', async () => {
    appendLog('Campaign finished.');
    if (currentCampaign) {
      const r = await window.api.getCampaign(currentCampaign._id);
      if (r.ok) { currentCampaign = r.campaign; renderCampaign(); }
    }
  });
  window.api.on('worker:progress', async () => {
    if (currentCampaign && cd.panel.style.display !== 'none') {
      const r = await window.api.getCampaign(currentCampaign._id);
      if (r.ok) { currentCampaign = r.campaign; renderCampaign(); }
    }
  });

  // ============== Groups page ==============
  document.getElementById('grRefreshBtn').addEventListener('click', loadGroups);
  document.getElementById('grFilter').addEventListener('input', renderGroups);

  async function loadGroups() {
    document.getElementById('grList').textContent = 'Loading groups…';
    const r = await window.api.waListGroups();
    if (!r.ok) { document.getElementById('grList').innerHTML = `<span class="error">${esc(r.error)}</span>`; return; }
    groupsCache = r.groups;
    renderGroups();
  }

  function renderGroups() {
    const filter = document.getElementById('grFilter').value.trim().toLowerCase();
    const list = filter ? groupsCache.filter((g) => g.name.toLowerCase().includes(filter)) : groupsCache;
    if (!list.length) { document.getElementById('grList').textContent = 'No groups found.'; return; }
    document.getElementById('grList').innerHTML = list.map((g) => `
      <div class="group-row" data-gid="${esc(g.id)}">
        <div style="flex:1">
          <div style="font-weight:600">${esc(g.name)}</div>
          <div class="muted" style="font-size:12px">${g.participants_count} members</div>
        </div>
        <button class="secondary">Open</button>
      </div>`).join('');
    document.querySelectorAll('.group-row').forEach((row) => {
      row.querySelector('button').addEventListener('click', () => openGroup(row.dataset.gid));
    });
  }

  function openGroup(gid) {
    const g = groupsCache.find((x) => x.id === gid);
    if (!g) return;
    selectedGroup = g;
    document.getElementById('groupActions').style.display = 'block';
    document.getElementById('gaTitle').textContent = g.name;
    document.getElementById('gaMeta').textContent = `${g.participants_count} members • ID: ${g.id}`;
    document.getElementById('gaSendMsg').textContent = '';
    document.getElementById('gaExtractResult').innerHTML = '';
    // Also open the details modal automatically
    openGroupDetailsModal(gid);
  }

  // ----- Group Details Modal -----
  let groupDetailMembers = [];

  async function openGroupDetailsModal(gid) {
    const g = groupsCache.find((x) => x.id === gid);
    document.getElementById('groupModal').style.display = 'grid';
    document.getElementById('gmName').textContent = g?.name || 'Loading…';
    document.getElementById('gmMeta').textContent = 'Loading members…';
    document.getElementById('gmDesc').style.display = 'none';
    document.getElementById('gmRows').innerHTML = '<tr><td colspan="3" class="muted">Loading…</td></tr>';

    const r = await window.api.waGroupDetails(gid);
    if (!r.ok) {
      document.getElementById('gmRows').innerHTML = `<tr><td colspan="3" class="error">${esc(r.error)}</td></tr>`;
      document.getElementById('gmMeta').textContent = '';
      return;
    }

    const d = r.details;
    document.getElementById('gmName').textContent = d.name || '(unnamed)';
    document.getElementById('gmMeta').textContent = `${d.participants_count} members`;

    if (d.description) {
      const descEl = document.getElementById('gmDesc');
      descEl.style.display = 'block';
      descEl.textContent = d.description;
    }

    const img = document.getElementById('gmPic');
    const fb = document.getElementById('gmPicFallback');
    if (d.picUrl) { img.src = d.picUrl; img.style.display = 'block'; fb.style.display = 'none'; }
    else          { img.style.display = 'none'; fb.style.display = 'grid'; }

    groupDetailMembers = d.members.map((m) => ({ ...m, _selected: true }));
    renderGroupMembers();
  }

  function renderGroupMembers() {
    const filter = document.getElementById('gmFilter').value.trim().toLowerCase();
    const list = filter
      ? groupDetailMembers.filter((m) => m.phone.includes(filter))
      : groupDetailMembers;
    const rows = document.getElementById('gmRows');
    if (!list.length) { rows.innerHTML = '<tr><td colspan="3" class="muted">No members.</td></tr>'; updateGmCount(); return; }
    rows.innerHTML = list.map((m) => {
      const i = groupDetailMembers.indexOf(m);
      const role = m.isSuperAdmin ? '<span class="tag green-tag">owner</span>'
                 : m.isAdmin      ? '<span class="tag amber-tag">admin</span>'
                 : '<span class="muted">member</span>';
      return `<tr>
        <td><input type="checkbox" class="gm-sel" data-i="${i}" ${m._selected ? 'checked' : ''}></td>
        <td><span class="code">${esc(m.phone)}</span></td>
        <td>${role}</td>
      </tr>`;
    }).join('');
    rows.querySelectorAll('.gm-sel').forEach((cb) => {
      cb.addEventListener('change', () => {
        groupDetailMembers[+cb.dataset.i]._selected = cb.checked;
        updateGmCount();
      });
    });
    updateGmCount();
  }
  function updateGmCount() {
    const n = groupDetailMembers.filter((m) => m._selected).length;
    document.getElementById('gmSelCount').textContent = `${n} selected`;
  }

  document.getElementById('gmClose').addEventListener('click', () => {
    document.getElementById('groupModal').style.display = 'none';
  });
  document.getElementById('gmFilter').addEventListener('input', renderGroupMembers);
  document.getElementById('gmHeadCheck').addEventListener('change', (e) => {
    groupDetailMembers.forEach((m) => (m._selected = e.target.checked));
    renderGroupMembers();
  });
  document.getElementById('gmSelectAll').addEventListener('click', () => {
    groupDetailMembers.forEach((m) => (m._selected = true));
    renderGroupMembers();
  });
  document.getElementById('gmSelectNone').addEventListener('click', () => {
    groupDetailMembers.forEach((m) => (m._selected = false));
    renderGroupMembers();
  });

  async function addMembersToContacts(members) {
    if (!members.length) { alert('No members to add'); return; }
    const raw = members.map((m) => ({ phone: m.phone, name: '', vars: {} }));
    const norm = await window.api.normalizePhones(raw);
    if (!norm.ok) { alert(norm.error); return; }
    contacts = norm.contacts.map((c) => ({ ...c, risk_level: 'unknown', _selected: c.valid }));
    ctSummary.style.display = 'block';
    ctSummary.innerHTML = `Loaded <strong>${norm.stats.valid}</strong> contacts from group <code>${esc(selectedGroup?.name || '')}</code>${norm.stats.invalid ? `, ${norm.stats.invalid} invalid` : ''}.`;
    renderContacts();
    document.getElementById('groupModal').style.display = 'none';
    show('Contacts');
  }

  document.getElementById('gmAddSelected').addEventListener('click', () => {
    addMembersToContacts(groupDetailMembers.filter((m) => m._selected));
  });
  document.getElementById('gmAddAll').addEventListener('click', () => {
    addMembersToContacts(groupDetailMembers);
  });

  document.querySelectorAll('[data-gtab]').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('[data-gtab]').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      const which = t.dataset.gtab;
      document.getElementById('gaSend').style.display = which === 'send' ? 'block' : 'none';
      document.getElementById('gaExtract').style.display = which === 'extract' ? 'block' : 'none';
    });
  });

  document.getElementById('gaPickMedia').addEventListener('click', async () => {
    const r = await window.api.pickMedia();
    if (r.canceled) return;
    if (!r.ok) { alert(r.error); return; }
    attachedGroupMedia = r.media;
    document.getElementById('gaMediaName').textContent = `${r.media.filename} (${humanSize(r.media.size)})`;
    document.getElementById('gaRemoveMedia').style.display = 'inline-block';
  });
  document.getElementById('gaRemoveMedia').addEventListener('click', () => {
    attachedGroupMedia = null;
    document.getElementById('gaMediaName').textContent = 'No file attached';
    document.getElementById('gaRemoveMedia').style.display = 'none';
  });

  document.getElementById('gaSendBtn').addEventListener('click', async () => {
    if (!selectedGroup) return;
    const text = document.getElementById('gaMessage').value.trim();
    if (!text && !attachedGroupMedia) { alert('Type a message or attach media.'); return; }

    const msg = document.getElementById('gaSendMsg');
    msg.className = 'muted'; msg.textContent = 'Sending…';

    let r;
    if (attachedGroupMedia) {
      r = await window.api.waSendGroupMedia(selectedGroup.id, attachedGroupMedia, text);
    } else {
      r = await window.api.waSendGroup(selectedGroup.id, text);
    }
    if (r.ok) { msg.className = 'success'; msg.textContent = '✓ Sent.'; }
    else      { msg.className = 'error';   msg.textContent = r.error; }
  });

  document.getElementById('gaExtractBtn').addEventListener('click', async () => {
    if (!selectedGroup) return;
    const out = document.getElementById('gaExtractResult');
    out.textContent = 'Extracting…';
    const r = await window.api.waExtractGroup(selectedGroup.id);
    if (!r.ok) { out.innerHTML = `<span class="error">${esc(r.error)}</span>`; return; }
    out.innerHTML = `
      <p>Extracted <strong>${r.members.length}</strong> members.</p>
      <button id="gaCopy" class="secondary">Copy phones</button>
      <button id="gaUseInCampaign" class="secondary">Use in new campaign</button>
      <textarea readonly rows="8" style="margin-top:10px">${r.members.map(m => m.phone).join('\n')}</textarea>`;
    document.getElementById('gaCopy').addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(r.members.map(m => m.phone).join('\n')); alert('Copied'); } catch (_) {}
    });
    document.getElementById('gaUseInCampaign').addEventListener('click', async () => {
      const raw = r.members.map((m) => ({ phone: m.phone, name: '', vars: {} }));
      const norm = await window.api.normalizePhones(raw);
      if (norm.ok) {
        contacts = norm.contacts.map((c) => ({ ...c, risk_level: 'unknown', _selected: c.valid }));
        ctSummary.style.display = 'block';
        ctSummary.innerHTML = `Loaded <strong>${norm.stats.valid}</strong> contacts from group <code>${esc(selectedGroup.name)}</code>.`;
        renderContacts();
        show('Contacts');
      }
    });
  });

  // ============== Blacklist ==============
  async function loadBlacklist() {
    const r = await window.api.blacklistList();
    const tbody = document.getElementById('blRows');
    const count = document.getElementById('blCount');
    if (!r.ok || !r.items.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">No blocked numbers.</td></tr>';
      count.textContent = '0 blocked';
      return;
    }
    count.textContent = `${r.items.length} blocked`;
    tbody.innerHTML = r.items.map((it) => `
      <tr>
        <td><span class="code">${esc(it.phone)}</span></td>
        <td>${esc(it.note || '')}</td>
        <td><button class="danger" data-rm="${esc(it.phone)}">Remove</button></td>
      </tr>`).join('');
    tbody.querySelectorAll('button[data-rm]').forEach((b) => {
      b.addEventListener('click', async () => {
        await window.api.blacklistRemove(b.dataset.rm);
        loadBlacklist();
      });
    });
  }

  document.getElementById('blAddBtn').addEventListener('click', async () => {
    const phone = document.getElementById('blPhone').value.trim();
    const note = document.getElementById('blNote').value.trim();
    if (!phone) return;
    const norm = await window.api.normalizePhones([{ phone }]);
    if (!norm.ok || !norm.contacts[0] || !norm.contacts[0].phone) { alert('Invalid number'); return; }
    await window.api.blacklistAdd(norm.contacts[0].phone, note);
    document.getElementById('blPhone').value = '';
    document.getElementById('blNote').value = '';
    loadBlacklist();
  });

  document.getElementById('blClearBtn').addEventListener('click', async () => {
    if (!confirm('Clear ALL blocked numbers?')) return;
    await window.api.blacklistClear();
    loadBlacklist();
  });

  // ============== Sent contacts log ==============
  async function loadSentLog() {
    const r = await window.api.sentList();
    const tbody = document.getElementById('sentRows');
    const count = document.getElementById('sentCount');
    if (!r.ok || !r.entries.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted">Empty.</td></tr>';
      count.textContent = '0 entries';
      return;
    }
    count.textContent = `${r.count} entries`;
    tbody.innerHTML = r.entries.slice(0, 500).map((e) => `
      <tr>
        <td><span class="code">${esc(e.phone)}</span></td>
        <td>${esc(e.name || '')}</td>
        <td class="muted">${new Date(e.ts).toLocaleString()}</td>
      </tr>`).join('');
  }

  document.getElementById('sentRefreshBtn').addEventListener('click', loadSentLog);
  document.getElementById('sentClearBtn').addEventListener('click', async () => {
    if (!confirm('Clear sent contacts log?')) return;
    await window.api.sentClear();
    loadSentLog();
  });
  document.getElementById('sentExportBtn').addEventListener('click', async () => {
    const r = await window.api.sentList();
    if (!r.ok || !r.entries.length) return;
    const lines = [['phone', 'name', 'when', 'campaign']];
    for (const e of r.entries) lines.push([e.phone, e.name || '', new Date(e.ts).toISOString(), e.campaign || '']);
    const csv = lines.map((row) => row.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'sent-contacts.csv'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }
  function humanSize(bytes) {
    if (!bytes) return '0B';
    const u = ['B','KB','MB','GB'];
    let i = 0;
    while (bytes >= 1024 && i < u.length - 1) { bytes /= 1024; i++; }
    return bytes.toFixed(1) + u[i];
  }

  show('WA');
})();
