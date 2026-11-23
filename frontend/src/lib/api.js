'use client';

import axios from 'axios';
import { kmcMockAdapter } from '../../lib/kmcBackendEngine';
import { navigateTo } from '../../shims/nextNavigation';

/**
 * KMC-GIS-SERVER API Client
 * Axios instance with JWT interceptor and error handling.
 */

export const getApiBaseUrl = () => {
  if (typeof window !== 'undefined' && window.__KMC_RUNTIME_CONFIG__?.API_URL) {
    return window.__KMC_RUNTIME_CONFIG__.API_URL;
  }
  return '/api';
};

const API_BASE = getApiBaseUrl();

/**
 * Real backend adapter. In production a failed request must surface the real
 * error: silently substituting a client-side mock would fake successful saves.
 * `window.__KMC_FORCE_MOCK__ === true` is the explicit opt-in demo mode.
 */
const defaultAdapter = axios.defaults.adapter;

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
  baseURL: API_BASE,
  timeout: 120000,
  adapter: kmcProgressiveAdapter,
  headers: {
    'Content-Type': 'application/json',
  },
});

// ---- Request Interceptor: Attach Runtime BaseURL & JWT ----
api.interceptors.request.use(
  (config) => {
    config.baseURL = getApiBaseUrl();
    if (typeof window !== 'undefined') {
      const token = localStorage.getItem('kmc_access_token');
      if (token) {
        config.headers.Authorization = `Bearer ${token}`;
      }
    }
    return config;
  },
  (error) => Promise.reject(error)
);

// ---- Response Interceptor: Handle 401 + Token Refresh ----
let isRefreshing = false;
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach((prom) => {
    if (error) prom.reject(error);
    else prom.resolve(token);
  });
  failedQueue = [];
};

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;

    // Do not attempt token refresh for login or refresh requests
    const isAuthEndpoint = originalRequest?.url?.includes('/auth/login') ||
                           originalRequest?.url?.includes('/auth/refresh');

    if (error.response?.status === 401 && !originalRequest._retry && !isAuthEndpoint) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then((token) => {
          originalRequest.headers.Authorization = `Bearer ${token}`;
          return api(originalRequest);
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        const refreshToken = localStorage.getItem('kmc_refresh_token');
        if (!refreshToken) throw new Error('No refresh token');

        const res = await axios.post(`${getApiBaseUrl()}/auth/refresh`, {
          refresh_token: refreshToken,
        });

        const { access_token, refresh_token: newRefresh } = res.data;
        localStorage.setItem('kmc_access_token', access_token);
        localStorage.setItem('kmc_refresh_token', newRefresh);

        processQueue(null, access_token);
        originalRequest.headers.Authorization = `Bearer ${access_token}`;
        return api(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError);
        localStorage.removeItem('kmc_access_token');
        localStorage.removeItem('kmc_refresh_token');
        localStorage.removeItem('kmc_user');
        if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
          window.location.href = '/login';
        }
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

export default api;

// ---- Auth API ----
export const authAPI = {
  login: (username, password) => api.post('/auth/login', { username, password }),
  refresh: (refresh_token) => api.post('/auth/refresh', { refresh_token }),
  me: () => api.get('/auth/me'),
};

// ---- Users API ----
export const usersAPI = {
  list: () => api.get('/users'),
  get: (id) => api.get(`/users/${id}`),
  create: (data) => api.post('/users', data),
  update: (id, data) => api.put(`/users/${id}`, data),
  changePassword: (id, data) => api.put(`/users/${id}/password`, data),
  delete: (id) => api.delete(`/users/${id}`),
  getProjects: (userId) => api.get(`/users/${userId}/projects`),
};

// ---- Projects API ----
export const projectsAPI = {
  list: () => api.get('/projects'),
  get: (id) => api.get(`/projects/${id}`),
  create: (data) => api.post('/projects', data),
  update: (id, data) => api.put(`/projects/${id}`, data),
  delete: (id) => api.delete(`/projects/${id}`),
  uploadBoundary: (id, formData) =>
    api.post(`/projects/${id}/boundary/upload`, formData, {
      headers: { 'Content-Type': 'multipart/form-data' },
    }),
  setBoundary: (id, data) => api.post(`/projects/${id}/boundary`, data),
  generateGrid: (id, data) => api.post(`/projects/${id}/generate-grid`, data),
  getAssignments: (id) => api.get(`/projects/${id}/assignments`),
  assignLayer: (id, layerId) => api.post(`/projects/${id}/assign-layer`, { layer_id: layerId }),
  assignTiles: (id, mbtilesId) => api.post(`/projects/${id}/assign-tiles`, { mbtiles_id: mbtilesId }),
  unassignLayer: (id, layerId) => api.delete(`/projects/${id}/unassign-layer/${layerId}`),
  unassignTiles: (id, mbtilesId) => api.delete(`/projects/${id}/unassign-tiles/${mbtilesId}`),
  getCollectors: (id) => api.get(`/projects/${id}/collectors`),
  assignCollectors: (id, userIds) =>
    api.post(`/projects/${id}/collectors`, { user_ids: Array.isArray(userIds) ? userIds : [userIds] }),
  unassignCollector: (id, userId) => api.delete(`/projects/${id}/collectors/${userId}`),
  getHouseNumbering: (id) => api.get(`/projects/${id}/house-numbering`),
  generateHouseNumbers: (id, data = {}) => api.post(`/projects/${id}/house-numbering/generate`, data),
};

// ---- Tasks API ----
export const tasksAPI = {
  list: (projectId, statusFilter, collectorFilter) => {
    const params = {};
    if (statusFilter && statusFilter !== 'ALL') params.status_filter = statusFilter;
    if (collectorFilter && collectorFilter !== 'ALL') params.collector_filter = collectorFilter;
    return api.get(`/projects/${projectId}/tasks`, { params });
  },
  assign: (projectId, taskIds, userId) =>
    api.post(`/projects/${projectId}/tasks/assign`, { task_ids: Array.isArray(taskIds) ? taskIds : [taskIds], user_id: userId }),
  assignValidator: (projectId, taskIds, validatorId) =>
    api.post(`/projects/${projectId}/tasks/assign`, {
      task_ids: Array.isArray(taskIds) ? taskIds : [taskIds],
      validator_id: validatorId,
      assigned_validator_id: validatorId,
    }),
  assignMany: (projectId, taskIds, assignments) =>
    api.post(`/projects/${projectId}/tasks/assign`, {
      task_ids: Array.isArray(taskIds) ? taskIds : [taskIds],
      assignments,
    }),
  autoDistribute: (projectId, userIds) =>
    api.post(`/projects/${projectId}/tasks/auto-distribute`, { user_ids: userIds }),
  lock: (taskId, data) => api.post(`/tasks/${taskId}/lock`, data || {}),
  unlock: (taskId) => api.post(`/tasks/${taskId}/unlock`),
  submit: (taskId) => api.post(`/tasks/${taskId}/submit`),
  validate: (taskId, action) => api.post(`/tasks/${taskId}/validate?action=${action}`),
  reset: (projectId) => api.delete(`/projects/${projectId}/tasks/reset`),
};

// ---- Layers API ----
export const layersAPI = {
  list: (params = {}) => api.get('/layers', { params: { all_layers: true, ...params } }),
  listGlobal: () => api.get('/layers'),
  listAll: (params = {}) => api.get('/layers', { params: { all_layers: true, ...params } }),
  listProject: (projectId) => api.get(`/projects/${projectId}/layers`),
  get: (id) => api.get(`/layers/${id}`),
  getFeatures: (layerId, bbox, zoom) => {
    const params = {
      ...(bbox ? { bbox } : {}),
      ...(zoom != null ? { zoom } : {}),
    };
    return api.get(`/layers/${layerId}/features`, { params });
  },
  create: (data) => api.post('/layers', data),
  createProject: (projectId, data) => api.post(`/projects/${projectId}/layers`, data),
  update: (id, data) => api.put(`/layers/${id}`, data),
  delete: (id) => api.delete(`/layers/${id}`),
  getDeleted: () => api.get('/layers/deleted'),
  restore: (id) => api.post(`/layers/${id}/restore`),
  permanentDelete: (id) => api.delete(`/layers/${id}/permanent`),
  download: (layerId, format = 'geojson') =>
    api.get(`/layers/${layerId}/download`, {
      params: { format },
      responseType: 'blob',
    }),
  link: (sourceLayerId, data) => api.post(`/layers/${sourceLayerId}/link`, data),
  getFields: (layerId, params = {}) => api.get(`/layers/${layerId}/fields`, { params }),
  updateFields: (layerId, fields) => api.put(`/layers/${layerId}/fields`, fields),
  getNextId: (layerId, params = {}) => api.get(`/layers/${layerId}/next-id`, { params }),
  upload: (formData, onUploadProgress) => api.post('/layers/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    onUploadProgress,
  }),
  getAuditEdits: (layerId, limit = 100) => api.get(`/layers/${layerId}/audit-edits`, { params: { limit } }),
  setPrimaryKey: (layerId, data) => api.post(`/layers/${layerId}/primary-key`, data),
  getPrimaryKeyAudit: (layerId, params = {}) => api.get(`/layers/${layerId}/primary-key/audit`, { params }),
};

// ---- Features API ----
export const featuresAPI = {
  get: (featureId) => api.get(`/features/${featureId}`),
  list: (layerId, bbox, zoom, options = {}) => {
    const params = {
      ...(bbox ? { bbox } : {}),
      ...(zoom != null ? { zoom } : {}),
      ...(options.params || {}),
    };
    return api.get(`/layers/${layerId}/features`, { ...options, params });
  },
  create: (data) => api.post('/features', data),
  update: (id, data) => api.put(`/features/${id}`, data),
  delete: (id, layerId) => api.delete(
    `/features/${id}`,
    layerId != null ? { params: { layer_id: layerId } } : undefined
  ),
  getLinked: (featureId) => api.get(`/features/${featureId}/linked`),
  link: (featureId, data) => api.post(`/features/${featureId}/link`, data),
  unlink: (featureId, params) => api.delete(`/features/${featureId}/link`, { params }),
  split: (featureId, blade) => api.post(`/features/${featureId}/split`, { blade }),
  splitPreview: (featureId, bladeOrPayload) => {
    const payload = (bladeOrPayload && typeof bladeOrPayload === 'object' && ('blade' in bladeOrPayload || 'split_multipart' in bladeOrPayload))
      ? bladeOrPayload
      : { blade: bladeOrPayload };
    return api.post(`/features/${featureId}/split-preview`, payload);
  },
  splitConfirm: (featureId, parts) => api.post(`/features/${featureId}/split-confirm`, { parts }),
  merge: (layerId, dataOrFeatureIds, options = {}) => {
    if (dataOrFeatureIds && typeof dataOrFeatureIds === 'object' && !Array.isArray(dataOrFeatureIds)) {
      return api.post(`/layers/${layerId}/merge`, dataOrFeatureIds);
    }
    return api.post(`/layers/${layerId}/merge`, {
      feature_ids: dataOrFeatureIds,
      merge_mode: options.merge_mode || 'union',
      primary_feature_id: options.primary_feature_id || null,
      custom_id: options.custom_id || null,
      attributes: options.attributes || null,
    });
  },
  getExtent: (layerId) => api.get(`/layers/${layerId}/extent`),
};

// ---- Tiles API ----
export const tilesAPI = {
  listGlobal: () => api.get('/tiles'),
  listAll: (params = {}) => api.get('/tiles', { params: { all_tiles: true, ...params } }),
  listProject: (projectId) => api.get(`/projects/${projectId}/tiles`),
  download: (tileId) =>
    api.get(`/tiles/${tileId}/download`, {
      responseType: 'blob',
    }),
  upload: (formData, onUploadProgress) => api.post('/tiles/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    onUploadProgress,
  }),
  uploadProject: (projectId, formData, onUploadProgress) => api.post(`/projects/${projectId}/tiles/upload`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
    timeout: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    onUploadProgress,
  }),
  delete: (id) => api.delete(`/tiles/${id}`),
  getDeleted: () => api.get('/tiles/deleted'),
  restore: (id) => api.post(`/tiles/${id}/restore`),
  permanentDelete: (id) => api.delete(`/tiles/${id}/permanent`),
};

// ---- Resumable Chunked Uploads API (files up to hundreds of GB) ----
// Uses direct sparse writing and seek offsets, streaming raw bytes without spooling duplicate temp files.
export const uploadsAPI = {
  init: (data) => api.post('/uploads/init', data, { timeout: 60000 }),
  chunk: (uploadId, index, blob, onUploadProgress) =>
    api.post(`/uploads/${uploadId}/chunk`, blob, {
      params: { index },
      headers: { 'Content-Type': 'application/octet-stream' },
      timeout: 1800000, // 30 min per chunk
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      onUploadProgress,
    }),
  complete: (uploadId) => api.post(`/uploads/${uploadId}/complete`, {}, { timeout: 1800000 }),
  status: (uploadId) => api.get(`/uploads/${uploadId}`),
  abort: (uploadId) => api.delete(`/uploads/${uploadId}`),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function formatBytes(bytes, decimals = 1) {
  if (!bytes || bytes <= 0) return '0 B';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(dm))} ${sizes[i]}`;
}

export function formatSeconds(seconds) {
  if (!seconds || !isFinite(seconds) || seconds <= 0) return '';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m > 0) return `${m} मिनेट ${s} सेकेन्ड`;
  return `${s} सेकेन्ड`;
}

/**
 * Upload a file of any size (up to hundreds of GB) via the resumable chunked API.
 * Accurately tracks speed, ETA, chunk progression, and post-100% verification phase.
 *
 * @param {File} file
 * @param {object} meta { kind: 'vector'|'raster', name, description?, is_global, project_id?, editable_by_collectors?, allow_snapping?, bounds? }
 * @param {(p:{phase:string,loaded:number,total:number,percent:number,speedMBs:number,etaSeconds:number,label?:string})=>void} onProgress
 * @param {AbortSignal} [signal]
 * @returns the /complete response payload
 */
const RESUMABLE_UPLOAD_STORAGE_KEY = 'kmc_resumable_uploads_v1';

function getUploadSessionKey(file, meta) {
  return `${file.name}::${file.size}::${file.lastModified || 0}::${meta.kind || 'vector'}::${meta.project_id ?? 'global'}`;
}

function readUploadSessions() {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(RESUMABLE_UPLOAD_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function writeUploadSessions(map) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(RESUMABLE_UPLOAD_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore quota errors
  }
}

function saveUploadSession(sessionKey, sessionData) {
  const all = readUploadSessions();
  all[sessionKey] = { ...sessionData, updatedAt: Date.now() };
  writeUploadSessions(all);
}

function removeUploadSession(sessionKey) {
  const all = readUploadSessions();
  if (all[sessionKey]) {
    delete all[sessionKey];
    writeUploadSessions(all);
  }
}

export async function uploadFileResumable(file, meta, onProgress, signal) {
  const sessionKey = getUploadSessionKey(file, meta);
  const existingSession = readUploadSessions()[sessionKey];

  let uploadId = null;
  let chunkSize = null;
  let totalChunks = null;
  let doneIndices = new Set();

  // Attempt seamless resume from persisted localStorage session
  if (existingSession?.upload_id) {
    try {
      const st = await uploadsAPI.status(existingSession.upload_id);
      if (st.data && st.data.status !== 'failed' && st.data.status !== 'aborted') {
        uploadId = existingSession.upload_id;
        chunkSize = st.data.chunk_size || existingSession.chunk_size;
        totalChunks = st.data.total_chunks || existingSession.total_chunks;
        if (Array.isArray(st.data.received_chunks)) {
          doneIndices = new Set(st.data.received_chunks);
        }
      } else {
        removeUploadSession(sessionKey);
      }
    } catch {
      removeUploadSession(sessionKey);
    }
  }

  // Initialize fresh upload session if no valid persisted session exists
  if (!uploadId || !chunkSize || !totalChunks) {
    const initRes = await uploadsAPI.init({
      filename: file.name,
      mime_type: file.type || '',
      total_size: file.size,
      kind: meta.kind,
      name: meta.name,
      description: meta.description,
      is_global: meta.is_global,
      project_id: meta.project_id,
      editable_by_collectors: meta.editable_by_collectors,
      allow_snapping: meta.allow_snapping,
      bounds: meta.bounds || null,
    });
    uploadId = initRes.data.upload_id;
    chunkSize = initRes.data.chunk_size;
    totalChunks = initRes.data.total_chunks;

    saveUploadSession(sessionKey, {
      upload_id: uploadId,
      filename: file.name,
      size: file.size,
      lastModified: file.lastModified || 0,
      kind: meta.kind,
      project_id: meta.project_id ?? null,
      chunk_size: chunkSize,
      total_chunks: totalChunks,
    });

    try {
      const st = await uploadsAPI.status(uploadId);
      if (st.data && Array.isArray(st.data.received_chunks)) {
        doneIndices = new Set(st.data.received_chunks);
      }
    } catch {
      /* fresh upload */
    }
  }

  const getChunkSizeForIndex = (idx) =>
    Math.min(chunkSize, Math.max(0, file.size - idx * chunkSize));

  let completedBytes = 0;
  doneIndices.forEach((idx) => {
    completedBytes += getChunkSizeForIndex(idx);
  });
  const inFlightBytes = new Map();

  let startTime = Date.now();
  let lastSpeedCheckTime = startTime;
  let lastSpeedCheckBytes = completedBytes;
  let currentSpeedMBs = 0;

  const getAggregateLoaded = () => {
    let inflight = 0;
    inFlightBytes.forEach((b) => {
      inflight += b;
    });
    return Math.min(file.size, completedBytes + inflight);
  };

  const report = (loaded, phase = 'uploading', customLabel = null, serverPercent = null) => {
    if (!onProgress) return;
    const now = Date.now();
    const timeDiff = (now - lastSpeedCheckTime) / 1000;
    if (timeDiff >= 0.4 && phase === 'uploading') {
      const bytesDiff = loaded - lastSpeedCheckBytes;
      currentSpeedMBs = Math.max(0, bytesDiff / timeDiff / (1024 * 1024));
      lastSpeedCheckTime = now;
      lastSpeedCheckBytes = loaded;
    }
    const uploadPercent = file.size > 0 ? Math.min(100, Math.round((loaded * 100) / file.size)) : 0;
    const remainingBytes = Math.max(0, file.size - loaded);
    const etaSeconds = (phase === 'uploading' && currentSpeedMBs > 0) ? Math.round(remainingBytes / (currentSpeedMBs * 1024 * 1024)) : 0;

    let label = customLabel;
    if (!label) {
      if (phase === 'uploading') {
        const speedText = currentSpeedMBs > 0 ? ` • ${currentSpeedMBs.toFixed(1)} MB/s` : '';
        const etaText = etaSeconds > 0 ? ` • ${formatSeconds(etaSeconds)} बाँकी` : '';
        label = `${uploadPercent}% (${formatBytes(loaded)} / ${formatBytes(file.size)})${speedText}${etaText}`;
      } else if (phase === 'server_processing' || phase === 'verifying' || phase === 'reassembling' || phase === 'ingesting' || phase === 'spatial_indexing') {
        const sPct = serverPercent !== null ? ` ${serverPercent}%` : '';
        label = `सर्भरमा फाइल जोडिँदैछ र विश्लेषण गरिँदैछ...${sPct}`;
      }
    }

    const effectivePercent =
      phase === 'complete'
        ? 100
        : (phase === 'server_processing' || phase === 'verifying' || phase === 'reassembling' || phase === 'ingesting' || phase === 'spatial_indexing')
        ? (serverPercent !== null && serverPercent !== undefined ? serverPercent : 100)
        : uploadPercent;

    onProgress({
      phase,
      loaded,
      total: file.size,
      percent: effectivePercent,
      uploadPercent,
      serverPercent,
      speedMBs: phase === 'uploading' ? currentSpeedMBs : 0,
      etaSeconds: phase === 'uploading' ? etaSeconds : 0,
      label,
    });
  };

  report(completedBytes, 'uploading');

  // Phase 1: Bounded parallel chunk worker pool (concurrency = 4)
  const pendingIndices = [];
  for (let i = 0; i < totalChunks; i++) {
    if (!doneIndices.has(i)) pendingIndices.push(i);
  }

  let nextQueuePos = 0;
  let fatalError = null;
  const CONCURRENCY = Math.min(4, Math.max(1, pendingIndices.length));

  const uploadSingleChunk = async (i) => {
    const expectedSize = getChunkSizeForIndex(i);
    const chunkBlob = file.slice(i * chunkSize, Math.min(file.size, (i + 1) * chunkSize));
    let attempt = 0;
    const maxAttempts = 8;

    for (;;) {
      if (signal && signal.aborted) {
        throw new Error('Upload aborted by user');
      }
      if (fatalError) {
        throw fatalError;
      }
      try {
        inFlightBytes.set(i, 0);
        await uploadsAPI.chunk(uploadId, i, chunkBlob, (e) => {
          const loadedChunk = Math.min(expectedSize, e.loaded || 0);
          inFlightBytes.set(i, loadedChunk);
          report(getAggregateLoaded(), 'uploading');
        });
        inFlightBytes.delete(i);
        if (!doneIndices.has(i)) {
          doneIndices.add(i);
          completedBytes = Math.min(file.size, completedBytes + expectedSize);
        }
        report(getAggregateLoaded(), 'uploading');
        return;
      } catch (err) {
        inFlightBytes.delete(i);
        attempt += 1;
        // Verify if server actually received it despite network blip
        try {
          const st = await uploadsAPI.status(uploadId);
          if (st.data && Array.isArray(st.data.received_chunks) && st.data.received_chunks.includes(i)) {
            if (!doneIndices.has(i)) {
              doneIndices.add(i);
              completedBytes = Math.min(file.size, completedBytes + expectedSize);
            }
            report(getAggregateLoaded(), 'uploading');
            return;
          }
        } catch {
          // continue retry
        }

        if (attempt >= maxAttempts) {
          throw new Error(`Chunk ${i + 1}/${totalChunks} upload failed after ${maxAttempts} attempts: ${err.message || 'Network error'}`);
        }
        const backoffMs = Math.min(10000, 1000 * Math.pow(1.5, attempt) + Math.random() * 500);
        await sleep(backoffMs);
      }
    }
  };

  const worker = async () => {
    while (nextQueuePos < pendingIndices.length && !fatalError) {
      if (signal && signal.aborted) {
        fatalError = new Error('Upload aborted by user');
        return;
      }
      const chunkIdx = pendingIndices[nextQueuePos++];
      try {
        await uploadSingleChunk(chunkIdx);
      } catch (err) {
        fatalError = err;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  if (fatalError) {
    throw fatalError;
  }

  // Phase 2: Post-100% Verification and Assembly with live EventSource + polling fallback
  report(file.size, 'server_processing', 'सर्भरमा फाइल जोडिँदैछ (Assembling on server)...', 100);

  let eventSource = null;
  let pollTimer = null;
  let phase2Active = true;

  const startPhase2Monitor = () => {
    if (typeof window === 'undefined') return;
    const startPolling = () => {
      if (!phase2Active || pollTimer) return;
      pollTimer = setInterval(async () => {
        if (!phase2Active) return;
        try {
          const st = await uploadsAPI.status(uploadId);
          if (st.data) {
            const phaseMsg = st.data.phase_message || st.data.message || 'सर्भरमा प्रशोधन गरिँदैछ...';
            const sPct = st.data.phase_progress !== undefined ? st.data.phase_progress : null;
            report(file.size, st.data.phase || 'server_processing', phaseMsg, sPct);
          }
        } catch {
          // ignore transient status polling error
        }
      }, 1000);
    };

    try {
      if (typeof window.EventSource === 'function') {
        const token = window.localStorage.getItem('kmc_access_token');
        const base = getApiBaseUrl();
        const url = `${base}/uploads/${uploadId}/events${token ? `?token=${encodeURIComponent(token)}` : ''}`;
        eventSource = new window.EventSource(url);
        eventSource.onmessage = (evt) => {
          if (!phase2Active) return;
          try {
            const data = JSON.parse(evt.data);
            if (data) {
              const phaseMsg = data.phase_message || data.message || (data.phase === 'completed' ? 'सफलतापूर्वक सम्पन्न' : 'सर्भरमा प्रशोधन गरिँदैछ...');
              const sPct = data.phase_progress !== undefined ? data.phase_progress : (data.phase === 'completed' ? 100 : null);
              report(file.size, data.phase || 'server_processing', phaseMsg, sPct);
            }
          } catch {
            if (evt.data) report(file.size, 'server_processing', evt.data);
          }
        };
        eventSource.onerror = () => {
          if (eventSource) {
            eventSource.close();
            eventSource = null;
          }
          startPolling();
        };
      } else {
        startPolling();
      }
    } catch {
      startPolling();
    }
  };

  const stopPhase2Monitor = () => {
    phase2Active = false;
    if (eventSource) {
      try { eventSource.close(); } catch {}
      eventSource = null;
    }
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  };

  startPhase2Monitor();
  try {
    const doneRes = await uploadsAPI.complete(uploadId);
    removeUploadSession(sessionKey);
    report(file.size, 'complete', 'सफलतापूर्वक सक्रिय गरियो (Active & Complete)');
    return doneRes.data;
  } catch (err) {
    removeUploadSession(sessionKey);
    report(file.size, 'failed', err?.response?.data?.detail || err?.message || 'सर्भरमा प्रशोधन असफल भयो');
    throw err;
  } finally {
    stopPhase2Monitor();
  }
}

// ---- Helper: Trigger Browser Blob File Download ----
export const triggerFileDownload = (response, defaultFilename = 'download') => {
  if (!response || !response.data) return;
  const blob = new Blob([response.data], {
    type: response.headers?.['content-type'] || 'application/octet-stream',
  });
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;

  let filename = defaultFilename;
  const disposition = response.headers?.['content-disposition'];
  if (disposition && disposition.includes('filename=')) {
    const match = disposition.match(/filename="?([^";]+)"?/);
    if (match && match[1]) filename = match[1].trim();
  }
  link.setAttribute('download', filename);
  document.body.appendChild(link);
  link.click();
  link.parentNode.removeChild(link);
  window.URL.revokeObjectURL(url);
};

// ---- Real-Time Tracking API ----
export const trackingAPI = {
  ping: (data) => api.post('/tracking/ping', data),
  setStatus: (data) => api.post('/tracking/status', data),
  sendBeaconStatus: (statusData) => {
    if (typeof window === 'undefined') return;
    const token = localStorage.getItem('kmc_access_token');
    const baseUrl = getApiBaseUrl();
    const url = `${baseUrl}/tracking/status`;
    const payload = JSON.stringify(statusData);

    // 1. Try fetch with keepalive: true (keeps request alive during unload and supports headers)
    try {
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: payload,
        keepalive: true,
      }).catch(() => {});
    } catch (e) {
      // 2. Fallback to navigator.sendBeacon
      try {
        if (navigator.sendBeacon) {
          const blob = new Blob([payload], { type: 'application/json' });
          const beaconUrl = token ? `${url}?token=${encodeURIComponent(token)}` : url;
          navigator.sendBeacon(beaconUrl, blob);
        }
      } catch (err) {}
    }
  },
  getCollectors: (projectId = null, onlineOnly = false) => {
    const params = {};
    if (projectId) params.project_id = projectId;
    if (onlineOnly) params.online_only = true;
    return api.get('/tracking/collectors', { params });
  },
  getCollectorsGeoJSON: (projectId = null) => {
    const params = {};
    if (projectId) params.project_id = projectId;
    return api.get('/tracking/collectors/geojson', { params });
  },
  getHistory: (userId, limit = 200) =>
    api.get(`/tracking/collectors/${userId}/history`, { params: { limit } }),
  getAdminEvents: (params = {}) => api.get('/tracking/admin/logs/events', { params }),
  getAdminRoutes: (params = {}) => api.get('/tracking/admin/logs/collector-routes', { params }),
  downloadAdminLogs: () =>
    api.get('/tracking/admin/logs/download', {
      responseType: 'blob',
    }),
};

// ---- GeoPortal API ----
export const geoportalAPI = {
  getCatalog: () => api.get('/geoportal/catalog'),
  updateLayerConfig: (layerId, data) => api.put(`/geoportal/layers/${layerId}/config`, data),
  updateMBTilesConfig: (mbtilesId, data) => api.put(`/geoportal/mbtiles/${mbtilesId}/config`, data),
};

// ---- GIS Analytics & Infographics API ----
export const analyticsAPI = {
  getLayerAnalytics: (layerId, bbox = null, ward = null) => {
    const params = {};
    if (bbox) params.bbox = bbox;
    if (ward) params.ward = ward;
    return api.get(`/analytics/layer/${layerId}`, { params });
  },
};

// ---- House Numbering API ----
export const houseNumberingAPI = {
  getStats: () => api.get('/house-numbering/stats'),
  listNumbers: (params = {}) => api.get('/house-numbering/numbers', { params }),
  generateNumbers: (data) => api.post('/house-numbering/generate', data),
  updateNumber: (id, data) => api.put(`/house-numbering/numbers/${id}`, data),
  deleteNumber: (id) => api.delete(`/house-numbering/numbers/${id}`),
  exportRegistry: (format = 'csv', params = {}) =>
    api.get('/house-numbering/export', {
      params: { format, ...params },
      responseType: format === 'csv' ? 'blob' : 'json',
    }),
};

// ---- Advanced Questionnaire API ----
export const questionnairesAPI = {
  list: (projectId) => api.get(`/projects/${projectId}/questionnaires`),
  listByProject: (projectId) => api.get(`/projects/${projectId}/questionnaires`),
  listGlobal: () => api.get('/questionnaires'),
  createGlobal: (data) => api.post('/questionnaires', data),
  getActive: (projectId) => api.get(`/projects/${projectId}/questionnaires/active`),
  get: (id) => api.get(`/questionnaires/${id}`),
  getById: (id) => api.get(`/questionnaires/${id}`),
  createDraft: (projectId, data) => api.post(`/projects/${projectId}/questionnaires`, data),
  updateDraft: (id, data) => api.put(`/questionnaires/${id}`, data),
  validateSchema: (id) => api.post(`/questionnaires/${id}/validate`),
  publish: (id, data = {}) => api.post(`/questionnaires/${id}/publish`, data),
  duplicate: (id) => api.post(`/questionnaires/${id}/duplicate`),
};

// ---- Field Records API ----
const recordProjectPrefix = (projectId) => {
  const value = projectId === null || projectId === undefined ? '' : String(projectId).trim();
  return !value || value === 'null' || value === 'undefined' || value === '0'
    ? '/records'
    : `/projects/${value}/records`;
};

export const recordsAPI = {
  saveDraft: (projectId, data) => api.post(`${recordProjectPrefix(projectId)}/draft`, data),
  submit: (projectId, data) => api.post(`${recordProjectPrefix(projectId)}/submit`, data),
  listMyRecords: (projectId, status = null) => {
    const params = {};
    if (status) params.status_filter = status;
    return api.get(`/projects/${projectId}/records/my`, { params });
  },
  listAllRecords: (projectId, params = {}) => api.get(`/projects/${projectId}/records`, { params }),
  getById: (id) => api.get(`/records/${id}`),
  review: (id, data) => api.put(`/records/${id}/review`, data),
  exportGeoJSON: (projectId, status = null) => {
    const params = {};
    if (status) params.status_filter = status;
    return api.get(`/projects/${projectId}/records/export`, { params });
  },
};

// ---- Docker Swarm Secrets & Security Posture API ----
export const systemAPI = {
  purgeRecycleBin: () => api.post('/system/recycle-bin/purge'),
  getSwarmSecrets: () => api.get('/system/swarm-secrets'),
  getGeoportalState: () => api.get('/system/geoportal'),
  setGeoportalEnabled: (enabled, reason = '') =>
    api.put('/system/geoportal', { enabled, reason }),
  getLandingPageState: () => api.get('/system/landing-page'),
  setLandingPageEnabled: (enabled) =>
    api.put('/system/landing-page', { enabled }),
  getPlatformSettings: () => api.get('/system/platform-settings'),
  setPlatformSettings: (settings) =>
    api.put('/system/platform-settings', settings),
  getStorageUsage: () => api.get('/system/storage'),
  getStorageFiles: () => api.get('/system/storage/files'),
  deleteStorageFile: (root, path) =>
    api.delete('/system/storage/file', { params: { root, path } }),
  purgeAllStorage: (confirm) => api.post('/system/storage/purge', { confirm }),
};
