const EARTH_RADIUS_M = 63710088e-1;
const KATHMANDU_LAT_RAD = 27.700769 * Math.PI / 180;
const METERS_PER_DEG_LAT = 111132.954;
const METERS_PER_DEG_LON = 111319.488 * Math.cos(KATHMANDU_LAT_RAD);
function metersToDegrees(dxMeters, dyMeters) {
  return [dxMeters / METERS_PER_DEG_LON, dyMeters / METERS_PER_DEG_LAT];
}
function haversineDistanceMeters(a, b) {
  const toRad = (deg) => deg * Math.PI / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const sinDLat = Math.sin(dLat / 2);
  const sinDLon = Math.sin(dLon / 2);
  const h = sinDLat * sinDLat + Math.cos(lat1) * Math.cos(lat2) * sinDLon * sinDLon;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}
function computePolygonAreaSqm(ring) {
  if (!ring || ring.length < 3) return 0;
  let area = 0;
  const n = ring.length;
  const refLon = ring[0][0];
  const refLat = ring[0][1];
  for (let i = 0; i < n; i++) {
    const p1 = ring[i];
    const p2 = ring[(i + 1) % n];
    const x1 = (p1[0] - refLon) * METERS_PER_DEG_LON;
    const y1 = (p1[1] - refLat) * METERS_PER_DEG_LAT;
    const x2 = (p2[0] - refLon) * METERS_PER_DEG_LON;
    const y2 = (p2[1] - refLat) * METERS_PER_DEG_LAT;
    area += x1 * y2 - x2 * y1;
  }
  return Math.round(Math.abs(area / 2) * 100) / 100;
}
function computeLineLengthMeters(coords) {
  if (!coords || coords.length < 2) return 0;
  let total = 0;
  for (let i = 0; i < coords.length - 1; i++) {
    total += haversineDistanceMeters(coords[i], coords[i + 1]);
  }
  return Math.round(total * 100) / 100;
}
function computePolygonCentroid(ring) {
  if (!ring || ring.length === 0) return [85.324, 27.705];
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  let sumLon = 0;
  let sumLat = 0;
  for (const p of pts) {
    sumLon += p[0];
    sumLat += p[1];
  }
  return [sumLon / pts.length, sumLat / pts.length];
}
function isPointInPolygon(pt, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < (xj - xi) * (pt[1] - yi) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
function pointToSegmentDistanceMeters(p, a, b) {
  const px = (p[0] - a[0]) * METERS_PER_DEG_LON;
  const py = (p[1] - a[1]) * METERS_PER_DEG_LAT;
  const bx = (b[0] - a[0]) * METERS_PER_DEG_LON;
  const by = (b[1] - a[1]) * METERS_PER_DEG_LAT;
  const segLenSq = bx * bx + by * by;
  if (segLenSq === 0) return Math.hypot(px, py);
  const t = Math.max(0, Math.min(1, (px * bx + py * by) / segLenSq));
  const projX = t * bx;
  const projY = t * by;
  return Math.hypot(px - projX, py - projY);
}
function pointToPolygonDistanceMeters(pt, ring) {
  if (isPointInPolygon(pt, ring)) return 0;
  let minDist = Infinity;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const d = pointToSegmentDistanceMeters(pt, a, b);
    if (d < minDist) minDist = d;
  }
  return Math.round(minDist * 100) / 100;
}
function verifyDoubleGeofence(params) {
  const maxAllowed = params.maxDistanceMeters ?? 50;
  const distGrid = pointToPolygonDistanceMeters(params.userGps, params.gridPolygon);
  let distFeat = Infinity;
  if (params.featureCoords.length === 1) {
    distFeat = haversineDistanceMeters(params.userGps, params.featureCoords[0]);
  } else if (params.featureCoords.length > 1) {
    distFeat = pointToPolygonDistanceMeters(params.userGps, params.featureCoords);
  } else {
    distFeat = 0;
  }
  distFeat = Math.round(distFeat * 100) / 100;
  if (
    params.userRole === "MasterAdmin" ||
    params.userRole === "SuperAdmin" ||
    params.userRole === "GisAdmin" ||
    params.userRole === "DepartmentAdmin"
  ) {
    return {
      allowed: true,
      distanceToGridMeters: distGrid,
      distanceToFeatureMeters: distFeat,
      maxAllowedMeters: maxAllowed
    };
  }
  if (distGrid > maxAllowed) {
    return {
      allowed: false,
      distanceToGridMeters: distGrid,
      distanceToFeatureMeters: distFeat,
      maxAllowedMeters: maxAllowed,
      reason: `GPS Geofence Violation: You are ${distGrid.toFixed(1)}m outside assigned Task Grid (max ${maxAllowed}m).`,
      reasonNe: `\u091C\u0940\u092A\u0940\u090F\u0938 \u0938\u0940\u092E\u093E \u0909\u0932\u094D\u0932\u0902\u0918\u0928: \u0924\u092A\u093E\u0908\u0902 \u0924\u094B\u0915\u093F\u090F\u0915\u094B \u0915\u093E\u0930\u094D\u092F \u0917\u094D\u0930\u093F\u0921 \u092D\u0928\u094D\u0926\u093E ${distGrid.toFixed(1)} \u092E\u093F\u091F\u0930 \u091F\u093E\u0922\u093E \u0939\u0941\u0928\u0941\u0939\u0941\u0928\u094D\u091B (\u0905\u0927\u093F\u0915\u0924\u092E ${maxAllowed} \u092E\u093F.)\u0964`
    };
  }
  if (distFeat > maxAllowed) {
    return {
      allowed: false,
      distanceToGridMeters: distGrid,
      distanceToFeatureMeters: distFeat,
      maxAllowedMeters: maxAllowed,
      reason: `GPS Geofence Violation: You are ${distFeat.toFixed(1)}m from target feature (max ${maxAllowed}m).`,
      reasonNe: `\u091C\u0940\u092A\u0940\u090F\u0938 \u0938\u0940\u092E\u093E \u0909\u0932\u094D\u0932\u0902\u0918\u0928: \u0924\u092A\u093E\u0908\u0902 \u091A\u092F\u0928 \u0917\u0930\u093F\u090F\u0915\u094B \u0938\u0902\u0930\u091A\u0928\u093E \u092D\u0928\u094D\u0926\u093E ${distFeat.toFixed(1)} \u092E\u093F\u091F\u0930 \u091F\u093E\u0922\u093E \u0939\u0941\u0928\u0941\u0939\u0941\u0928\u094D\u091B (\u0905\u0927\u093F\u0915\u0924\u092E ${maxAllowed} \u092E\u093F.)\u0964`
    };
  }
  return {
    allowed: true,
    distanceToGridMeters: distGrid,
    distanceToFeatureMeters: distFeat,
    maxAllowedMeters: maxAllowed
  };
}
function clipPolygonHalfPlane(poly, a, b) {
  if (poly.length === 0) return [];
  const inside = (p) => (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= -1e-11;
  const intersect = (p1, p2) => {
    const dx1 = p2[0] - p1[0];
    const dy1 = p2[1] - p1[1];
    const dx2 = b[0] - a[0];
    const dy2 = b[1] - a[1];
    const denom = dx1 * dy2 - dy1 * dx2;
    if (Math.abs(denom) < 1e-12) return p1;
    const t = ((a[0] - p1[0]) * dy2 - (a[1] - p1[1]) * dx2) / denom;
    return [p1[0] + t * dx1, p1[1] + t * dy1];
  };
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const cur = poly[i];
    const prev = poly[(i + poly.length - 1) % poly.length];
    const curIn = inside(cur);
    const prevIn = inside(prev);
    if (curIn) {
      if (!prevIn) out.push(intersect(prev, cur));
      out.push(cur);
    } else if (prevIn) {
      out.push(intersect(prev, cur));
    }
  }
  return out;
}
function closeRing(pts) {
  if (pts.length === 0) return [];
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    return [...pts, [first[0], first[1]]];
  }
  return pts;
}
function generateSpatialGrid(params) {
  const { aoiRing, gridShape, projectId, wardNo = 10 } = params;
  const cellSizeM = Math.max(40, Math.min(1e3, params.cellSizeMeters || 150));
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lon, lat] of aoiRing) {
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  const [dLon, dLat] = metersToDegrees(cellSizeM, cellSizeM);
  const rawPolys = [];
  if (gridShape === "rectangular") {
    for (let lon = minLon; lon < maxLon; lon += dLon) {
      for (let lat = minLat; lat < maxLat; lat += dLat) {
        const cell = [
          [lon, lat],
          [lon + dLon, lat],
          [lon + dLon, lat + dLat],
          [lon, lat + dLat]
        ];
        rawPolys.push({ coords: cell });
      }
    }
  } else if (gridShape === "triangular") {
    for (let lon = minLon; lon < maxLon; lon += dLon) {
      for (let lat = minLat; lat < maxLat; lat += dLat) {
        const t1 = [
          [lon, lat],
          [lon + dLon, lat],
          [lon + dLon, lat + dLat]
        ];
        const t2 = [
          [lon, lat],
          [lon + dLon, lat + dLat],
          [lon, lat + dLat]
        ];
        rawPolys.push({ coords: t1 }, { coords: t2 });
      }
    }
  } else if (gridShape === "circular") {
    const rLon = dLon * 0.48;
    const rLat = dLat * 0.48;
    const rowStepLat = dLat * 0.866;
    let rowIdx = 0;
    for (let lat = minLat + rLat; lat <= maxLat; lat += rowStepLat, rowIdx++) {
      const offsetLon = rowIdx % 2 === 1 ? dLon * 0.5 : 0;
      for (let lon = minLon + rLon + offsetLon; lon <= maxLon; lon += dLon) {
        const circlePts = [];
        const segs = 20;
        for (let s = 0; s < segs; s++) {
          const ang = 2 * Math.PI * s / segs;
          circlePts.push([lon + rLon * Math.cos(ang), lat + rLat * Math.sin(ang)]);
        }
        rawPolys.push({ coords: circlePts });
      }
    }
  } else if (gridShape === "hexagonal") {
    const rLon = dLon * 0.55;
    const rLat = dLat * 0.55;
    const dx = rLon * 1.5;
    const dy = rLat * Math.sqrt(3);
    let col = 0;
    for (let lon = minLon; lon <= maxLon + rLon; lon += dx, col++) {
      const yOffset = col % 2 === 1 ? dy / 2 : 0;
      for (let lat = minLat - dy / 2; lat <= maxLat + rLat; lat += dy) {
        const cy = lat + yOffset;
        const hex = [];
        for (let i = 0; i < 6; i++) {
          const angle = Math.PI / 3 * i;
          hex.push([lon + rLon * Math.cos(angle), cy + rLat * Math.sin(angle)]);
        }
        rawPolys.push({ coords: hex });
      }
    }
  } else if (gridShape === "random") {
    const cols = Math.max(2, Math.round((maxLon - minLon) / dLon));
    const rows = Math.max(2, Math.round((maxLat - minLat) / dLat));
    const seeds = [];
    let seedState = 42 + wardNo * 17;
    const nextRand = () => {
      seedState = (seedState * 1664525 + 1013904223) % 4294967296;
      return seedState / 4294967296;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const jitterLon = (c + 0.2 + 0.6 * nextRand()) * ((maxLon - minLon) / cols) + minLon;
        const jitterLat = (r + 0.2 + 0.6 * nextRand()) * ((maxLat - minLat) / rows) + minLat;
        seeds.push([jitterLon, jitterLat]);
      }
    }
    const bboxPoly = [
      [minLon, minLat],
      [maxLon, minLat],
      [maxLon, maxLat],
      [minLon, maxLat]
    ];
    for (let i = 0; i < seeds.length; i++) {
      let cell = [...bboxPoly];
      const si = seeds[i];
      for (let j = 0; j < seeds.length; j++) {
        if (i === j) continue;
        const sj = seeds[j];
        const mid = [(si[0] + sj[0]) / 2, (si[1] + sj[1]) / 2];
        const vx = sj[0] - si[0];
        const vy = sj[1] - si[1];
        const pA = [mid[0] - vy, mid[1] + vx];
        const pB = [mid[0] + vy, mid[1] - vx];
        cell = clipPolygonHalfPlane(cell, pA, pB);
        if (cell.length < 3) break;
      }
      if (cell.length >= 3) {
        rawPolys.push({ coords: cell });
      }
    }
  } else if (gridShape === "straight_skeleton") {
    const midLon = (minLon + maxLon) / 2;
    const midLat = (minLat + maxLat) / 2;
    const riverTiltLon = (maxLon - minLon) * 0.08;
    const zones = [
      { name: "NW Bagmati-Arterial Sector", lon0: minLon, lon1: midLon - riverTiltLon * 0.2, lat0: midLat, lat1: maxLat },
      { name: "NE Dhobikhola Corridor", lon0: midLon - riverTiltLon * 0.2, lon1: maxLon, lat0: midLat, lat1: maxLat },
      { name: "SW Bishnumati Heritage Block", lon0: minLon, lon1: midLon + riverTiltLon * 0.2, lat0: minLat, lat1: midLat },
      { name: "SE Araniko Highway Block", lon0: midLon + riverTiltLon * 0.2, lon1: maxLon, lat0: minLat, lat1: midLat }
    ];
    for (const z of zones) {
      const subCols = Math.max(1, Math.round((z.lon1 - z.lon0) / (dLon * 1.1)));
      const subRows = Math.max(1, Math.round((z.lat1 - z.lat0) / (dLat * 1.1)));
      const stepX = (z.lon1 - z.lon0) / subCols;
      const stepY = (z.lat1 - z.lat0) / subRows;
      for (let r = 0; r < subRows; r++) {
        for (let c = 0; c < subCols; c++) {
          const x0 = z.lon0 + c * stepX;
          const y0 = z.lat0 + r * stepY;
          const skew = (r % 2 === 0 ? 1 : -1) * stepX * 0.08;
          rawPolys.push({
            barrierZone: z.name,
            coords: [
              [x0, y0],
              [x0 + stepX, y0],
              [x0 + stepX + skew, y0 + stepY],
              [x0 + skew, y0 + stepY]
            ]
          });
        }
      }
    }
  }
  const shapeLabelNe = {
    rectangular: "\u0935\u0930\u094D\u0917\u093E\u0915\u093E\u0930 \u0917\u094D\u0930\u093F\u0921",
    triangular: "\u0924\u094D\u0930\u093F\u0915\u094B\u0923 \u0917\u094D\u0930\u093F\u0921",
    circular: "\u0935\u0943\u0924\u094D\u0924\u093E\u0915\u093E\u0930 \u0917\u094D\u0930\u093F\u0921",
    hexagonal: "\u0937\u091F\u094D\u092D\u0941\u091C \u0917\u094D\u0930\u093F\u0921",
    random: "\u092D\u094B\u0930\u094B\u0928\u094B\u0908 \u0917\u094D\u0930\u093F\u0921",
    straight_skeleton: "\u0905\u0935\u0930\u094B\u0927-\u0938\u091A\u0947\u0924 \u0917\u094D\u0930\u093F\u0921"
  };
  const results = [];
  let idx = 1;
  for (const item of rawPolys) {
    const c = computePolygonCentroid(item.coords);
    const anyVertexInside = item.coords.some((pt) => isPointInPolygon(pt, aoiRing));
    if (!isPointInPolygon(c, aoiRing) && !anyVertexInside) {
      continue;
    }
    const closed = closeRing(item.coords);
    const areaSqm = computePolygonAreaSqm(closed);
    if (areaSqm < 25) continue;
    const estBuildings = Math.max(4, Math.round(areaSqm / 420));
    results.push({
      id: `${projectId}-G${String(idx).padStart(3, "0")}`,
      grid_index: idx,
      name: `W${wardNo}-${gridShape.slice(0, 3).toUpperCase()}-${String(idx).padStart(3, "0")}`,
      name_ne: `${shapeLabelNe[gridShape]} #${idx}`,
      grid_shape: gridShape,
      status: "READY",
      coordinates: closed,
      centroid: c,
      area_sqm: areaSqm,
      estimated_buildings: estBuildings,
      ward_no: wardNo,
      barrier_zone: item.barrierZone,
      qa_flags: []
    });
    idx++;
  }
  if (results.length === 0 && aoiRing.length >= 3) {
    const closed = closeRing(aoiRing);
    const areaSqm = computePolygonAreaSqm(closed);
    results.push({
      id: `${projectId}-G001`,
      grid_index: 1,
      name: `W${wardNo}-${gridShape.slice(0, 3).toUpperCase()}-001`,
      name_ne: `${shapeLabelNe[gridShape]} #1`,
      grid_shape: gridShape,
      status: "READY",
      coordinates: closed,
      centroid: computePolygonCentroid(closed),
      area_sqm: areaSqm,
      estimated_buildings: Math.max(5, Math.round(areaSqm / 400)),
      ward_no: wardNo,
      qa_flags: []
    });
  }
  return results;
}
function transitionTaskState(params) {
  const { currentStatus, action, userRole, issueCategories, validatorComment } = params;
  const isValidatorOrAbove = userRole === "Validator" || userRole === "GisAdmin" || userRole === "SuperAdmin" || userRole === "DepartmentAdmin" || userRole === "MasterAdmin";
  if (action === "LOCK_FOR_MAPPING") {
    if (currentStatus !== "READY" && currentStatus !== "INVALIDATED") {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: `Cannot lock grid for mapping when status is ${currentStatus}.`,
        errorNe: `${currentStatus} \u0905\u0935\u0938\u094D\u0925\u093E\u092E\u093E \u0917\u094D\u0930\u093F\u0921 \u0932\u0915 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u0901\u0926\u0948\u0928\u0964`
      };
    }
    return { ok: true, nextStatus: "LOCKED_FOR_MAPPING" };
  }
  if (action === "UNLOCK") {
    if (currentStatus === "LOCKED_FOR_MAPPING") return { ok: true, nextStatus: "READY" };
    if (currentStatus === "LOCKED_FOR_VALIDATION") return { ok: true, nextStatus: "MAPPED" };
    return {
      ok: false,
      nextStatus: currentStatus,
      error: "Grid is not currently locked.",
      errorNe: "\u0917\u094D\u0930\u093F\u0921 \u0939\u093E\u0932 \u0932\u0915 \u0917\u0930\u093F\u090F\u0915\u094B \u091B\u0948\u0928\u0964"
    };
  }
  if (action === "SUBMIT_MAPPED") {
    if (currentStatus !== "LOCKED_FOR_MAPPING") {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: "Grid must be LOCKED_FOR_MAPPING before marking as MAPPED.",
        errorNe: "\u092E\u094D\u092F\u093E\u092A \u0938\u092E\u094D\u092A\u0928\u094D\u0928 \u0917\u0930\u094D\u0928 \u092A\u0939\u093F\u0932\u0947 \u0917\u094D\u0930\u093F\u0921 \u0932\u0915 \u0917\u0930\u093F\u090F\u0915\u094B \u0939\u0941\u0928\u0941\u092A\u0930\u094D\u091B\u0964"
      };
    }
    return { ok: true, nextStatus: "MAPPED" };
  }
  if (action === "LOCK_FOR_VALIDATION") {
    if (!isValidatorOrAbove) {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: "Only Validators or GIS Admins can lock grids for QA validation.",
        errorNe: "\u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923\u0915\u0930\u094D\u0924\u093E \u0935\u093E \u092A\u094D\u0930\u0936\u093E\u0938\u0915\u0932\u0947 \u092E\u093E\u0924\u094D\u0930 \u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923\u0915\u093E \u0932\u093E\u0917\u093F \u0917\u094D\u0930\u093F\u0921 \u0932\u0915 \u0917\u0930\u094D\u0928 \u0938\u0915\u094D\u091B\u0928\u094D\u0964"
      };
    }
    if (currentStatus !== "MAPPED") {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: "Only MAPPED grids can be locked for validation.",
        errorNe: "\u092E\u094D\u092F\u093E\u092A \u0938\u092E\u094D\u092A\u0928\u094D\u0928 (MAPPED) \u0917\u094D\u0930\u093F\u0921 \u092E\u093E\u0924\u094D\u0930 \u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u0928\u094D\u091B\u0964"
      };
    }
    return { ok: true, nextStatus: "LOCKED_FOR_VALIDATION" };
  }
  if (action === "VALIDATE") {
    if (!isValidatorOrAbove) {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: "Role unauthorized to validate task grids.",
        errorNe: "\u092F\u094B \u092D\u0942\u092E\u093F\u0915\u093E\u0932\u093E\u0908 \u0917\u094D\u0930\u093F\u0921 \u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923 \u0917\u0930\u094D\u0928\u0947 \u0905\u0928\u0941\u092E\u0924\u093F \u091B\u0948\u0928\u0964"
      };
    }
    if (currentStatus !== "LOCKED_FOR_VALIDATION" && currentStatus !== "MAPPED") {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: `Cannot validate grid from state ${currentStatus}.`,
        errorNe: `${currentStatus} \u0905\u0935\u0938\u094D\u0925\u093E\u092C\u093E\u091F \u092A\u094D\u0930\u092E\u093E\u0923\u0940\u0915\u0930\u0923 \u0917\u0930\u094D\u0928 \u0938\u0915\u093F\u0901\u0926\u0948\u0928\u0964`
      };
    }
    return { ok: true, nextStatus: "VALIDATED" };
  }
  if (action === "INVALIDATE") {
    if (!isValidatorOrAbove) {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: "Role unauthorized to invalidate task grids.",
        errorNe: "\u092F\u094B \u092D\u0942\u092E\u093F\u0915\u093E\u0932\u093E\u0908 \u0917\u094D\u0930\u093F\u0921 \u0905\u0938\u094D\u0935\u0940\u0915\u0943\u0924 \u0917\u0930\u094D\u0928\u0947 \u0905\u0928\u0941\u092E\u0924\u093F \u091B\u0948\u0928\u0964"
      };
    }
    if (!issueCategories || issueCategories.length === 0 || !validatorComment?.trim()) {
      return {
        ok: false,
        nextStatus: currentStatus,
        error: "Invalidation requires at least one Issue Category tag and a remediation comment for the DataCollector.",
        errorNe: "\u0905\u0938\u094D\u0935\u0940\u0915\u0943\u0924 \u0917\u0930\u094D\u0926\u093E \u0915\u092E\u094D\u0924\u093F\u092E\u093E \u090F\u0909\u091F\u093E \u0938\u092E\u0938\u094D\u092F\u093E \u0935\u0930\u094D\u0917 \u0930 \u0938\u0941\u0927\u093E\u0930 \u091F\u093F\u092A\u094D\u092A\u0923\u0940 \u0905\u0928\u093F\u0935\u093E\u0930\u094D\u092F \u091B\u0964"
      };
    }
    return { ok: true, nextStatus: "INVALIDATED" };
  }
  if (action === "FLAG_BAD_IMAGERY") {
    return { ok: true, nextStatus: "BAD_IMAGERY" };
  }
  return { ok: false, nextStatus: currentStatus, error: "Unknown action" };
}
function splitPolygonGeometry(ring, cutAngleDeg = 0, bladeCoords) {
  const pts = ring.length > 1 && ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1] ? ring.slice(0, -1) : ring;
  if (pts.length < 3) return [ring, ring];
  let a;
  let b;
  if (Array.isArray(bladeCoords) && bladeCoords.length >= 2) {
    const p0 = bladeCoords[0];
    const p1 = bladeCoords[bladeCoords.length - 1];
    const dx = p1[0] - p0[0];
    const dy = p1[1] - p0[1];
    const len = Math.hypot(dx, dy);
    if (len > 1e-8) {
      const ux = dx / len * 0.05;
      const uy = dy / len * 0.05;
      const mid = [(p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2];
      a = [mid[0] - ux, mid[1] - uy];
      b = [mid[0] + ux, mid[1] + uy];
    } else {
      const centroid = computePolygonCentroid(pts);
      const rad = cutAngleDeg * Math.PI / 180;
      a = [centroid[0] - Math.cos(rad) * 0.02, centroid[1] - Math.sin(rad) * 0.02];
      b = [centroid[0] + Math.cos(rad) * 0.02, centroid[1] + Math.sin(rad) * 0.02];
    }
  } else {
    const centroid = computePolygonCentroid(pts);
    const rad = cutAngleDeg * Math.PI / 180;
    const dir = [Math.cos(rad) * 0.02, Math.sin(rad) * 0.02];
    a = [centroid[0] - dir[0], centroid[1] - dir[1]];
    b = [centroid[0] + dir[0], centroid[1] + dir[1]];
  }
  let half1 = clipPolygonHalfPlane(pts, a, b);
  let half2 = clipPolygonHalfPlane(pts, b, a);
  if (half1.length < 3 || half2.length < 3) {
    const centroid = computePolygonCentroid(pts);
    const rad = cutAngleDeg * Math.PI / 180;
    const dir = [Math.cos(rad) * 0.02, Math.sin(rad) * 0.02];
    const ca = [centroid[0] - dir[0], centroid[1] - dir[1]];
    const cb = [centroid[0] + dir[0], centroid[1] + dir[1]];
    half1 = clipPolygonHalfPlane(pts, ca, cb);
    half2 = clipPolygonHalfPlane(pts, cb, ca);
  }
  return [closeRing(half1), closeRing(half2)];
}
function mergePolygonGeometries(ringA, ringB) {
  const all = [...ringA, ...ringB];
  if (all.length < 3) return ringA;
  const unique = Array.from(new Map(all.map((p) => [`${p[0].toFixed(7)},${p[1].toFixed(7)}`, p])).values());
  unique.sort((p1, p2) => p1[0] !== p2[0] ? p1[0] - p2[0] : p1[1] - p2[1]);
  if (unique.length < 3) return closeRing(unique);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const p of unique) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }
  const upper = [];
  for (let i = unique.length - 1; i >= 0; i--) {
    const p = unique[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }
  upper.pop();
  lower.pop();
  return closeRing([...lower, ...upper]);
}
function mergeGeometriesWithMode(geometries, mode = "union") {
  if (!Array.isArray(geometries) || geometries.length === 0) {
    return { type: "Polygon", coordinates: [[]] };
  }
  if (geometries.length === 1) {
    return geometries[0];
  }
  const firstType = String(geometries[0]?.type || "Polygon");
  if (firstType.includes("Polygon")) {
    const allPolygons = [];
    for (const g of geometries) {
      if (!g || !g.coordinates) continue;
      if (g.type === "Polygon") {
        allPolygons.push(g.coordinates);
      } else if (g.type === "MultiPolygon") {
        allPolygons.push(...g.coordinates);
      }
    }
    if (mode === "multifeature") {
      return {
        type: "MultiPolygon",
        coordinates: allPolygons
      };
    }
    let mergedRing = allPolygons[0]?.[0] || [];
    for (let i = 1; i < allPolygons.length; i++) {
      const nextRing = allPolygons[i]?.[0] || [];
      if (nextRing.length >= 3) {
        mergedRing = mergePolygonGeometries(mergedRing, nextRing);
      }
    }
    return {
      type: "Polygon",
      coordinates: [mergedRing]
    };
  }
  if (firstType.includes("LineString")) {
    const allLines = [];
    for (const g of geometries) {
      if (!g || !g.coordinates) continue;
      if (g.type === "LineString") {
        allLines.push(g.coordinates);
      } else if (g.type === "MultiLineString") {
        allLines.push(...g.coordinates);
      }
    }
    if (mode === "multifeature") {
      return {
        type: "MultiLineString",
        coordinates: allLines
      };
    }
    return {
      type: "LineString",
      coordinates: allLines.flat()
    };
  }
  const allPts = [];
  for (const g of geometries) {
    if (!g || !g.coordinates) continue;
    if (g.type === "Point") {
      allPts.push(g.coordinates);
    } else if (g.type === "MultiPoint") {
      allPts.push(...g.coordinates);
    }
  }
  return {
    type: "MultiPoint",
    coordinates: allPts
  };
}
function threeWayMergeFeature(params) {
  const {
    baseVersion,
    serverVersion,
    baseProperties,
    serverProperties,
    clientProperties,
    baseCoordinates,
    serverCoordinates,
    clientCoordinates
  } = params;
  if (baseVersion === serverVersion) {
    return {
      applyStatus: "APPLIED",
      mergedProperties: { ...serverProperties, ...clientProperties },
      mergedCoordinates: clientCoordinates,
      conflictingKeys: [],
      newVersion: serverVersion + 1
    };
  }
  const merged = { ...serverProperties };
  const conflictingKeys = [];
  const allKeys = /* @__PURE__ */ new Set([
    ...Object.keys(baseProperties),
    ...Object.keys(serverProperties),
    ...Object.keys(clientProperties)
  ]);
  for (const key of allKeys) {
    if (key.startsWith("_")) continue;
    const baseVal = JSON.stringify(baseProperties[key]);
    const srvVal = JSON.stringify(serverProperties[key]);
    const cliVal = JSON.stringify(clientProperties[key]);
    if (cliVal === baseVal) {
      merged[key] = serverProperties[key];
    } else if (srvVal === baseVal) {
      merged[key] = clientProperties[key];
    } else if (cliVal === srvVal) {
      merged[key] = clientProperties[key];
    } else {
      conflictingKeys.push(key);
      merged[key] = clientProperties[key];
    }
  }
  const baseGeomStr = JSON.stringify(baseCoordinates);
  const srvGeomStr = JSON.stringify(serverCoordinates);
  const cliGeomStr = JSON.stringify(clientCoordinates);
  let mergedCoords = serverCoordinates;
  if (cliGeomStr !== baseGeomStr) {
    if (srvGeomStr === baseGeomStr || srvGeomStr === cliGeomStr) {
      mergedCoords = clientCoordinates;
    } else {
      conflictingKeys.push("geometry");
      mergedCoords = clientCoordinates;
    }
  }
  return {
    applyStatus: conflictingKeys.length > 0 ? "CONFLICT" : "APPLIED",
    mergedProperties: merged,
    mergedCoordinates: mergedCoords,
    conflictingKeys,
    newVersion: serverVersion + 1
  };
}
function validateQuestionnaireSchema(questions) {
  const errors = [];
  const seenIds = /* @__PURE__ */ new Set();
  const snakeCaseRegex = /^[a-z][a-z0-9_]*$/;
  for (const q of questions) {
    if (!q.id || !snakeCaseRegex.test(q.id)) {
      errors.push(`Invalid question ID "${q.id}": must be snake_case.`);
    }
    if (seenIds.has(q.id)) {
      errors.push(`Duplicate question ID "${q.id}" detected.`);
    }
    seenIds.add(q.id);
    if ((q.type === "select_one" || q.type === "select_multiple" || q.type === "dropdown") && (!q.options || q.options.length === 0)) {
      errors.push(`Choice question "${q.id}" is missing options.`);
    }
  }
  const depMap = /* @__PURE__ */ new Map();
  for (const q of questions) {
    if (q.skipLogic?.dependsOnQuestionId) {
      depMap.set(q.id, q.skipLogic.dependsOnQuestionId);
    }
  }
  for (const startId of depMap.keys()) {
    const visited = /* @__PURE__ */ new Set();
    let curr = startId;
    while (curr) {
      if (visited.has(curr)) {
        errors.push(`Circular skip logic dependency detected involving "${startId}".`);
        break;
      }
      visited.add(curr);
      curr = depMap.get(curr);
    }
  }
  return { valid: errors.length === 0, errors };
}
function isQuestionVisible(question, answers) {
  if (!question.skipLogic) return true;
  const { dependsOnQuestionId, operator, value } = question.skipLogic;
  const actual = answers[dependsOnQuestionId];
  if (actual === void 0 || actual === null || actual === "") return false;
  if (operator === "equals") return String(actual) === String(value);
  if (operator === "not_equals") return String(actual) !== String(value);
  if (operator === "greater_than") return Number(actual) > Number(value);
  return true;
}
function computeAutomatedQaFlags(params) {
  const flags = [];
  const area = computePolygonAreaSqm(params.coordinates);
  if (params.coordinates.length >= 3 && area < 12) {
    flags.push("MICRO_GEOMETRY_ANOMALY (<12 sqm)");
  }
  if (params.gpsDistanceMeters > 50) {
    flags.push(`GPS_OFFSET_VIOLATION (${params.gpsDistanceMeters.toFixed(1)}m > 50m)`);
  }
  if (params.completionDurationSeconds < 15) {
    flags.push(`SPEED_ANOMALY_CURBSTONING (${params.completionDurationSeconds}s < 15s)`);
  }
  if (!params.hasPhoto) {
    flags.push("MISSING_EXIF_FIELD_PHOTO");
  }
  if (params.floorsCount !== void 0 && params.floorsCount > 15) {
    flags.push(`EXTREME_HEIGHT_VERIFICATION_REQUIRED (${params.floorsCount} floors)`);
  }
  return flags;
}
function computeMetricHouseNumber(params) {
  const { wardNo, roadCode, roadCoords, buildingCentroid } = params;
  if (roadCoords.length < 2) {
    return {
      houseNumberCode: `W${wardNo}-${roadCode}-0001L`,
      chainageMeters: 0,
      side: "LEFT",
      metricNumber: 1,
      offsetMeters: 0
    };
  }
  let bestDist = Infinity;
  let bestChainage = 0;
  let bestSide = "LEFT";
  let accumulated = 0;
  for (let i = 0; i < roadCoords.length - 1; i++) {
    const a = roadCoords[i];
    const b = roadCoords[i + 1];
    const segLen = haversineDistanceMeters(a, b);
    const px = (buildingCentroid[0] - a[0]) * METERS_PER_DEG_LON;
    const py = (buildingCentroid[1] - a[1]) * METERS_PER_DEG_LAT;
    const bx = (b[0] - a[0]) * METERS_PER_DEG_LON;
    const by = (b[1] - a[1]) * METERS_PER_DEG_LAT;
    const lenSq = bx * bx + by * by;
    const t = lenSq > 0 ? Math.max(0, Math.min(1, (px * bx + py * by) / lenSq)) : 0;
    const dist = Math.hypot(px - t * bx, py - t * by);
    if (dist < bestDist) {
      bestDist = dist;
      bestChainage = accumulated + t * segLen;
      const cross = bx * py - by * px;
      bestSide = cross >= 0 ? "LEFT" : "RIGHT";
    }
    accumulated += segLen;
  }
  const rawMetric = Math.max(1, Math.round(bestChainage));
  const metricNumber = bestSide === "LEFT" ? rawMetric % 2 === 1 ? rawMetric : rawMetric + 1 : rawMetric % 2 === 0 ? rawMetric : rawMetric + 1;
  const padded = String(metricNumber).padStart(4, "0");
  const suffix = bestSide === "LEFT" ? "L" : "R";
  return {
    houseNumberCode: `W${wardNo}-${roadCode}-${padded}${suffix}`,
    chainageMeters: Math.round(bestChainage * 10) / 10,
    side: bestSide,
    metricNumber,
    offsetMeters: Math.round(bestDist * 10) / 10
  };
}
export {
  computeAutomatedQaFlags,
  computeLineLengthMeters,
  computeMetricHouseNumber,
  computePolygonAreaSqm,
  computePolygonCentroid,
  generateSpatialGrid,
  haversineDistanceMeters,
  isPointInPolygon,
  isQuestionVisible,
  mergeGeometriesWithMode,
  mergePolygonGeometries,
  metersToDegrees,
  pointToPolygonDistanceMeters,
  pointToSegmentDistanceMeters,
  splitPolygonGeometry,
  threeWayMergeFeature,
  transitionTaskState,
  validateQuestionnaireSchema,
  verifyDoubleGeofence
};
