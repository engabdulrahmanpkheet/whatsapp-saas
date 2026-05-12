/* admin login.js */
(function () {
  const apiUrlEl = document.getElementById('apiUrl');
  const emailEl  = document.getElementById('email');
  const passEl   = document.getElementById('password');
  const btn      = document.getElementById('loginBtn');
  const msg      = document.getElementById('msg');

  apiUrlEl.value = localStorage.getItem('apiUrl') || 'http://localhost:4000';
  emailEl.value  = localStorage.getItem('lastEmail') || 'admin@local.test';

  btn.addEventListener('click', login);
  passEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });

  async function login() {
    const apiUrl = apiUrlEl.value.replace(/\/+$/, '');
    const email = emailEl.value.trim();
    const password = passEl.value;
    if (!apiUrl || !email || !password) {
      msg.className = 'error'; msg.textContent = 'All fields required.'; return;
    }

    btn.disabled = true;
    msg.className = ''; msg.textContent = 'Signing in…';

    try {
      const res = await fetch(`${apiUrl}/api/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || 'Login failed');

      localStorage.setItem('apiUrl', apiUrl);
      localStorage.setItem('token', data.token);
      localStorage.setItem('lastEmail', email);
      window.location.href = 'index.html';
    } catch (e) {
      btn.disabled = false;
      msg.className = 'error'; msg.textContent = e.message;
    }
  }
})();
