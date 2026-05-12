/**
 * src/services/api.service.js
 *
 * HTTP client that:
 *  - Uses the saved JWT in Authorization header
 *  - Auto-refreshes the JWT via /api/license/validate on 401/403
 *  - Falls back to raising "REACTIVATION_REQUIRED" when refresh fails
 *
 * Tokens / config are managed by the caller (main.js) which owns electron-store.
 */
const axios = require('axios');

class ApiClient {
  constructor({ getConfig, setToken }) {
    this.getConfig = getConfig;     // () => { apiUrl, token, licenseKey, fingerprint }
    this.setToken  = setToken;      // (newToken) => void

    this.http = axios.create({ timeout: 25_000 });

    // Attach JWT
    this.http.interceptors.request.use((cfg) => {
      const { apiUrl, token } = this.getConfig();
      cfg.baseURL = apiUrl;
      if (token) cfg.headers.Authorization = `Bearer ${token}`;
      return cfg;
    });

    // On auth errors, try /validate to refresh JWT, then retry once
    this.http.interceptors.response.use(
      (r) => r,
      async (error) => {
        const cfg = error.config || {};
        const status = error.response?.status;
        const isAuthErr = status === 401 ||
          (status === 403 && /token|expired/i.test(error.response?.data?.error || ''));

        if (!isAuthErr || cfg.__retried) return Promise.reject(error);
        cfg.__retried = true;

        const refreshed = await this.tryRefreshToken();
        if (!refreshed) {
          const e = new Error('REACTIVATION_REQUIRED');
          e.code = 'REACTIVATION_REQUIRED';
          return Promise.reject(e);
        }
        return this.http(cfg);
      }
    );
  }

  async tryRefreshToken() {
    const { apiUrl, licenseKey, fingerprint } = this.getConfig();
    if (!licenseKey || !fingerprint || !apiUrl) return false;
    try {
      const { data } = await axios.post(
        `${apiUrl}/api/license/validate`,
        { license_key: licenseKey, device_fingerprint: fingerprint },
        { timeout: 15_000 }
      );
      if (data?.ok && data.token) {
        this.setToken(data.token);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  // ---------- Endpoints ----------
  activate(license_key, device_fingerprint) {
    const { apiUrl } = this.getConfig();
    return axios.post(
      `${apiUrl}/api/license/activate`,
      { license_key, device_fingerprint },
      { timeout: 15_000 }
    ).then((r) => r.data);
  }

  validate(license_key, device_fingerprint) {
    const { apiUrl } = this.getConfig();
    return axios.post(
      `${apiUrl}/api/license/validate`,
      { license_key, device_fingerprint },
      { timeout: 15_000 }
    ).then((r) => r.data);
  }

  me()                            { return this.http.get('/api/license/me').then(r => r.data); }

  startCampaign(payload)          { return this.http.post('/api/campaign/start', payload).then(r => r.data); }
  listCampaigns()                 { return this.http.get('/api/campaign').then(r => r.data); }
  getCampaign(id)                 { return this.http.get(`/api/campaign/${id}`).then(r => r.data); }
  getReport(id)                   { return this.http.get(`/api/campaign/${id}/report`).then(r => r.data); }
  setStatus(id, status)           { return this.http.patch(`/api/campaign/${id}/status`, { status }).then(r => r.data); }
  updateRisk(id, updates)         { return this.http.patch(`/api/campaign/${id}/risk`, { updates }).then(r => r.data); }
  deleteCampaign(id)              { return this.http.delete(`/api/campaign/${id}`).then(r => r.data); }

  nextJob(id)                     { return this.http.get(`/api/campaign/${id}/next`).then(r => r.data); }
  reportJob(id, payload)          { return this.http.post(`/api/campaign/${id}/report`, payload).then(r => r.data); }
  skipJob(id, payload)            { return this.http.post(`/api/campaign/${id}/skip`, payload).then(r => r.data); }
}

module.exports = { ApiClient };
