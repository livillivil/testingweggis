import {
  generateSpatialGrid,
  splitPolygonGeometry,
  mergeGeometriesWithMode
} from "../utils/spatialEngine";
const STORAGE_KEY = "kmc_enterprise_geodb_v6";
function generateSyntheticOrthophotoSvgDataUrl(title, subtitle) {
  return null;
}
async function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || ""));
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
function createInitialDb() {
  const users = [
    {
      id: 1,
      username: "KmcSuperUser2083",
      full_name: "",
      email: "admin@kmc.gov.np",
      phone: "",
      role: "SuperAdmin",
      is_active: true
    },
    {
      id: 2,
      username: "admin",
      full_name: "",
      email: "admin@kmc.gov.np",
      phone: "",
      role: "SuperAdmin",
      is_active: true
    }
  ];
  const modules = [
    { id: "field_data", name: "Field Data Collection", enabled: true },
    { id: "geoportal", name: "Public GeoPortal", enabled: true },
    { id: "house_numbering", name: "Metric House Numbering", enabled: true }
  ];
  return {
    users,
    projects: [],
    tasksByProject: {},
    projectAssignments: {},
    projectCollectors: {},
    vectorLayers: [],
    deletedVectorLayers: [],
    rasterLayers: [],
    deletedRasterLayers: [],
    featuresByLayer: {},
    auditEditsByLayer: {},
    featureLinks: [],
    collectorLocations: [],
    houseNumbers: [],
    questionnaires: [],
    records: [],
    modules
  };
}
const pendingUploads = /* @__PURE__ */ new Map();
function getDb() {
  if (typeof window === "undefined") return createInitialDb();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.vectorLayers)) {
        const base = createInitialDb();
        let mutated = false;
        const hydratedRasters = (parsed.rasterLayers || base.rasterLayers).map((r) => {
          let updated = { ...r };
          if (typeof updated.image_data_url === "string" && (updated.image_data_url.includes("data:image/svg+xml") || updated.image_data_url.includes("orthoGrid") || updated.image_data_url.includes("uavTint"))) {
            updated.image_data_url = null;
            mutated = true;
          }
          if (!updated.tile_url || updated.tile_url.startsWith("/tiles/data/")) {
            const stem = String(updated.filename || "drone_survey").replace(/\.[^/.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
            updated.tile_url = `/api/tiles/data/${stem}/{z}/{x}/{y}.png`;
            mutated = true;
          }
          return updated;
        });
        const mergedDb = {
          ...base,
          ...parsed,
          rasterLayers: hydratedRasters,
          featureLinks: Array.isArray(parsed.featureLinks) ? parsed.featureLinks : base.featureLinks
        };
        if (mutated) {
          saveDb(mergedDb);
        }
        return mergedDb;
      }
    }
  } catch (_) {
  }
  const initial = createInitialDb();
  saveDb(initial);
  return initial;
}
function saveDb(db) {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  } catch (err) {
    console.warn("[kmcBackendEngine] localStorage quota exceeded, preserving layer metadata safely without feature cache:", err);
    try {
      const shallowDb = {
        ...db,
        featuresByLayer: {},
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(shallowDb));
    } catch (e) {
      console.error("[kmcBackendEngine] Failed to save shallow db:", e);
    }
  }
}
function getCurrentUser(db) {
  if (typeof window !== "undefined") {
    try {
      const cached = localStorage.getItem("kmc_user");
      if (cached) {
        const u = JSON.parse(cached);
        const match = db.users.find((x) => x.username === u.username || x.id === u.id);
        if (match) return match;
        return u;
      }
    } catch (_) {
    }
  }
  return db.users[0];
}
function computeRingBbox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  ring.forEach(([lng, lat]) => {
    if (lng < minX) minX = lng;
    if (lng > maxX) maxX = lng;
    if (lat < minY) minY = lat;
    if (lat > maxY) maxY = lat;
  });
  if (!isFinite(minX)) return [85.326, 27.684, 85.344, 27.698];
  return [minX, minY, maxX, maxY];
}
function toHouseNumberFeatureCollection(houseNumbers, search = "") {
  const q = search.trim().toLowerCase();
  const filtered = q ? houseNumbers.filter(
    (h) => String(h.house_number || h.metric_house_no || "").toLowerCase().includes(q) || String(h.road_name || "").toLowerCase().includes(q) || String(h.owner_name || "").toLowerCase().includes(q)
  ) : houseNumbers;
  return {
    type: "FeatureCollection",
    features: filtered.map((h) => ({
      type: "Feature",
      id: h.id,
      geometry: {
        type: "Point",
        coordinates: [Number(h.longitude || 85.331), Number(h.latitude || 27.689)]
      },
      properties: {
        id: h.id,
        house_number: h.house_number || h.metric_house_no,
        metric_house_no: h.metric_house_no || h.house_number,
        building_code: h.building_code,
        owner_name: h.owner_name,
        road_name: h.road_name,
        ward: String(h.ward || h.ward_no || "10"),
        ward_no: Number(h.ward_no || h.ward || 10),
        side: String(h.side || "RIGHT").toUpperCase().includes("LEFT") || String(h.side || "").toUpperCase().includes("ODD") ? "LEFT" : "RIGHT",
        metric_distance: h.metric_distance ?? h.chainage_m ?? h.distance_m ?? 100,
        chainage_m: h.chainage_m ?? h.metric_distance ?? h.distance_m ?? 100,
        status: h.status || (h.qr_verified ? "VERIFIED" : "ASSIGNED"),
        qr_verified: Boolean(h.qr_verified || h.status === "VERIFIED")
      }
    }))
  };
}
function buildResponse(config, data, status = 200, headers = {}) {
  return {
    data,
    status,
    statusText: status === 200 ? "OK" : "Error",
    headers: { "content-type": "application/json", ...headers },
    config
  };
}
async function kmcMockAdapter(config) {
  const db = getDb();
  const method = (config.method || "get").toLowerCase();
  const rawUrl = (config.url || "").replace(/^https?:\/\/[^/]+/, "").replace(/^\/api/, "");
  const [pathname, queryString] = rawUrl.split("?");
  const params = new URLSearchParams(queryString || "");
  if (config.params) {
    Object.entries(config.params).forEach(([k, v]) => {
      if (v !== void 0 && v !== null) params.set(k, String(v));
    });
  }
  let body = {};
  if (config.data) {
    if (typeof config.data === "string") {
      try {
        body = JSON.parse(config.data);
      } catch (_) {
        body = {};
      }
    } else {
      body = config.data;
    }
  }
  if (pathname === "/geo/access-check" || pathname === "/geo/verify") {
    return buildResponse(config, {
      allowed: true,
      country_code: "NP",
      country_name: "Nepal",
      city: "Kathmandu",
      asn: "AS23752 Nepal Telecommunications Corporation",
      geo_pass: "verified_nepal_kmc_pass"
    });
  }
  if (pathname === "/auth/login" && method === "post") {
    const uname = String(body.username || "admin").trim().toLowerCase();
    const matched = db.users.find((u) => u.username.toLowerCase() === uname || u.role.toLowerCase() === uname) || db.users[0];
    const token = `kmc_jwt_${matched.username}_${Date.now()}`;
    if (typeof window !== "undefined") {
      localStorage.setItem("kmc_access_token", token);
      localStorage.setItem("kmc_user", JSON.stringify(matched));
    }
    return buildResponse(config, {
      access_token: token,
      refresh_token: `refresh_${token}`,
      token_type: "bearer",
      user_id: matched.id,
      username: matched.username,
      role: matched.role,
      full_name: matched.full_name
    });
  }
  if (pathname === "/auth/me") {
    const user = getCurrentUser(db);
    return buildResponse(config, user);
  }
  if (pathname === "/geoportal/landing-stats") {
    const totalFeatures = Object.values(db.featuresByLayer).reduce((acc, arr) => acc + arr.length, 0);
    const catMap = /* @__PURE__ */ new Map();
    db.vectorLayers.forEach((l) => {
      const c = l.category || "General";
      catMap.set(c, (catMap.get(c) || 0) + 1);
    });
    return buildResponse(config, {
      vector_layers: db.vectorLayers.length,
      total_features: totalFeatures,
      raster_packages: db.rasterLayers.length,
      wards_covered: 32,
      categories: Array.from(catMap.entries()).map(([name, layers]) => ({ name, layers }))
    });
  }
  if (pathname === "/geoportal/catalog") {
    const user = getCurrentUser(db);
    const isAdmin = user?.role === "GisAdmin" || user?.role === "SuperAdmin";
    const catMap = /* @__PURE__ */ new Map();
    db.vectorLayers.forEach((l) => {
      const cat = l.category || "\u092D\u0942-\u0938\u094D\u0925\u093E\u0928\u093F\u0915 \u0924\u0939\u0939\u0930\u0942 (Spatial Layers)";
      if (!catMap.has(cat)) catMap.set(cat, []);
      const feats = db.featuresByLayer[l.id] || [];
      catMap.get(cat).push({
        ...l,
        type: "vector",
        feature_count: feats.length,
        features: { type: "FeatureCollection", features: feats }
      });
    });
    db.rasterLayers.forEach((r) => {
      const cat = r.category || "\u0921\u094D\u0930\u094B\u0928 \u0924\u0925\u093E \u0905\u0930\u094D\u0925\u094B\u092B\u094B\u091F\u094B (UAV Imagery)";
      if (!catMap.has(cat)) catMap.set(cat, []);
      catMap.get(cat).push({
        ...r,
        type: "raster"
      });
    });
    return buildResponse(config, {
      municipality: "\u0915\u093E\u0920\u092E\u093E\u0921\u094C\u0901 \u092E\u0939\u093E\u0928\u0917\u0930\u092A\u093E\u0932\u093F\u0915\u093E (Kathmandu Metropolitan City)",
      is_admin: isAdmin,
      total_vector_layers: db.vectorLayers.length,
      total_raster_packages: db.rasterLayers.length,
      categories: Array.from(catMap.entries()).map(([name, layers]) => ({
        id: name,
        name,
        layers
      }))
    });
  }
  const layerCfgMatch = pathname.match(/^\/geoportal\/layers\/(\d+)\/config$/);
  if (layerCfgMatch && method === "put") {
    const lid = Number(layerCfgMatch[1]);
    db.vectorLayers = db.vectorLayers.map(
      (l) => l.id === lid ? {
        ...l,
        published: body.published_in_geoportal ?? l.published,
        default_visible: body.default_visible_in_geoportal ?? l.default_visible,
        opacity: body.opacity ?? l.opacity,
        role_permissions: body.role_permissions ?? l.role_permissions,
        access_level: body.role_permissions?.access_level ?? l.access_level,
        field_permissions: body.field_permissions ?? l.field_permissions,
        dashboard_config: body.dashboard_config ?? l.dashboard_config
      } : l
    );
    saveDb(db);
    return buildResponse(config, { status: "updated" });
  }
  const geoportalExportMatch = pathname.match(/^\/geoportal\/export\/(\d+)$/);
  if (geoportalExportMatch) {
    const lid = Number(geoportalExportMatch[1]);
    const feats = db.featuresByLayer[lid] || [];
    const fc = { type: "FeatureCollection", features: feats };
    return buildResponse(config, fc);
  }
  const analyticsMatch = pathname.match(/^\/analytics\/layer\/(\d+)$/);
  if (analyticsMatch) {
    const lid = Number(analyticsMatch[1]);
    const layer = db.vectorLayers.find((l) => l.id === lid) || db.vectorLayers[0];
    const feats = db.featuresByLayer[layer.id] || [];
    const useCounts = {};
    let totalFloors = 0;
    let totalArea = 0;
    feats.forEach((f) => {
      const p = f.properties || {};
      const cat = p.use_type || p.surface_type || p.category || p.owner_type || "\u0905\u0928\u094D\u092F (Other)";
      useCounts[cat] = (useCounts[cat] || 0) + 1;
      if (typeof p.floors === "number") totalFloors += p.floors;
      if (typeof p.plinth_area_sqm === "number") totalArea += p.plinth_area_sqm;
      if (typeof p.area_sq_m === "number") totalArea += p.area_sq_m;
    });
    return buildResponse(config, {
      layer_id: layer.id,
      layer_name: layer.name,
      geometry_type: layer.geometry_type,
      kpi_cards: [
        { id: "total_features", title: "\u091C\u092E\u094D\u092E\u093E \u0938\u0902\u0930\u091A\u0928\u093E\u0939\u0930\u0942 (Total Features)", value: feats.length, unit: "\u0907\u0915\u093E\u0908", secondary: "PostGIS Verified" },
        { id: "wards_active", title: "\u0938\u0915\u094D\u0930\u093F\u092F \u0935\u0921\u093E\u0939\u0930\u0942 (Active Wards)", value: 32, unit: "\u0935\u0921\u093E", secondary: "\u0915\u093E\u0920\u092E\u093E\u0921\u094C\u0901 \u092E\u0939\u093E\u0928\u0917\u0930\u092A\u093E\u0932\u093F\u0915\u093E" },
        { id: "total_area", title: "\u0915\u0941\u0932 \u0915\u094D\u0937\u0947\u0924\u094D\u0930\u092B\u0932 (Total Plinth Area)", value: Math.round(totalArea || feats.length * 380), unit: "sq.m", secondary: "EPSG:3857 Metric" },
        { id: "qa_rate", title: "\u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923 \u0926\u0930 (Validated QA)", value: "96.4%", unit: "", secondary: "HOT/FMTM QA Pass" }
      ],
      charts: {
        categories: [
          {
            field: "use_type",
            title: "\u092A\u094D\u0930\u0915\u093E\u0930 / \u092A\u094D\u0930\u092F\u094B\u0917 \u0905\u0928\u0941\u0938\u093E\u0930 \u0935\u0930\u094D\u0917\u0940\u0915\u0930\u0923 (Category Breakdown)",
            data: Object.entries(useCounts).map(([name, value]) => ({ name, value }))
          }
        ],
        numeric_summaries: [
          {
            field: "plinth_area_sqm",
            title: "\u092D\u094C\u0917\u094B\u0932\u093F\u0915 \u0915\u094D\u0937\u0947\u0924\u094D\u0930\u092B\u0932 \u0924\u0925\u093E \u0924\u0932\u094D\u0932\u093E (Spatial Metrics)",
            avg: feats.length ? Math.round((totalArea || 1850) / feats.length) : 0,
            sum: Math.round(totalArea || 1850),
            min: 120,
            max: 1420
          }
        ]
      }
    });
  }
  if (pathname === "/users") {
    if (method === "get") return buildResponse(config, db.users);
    if (method === "post") {
      const newUser = {
        id: Date.now(),
        username: body.username || `user_${Date.now()}`,
        full_name: body.full_name || body.username,
        email: body.email || `${body.username}@kathmandu.gov.np`,
        role: body.role || "DataCollector",
        is_active: true
      };
      db.users.push(newUser);
      saveDb(db);
      return buildResponse(config, newUser);
    }
  }
  const userDetailMatch = pathname.match(/^\/users\/(\d+)$/);
  if (userDetailMatch) {
    const uid = Number(userDetailMatch[1]);
    if (method === "get") {
      return buildResponse(config, db.users.find((u) => u.id === uid) || db.users[0]);
    }
    if (method === "put") {
      db.users = db.users.map((u) => u.id === uid ? { ...u, ...body } : u);
      saveDb(db);
      return buildResponse(config, db.users.find((u) => u.id === uid));
    }
    if (method === "delete") {
      db.users = db.users.filter((u) => u.id !== uid);
      saveDb(db);
      return buildResponse(config, { status: "deleted" });
    }
  }
  const userProjectsMatch = pathname.match(/^\/users\/(\d+)\/projects$/);
  if (userProjectsMatch && method === "get") {
    const uid = Number(userProjectsMatch[1]);
    const assigned = db.projects.filter((p) => (db.projectCollectors[p.id] || []).includes(uid));
    return buildResponse(config, assigned.length > 0 ? assigned : db.projects);
  }
  if (pathname === "/projects") {
    if (method === "get") return buildResponse(config, db.projects);
    if (method === "post") {
      const newProj = {
        id: Date.now(),
        name: body.name || "\u0928\u092F\u093E\u0901 \u092E\u0939\u093E\u0928\u0917\u0930 \u0938\u0930\u094D\u0935\u0947\u0915\u094D\u0937\u0923 \u092A\u0930\u093F\u092F\u094B\u091C\u0928\u093E",
        description: body.description || "",
        status: "ACTIVE",
        project_mode: body.project_mode || "STANDARD",
        geometry_config: body.geometry_config || { type: "Point" },
        task_count: 0,
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      db.projects.unshift(newProj);
      db.tasksByProject[newProj.id] = [];
      db.projectAssignments[newProj.id] = { assigned_layer_ids: [1, 2], assigned_mbtiles_ids: [101] };
      db.projectCollectors[newProj.id] = [4, 5];
      saveDb(db);
      return buildResponse(config, newProj);
    }
  }
  const projAssignMatch = pathname.match(/^\/projects\/(\d+)\/assignments$/);
  if (projAssignMatch && method === "get") {
    const pid = Number(projAssignMatch[1]);
    return buildResponse(config, db.projectAssignments[pid] || { assigned_layer_ids: [1, 2], assigned_mbtiles_ids: [101] });
  }
  const assignLayerMatch = pathname.match(/^\/projects\/(\d+)\/assign-layer$/);
  if (assignLayerMatch && method === "post") {
    const pid = Number(assignLayerMatch[1]);
    const lid = Number(body.layer_id);
    if (!db.projectAssignments[pid]) db.projectAssignments[pid] = { assigned_layer_ids: [], assigned_mbtiles_ids: [] };
    if (!db.projectAssignments[pid].assigned_layer_ids.includes(lid)) {
      db.projectAssignments[pid].assigned_layer_ids.push(lid);
    }
    saveDb(db);
    return buildResponse(config, db.projectAssignments[pid]);
  }
  const unassignLayerMatch = pathname.match(/^\/projects\/(\d+)\/unassign-layer\/(\d+)$/);
  if (unassignLayerMatch && method === "delete") {
    const pid = Number(unassignLayerMatch[1]);
    const lid = Number(unassignLayerMatch[2]);
    if (db.projectAssignments[pid]) {
      db.projectAssignments[pid].assigned_layer_ids = db.projectAssignments[pid].assigned_layer_ids.filter((id) => id !== lid);
    }
    saveDb(db);
    return buildResponse(config, { status: "unassigned" });
  }
  const assignTilesMatch = pathname.match(/^\/projects\/(\d+)\/assign-tiles$/);
  if (assignTilesMatch && method === "post") {
    const pid = Number(assignTilesMatch[1]);
    const tid = Number(body.mbtiles_id);
    if (!db.projectAssignments[pid]) db.projectAssignments[pid] = { assigned_layer_ids: [], assigned_mbtiles_ids: [] };
    if (!db.projectAssignments[pid].assigned_mbtiles_ids.includes(tid)) {
      db.projectAssignments[pid].assigned_mbtiles_ids.push(tid);
    }
    saveDb(db);
    return buildResponse(config, db.projectAssignments[pid]);
  }
  const unassignTilesMatch = pathname.match(/^\/projects\/(\d+)\/unassign-tiles\/(\d+)$/);
  if (unassignTilesMatch && method === "delete") {
    const pid = Number(unassignTilesMatch[1]);
    const tid = Number(unassignTilesMatch[2]);
    if (db.projectAssignments[pid]) {
      db.projectAssignments[pid].assigned_mbtiles_ids = db.projectAssignments[pid].assigned_mbtiles_ids.filter((id) => id !== tid);
    }
    saveDb(db);
    return buildResponse(config, { status: "unassigned" });
  }
  const projCollectorsMatch = pathname.match(/^\/projects\/(\d+)\/collectors$/);
  if (projCollectorsMatch) {
    const pid = Number(projCollectorsMatch[1]);
    if (method === "get") {
      const cIds = db.projectCollectors[pid] || [4, 5];
      const tasks = db.tasksByProject[pid] || [];
      const list = cIds.map((uid) => {
        const u = db.users.find((x) => x.id === uid);
        if (!u) return null;
        return {
          user_id: u.id,
          id: u.id,
          username: u.username,
          full_name: u.full_name,
          email: u.email,
          role: u.role,
          assigned_tasks_count: tasks.filter((t) => Number(t.assigned_to) === Number(u.id)).length
        };
      }).filter(Boolean);
      return buildResponse(config, list);
    }
    if (method === "post") {
      const incoming = (body.user_ids || []).map(Number);
      const curr = new Set(db.projectCollectors[pid] || []);
      incoming.forEach((id) => curr.add(id));
      db.projectCollectors[pid] = Array.from(curr);
      saveDb(db);
      return buildResponse(config, { status: "assigned", user_ids: db.projectCollectors[pid] });
    }
  }
  const unassignCollectorMatch = pathname.match(/^\/projects\/(\d+)\/collectors\/(\d+)$/);
  if (unassignCollectorMatch && method === "delete") {
    const pid = Number(unassignCollectorMatch[1]);
    const uid = Number(unassignCollectorMatch[2]);
    db.projectCollectors[pid] = (db.projectCollectors[pid] || []).filter((id) => id !== uid);
    saveDb(db);
    return buildResponse(config, { status: "unassigned" });
  }
  const uploadBoundaryMatch = pathname.match(/^\/projects\/(\d+)\/boundary\/upload$/);
  if (uploadBoundaryMatch && method === "post") {
    const pid = Number(uploadBoundaryMatch[1]);
    const aoiRing = [
      [85.326, 27.684],
      [85.344, 27.684],
      [85.344, 27.698],
      [85.326, 27.698],
      [85.326, 27.684]
    ];
    const cells = generateSpatialGrid({
      aoiRing,
      gridShape: "hexagonal",
      cellSizeMeters: 250,
      projectId: String(pid),
      wardNo: 10
    });
    const newTasks = cells.slice(0, 8).map((cell, idx) => ({
      id: pid * 1e3 + idx + 1,
      project_id: pid,
      task_number: idx + 1,
      grid_index: idx + 1,
      grid_code: `W10-BND-${String(idx + 1).padStart(3, "0")}`,
      status: "READY",
      assigned_to: null,
      assigned_username: null,
      assigned_full_name: null,
      locked_by: null,
      validated_by: null,
      feature_count: 0,
      bbox: computeRingBbox(cell.coordinates),
      geometry: {
        type: "Polygon",
        coordinates: [cell.coordinates]
      }
    }));
    db.tasksByProject[pid] = newTasks;
    db.projects = db.projects.map((p) => p.id === pid ? { ...p, task_count: newTasks.length } : p);
    saveDb(db);
    return buildResponse(config, { tasks_created: newTasks.length, task_count: newTasks.length });
  }
  const projDetailMatch = pathname.match(/^\/projects\/(\d+)$/);
  if (projDetailMatch) {
    const pid = Number(projDetailMatch[1]);
    if (method === "get") {
      const proj = db.projects.find((p) => p.id === pid) || db.projects[0];
      return buildResponse(config, proj);
    }
    if (method === "put") {
      db.projects = db.projects.map((p) => p.id === pid ? { ...p, ...body } : p);
      saveDb(db);
      return buildResponse(config, db.projects.find((p) => p.id === pid));
    }
    if (method === "delete") {
      db.projects = db.projects.filter((p) => p.id !== pid);
      delete db.tasksByProject[pid];
      delete db.projectAssignments[pid];
      delete db.projectCollectors[pid];
      db.vectorLayers.forEach((l) => {
        if (l.project_id === pid) l.project_id = null;
      });
      db.rasterLayers.forEach((r) => {
        if (r.project_id === pid) r.project_id = null;
      });
      saveDb(db);
      return buildResponse(config, { status: "deleted", id: pid });
    }
  }
  const projTasksMatch = pathname.match(/^\/projects\/(\d+)\/tasks$/);
  if (projTasksMatch && method === "get") {
    const pid = Number(projTasksMatch[1]);
    const statusFilter = params.get("status_filter");
    const collectorFilter = params.get("collector_filter");
    let tasks = db.tasksByProject[pid] || db.tasksByProject[1] || [];
    if (statusFilter && statusFilter !== "ALL") {
      tasks = tasks.filter((t) => t.status === statusFilter);
    }
    if (collectorFilter && collectorFilter !== "ALL") {
      tasks = tasks.filter((t) => String(t.assigned_to) === String(collectorFilter));
    }
    const features = tasks.map((t, i) => ({
      type: "Feature",
      id: t.id,
      geometry: t.geometry,
      properties: {
        id: t.id,
        task_id: t.id,
        project_id: t.project_id,
        task_number: t.task_number || i + 1,
        grid_index: t.grid_index || t.task_number || i + 1,
        grid_code: t.grid_code,
        name: t.grid_code ? `\u0915\u093E\u0930\u094D\u092F\u0915\u094D\u0937\u0947\u0924\u094D\u0930 #${t.grid_index || t.task_number || i + 1} (${t.grid_code})` : `\u0915\u093E\u0930\u094D\u092F\u0915\u094D\u0937\u0947\u0924\u094D\u0930 #${t.grid_index || t.task_number || i + 1}`,
        status: t.status,
        assigned_to: t.assigned_to,
        assigned_username: t.assigned_username,
        assigned_full_name: t.assigned_full_name,
        assigned_to_name: t.assigned_full_name || t.assigned_username || null,
        locked_by: t.locked_by,
        validated_by: t.validated_by,
        invalidation_comment: t.invalidation_comment,
        feature_count: t.feature_count || 0,
        bbox: t.bbox || (t.geometry?.coordinates?.[0] ? computeRingBbox(t.geometry.coordinates[0]) : [85.328, 27.686, 85.333, 27.69])
      }
    }));
    return buildResponse(config, {
      type: "FeatureCollection",
      features
    });
  }
  const taskAssignMatch = pathname.match(/^\/projects\/(\d+)\/tasks\/assign$/);
  if (taskAssignMatch && method === "post") {
    const pid = Number(taskAssignMatch[1]);
    const taskIds = (body.task_ids || []).map(Number);
    const uid = Number(body.user_id);
    const userObj = db.users.find((u) => u.id === uid);
    db.tasksByProject[pid] = (db.tasksByProject[pid] || []).map(
      (t) => taskIds.includes(Number(t.id)) ? {
        ...t,
        assigned_to: userObj ? userObj.id : null,
        assigned_username: userObj ? userObj.username : null,
        assigned_full_name: userObj ? userObj.full_name : null
      } : t
    );
    saveDb(db);
    return buildResponse(config, { assigned_count: taskIds.length });
  }
  const taskAutoDistMatch = pathname.match(/^\/projects\/(\d+)\/tasks\/auto-distribute$/);
  if (taskAutoDistMatch && method === "post") {
    const pid = Number(taskAutoDistMatch[1]);
    const collectors = db.users.filter((u) => u.role === "DataCollector");
    const tasks = db.tasksByProject[pid] || [];
    db.tasksByProject[pid] = tasks.map((t, idx) => {
      const col = collectors[idx % collectors.length] || db.users[3];
      return {
        ...t,
        assigned_to: col.id,
        assigned_username: col.username,
        assigned_full_name: col.full_name
      };
    });
    saveDb(db);
    return buildResponse(config, {
      total_tasks_distributed: tasks.length,
      collectors_count: collectors.length
    });
  }
  const taskResetMatch = pathname.match(/^\/projects\/(\d+)\/tasks\/reset$/);
  if (taskResetMatch && method === "delete") {
    const pid = Number(taskResetMatch[1]);
    db.tasksByProject[pid] = [];
    db.projects = db.projects.map((p) => p.id === pid ? { ...p, task_count: 0 } : p);
    saveDb(db);
    return buildResponse(config, { status: "reset" });
  }
  const genGridMatch = pathname.match(/^\/projects\/(\d+)\/generate-grid$/);
  if (genGridMatch && method === "post") {
    const pid = Number(genGridMatch[1]);
    const modeMap = {
      RECTANGULAR: "rectangular",
      SQUARE: "rectangular",
      TRIANGULAR: "triangular",
      TRIANGLE: "triangular",
      CIRCULAR: "circular",
      CIRCLE: "circular",
      HEXAGONAL: "hexagonal",
      HEXAGON: "hexagonal",
      VORONOI: "random",
      RANDOM: "random",
      STRAIGHT_SKELETON: "straight_skeleton"
    };
    const rawShape = String(body.grid_shape || body.grid_type || "HEXAGONAL").toUpperCase();
    const gridShape = modeMap[rawShape] || "hexagonal";
    const cellSizeMeters = Number(body.cell_size_meters || body.grid_size_m || body.grid_size || 250);
    const aoiRing = body.boundary_geojson?.coordinates?.[0] || body.boundary_geojson?.geometry?.coordinates?.[0] || [
      [85.326, 27.684],
      [85.344, 27.684],
      [85.344, 27.698],
      [85.326, 27.698],
      [85.326, 27.684]
    ];
    const cells = generateSpatialGrid({
      aoiRing,
      gridShape,
      cellSizeMeters: Math.max(120, Math.min(800, cellSizeMeters)),
      projectId: String(pid),
      wardNo: 10
    });
    const newTasks = cells.slice(0, 24).map((cell, idx) => ({
      id: pid * 1e3 + idx + 1,
      project_id: pid,
      task_number: idx + 1,
      grid_index: idx + 1,
      grid_code: `W10-${rawShape.slice(0, 3)}-${String(idx + 1).padStart(3, "0")}`,
      status: "READY",
      assigned_to: null,
      assigned_username: null,
      assigned_full_name: null,
      locked_by: null,
      validated_by: null,
      feature_count: 0,
      bbox: computeRingBbox(cell.coordinates),
      geometry: {
        type: "Polygon",
        coordinates: [cell.coordinates]
      }
    }));
    db.tasksByProject[pid] = newTasks;
    db.projects = db.projects.map((p) => p.id === pid ? { ...p, task_count: newTasks.length } : p);
    saveDb(db);
    return buildResponse(config, {
      message: `${newTasks.length} \u0915\u093E\u0930\u094D\u092F \u0917\u094D\u0930\u093F\u0921\u0939\u0930\u0942 \u0938\u092B\u0932\u0924\u093E\u092A\u0942\u0930\u094D\u0935\u0915 \u0938\u093F\u0930\u094D\u091C\u0928\u093E \u0917\u0930\u093F\u092F\u094B`,
      tasks_created: newTasks.length,
      task_count: newTasks.length
    });
  }
  const taskActionMatch = pathname.match(/^\/tasks\/(\d+)\/(lock|unlock|submit|validate)$/);
  if (taskActionMatch && method === "post") {
    const tid = Number(taskActionMatch[1]);
    const act = taskActionMatch[2];
    const valAction = params.get("action");
    Object.keys(db.tasksByProject).forEach((pidStr) => {
      const pid = Number(pidStr);
      db.tasksByProject[pid] = (db.tasksByProject[pid] || []).map((t) => {
        if (t.id !== tid) return t;
        if (act === "lock") return { ...t, status: "LOCKED_FOR_MAPPING", locked_by: getCurrentUser(db).id };
        if (act === "unlock") return { ...t, status: "READY", locked_by: null };
        if (act === "submit") return { ...t, status: "MAPPED", locked_by: null };
        if (act === "validate") {
          return {
            ...t,
            status: valAction === "invalidate" || valAction === "INVALIDATED" ? "INVALIDATED" : "VALIDATED",
            validated_by: getCurrentUser(db).id
          };
        }
        return t;
      });
    });
    saveDb(db);
    return buildResponse(config, { status: "ok", task_id: tid, action: act });
  }
  if (pathname === "/layers/deleted" && method === "get") {
    return buildResponse(config, db.deletedVectorLayers || []);
  }
  if (pathname === "/layers" || pathname.match(/^\/projects\/\d+\/layers$/)) {
    if (method === "get") {
      const enriched = db.vectorLayers.map((l) => ({
        ...l,
        feature_count: (db.featuresByLayer[l.id] || []).length,
        bbox: l.bbox || l.bounds || [85.31, 27.682, 85.345, 27.702],
        features: {
          type: "FeatureCollection",
          features: db.featuresByLayer[l.id] || []
        }
      }));
      return buildResponse(config, enriched);
    }
    if (method === "post") {
      const user = getCurrentUser(db);
      const newLayer = {
        id: Date.now(),
        name: body.name || "\u0928\u092F\u093E\u0901 \u092D\u0947\u0915\u094D\u091F\u0930 \u0924\u0939",
        description: body.description || "",
        type: "vector",
        geometry_type: body.geometry_type || "Polygon",
        creation_geometry_types: body.creation_geometry_types || [body.geometry_type || "Polygon"],
        category: body.category || "\u092D\u0942-\u0938\u094D\u0925\u093E\u0928\u093F\u0915 \u0924\u0939\u0939\u0930\u0942 (Spatial Layers)",
        is_global: body.is_global !== false,
        project_id: body.project_id || null,
        allow_snapping: body.allow_snapping !== false,
        editable_by_collectors: body.editable_by_collectors !== false,
        published: true,
        default_visible: true,
        access_level: "public",
        opacity: 1,
        feature_count: 0,
        bounds: [85.31, 27.682, 85.345, 27.702],
        bbox: [85.31, 27.682, 85.345, 27.702],
        created_by_id: user.id,
        created_by_username: user.username,
        created_by_name: user.full_name,
        style: body.style || { strokeColor: "#0447AF", fillColor: "#0447AF", strokeWidth: 2.5, clickTolerance: 14 },
        fields_config: body.fields_config || []
      };
      db.vectorLayers.unshift(newLayer);
      db.featuresByLayer[newLayer.id] = [];
      saveDb(db);
      return buildResponse(config, newLayer);
    }
  }
  const layerRestoreMatch = pathname.match(/^\/layers\/(\d+)\/restore$/);
  if (layerRestoreMatch && method === "post") {
    const lid = Number(layerRestoreMatch[1]);
    const target = (db.deletedVectorLayers || []).find((l) => l.id === lid);
    if (target) {
      const { deleted_at, ...restored } = target;
      db.vectorLayers.push(restored);
      db.deletedVectorLayers = (db.deletedVectorLayers || []).filter((l) => l.id !== lid);
      saveDb(db);
    }
    return buildResponse(config, { status: "restored", id: lid });
  }
  const layerPermDeleteMatch = pathname.match(/^\/layers\/(\d+)\/permanent$/);
  if (layerPermDeleteMatch && method === "delete") {
    const lid = Number(layerPermDeleteMatch[1]);
    db.deletedVectorLayers = (db.deletedVectorLayers || []).filter((l) => l.id !== lid);
    delete db.featuresByLayer[lid];
    saveDb(db);
    return buildResponse(config, { status: "permanently_deleted", id: lid });
  }
  const layerFieldsMatch = pathname.match(/^\/layers\/(\d+)\/fields$/);
  if (layerFieldsMatch) {
    const lid = Number(layerFieldsMatch[1]);
    const layer = db.vectorLayers.find((l) => l.id === lid) || db.vectorLayers[0];
    if (method === "get") {
      const feats = db.featuresByLayer[lid] || [];
      const existingCfg = layer?.fields_config || [];
      const sampleProps = feats[0]?.properties || {};
      const detected = Object.keys(sampleProps).filter((k) => !k.startsWith("_") && k !== "Kmc_Editor").map((k) => {
        const found = existingCfg.find((f) => f.name === k);
        if (found) return found;
        return {
          name: k,
          label: k,
          type: typeof sampleProps[k] === "number" ? "number" : "text",
          required: false,
          is_unique: false,
          id_mode: "manual",
          visible_in_popup: true
        };
      });
      return buildResponse(config, {
        fields: existingCfg.length > 0 ? existingCfg : detected,
        fields_config: existingCfg.length > 0 ? existingCfg : detected,
        creation_geometry_types: layer?.creation_geometry_types || [layer?.geometry_type || "Polygon"],
        geometry_fields_config: layer?.geometry_fields_config || {}
      });
    }
    if (method === "put") {
      db.vectorLayers = db.vectorLayers.map(
        (l) => l.id === lid ? {
          ...l,
          fields_config: body.fields || body.fields_config || l.fields_config,
          creation_geometry_types: body.creation_geometry_types || l.creation_geometry_types,
          geometry_fields_config: body.geometry_fields_config || l.geometry_fields_config
        } : l
      );
      saveDb(db);
      return buildResponse(config, { status: "updated" });
    }
  }
  const layerNextIdMatch = pathname.match(/^\/layers\/(\d+)\/next-id$/);
  if (layerNextIdMatch && method === "get") {
    const lid = Number(layerNextIdMatch[1]);
    const layer = db.vectorLayers.find((l) => l.id === lid);
    const uniqueField = (layer?.fields_config || []).find((f) => f.is_unique);
    const prefix = uniqueField?.id_prefix || "KMC-";
    const seq = (db.featuresByLayer[lid]?.length || 0) + (uniqueField?.id_sequence || 1001);
    return buildResponse(config, {
      field_name: uniqueField?.name || "bldg_code",
      next_id: `${prefix}${String(seq).padStart(4, "0")}`
    });
  }
  const layerAuditMatch = pathname.match(/^\/layers\/(\d+)\/audit-edits$/);
  if (layerAuditMatch && method === "get") {
    const lid = Number(layerAuditMatch[1]);
    return buildResponse(config, {
      layer_id: lid,
      edits: db.auditEditsByLayer?.[lid] || []
    });
  }
  const layerLinkMatch = pathname.match(/^\/layers\/(\d+)\/link$/);
  if (layerLinkMatch && method === "post") {
    const sourceLayerId = Number(layerLinkMatch[1]);
    const targetLayerId = Number(body.target_layer_id || sourceLayerId);
    const sourceLayer = db.vectorLayers.find((l) => l.id === sourceLayerId) || db.vectorLayers[0];
    const targetLayer = db.vectorLayers.find((l) => l.id === targetLayerId) || sourceLayer;
    const targetAttr = body.target_attribute || "road_name";
    const outField = body.output_field_name || `linked_${targetAttr}`;
    const sourceFeats = db.featuresByLayer[sourceLayerId] || [];
    const targetFeats = db.featuresByLayer[targetLayerId] || [];
    const fallbackVal = targetFeats[0]?.properties?.[targetAttr] || targetLayer?.name || "KMC-LINK-01";
    if (!db.featureLinks) db.featureLinks = [];
    if (body.source_feature_id != null && body.target_feature_id != null) {
      const sFid = Number(body.source_feature_id);
      const tFid = Number(body.target_feature_id);
      const tFeat = targetFeats.find((f) => Number(f.id) === tFid);
      const val = tFeat?.properties?.[targetAttr] ?? `Feature #${tFid}`;
      db.featuresByLayer[sourceLayerId] = sourceFeats.map((f) => {
        if (Number(f.id) !== sFid) return f;
        return {
          ...f,
          properties: {
            ...f.properties,
            [outField]: val
          }
        };
      });
      const existingLink = db.featureLinks.find(
        (lnk) => Number(lnk.source_feature_id) === sFid && Number(lnk.target_feature_id) === tFid
      );
      if (!existingLink) {
        db.featureLinks.push({
          id: Date.now(),
          source_feature_id: sFid,
          source_layer_id: sourceLayerId,
          target_feature_id: tFid,
          target_layer_id: targetLayerId,
          relationship_type: body.link_method || "feature_to_feature",
          notes: `Linked via ${outField}`,
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        });
      }
      saveDb(db);
      return buildResponse(config, {
        source_layer_name: sourceLayer?.name || `Layer #${sourceLayerId}`,
        total_source_features: 1,
        target_layer_name: targetLayer?.name || `Layer #${targetLayerId}`,
        linked_attribute_name: outField,
        linked_count: 1,
        matched_percentage: 100
      });
    }
    db.featuresByLayer[sourceLayerId] = sourceFeats.map((f, idx) => {
      const candidateTargets = sourceLayerId === targetLayerId ? targetFeats.filter((tf) => Number(tf.id) !== Number(f.id)) : targetFeats;
      const targetFeat = candidateTargets[idx % Math.max(1, candidateTargets.length)] || targetFeats[0];
      const val = targetFeat?.properties?.[targetAttr] ?? fallbackVal;
      if (targetFeat) {
        const exists = db.featureLinks.some(
          (lnk) => Number(lnk.source_feature_id) === Number(f.id) && Number(lnk.target_feature_id) === Number(targetFeat.id)
        );
        if (!exists) {
          db.featureLinks.push({
            id: Date.now() + idx,
            source_feature_id: Number(f.id),
            source_layer_id: sourceLayerId,
            target_feature_id: Number(targetFeat.id),
            target_layer_id: targetLayerId,
            relationship_type: body.link_method || "spatial_join",
            notes: `${outField}: ${val}`,
            created_at: (/* @__PURE__ */ new Date()).toISOString()
          });
        }
      }
      return {
        ...f,
        properties: {
          ...f.properties,
          [outField]: val
        }
      };
    });
    saveDb(db);
    return buildResponse(config, {
      source_layer_name: sourceLayer?.name || `Layer #${sourceLayerId}`,
      total_source_features: sourceFeats.length,
      target_layer_name: targetLayer?.name || `Layer #${targetLayerId}`,
      linked_attribute_name: outField,
      linked_count: sourceFeats.length,
      matched_percentage: 100
    });
  }
  const layerDownloadMatch = pathname.match(/^\/layers\/(\d+)\/download$/);
  if (layerDownloadMatch && method === "get") {
    const lid = Number(layerDownloadMatch[1]);
    const feats = db.featuresByLayer[lid] || [];
    const fc = JSON.stringify({ type: "FeatureCollection", features: feats }, null, 2);
    return buildResponse(config, fc);
  }
  const layerExtentMatch = pathname.match(/^\/layers\/(\d+)\/extent$/);
  if (layerExtentMatch && method === "get") {
    const lid = Number(layerExtentMatch[1]);
    const layer = db.vectorLayers.find((l) => l.id === lid);
    return buildResponse(config, { bbox: layer?.bbox || layer?.bounds || [85.31, 27.682, 85.345, 27.702] });
  }
  const layerDetailMatch = pathname.match(/^\/layers\/(\d+)$/);
  if (layerDetailMatch) {
    const lid = Number(layerDetailMatch[1]);
    if (method === "get") {
      const layer = db.vectorLayers.find((l) => l.id === lid);
      return buildResponse(config, {
        ...layer || {},
        import_status: "complete",
        feature_count: (db.featuresByLayer[lid] || []).length
      });
    }
    if (method === "put") {
      const user = getCurrentUser(db);
      db.vectorLayers = db.vectorLayers.map(
        (l) => l.id === lid ? {
          ...l,
          ...body,
          updated_by_id: user.id,
          updated_by_username: user.username,
          updated_by_name: user.full_name
        } : l
      );
      saveDb(db);
      return buildResponse(config, db.vectorLayers.find((l) => l.id === lid));
    }
    if (method === "delete") {
      const target = db.vectorLayers.find((l) => l.id === lid);
      if (target) {
        db.deletedVectorLayers = [
          { ...target, deleted_at: (/* @__PURE__ */ new Date()).toISOString() },
          ...db.deletedVectorLayers || []
        ];
        db.vectorLayers = db.vectorLayers.filter((l) => l.id !== lid);
        saveDb(db);
      }
      return buildResponse(config, { status: "soft_deleted", id: lid });
    }
  }
  const layerFeatsMatch = pathname.match(/^\/layers\/(\d+)\/features$/);
  if (layerFeatsMatch && method === "get") {
    const lid = Number(layerFeatsMatch[1]);
    return buildResponse(config, {
      type: "FeatureCollection",
      features: db.featuresByLayer[lid] || []
    });
  }
  if (pathname === "/features" && method === "post") {
    const lid = Number(body.layer_id || 1);
    const newId = Date.now();
    const user = getCurrentUser(db);
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const newFeat = {
      type: "Feature",
      id: newId,
      geometry: body.geometry || body.geom || body.geom_geojson,
      properties: {
        ...body.properties || body.attributes || {},
        _id: newId,
        _created_by: user.id,
        _created_by_username: user.username,
        _created_by_name: user.full_name,
        _version: 1,
        _created_at: nowIso,
        _updated_at: nowIso,
        Kmc_Editor: user.username
      }
    };
    if (!db.featuresByLayer[lid]) db.featuresByLayer[lid] = [];
    db.featuresByLayer[lid].push(newFeat);
    saveDb(db);
    return buildResponse(config, newFeat);
  }
  const findFeatureAcrossLayers = (featureId) => {
    for (const lidStr of Object.keys(db.featuresByLayer)) {
      const lid = Number(lidStr);
      const found = (db.featuresByLayer[lid] || []).find((f) => Number(f.id) === featureId);
      if (found) {
        const layer = db.vectorLayers.find((l) => Number(l.id) === lid);
        return { feature: found, layerId: lid, layerName: layer?.name || `Layer #${lid}` };
      }
    }
    return null;
  };
  const featLinkedMatch = pathname.match(/^\/features\/(\d+)\/linked$/);
  if (featLinkedMatch && method === "get") {
    const fid = Number(featLinkedMatch[1]);
    const allLinks = db.featureLinks || [];
    const related = allLinks.filter(
      (lnk) => Number(lnk.source_feature_id) === fid || Number(lnk.target_feature_id) === fid
    );
    const resolved = related.map((lnk) => {
      const isSource = Number(lnk.source_feature_id) === fid;
      const otherFid = isSource ? Number(lnk.target_feature_id) : Number(lnk.source_feature_id);
      const found = findFeatureAcrossLayers(otherFid);
      if (!found) return null;
      return {
        link_id: lnk.id,
        direction: isSource ? "outgoing" : "incoming",
        relationship_type: lnk.relationship_type || "spatial_link",
        notes: lnk.notes || "",
        created_at: lnk.created_at,
        feature_id: found.feature.id,
        layer_id: found.layerId,
        layer_name: found.layerName,
        geometry_type: found.feature.geometry?.type || "Geometry",
        geometry: found.feature.geometry,
        properties: found.feature.properties || {}
      };
    }).filter(Boolean);
    return buildResponse(config, { linked_features: resolved });
  }
  const featLinkActionMatch = pathname.match(/^\/features\/(\d+)\/link$/);
  if (featLinkActionMatch && (method === "post" || method === "delete")) {
    const sourceFid = Number(featLinkActionMatch[1]);
    if (!db.featureLinks) db.featureLinks = [];
    if (method === "post") {
      const targetFid = Number(body.target_feature_id);
      const sourceFound = findFeatureAcrossLayers(sourceFid);
      const targetFound = findFeatureAcrossLayers(targetFid);
      if (!sourceFound || !targetFound) {
        return buildResponse(config, { detail: "Source or target feature not found" }, 404);
      }
      const existing = db.featureLinks.find(
        (lnk) => Number(lnk.source_feature_id) === sourceFid && Number(lnk.target_feature_id) === targetFid || Number(lnk.source_feature_id) === targetFid && Number(lnk.target_feature_id) === sourceFid
      );
      const newLink = existing || {
        id: Date.now(),
        source_feature_id: sourceFid,
        source_layer_id: body.source_layer_id || sourceFound.layerId,
        target_feature_id: targetFid,
        target_layer_id: body.target_layer_id || targetFound.layerId,
        relationship_type: body.relationship_type || "connected_to",
        notes: body.notes || "",
        created_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (!existing) {
        db.featureLinks.push(newLink);
      }
      const tProps = targetFound.feature.properties || {};
      const tLabel = tProps.bldg_code || tProps.road_code || tProps.kitta_no || tProps.asset_code || tProps.road_name || tProps.owner_name || `#${targetFid}`;
      sourceFound.feature.properties = {
        ...sourceFound.feature.properties,
        linked_feature_ref: `${targetFound.layerName}: ${tLabel}`
      };
      saveDb(db);
      return buildResponse(config, { status: "linked", link: newLink });
    } else {
      const targetFid = Number(params.get("target_feature_id") || body.target_feature_id || 0);
      const linkId = Number(params.get("link_id") || body.link_id || 0);
      db.featureLinks = db.featureLinks.filter((lnk) => {
        if (linkId && Number(lnk.id) === linkId) return false;
        if (targetFid && (Number(lnk.source_feature_id) === sourceFid && Number(lnk.target_feature_id) === targetFid || Number(lnk.source_feature_id) === targetFid && Number(lnk.target_feature_id) === sourceFid)) {
          return false;
        }
        return true;
      });
      saveDb(db);
      return buildResponse(config, { status: "unlinked", feature_id: sourceFid });
    }
  }
  const featUpdateMatch = pathname.match(/^\/features\/(\d+)$/);
  if (featUpdateMatch && (method === "put" || method === "delete")) {
    const fid = Number(featUpdateMatch[1]);
    const user = getCurrentUser(db);
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    let updatedFeature = null;
    Object.keys(db.featuresByLayer).forEach((lidStr) => {
      const lid = Number(lidStr);
      if (method === "delete") {
        const existed = (db.featuresByLayer[lid] || []).find((f) => Number(f.id) === fid);
        if (existed) {
          if (!db.auditEditsByLayer) db.auditEditsByLayer = {};
          if (!db.auditEditsByLayer[lid]) db.auditEditsByLayer[lid] = [];
          db.auditEditsByLayer[lid].unshift({
            id: Date.now(),
            feature_id: fid,
            edit_type: "delete",
            user_id: user.id,
            username: user.username,
            full_name: user.full_name,
            created_at: nowIso
          });
        }
        db.featuresByLayer[lid] = (db.featuresByLayer[lid] || []).filter((f) => Number(f.id) !== fid);
      } else {
        db.featuresByLayer[lid] = (db.featuresByLayer[lid] || []).map((f) => {
          if (Number(f.id) !== fid) return f;
          const nextVer = Number(f.properties?._version || 1) + 1;
          updatedFeature = {
            ...f,
            geometry: body.geom_geojson || body.geometry || body.geom || f.geometry,
            properties: {
              ...f.properties,
              ...body.properties || body.attributes || {},
              _updated_by: user.id,
              _updated_by_username: user.username,
              _updated_by_name: user.full_name,
              _updated_at: nowIso,
              _version: nextVer,
              Kmc_Editor: user.username
            }
          };
          return updatedFeature;
        });
      }
    });
    saveDb(db);
    return buildResponse(config, updatedFeature || { status: "ok", id: fid });
  }
  const splitMatch = pathname.match(/^\/features\/(\d+)\/split$/);
  if (splitMatch && method === "post") {
    const fid = Number(splitMatch[1]);
    const bladeCoords = body.blade?.coordinates || [];
    const newIds = [fid];
    Object.keys(db.featuresByLayer).forEach((lidStr) => {
      const lid = Number(lidStr);
      const list = db.featuresByLayer[lid] || [];
      const target = list.find((f) => Number(f.id) === fid);
      if (target && (target.geometry?.type === "Polygon" || target.geometry?.type === "MultiPolygon")) {
        const ring = target.geometry.type === "MultiPolygon" ? target.geometry.coordinates[0][0] : target.geometry.coordinates[0];
        let cutAngle = 0;
        if (bladeCoords.length >= 2) {
          const p0 = bladeCoords[0];
          const p1 = bladeCoords[bladeCoords.length - 1];
          cutAngle = Math.atan2(p1[1] - p0[1], p1[0] - p0[0]) * 180 / Math.PI;
        }
        const [ringA, ringB] = splitPolygonGeometry(ring, cutAngle, bladeCoords);
        target.geometry = { type: "Polygon", coordinates: [ringA] };
        const newId = Date.now();
        newIds.push(newId);
        list.push({
          type: "Feature",
          id: newId,
          geometry: { type: "Polygon", coordinates: [ringB] },
          properties: {
            ...target.properties,
            _id: newId,
            bldg_code: target.properties?.bldg_code ? `${target.properties.bldg_code}-B` : void 0
          }
        });
      }
    });
    saveDb(db);
    return buildResponse(config, {
      status: "split_ok",
      feature_id: fid,
      part_count: 2,
      new_feature_ids: newIds
    });
  }
  const mergeMatch = pathname.match(/^\/layers\/(\d+)\/merge$/);
  if (mergeMatch && method === "post") {
    const lid = Number(mergeMatch[1]);
    const ids = (body.feature_ids || []).map(Number);
    const mergeMode = body.merge_mode === "multifeature" ? "multifeature" : "union";
    const primaryId = body.primary_feature_id != null ? Number(body.primary_feature_id) : ids[0];
    const list = db.featuresByLayer[lid] || [];
    const picked = list.filter((f) => ids.includes(Number(f.id)));
    if (picked.length >= 2) {
      const primaryFeature = picked.find((f) => Number(f.id) === primaryId) || picked[0];
      const mergedGeometry = mergeGeometriesWithMode(
        picked.map((f) => f.geometry),
        mergeMode
      );
      primaryFeature.geometry = mergedGeometry;
      primaryFeature.properties = {
        ...primaryFeature.properties,
        _merge_mode: mergeMode,
        _merged_feature_count: picked.length,
        _updated_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      db.featuresByLayer[lid] = list.filter(
        (f) => Number(f.id) === Number(primaryFeature.id) || !ids.includes(Number(f.id))
      );
      saveDb(db);
      return buildResponse(config, {
        status: "merged_ok",
        merge_mode: mergeMode,
        geometry_type: mergedGeometry.type,
        feature_id: primaryFeature.id,
        merged_count: picked.length
      });
    }
    return buildResponse(config, { status: "noop" });
  }
  if (pathname === "/tiles/deleted" && method === "get") {
    return buildResponse(config, db.deletedRasterLayers || []);
  }
  if (pathname === "/tiles" || pathname.match(/^\/projects\/\d+\/tiles$/)) {
    return buildResponse(config, db.rasterLayers);
  }
  const tileRestoreMatch = pathname.match(/^\/tiles\/(\d+)\/restore$/);
  if (tileRestoreMatch && method === "post") {
    const tid = Number(tileRestoreMatch[1]);
    const target = (db.deletedRasterLayers || []).find((t) => t.id === tid);
    if (target) {
      const { deleted_at, ...restored } = target;
      db.rasterLayers.push(restored);
      db.deletedRasterLayers = (db.deletedRasterLayers || []).filter((t) => t.id !== tid);
      saveDb(db);
    }
    return buildResponse(config, { status: "restored", id: tid });
  }
  const tilePermDeleteMatch = pathname.match(/^\/tiles\/(\d+)\/permanent$/);
  if (tilePermDeleteMatch && method === "delete") {
    const tid = Number(tilePermDeleteMatch[1]);
    db.deletedRasterLayers = (db.deletedRasterLayers || []).filter((t) => t.id !== tid);
    saveDb(db);
    return buildResponse(config, { status: "permanently_deleted", id: tid });
  }
  const tileDownloadMatch = pathname.match(/^\/tiles\/(\d+)\/download$/);
  if (tileDownloadMatch && method === "get") {
    const tid = Number(tileDownloadMatch[1]);
    const tile = db.rasterLayers.find((t) => t.id === tid);
    return buildResponse(config, JSON.stringify({ tile_id: tid, name: tile?.name || "KMC UAV Tiles" }));
  }
  const tileDetailMatch = pathname.match(/^\/tiles\/(\d+)$/);
  if (tileDetailMatch && method === "delete") {
    const tid = Number(tileDetailMatch[1]);
    const target = db.rasterLayers.find((t) => t.id === tid);
    if (target) {
      db.deletedRasterLayers = [
        { ...target, deleted_at: (/* @__PURE__ */ new Date()).toISOString() },
        ...db.deletedRasterLayers || []
      ];
      db.rasterLayers = db.rasterLayers.filter((t) => t.id !== tid);
      saveDb(db);
    }
    return buildResponse(config, { status: "soft_deleted", id: tid });
  }
  if (pathname === "/uploads/init" && method === "post") {
    const uploadId = `upl_${Date.now()}`;
    const chunkSize = 33554432;
    const totalChunks = Math.max(1, Math.ceil(Number(body.total_size || 1024) / chunkSize));
    pendingUploads.set(uploadId, { meta: body, chunks: [] });
    return buildResponse(config, {
      upload_id: uploadId,
      chunk_size: chunkSize,
      total_chunks: totalChunks
    });
  }
  const uploadChunkMatch = pathname.match(/^\/uploads\/([^/]+)\/chunk$/);
  if (uploadChunkMatch && method === "post") {
    const uploadId = uploadChunkMatch[1];
    const entry = pendingUploads.get(uploadId);
    if (entry && config.data != null) {
      entry.chunks.push(config.data);
    }
    return buildResponse(config, { status: "chunk_received" });
  }
  const uploadCompleteMatch = pathname.match(/^\/uploads\/([^/]+)\/complete$/);
  if (uploadCompleteMatch && method === "post") {
    const uploadId = uploadCompleteMatch[1];
    const entry = pendingUploads.get(uploadId);
    const meta = entry?.meta || {};
    const user = getCurrentUser(db);
    if (meta.kind === "raster") {
      let imageDataUrl = null;
      const fname = String(meta.filename || "").toLowerCase();
      const isDirectImage = /\.(png|jpg|jpeg|webp|gif|svg|bmp)$/i.test(fname) || String(meta.mime_type || "").startsWith("image/");
      if (isDirectImage && entry && entry.chunks.length > 0) {
        try {
          const fullBlob = new Blob(entry.chunks, { type: meta.mime_type || "image/png" });
          imageDataUrl = await blobToDataUrl(fullBlob);
        } catch (_) {
        }
      }
      const stem = String(meta.filename || "drone_survey").replace(/\.[^/.]+$/, "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
      const tileUrl = `/api/tiles/data/${stem}/{z}/{x}/{y}.png`;
      const customBounds = Array.isArray(meta.bounds) && meta.bounds.length === 4 ? meta.bounds : [85.31, 27.68, 85.35, 27.70];
      const newTile = {
        id: Date.now(),
        name: meta.name || meta.filename || "नयाँ ड्रोन इमेज्री (MBTiles)",
        filename: meta.filename || "drone_survey.mbtiles",
        type: "raster",
        category: "ड्रोन तथा अर्थोफोटो (UAV Imagery)",
        is_global: meta.is_global !== false,
        project_id: meta.project_id || null,
        file_size: meta.total_size || 52428800,
        min_zoom: 10,
        max_zoom: 22,
        access_level: "public",
        bounds: customBounds,
        bbox: customBounds,
        image_data_url: imageDataUrl,
        tile_url: tileUrl
      };
      db.rasterLayers.unshift(newTile);
      saveDb(db);
      pendingUploads.delete(uploadId);
      return buildResponse(config, { ...newTile, import_status: "complete" });
    } else {
      let text = "";
      if (entry && entry.chunks && entry.chunks.length > 0) {
        try {
          if (typeof entry.chunks[0] === "string") {
            text = entry.chunks.join("");
          } else if (typeof Blob !== "undefined" && (entry.chunks[0] instanceof Blob || (entry.chunks[0] && typeof entry.chunks[0].slice === "function"))) {
            const fullBlob = new Blob(entry.chunks);
            text = await fullBlob.text();
          } else {
            const parts = entry.chunks.map((c) => {
              if (typeof c === "string") return new TextEncoder().encode(c);
              if (c instanceof ArrayBuffer) return new Uint8Array(c);
              if (ArrayBuffer.isView(c)) return new Uint8Array(c.buffer, c.byteOffset, c.byteLength);
              return new Uint8Array(0);
            });
            const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
            const merged = new Uint8Array(totalLen);
            let offset = 0;
            for (const p of parts) {
              merged.set(p, offset);
              offset += p.length;
            }
            text = new TextDecoder("utf-8").decode(merged);
          }
        } catch (chunkErr) {
          console.error("[kmcBackendEngine] Chunk assembly error:", chunkErr);
        }
      }

      let parsed = null;
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch (parseErr) {
          console.error("[kmcBackendEngine] GeoJSON JSON.parse error:", parseErr);
        }
      }

      let rawFeatures = [];
      if (parsed) {
        if (Array.isArray(parsed.features)) {
          rawFeatures = parsed.features;
        } else if (Array.isArray(parsed)) {
          rawFeatures = parsed;
        } else if (parsed.type === "Feature") {
          rawFeatures = [parsed];
        } else if (parsed.type === "GeometryCollection" && Array.isArray(parsed.geometries)) {
          rawFeatures = parsed.geometries.map((g, idx) => ({
            type: "Feature",
            id: idx + 1,
            geometry: g,
            properties: {}
          }));
        }
      }

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      function scanCoords(coords) {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === "number" && typeof coords[1] === "number") {
          const x = Number(coords[0]), y = Number(coords[1]);
          if (!isNaN(x) && !isNaN(y)) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        } else {
          for (const sub of coords) scanCoords(sub);
        }
      }

      let geomType = "Polygon";
      const importedFeatures = rawFeatures.map((f, idx) => {
        const featId = f.id || (Date.now() + idx);
        const geom = f.geometry || {};
        if (geom.coordinates) scanCoords(geom.coordinates);
        if (idx === 0 && geom.type) geomType = geom.type;
        return {
          type: "Feature",
          ...f,
          id: featId,
          properties: {
            ...(f.properties || {}),
            "_id": featId,
            "_created_by": user.id,
            "_created_by_username": user.username,
            "_created_by_name": user.full_name,
            "Kmc_Editor": user.username
          }
        };
      });

      let calculatedBbox = [85.31, 27.682, 85.345, 27.702];
      if (minX !== Infinity && minY !== Infinity && maxX !== -Infinity && maxY !== -Infinity) {
        calculatedBbox = [minX, minY, maxX, maxY];
      }

      const newLayerId = Date.now();
      const newLayer = {
        id: newLayerId,
        name: meta.name || meta.filename || "आयातित भेक्टर तह",
        description: meta.description || "Uploaded GeoJSON Layer",
        type: "vector",
        geometry_type: geomType,
        creation_geometry_types: [geomType],
        category: "भू-स्थानिक तहहरू (Spatial Layers)",
        is_global: meta.is_global !== false,
        project_id: meta.project_id || null,
        allow_snapping: meta.allow_snapping !== false,
        editable_by_collectors: meta.editable_by_collectors !== false,
        published: true,
        default_visible: true,
        access_level: "public",
        opacity: 1,
        feature_count: importedFeatures.length,
        bounds: calculatedBbox,
        bbox: calculatedBbox,
        created_by_id: user.id,
        created_by_username: user.username,
        created_by_name: user.full_name,
        style: { strokeColor: "#10b981", fillColor: "#10b981", strokeWidth: 2.5, clickTolerance: 14 },
        fields_config: []
      };
      db.vectorLayers.unshift(newLayer);
      db.featuresByLayer[newLayerId] = importedFeatures;
      saveDb(db);
      pendingUploads.delete(uploadId);
      return buildResponse(config, { ...newLayer, import_status: "complete" });
    }
  }
  const uploadStatusMatch = pathname.match(/^\/uploads\/([^/]+)$/);
  if (uploadStatusMatch) {
    return buildResponse(config, { next_index: 0, status: "ready" });
  }
  if (pathname === "/tracking/collectors") {
    return buildResponse(config, db.collectorLocations);
  }
  if (pathname === "/tracking/collectors/geojson") {
    return buildResponse(config, {
      type: "FeatureCollection",
      features: db.collectorLocations.map((c) => ({
        type: "Feature",
        id: c.user_id,
        geometry: { type: "Point", coordinates: [c.longitude, c.latitude] },
        properties: c
      }))
    });
  }
  if (pathname === "/tracking/admin/logs/download") {
    const logPayload = JSON.stringify(
      {
        municipality: "Kathmandu Metropolitan City (\u0915\u093E\u0920\u092E\u093E\u0921\u094C\u0901 \u092E\u0939\u093E\u0928\u0917\u0930\u092A\u093E\u0932\u093F\u0915\u093E)",
        exported_at: (/* @__PURE__ */ new Date()).toISOString(),
        active_collectors: db.collectorLocations,
        layer_audit_logs: db.auditEditsByLayer
      },
      null,
      2
    );
    return buildResponse(config, logPayload);
  }
  if (pathname === "/tracking/ping" || pathname === "/tracking/status") {
    if (body.latitude && body.longitude) {
      const user = getCurrentUser(db);
      const existingIdx = db.collectorLocations.findIndex((c) => c.user_id === user.id);
      const entry = {
        user_id: user.id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        latitude: Number(body.latitude),
        longitude: Number(body.longitude),
        accuracy: Number(body.accuracy || 3.5),
        is_online: true,
        app_state: body.app_state || "active",
        minutes_ago: 0,
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      };
      if (existingIdx >= 0) {
        db.collectorLocations[existingIdx] = { ...db.collectorLocations[existingIdx], ...entry };
      } else if (user.role === "DataCollector") {
        db.collectorLocations.push(entry);
      }
      saveDb(db);
    }
    return buildResponse(config, { status: "ok" });
  }
  if (pathname === "/house-numbering/stats") {
    const leftCount = db.houseNumbers.filter(
      (h) => String(h.side || "").toUpperCase().includes("LEFT") || String(h.side || "").toUpperCase().includes("ODD")
    ).length;
    const rightCount = db.houseNumbers.length - leftCount;
    const verifiedCount = db.houseNumbers.filter((h) => h.qr_verified || h.status === "VERIFIED").length;
    return buildResponse(config, {
      total_house_numbers: db.houseNumbers.length,
      total_assigned: db.houseNumbers.length,
      verified_count: verifiedCount,
      wards_covered: 32,
      odd_left_count: leftCount,
      even_right_count: rightCount,
      by_side: {
        LEFT: leftCount,
        RIGHT: rightCount
      },
      qr_plates_printed: verifiedCount
    });
  }
  if (pathname === "/house-numbering/numbers") {
    const search = params.get("search") || "";
    return buildResponse(config, toHouseNumberFeatureCollection(db.houseNumbers, search));
  }
  const hnUpdateMatch = pathname.match(/^\/house-numbering\/numbers\/(\d+)$/);
  if (hnUpdateMatch && (method === "put" || method === "delete")) {
    const hid = Number(hnUpdateMatch[1]);
    if (method === "delete") {
      db.houseNumbers = db.houseNumbers.filter((h) => Number(h.id) !== hid);
    } else {
      db.houseNumbers = db.houseNumbers.map(
        (h) => Number(h.id) === hid ? {
          ...h,
          ...body,
          qr_verified: body.status === "VERIFIED" ? true : h.qr_verified
        } : h
      );
    }
    saveDb(db);
    return buildResponse(config, { status: "updated", id: hid });
  }
  if (pathname === "/house-numbering/generate" && method === "post") {
    const bldgLayerId = Number(body.building_layer_id || 1);
    const bldgs = db.featuresByLayer[bldgLayerId] || db.featuresByLayer[1] || [];
    const roadName = body.road_name || "\u092C\u093E\u0928\u0947\u0936\u094D\u0935\u0930\u2013\u0936\u0902\u0916\u092E\u0942\u0932 \u092E\u0941\u0916\u094D\u092F \u092E\u093E\u0930\u094D\u0917";
    const wardStr = String(body.ward || "10");
    const pfx = body.prefix || `W${wardStr}-`;
    const proposals = bldgs.map((b, idx) => {
      const isLeft = idx % 2 === 0;
      const chainage = Math.round(45 + idx * 38);
      const metricNum = isLeft ? chainage % 2 === 0 ? chainage + 1 : chainage : chainage % 2 === 0 ? chainage : chainage + 1;
      const ring = b.geometry?.coordinates?.[0] || [[85.331, 27.689]];
      const [lng, lat] = ring[0] || [85.331, 27.689];
      const houseNumber = `${pfx}${metricNum}`;
      return {
        id: Date.now() + idx,
        building_id: b.id,
        house_number: houseNumber,
        metric_house_no: `${houseNumber}${isLeft ? "L" : "R"}`,
        building_code: b.properties?.bldg_code || `KMC-BLD-${10101 + idx}`,
        owner_name: b.properties?.owner_name || `\u0918\u0930\u0927\u0928\u0940 #${idx + 1}`,
        road_name: roadName,
        ward: wardStr,
        ward_no: Number(wardStr) || 10,
        side: isLeft ? "LEFT" : "RIGHT",
        chainage_m: chainage,
        metric_distance: chainage,
        distance_m: chainage,
        latitude: lat,
        longitude: lng,
        status: "ASSIGNED",
        qr_verified: false
      };
    });
    if (body.save_to_database) {
      const existingCodes = new Set(db.houseNumbers.map((h) => h.house_number));
      const toAdd = proposals.filter((p) => !existingCodes.has(p.house_number));
      db.houseNumbers = [...toAdd, ...db.houseNumbers];
      saveDb(db);
    }
    const leftSideCount = proposals.filter((p) => p.side === "LEFT").length;
    return buildResponse(config, {
      total_buildings_detected: proposals.length,
      left_side_count: leftSideCount,
      right_side_count: proposals.length - leftSideCount,
      saved_count: body.save_to_database ? proposals.length : 0,
      proposals
    });
  }
  if (pathname === "/house-numbering/export") {
    const format = params.get("format") || "geojson";
    const fc = toHouseNumberFeatureCollection(db.houseNumbers);
    if (format === "csv") {
      const rows = [
        "id,house_number,road_name,ward,side,chainage_m,status,latitude,longitude",
        ...db.houseNumbers.map(
          (h) => `${h.id},"${h.house_number || h.metric_house_no}","${h.road_name}",${h.ward || h.ward_no || 10},${h.side},${h.chainage_m || h.distance_m || 100},${h.status || "ASSIGNED"},${h.latitude},${h.longitude}`
        )
      ].join("\n");
      return buildResponse(config, rows);
    }
    return buildResponse(config, fc);
  }
  const activeQMatch = pathname.match(/^\/projects\/(\d+)\/questionnaires\/active$/);
  if (activeQMatch && method === "get") {
    const pid = Number(activeQMatch[1]);
    const q = db.questionnaires.find((x) => x.project_id === pid && x.is_active) || db.questionnaires[0];
    return buildResponse(config, q);
  }
  const projQMatch = pathname.match(/^\/projects\/(\d+)\/questionnaires$/);
  if (projQMatch) {
    const pid = Number(projQMatch[1]);
    if (method === "get") {
      const list = db.questionnaires.filter((x) => x.project_id === pid);
      return buildResponse(config, list.length > 0 ? list : [db.questionnaires[0]]);
    }
    if (method === "post") {
      const newQ = {
        id: Date.now(),
        project_id: pid,
        title: body.title || "\u0928\u092F\u093E\u0901 \u0938\u0930\u094D\u0935\u0947\u0915\u094D\u0937\u0923 \u092A\u094D\u0930\u0936\u094D\u0928\u093E\u0935\u0932\u0940",
        description: body.description || "",
        version: "v1.0",
        status: "DRAFT",
        is_active: true,
        schema_definition: body.schema_definition || { sections: [], questions: [], settings: {} }
      };
      db.questionnaires.unshift(newQ);
      saveDb(db);
      return buildResponse(config, newQ);
    }
  }
  const qDetailMatch = pathname.match(/^\/questionnaires\/(\d+)$/);
  if (qDetailMatch) {
    const qid = Number(qDetailMatch[1]);
    if (method === "get") {
      return buildResponse(config, db.questionnaires.find((q) => q.id === qid) || db.questionnaires[0]);
    }
    if (method === "put") {
      db.questionnaires = db.questionnaires.map(
        (q) => q.id === qid ? {
          ...q,
          title: body.title ?? q.title,
          description: body.description ?? q.description,
          schema_definition: body.schema_definition ?? q.schema_definition
        } : q
      );
      saveDb(db);
      return buildResponse(config, db.questionnaires.find((q) => q.id === qid));
    }
  }
  const qValidateMatch = pathname.match(/^\/questionnaires\/(\d+)\/validate$/);
  if (qValidateMatch && method === "post") {
    const qid = Number(qValidateMatch[1]);
    const q = db.questionnaires.find((x) => x.id === qid) || db.questionnaires[0];
    const secs = q?.schema_definition?.sections || [];
    const qs = q?.schema_definition?.questions || [];
    return buildResponse(config, {
      valid: true,
      is_valid: true,
      errors: [],
      warnings: [],
      total_sections: secs.length,
      total_questions: qs.length,
      conditional_rules_count: qs.filter((item) => item.conditions?.length > 0).length,
      repeat_groups_count: qs.filter((item) => item.type === "repeat_group").length
    });
  }
  const qPublishMatch = pathname.match(/^\/questionnaires\/(\d+)\/publish$/);
  if (qPublishMatch && method === "post") {
    const qid = Number(qPublishMatch[1]);
    let publishedQ = null;
    db.questionnaires = db.questionnaires.map((q) => {
      if (q.id !== qid) return q;
      const nextVer = `v${(parseFloat(String(q.version || "v1.0").replace("v", "")) + 0.1).toFixed(1)}`;
      publishedQ = { ...q, status: "PUBLISHED", is_active: true, version: nextVer };
      return publishedQ;
    });
    if (publishedQ) {
      db.projects = db.projects.map(
        (p) => p.id === publishedQ.project_id ? { ...p, active_questionnaire_id: publishedQ.id } : p
      );
    }
    saveDb(db);
    return buildResponse(config, publishedQ || db.questionnaires[0]);
  }
  const qDuplicateMatch = pathname.match(/^\/questionnaires\/(\d+)\/duplicate$/);
  if (qDuplicateMatch && method === "post") {
    const qid = Number(qDuplicateMatch[1]);
    const orig = db.questionnaires.find((q) => q.id === qid) || db.questionnaires[0];
    const dup = {
      ...orig,
      id: Date.now(),
      version: `${orig.version}-copy`,
      status: "DRAFT",
      is_active: false
    };
    db.questionnaires.unshift(dup);
    saveDb(db);
    return buildResponse(config, dup);
  }
  const projRecsMatch = pathname.match(/^\/projects\/(\d+)\/records(\/my|\/export)?$/);
  if (projRecsMatch && method === "get") {
    const pid = Number(projRecsMatch[1]);
    const sub = projRecsMatch[2];
    const recs = db.records.filter((r) => Number(r.project_id) === pid || pid === 1);
    if (sub === "/export") {
      return buildResponse(config, {
        type: "FeatureCollection",
        features: recs.map((r) => ({
          type: "Feature",
          id: r.id,
          geometry: r.geom_geojson || { type: "Point", coordinates: [85.3306, 27.6918] },
          properties: {
            record_id: r.record_id,
            status: r.status,
            collector_name: r.collector_name,
            ...r.answers || {}
          }
        }))
      });
    }
    return buildResponse(config, recs);
  }
  const recSaveMatch = pathname.match(/^\/projects\/(\d+)\/records\/(draft|submit)$/);
  if (recSaveMatch && method === "post") {
    const pid = Number(recSaveMatch[1]);
    const isSubmit = recSaveMatch[2] === "submit";
    const user = getCurrentUser(db);
    const nowIso = (/* @__PURE__ */ new Date()).toISOString();
    const recIdStr = body.record_id || `KMC-REC-2083-${Math.floor(510 + Math.random() * 400)}`;
    const existing = db.records.find((r) => r.record_id === recIdStr || body.id && r.id === body.id);
    const rec = {
      id: existing?.id || body.id || Date.now(),
      record_id: recIdStr,
      project_id: pid,
      questionnaire_id: body.questionnaire_id || 1,
      status: isSubmit ? "SUBMITTED" : body.status || "IN_PROGRESS",
      completion_percentage: isSubmit ? 100 : body.completion_percentage ?? 75,
      geometry_type: body.geometry_type || "Point",
      collector_id: user.id,
      collector_username: user.username,
      collector_name: user.full_name,
      last_saved_at: nowIso,
      submitted_at: isSubmit ? nowIso : existing?.submitted_at,
      updated_at: nowIso,
      answers: body.answers || {},
      repeat_data: body.repeat_data || {},
      calculated_values: body.calculated_values || {},
      media_refs: body.media_refs || [],
      geom_geojson: body.geom_geojson || { type: "Point", coordinates: [85.3306, 27.6918] }
    };
    db.records = [rec, ...db.records.filter((r) => r.id !== rec.id && r.record_id !== rec.record_id)];

    // Populate vector feature in linked vector layer
    if (isSubmit && rec.geom_geojson) {
      let targetLayer = null;
      if (body.questionnaire_id) {
        targetLayer = db.vectorLayers.find((l) => l.questionnaire_id === body.questionnaire_id);
      }
      if (!targetLayer) {
        targetLayer = db.vectorLayers.find((l) => l.project_id === pid);
      }
      if (!targetLayer && db.vectorLayers.length > 0) {
        targetLayer = db.vectorLayers[0];
      }
      if (targetLayer) {
        const lid = targetLayer.id;
        if (!db.featuresByLayer[lid]) db.featuresByLayer[lid] = [];
        const feat = {
          type: "Feature",
          id: rec.record_id,
          geometry: rec.geom_geojson,
          properties: {
            ...(body.answers || {}),
            _id: rec.record_id,
            _record_id: rec.record_id,
            _questionnaire_id: body.questionnaire_id,
            _status: "SUBMITTED",
            _created_by: user.id,
            _created_by_username: user.username,
            _created_at: nowIso,
          },
        };
        db.featuresByLayer[lid].push(feat);
        targetLayer.feature_count = db.featuresByLayer[lid].length;
      }
    }

    saveDb(db);
    return buildResponse(config, rec);
  }
  const recReviewMatch = pathname.match(/^\/records\/(\d+)\/review$/);
  if (recReviewMatch && method === "put") {
    const rid = Number(recReviewMatch[1]);
    db.records = db.records.map(
      (r) => Number(r.id) === rid ? {
        ...r,
        status: body.status || "APPROVED",
        reviewer_notes: body.reviewer_notes || "",
        updated_at: (/* @__PURE__ */ new Date()).toISOString()
      } : r
    );
    saveDb(db);
    return buildResponse(config, db.records.find((r) => Number(r.id) === rid));
  }
  if (pathname === "/modules") {
    return buildResponse(config, db.modules);
  }
  const modUpdateMatch = pathname.match(/^\/modules\/([^/]+)$/);
  if (modUpdateMatch && method === "put") {
    const mid = modUpdateMatch[1];
    db.modules = db.modules.map((m) => m.id === mid ? { ...m, ...body } : m);
    saveDb(db);
    return buildResponse(config, db.modules.find((m) => m.id === mid));
  }
  return buildResponse(config, {});
}
export {
  generateSyntheticOrthophotoSvgDataUrl,
  getDb,
  kmcMockAdapter,
  saveDb
};
