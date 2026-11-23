import axios from 'axios';
import { kmcMockAdapter } from '../../lib/kmcBackendEngine';

export const getApiBaseUrl = () => {
  if (typeof window !== 'undefined' && window.__KMC_RUNTIME_CONFIG__?.API_URL) {
    return window.__KMC_RUNTIME_CONFIG__.API_URL;
  }
  return '/api';
};

const defaultAdapter = axios.defaults.adapter;

// In production a failed request must surface the real error; a client-side
// mock would fake a working public portal. Demo mode is explicit opt-in.
const kmcProgressiveAdapter = async (config) => {
  if (typeof window !== 'undefined' && window.__KMC_FORCE_MOCK__ === true) {
    return kmcMockAdapter(config);
  }
  const adapterFn = typeof defaultAdapter === 'function'
    ? defaultAdapter
    : (axios.getAdapter ? axios.getAdapter(defaultAdapter) : null);
  if (!adapterFn) {
    throw new Error('No HTTP adapter is available');
  }
  return adapterFn(config);
};

const api = axios.create({
  baseURL: getApiBaseUrl(),
  timeout: 30000,
  adapter: kmcProgressiveAdapter,
  headers: {
    'Content-Type': 'application/json',
  },
});

// Attach runtime baseURL and token if user was previously logged in on the same domain
api.interceptors.request.use((config) => {
  config.baseURL = getApiBaseUrl();
  if (typeof window !== 'undefined') {
    const token = localStorage.getItem('kmc_access_token');
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

export const authAPI = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  me: () => api.get('/auth/me'),
};

export const systemAPI = {
  getRuntimeConfig: () => api.get('/runtime-config'),
};

export const geoportalAPI = {
  getCatalog: () => api.get('/geoportal/catalog'),
  getLandingStats: () => api.get('/geoportal/landing-stats'),
  updateLayerConfig: (layerId, data) => api.put(`/geoportal/layers/${layerId}/config`, data),
  updateMBTilesConfig: (mbtilesId, data) => api.put(`/geoportal/mbtiles/${mbtilesId}/config`, data),
};

export const analyticsAPI = {
  getLayerAnalytics: (layerId, bbox = null, ward = null) => {
    const params = {};
    if (bbox) params.bbox = bbox;
    if (ward) params.ward = ward;
    return api.get(`/analytics/layer/${layerId}`, { params });
  },
};

/**
 * Geo World entry gate — Nepal-only access verification.
 * accessCheck runs the server-side Nepal / VPN evaluation and issues the
 * HttpOnly geo-pass cookie on success. verify re-checks the cookie.
 */
export const geoAPI = {
  accessCheck: (payload) => api.post('/geo/access-check', payload || {}),
  verify: () => api.get('/geo/verify'),
};

export default api;
