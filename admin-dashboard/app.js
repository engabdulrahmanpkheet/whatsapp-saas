/* admin app.js */
(function () {
  const apiUrl = (localStorage.getItem('apiUrl') || '').replace(/\/+$/, '');
  const token = localStorage.getItem('token');
  const email = localStorage.getItem('lastEmail') || '';

  if (!apiUrl || !token) { window.location.href = 'login.html'; return; }

  document.getElementById('adminEmail').textContent = email;
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('token');
    window.location.href = 'login.html';
  });

  // ---------- API helper ----------
  async function api(path, options = {}) {
    const res = await fetch(`${apiUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      localStorage.removeItem('token');
      window.location.href = 'login.html';
      return Promise.reject(new Error('Unauthorized'));
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  // ---------- View switching ----------
  const viewLicenses  = document.getElementById('viewLicenses');
  const viewCampaigns = document.getElementById('viewCampaigns');
  document.querySelectorAll('.nav-item').forEach((el) => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
      el.classList.add('active');
      const v = el.dataset.view;
      viewLicenses.style.display  = v === 'licenses'  ? 'block' : 'none';
      viewCampaigns.style.display = v === 'campaigns' ? 'block' : 'none';
      if (v === 'campaigns') loadCampaigns();
    });
  });

  // ---------- Stats ----------
  async function loadStats() {
    try {
      const d = await api('/api/admin/stats');
      document.getElementById('stTotal').textContent     = d.stats.total;
      document.getElementById('stActive').textContent    = d.stats.active;
      document.getElementById('stInactive').textContent  = d.stats.inactive;
      document.getElementById('stExpired').textContent   = d.stats.expired;
      document.getElementById('stRevoked').textContent   = d.stats.revoked;
      document.getElementById('stCampaigns').textContent = d.stats.totalCampaigns;
    } catch (e) { console.error(e); }
  }

  // ---------- Licenses ----------
  const rowsEl   = document.getElementById('rows');
  const searchEl = document.getElementById('searchEl');
  const filterEl = document.getElementById('filterStatus');

  async function loadLicenses() {
    rowsEl.innerHTML = '<tr><td colspan="7" style="color:#6b7587">Loading…</td></tr>';
    try {
      const params = new URLSearchParams();
      if (searchEl.value.trim()) params.set('q', searchEl.value.trim());
      if (filterEl.value)        params.set('status', filterEl.value);

      const d = await api(`/api/admin/licenses?${params.toString()}`);
      if (!d.licenses.length) {
        rowsEl.innerHTML = '<tr><td colspan="7" style="color:#6b7587">No licenses found.</td></tr>';
        return;
      }
      rowsEl.innerHTML = d.licenses.map((l) => {
        const expires = new Date(l.expires_at).toLocaleDateString();
        const device  = l.device_fingerprint
          ? `<span class="code" title="${l.device_fingerprint}">${l.device_fingerprint.slice(0, 12)}…</span>`
          : '<span style="color:#6b7587">unbound</span>';
        const customer = l.customer_name || l.customer_email
          ? `<div style="font-weight:500">${esc(l.customer_name)}</div><div style="color:#6b7587;font-size:12px">${esc(l.customer_email)}</div>`
          : '<span style="color:#6b7587">—</span>';
        return `
          <tr>
            <td>
              <span class="code">${l.license_key}</span>
              <button class="copy-btn" data-copy="${l.license_key}">Copy</button>
            </td>
            <td>${customer}</td>
            <td>${l.plan}</td>
            <td><span class="tag ${l.status}">${l.status}</span></td>
            <td>${device}</td>
            <td>${expires}</td>
            <td>
              <button class="secondary" data-reset="${l.license_key}" ${!l.device_fingerprint ? 'disabled' : ''}>Reset device</button>
              <button class="danger" data-revoke="${l.license_key}" ${l.status === 'revoked' ? 'disabled' : ''}>Revoke</button>
            </td>
          </tr>`;
      }).join('');
    } catch (e) {
      rowsEl.innerHTML = `<tr><td colspan="7" class="error">${esc(e.message)}</td></tr>`;
    }
  }

  rowsEl.addEventListener('click', async (e) => {
    const t = e.target;
    if (t.dataset.copy) {
      try { await navigator.clipboard.writeText(t.dataset.copy); t.textContent = 'Copied'; setTimeout(() => (t.textContent = 'Copy'), 1200); } catch(_) {}
    }
    if (t.dataset.revoke) {
      if (!confirm(`Revoke ${t.dataset.revoke}?`)) return;
      try { await api(`/api/admin/license/${encodeURIComponent(t.dataset.revoke)}/revoke`, { method: 'PATCH' }); refresh(); }
      catch (e) { alert(e.message); }
    }
    if (t.dataset.reset) {
      if (!confirm(`Reset device binding for ${t.dataset.reset}?\nThe customer can re-activate on a new machine.`)) return;
      try { await api(`/api/admin/license/${encodeURIComponent(t.dataset.reset)}/reset-device`, { method: 'PATCH' }); refresh(); }
      catch (e) { alert(e.message); }
    }
  });

  searchEl.addEventListener('input', debounce(loadLicenses, 250));
  filterEl.addEventListener('change', loadLicenses);
  document.getElementById('refreshBtn').addEventListener('click', refresh);

  function refresh() { loadStats(); loadLicenses(); }
  refresh();

  // ---------- Campaigns ----------
  const campRows = document.getElementById('campRows');
  const campFilter = document.getElementById('campFilter');
  document.getElementById('campRefreshBtn').addEventListener('click', loadCampaigns);
  campFilter.addEventListener('input', debounce(loadCampaigns, 300));

  async function loadCampaigns() {
    campRows.innerHTML = '<tr><td colspan="6" style="color:#6b7587">Loading…</td></tr>';
    try {
      const params = new URLSearchParams();
      if (campFilter.value.trim()) params.set('license_key', campFilter.value.trim().toUpperCase());

      const d = await api(`/api/admin/campaigns?${params.toString()}`);
      if (!d.campaigns.length) {
        campRows.innerHTML = '<tr><td colspan="6" style="color:#6b7587">No campaigns yet.</td></tr>';
        return;
      }
      campRows.innerHTML = d.campaigns.map((c) => {
        const total = c.progress?.total || 0;
        const done  = (c.progress?.sent || 0) + (c.progress?.failed || 0);
        const pct   = total ? Math.round((done / total) * 100) : 0;
        const today = c.sent_today?.count || 0;
        return `
          <tr>
            <td><strong>${esc(c.name)}</strong></td>
            <td><span class="code">${c.license_key}</span></td>
            <td><span class="tag ${c.status}">${c.status}</span></td>
            <td>
              ${done}/${total} (${pct}%)
              <div class="progress" style="margin-top:4px"><div style="width:${pct}%"></div></div>
            </td>
            <td>${today}</td>
            <td style="color:#6b7587">${new Date(c.createdAt).toLocaleString()}</td>
          </tr>`;
      }).join('');
    } catch (e) {
      campRows.innerHTML = `<tr><td colspan="6" class="error">${esc(e.message)}</td></tr>`;
    }
  }

  // ---------- New license modal ----------
  const newModal = document.getElementById('newModal');
  const createdModal = document.getElementById('createdModal');
  const createdList = document.getElementById('createdList');
  const newMsg = document.getElementById('newMsg');

  document.getElementById('newLicenseBtn').addEventListener('click', () => { newModal.style.display = 'grid'; newMsg.textContent = ''; });
  document.getElementById('cancelNew').addEventListener('click', () => { newModal.style.display = 'none'; });
  document.getElementById('closeCreated').addEventListener('click', () => { createdModal.style.display = 'none'; });

  document.getElementById('confirmNew').addEventListener('click', async () => {
    const payload = {
      customer_name:  document.getElementById('newCustName').value.trim(),
      customer_email: document.getElementById('newCustEmail').value.trim(),
      plan:           document.getElementById('newPlan').value,
      days_valid:     parseInt(document.getElementById('newDays').value, 10),
      max_messages_per_day: parseInt(document.getElementById('newLimit').value, 10),
      notes:          document.getElementById('newNotes').value.trim(),
      count:          parseInt(document.getElementById('newCount').value, 10),
    };
    try {
      newMsg.className = ''; newMsg.textContent = 'Creating…';
      const d = await api('/api/admin/create-license', { method: 'POST', body: JSON.stringify(payload) });
      newModal.style.display = 'none';
      createdList.innerHTML = d.licenses.map((l) => `
        <div style="display:flex; align-items:center; gap:10px; padding:8px; border:1px solid #e3e6ee; border-radius:8px; margin-bottom:6px;">
          <span class="code" style="flex:1; font-size:14px">${l.license_key}</span>
          <button class="copy-btn" data-copy="${l.license_key}">Copy</button>
        </div>`).join('');
      createdList.querySelectorAll('.copy-btn').forEach(b => {
        b.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = 'Copied'; setTimeout(() => (b.textContent = 'Copy'), 1200); } catch(_) {}
        });
      });
      createdModal.style.display = 'grid';
      refresh();
    } catch (e) {
      newMsg.className = 'error'; newMsg.textContent = e.message;
    }
  });

  // ---------- helpers ----------
  function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
      '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
    }[c]));
  }
})();
