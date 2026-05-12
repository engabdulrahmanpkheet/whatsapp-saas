/* renderer/login.js */
(async function () {
  const serverUrlEl = document.getElementById('serverUrl');
  const keyEl = document.getElementById('licenseKey');
  const fpEl = document.getElementById('fingerprint');
  const btn = document.getElementById('activateBtn');
  const msg = document.getElementById('msg');

  const cfg = await window.api.getConfig();
  serverUrlEl.value = cfg.apiUrl || 'http://localhost:4000';
  fpEl.value = cfg.fingerprint;

  serverUrlEl.addEventListener('change', async () => {
    await window.api.setServer(serverUrlEl.value);
  });

  btn.addEventListener('click', async () => {
    const key = (keyEl.value || '').trim().toUpperCase();
    if (!key) { msg.className='error'; msg.textContent='Enter a license key.'; return; }

    btn.disabled = true;
    msg.className='muted'; msg.textContent='Activating…';

    await window.api.setServer(serverUrlEl.value);
    const result = await window.api.activate(key);

    if (result.ok) {
      msg.className='success';
      msg.textContent='Activated! Loading dashboard…';
      setTimeout(() => window.api.goDashboard(), 600);
    } else {
      btn.disabled = false;
      msg.className='error';
      msg.textContent = result.error || 'Activation failed';
    }
  });

  keyEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); });
})();
