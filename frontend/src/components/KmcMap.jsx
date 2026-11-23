'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { Navigation, Crosshair, ZoomIn, ZoomOut, Maximize, X, Users, MapPin, ChevronLeft, ChevronRight, Compass, Plus, Minus } from 'lucide-react';
import { getDistanceToGeoJsonGeometry, GEOFENCE_EDIT_RADIUS_METERS } from '../lib/geoDistance';
import { getCollectorColor, extractFeatureCollector } from '../lib/collectorPalette';
import {
  flattenCoordinates,
  findNearestVertex as findNearestGeometryVertex,
  insertVertexAt,
  removeNearestVertex,
  describeEditFailure,
} from '../lib/geometryEditing';
import { buildHouseNumberBadgeDataUrl } from '../lib/houseNumberBadge';

// GPU Hardware Acceleration Enabled: Standard 2D canvas contexts with zero software CPU fallbacks

/**
 * Helper to validate bounding extent array [minX, minY, maxX, maxY]
 */
function isValidExtent(extent) {
  return (
    Array.isArray(extent) &&
    extent.length === 4 &&
    extent.every((val) => typeof val === 'number' && isFinite(val) && !isNaN(val)) &&
    extent[0] <= extent[2] &&
    extent[1] <= extent[3]
  );
}

/**
 * Helper to strictly validate and extract only real OpenLayers features with valid geometries
 */
function isValidOlFeature(f) {
  try {
    if (!f || typeof f.getGeometry !== 'function') return false;
    const geom = f.getGeometry();
    if (!geom || typeof geom.getExtent !== 'function') return false;
    const extent = geom.getExtent();
    if (!isValidExtent(extent)) return false;
    return true;
  } catch (e) {
    return false;
  }
}

function getValidOlFeatures(features) {
  if (!Array.isArray(features)) return [];
  const valid = [];
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    if (isValidOlFeature(f)) {
      valid.push(f);
    }
  }
  return valid;
}

/**
 * Ensures an OpenLayers feature is a full ol/Feature instance with standard geometry methods
 * (converting from ol/render/Feature or synthetic features if necessary).
 */
function ensureRealOlFeature(f, olModules) {
  if (!f) return null;
  // If it's already a full Feature with standard ol geometry methods
  if (typeof f.getGeometry === 'function') {
    const geom = f.getGeometry();
    if (geom && typeof geom.getType === 'function' && typeof geom.getCoordinates === 'function') {
      return f;
    }
  }
  if (!olModules) return f;
  const { Feature, Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon } = olModules;
  try {
    const type = typeof f.getType === 'function' ? f.getType() : 'Point';
    const flatCoords = typeof f.getFlatCoordinates === 'function' ? f.getFlatCoordinates() : [];
    const ends = typeof f.getEnds === 'function' ? f.getEnds() : null;
    const stride = typeof f.getStride === 'function' ? f.getStride() : 2;
    const props = typeof f.getProperties === 'function' ? { ...f.getProperties() } : {};
    const id = typeof f.getId === 'function' ? f.getId() : (props.id ?? props._id);

    let geom = null;
    if (type === 'Point' && Point) {
      geom = new Point(flatCoords.slice(0, stride));
    } else if (type === 'LineString' && LineString) {
      geom = new LineString(flatCoords, 'XY');
    } else if (type === 'Polygon' && Polygon) {
      geom = new Polygon(flatCoords, 'XY', ends);
    } else if (type === 'MultiPolygon' && MultiPolygon) {
      geom = new MultiPolygon(flatCoords, 'XY', ends);
    } else if (type === 'MultiLineString' && MultiLineString) {
      geom = new MultiLineString(flatCoords, 'XY', ends);
    } else if (type === 'MultiPoint' && MultiPoint) {
      geom = new MultiPoint(flatCoords, 'XY');
    }

    if (!geom || !Feature) return f;

    const realFeature = new Feature({ ...props, geometry: geom });
    if (id != null) realFeature.setId(id);
    return realFeature;
  } catch (err) {
    console.warn('[Map] ensureRealOlFeature conversion notice:', err);
    return f;
  }
}

/**
 * Prevents OpenLayers from destroying feature geometries when GeoJSON properties
 * contain a field named 'geometry' (common in Shapefile / QGIS / PostGIS exports).
 */
function sanitizeGeoJsonForOpenLayers(geoJsonData) {
  if (!geoJsonData) return geoJsonData;
  const cleanProps = (props) => {
    if (!props || typeof props !== 'object') return props;
    if (!('geometry' in props)) return props;
    const next = { ...props };
    next.geometry_prop = next.geometry;
    delete next.geometry;
    return next;
  };
  const cleanFeature = (f) => {
    if (!f || typeof f !== 'object') return f;
    if (f.properties && 'geometry' in f.properties) {
      return { ...f, properties: cleanProps(f.properties) };
    }
    return f;
  };
  if (geoJsonData.type === 'FeatureCollection' && Array.isArray(geoJsonData.features)) {
    return {
      ...geoJsonData,
      features: geoJsonData.features.map(cleanFeature),
    };
  }
  if (Array.isArray(geoJsonData)) {
    return geoJsonData.map(cleanFeature);
  }
  if (geoJsonData.type === 'Feature') {
    return cleanFeature(geoJsonData);
  }
  return geoJsonData;
}

/**
 * The three Nepali edit tools (ताने / बिस्तार / मेट्ने) are persisted with legacy
 * aliases ('modify', 'extend', 'deleteVertex'). These helpers keep every branch in
 * the map consistent so a tool can never half-apply because of an alias mismatch.
 */
const MOVE_SUB_MODES = ['tane', 'modify'];
const EXTEND_SUB_MODES = ['bistar', 'extend'];
const DELETE_SUB_MODES = ['metne', 'deleteVertex'];

function isMoveSubMode(subMode) {
  return MOVE_SUB_MODES.includes(subMode);
}
function isExtendSubMode(subMode) {
  return EXTEND_SUB_MODES.includes(subMode);
}
function isDeleteSubMode(subMode) {
  return DELETE_SUB_MODES.includes(subMode);
}

// How close (screen pixels) a बिस्तार click must be to the geometry to add a vertex.
const EXTEND_CLICK_TOLERANCE_PX = 28;


/**
 * Extracts clean, valid 2D coordinates from any OpenLayers geometry type
 */
function geometryToPlainGeoJSON(geom) {
  if (!geom) return null;
  try {
    return { type: geom.getType(), coordinates: geom.getCoordinates() };
  } catch (e) {
    return null;
  }
}

/**
 * Safely parses any GeoJSON structure (FeatureCollection, Feature, raw geometry, or JSON string)
 * into an array of OpenLayers Feature instances.
 */
function parseGeoJsonFeatures(geojsonInput, GeoJSONClass, featureProjection = 'EPSG:3857') {
  if (!geojsonInput || !GeoJSONClass) return [];
  try {
    let data = geojsonInput;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch (e) {
        return [];
      }
    }
    if (!data || typeof data !== 'object') return [];

    const format = new GeoJSONClass();
    if (data.type === 'FeatureCollection' && Array.isArray(data.features)) {
      return format.readFeatures(data, { featureProjection });
    }
    if (data.type === 'Feature') {
      const feat = format.readFeature(data, { featureProjection });
      return feat ? [feat] : [];
    }
    if (data.type && data.coordinates) {
      const feat = format.readFeature(
        { type: 'Feature', geometry: data, properties: {} },
        { featureProjection }
      );
      return feat ? [feat] : [];
    }
    return [];
  } catch (err) {
    console.warn('[Map] parseGeoJsonFeatures error:', err);
    return [];
  }
}

/**
 * Extracts clean, valid 2D coordinates from any OpenLayers geometry type.
 * Delegates to the shared ring/part-aware geometry engine so the edit tools and
 * the backend agree on vertex indexing (including polygon closing vertices).
 */
function extractCoordinatesFromGeometry(geom) {
  const plain = geometryToPlainGeoJSON(geom);
  return plain ? flattenCoordinates(plain) : [];
}

/**
 * Computes the minimum squared distance from point p to line segment (v, w).
 */
function distanceToSegmentSquared(p, v, w) {
  const l2 = (w[0] - v[0]) ** 2 + (w[1] - v[1]) ** 2;
  if (l2 === 0) return (p[0] - v[0]) ** 2 + (p[1] - v[1]) ** 2;
  const t = Math.max(0, Math.min(1, ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2));
  const projectionX = v[0] + t * (w[0] - v[0]);
  const projectionY = v[1] + t * (w[1] - v[1]);
  return (p[0] - projectionX) ** 2 + (p[1] - projectionY) ** 2;
}

/**
 * Checks if a 2D coordinate is within a tolerance distance of any boundary segment of a Polygon / MultiPolygon.
 */
function isPointNearPolygonBoundary(geom, coordinate, toleranceMapUnits = 20) {
  if (!geom || !coordinate) return false;
  const geomType = typeof geom.getType === 'function' ? geom.getType() : '';
  const tolSq = toleranceMapUnits * toleranceMapUnits;

  let ringsList = [];
  if (geomType === 'Polygon') {
    ringsList = geom.getCoordinates(); // array of linear rings
  } else if (geomType === 'MultiPolygon') {
    const polyList = geom.getCoordinates(); // array of polygons
    if (Array.isArray(polyList)) {
      polyList.forEach((poly) => {
        if (Array.isArray(poly)) {
          poly.forEach((r) => {
            if (Array.isArray(r)) ringsList.push(r);
          });
        }
      });
    }
  } else {
    // For non-polygon geometries (Point, LineString), any hit is already on the geometry
    return true;
  }

  for (let r = 0; r < ringsList.length; r++) {
    const ring = ringsList[r];
    if (!Array.isArray(ring) || ring.length < 2) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = ring[i];
      const p2 = ring[i + 1];
      if (distanceToSegmentSquared(coordinate, p1, p2) <= tolSq) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Finds the index of the vertex in olFeature geometry closest to clickCoord within tolerance.
 * Returns { index: number, coordinate: [x, y] } or null if none within tolerance.
 */
function findVertexIndexNearCoord(olFeature, clickCoord, toleranceMapUnits = 20) {
  const plain = geometryToPlainGeoJSON(olFeature && olFeature.getGeometry ? olFeature.getGeometry() : null);
  if (!plain) return null;
  return findNearestGeometryVertex(plain, clickCoord, toleranceMapUnits);
}

/**
 * Inserts targetCoord into geometry right adjacent to the selectedVertexIndex,
 * and returns the new global index of the inserted vertex.
 */
function insertCoordinateAtVertex(geom, targetCoord, selectedVertexIndex = null) {
  const plain = geometryToPlainGeoJSON(geom);
  if (!plain) return { ok: false, reason: 'unsupported' };
  const result = insertVertexAt(plain, targetCoord, selectedVertexIndex);
  if (!result.ok) return result;
  geom.setCoordinates(result.geometry.coordinates);
  return { ok: true, insertedIndex: result.insertedIndex };
}

/**
 * Renders vertex markers for the selected feature into snappingVerticesSource,
 * with the currently selected active vertex highlighted in RED.
 */
function renderSelectedFeatureVertices(olFeature, source, PointClass, FeatureClass, StyleClass, CircleStyleClass, FillClass, StrokeClass, selectedVertexIndex = null) {
  if (!source) return;
  source.clear();
  if (!olFeature || !PointClass || !FeatureClass || !StyleClass || !CircleStyleClass || !FillClass || !StrokeClass) return;
  const geom = olFeature.getGeometry();
  if (!geom) return;
  const coords = extractCoordinatesFromGeometry(geom);
  if (!coords || coords.length === 0) return;

  const vertexFeatures = coords.map((c, idx) => {
    const isSelected = (selectedVertexIndex !== null && selectedVertexIndex !== undefined && idx === selectedVertexIndex);
    const feat = new FeatureClass({
      geometry: new PointClass(c),
      vertexIndex: idx,
      isSelected,
    });

    if (isSelected) {
      // Selected active vertex: Vibrant RED (#dc2626) with pulsing red halo ring
      feat.setStyle([
        // Outer glowing red halo
        new StyleClass({
          image: new CircleStyleClass({
            radius: 12,
            stroke: new StrokeClass({ color: '#ef4444', width: 3 }),
            fill: new FillClass({ color: 'rgba(239, 68, 68, 0.35)' }),
          }),
        }),
        // Inner sharp red core with white border
        new StyleClass({
          image: new CircleStyleClass({
            radius: 6.5,
            fill: new FillClass({ color: '#dc2626' }),
            stroke: new StrokeClass({ color: '#ffffff', width: 2.5 }),
          }),
        }),
      ]);
    } else {
      // Regular vertex: Clean Cyan (#0284c7) with halo
      feat.setStyle([
        new StyleClass({
          image: new CircleStyleClass({
            radius: 8.5,
            stroke: new StrokeClass({ color: '#0284c7', width: 1.5 }),
            fill: new FillClass({ color: 'rgba(2, 132, 199, 0.2)' }),
          }),
        }),
        new StyleClass({
          image: new CircleStyleClass({
            radius: 4.5,
            fill: new FillClass({ color: '#0284c7' }),
            stroke: new StrokeClass({ color: '#ffffff', width: 1.5 }),
          }),
        }),
      ]);
    }
    return feat;
  });

  source.addFeatures(vertexFeatures);
}

/**
 * Extends or appends a coordinate to any OpenLayers geometry type
 */


/**
 * Removes the vertex closest to targetCoord within tolerance from olFeature
 */
function removeNearestVertexFromFeature(olFeature, targetCoord, toleranceMapUnits = 50) {
  const geom = olFeature && olFeature.getGeometry ? olFeature.getGeometry() : null;
  const plain = geometryToPlainGeoJSON(geom);
  if (!plain) return { ok: false, reason: 'unsupported' };
  const result = removeNearestVertex(plain, targetCoord, toleranceMapUnits);
  if (!result.ok) return result;
  geom.setCoordinates(result.geometry.coordinates);
  return { ok: true, removedIndex: result.removedIndex };
}

/**
 * Calculates perpendicular / minimum distance from point p to segment [v, w]
 */
function distToSegment(p, v, w) {
  const l2 = (w[0] - v[0]) * (w[0] - v[0]) + (w[1] - v[1]) * (w[1] - v[1]);
  if (l2 === 0) return Math.hypot(p[0] - v[0], p[1] - v[1]);
  let t = ((p[0] - v[0]) * (w[0] - v[0]) + (p[1] - v[1]) * (w[1] - v[1])) / l2;
  t = Math.max(0, Math.min(1, t));
  const projX = v[0] + t * (w[0] - v[0]);
  const projY = v[1] + t * (w[1] - v[1]);
  return Math.hypot(p[0] - projX, p[1] - projY);
}

/**
 * Iterates every segment [a, b] of an OL geometry (all parts / rings).
 */
function forEachSegment(geom, cb) {
  if (!geom || typeof cb !== 'function') return;
  const type = typeof geom.getType === 'function' ? geom.getType() : '';
  if (!type) return;
  const eachPair = (coords) => {
    if (!Array.isArray(coords)) return;
    for (let i = 0; i + 1 < coords.length; i++) {
      const a = coords[i];
      const b = coords[i + 1];
      if (
        a && b && a.length >= 2 && b.length >= 2 &&
        isFinite(a[0]) && isFinite(a[1]) && isFinite(b[0]) && isFinite(b[1])
      ) {
        cb(a, b);
      }
    }
  };
  if (type === 'LineString') {
    eachPair(geom.getCoordinates());
  } else if (type === 'Polygon' || type === 'MultiLineString') {
    (geom.getCoordinates() || []).forEach(eachPair);
  } else if (type === 'MultiPolygon') {
    (geom.getCoordinates() || []).forEach((poly) => {
      (poly || []).forEach(eachPair);
    });
  } else if (type === 'GeometryCollection' && typeof geom.getGeometries === 'function') {
    (geom.getGeometries() || []).forEach((g) => forEachSegment(g, cb));
  }
}

/**
 * Continuously searches all visible vector layer sources for the closest snap point
 * within tolerance in pixels.
 *
 * QGIS-style behavior: snaps to VERTICES first, then to SEGMENTS (edges). Segment
 * snapping is what makes snapping work when zoomed very far in — the click usually
 * lands mid-segment between two far-apart vertices, where vertex-only snapping
 * would find nothing within tolerance.
 */
function findNearestVertex(map, pixel, visibleSources, tolerancePx) {
  if (!map || !pixel || !Array.isArray(visibleSources) || visibleSources.length === 0) return null;
  const coord = map.getCoordinateFromPixel(pixel);
  if (!coord) return null;
  const view = map.getView();
  if (!view) return null;
  const resolution = view.getResolution();
  if (!resolution) return null;

  const mapTolerance = tolerancePx * resolution;
  const extent = [
    coord[0] - mapTolerance,
    coord[1] - mapTolerance,
    coord[0] + mapTolerance,
    coord[1] + mapTolerance,
  ];

  let bestVertex = null; // { coordinate, pixelDist, feature }
  let bestSegment = null; // { coordinate, pixelDist, feature }

  const checkFeature = (feature) => {
    if (!feature) return;
    const geom = feature.getGeometry ? feature.getGeometry() : null;
    if (!geom) return;

    // 1. Vertices (highest priority, like QGIS)
    const coords = extractCoordinatesFromGeometry(geom);
    for (let i = 0; i < coords.length; i++) {
      const c = coords[i];
      if (!c || c.length < 2) continue;
      const vertexPixel = map.getPixelFromCoordinate(c);
      if (!vertexPixel) continue;
      const dist = Math.hypot(vertexPixel[0] - pixel[0], vertexPixel[1] - pixel[1]);
      if (dist <= tolerancePx && (!bestVertex || dist < bestVertex.pixelDist)) {
        bestVertex = { coordinate: c, pixelDist: dist, feature };
      }
    }

    // 2. Segments / edges (project click point onto each segment)
    const geomType = geom.getType ? geom.getType() : '';
    if (geomType === 'Point' || geomType === 'MultiPoint') return;
    forEachSegment(geom, (a, b) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l2 = dx * dx + dy * dy;
      let t = 0;
      if (l2 > 0) {
        t = ((coord[0] - a[0]) * dx + (coord[1] - a[1]) * dy) / l2;
        t = Math.max(0, Math.min(1, t));
      }
      const px = a[0] + t * dx;
      const py = a[1] + t * dy;
      const distMap = Math.hypot(coord[0] - px, coord[1] - py);
      if (distMap <= mapTolerance) {
        const pixelDist = distMap / resolution;
        if (pixelDist <= tolerancePx && (!bestSegment || pixelDist < bestSegment.pixelDist)) {
          bestSegment = { coordinate: [px, py], pixelDist, feature };
        }
      }
    });
  };

  visibleSources.forEach((source) => {
    if (!source) return;
    if (typeof source.forEachFeatureInExtent === 'function') {
      try {
        source.forEachFeatureInExtent(extent, checkFeature);
      } catch (e) {
        // safe fallback
      }
    }
    if (source._tileSource && typeof source._tileSource.getFeaturesInExtent === 'function') {
      try {
        const tileFeats = source._tileSource.getFeaturesInExtent(extent) || [];
        for (let i = 0; i < tileFeats.length; i++) {
          checkFeature(tileFeats[i]);
        }
      } catch (e) {
        // safe fallback
      }
    }
  });

  // Vertex matches win over segment matches (QGIS priority)
  const best = bestVertex || bestSegment;
  return best
    ? {
        coordinate: best.coordinate,
        distance: best.pixelDist,
        feature: best.feature,
        snappedTo: bestVertex ? 'vertex' : 'segment',
      }
    : null;
}

// Flatten raw OpenLayers coordinate arrays into [x, y] pairs.
function flattenCoordinatePairs(coords, out = []) {
  if (!Array.isArray(coords) || coords.length === 0) return out;
  if (typeof coords[0] === 'number') {
    out.push(coords);
    return out;
  }
  coords.forEach((c) => flattenCoordinatePairs(c, out));
  return out;
}

// A collector may only add/move vertices that fall inside one of their grids.
// Unchanged vertices may stay outside (a feature can straddle two grids).
function changedVerticesOutsideGrids(grids, oldGeom, newGeom) {
  if (!Array.isArray(grids) || grids.length === 0) return [];
  if (!newGeom || typeof newGeom.getCoordinates !== 'function') return [];

  const keyOf = (c) => `${Number(c[0]).toFixed(6)},${Number(c[1]).toFixed(6)}`;
  const remainingOld = new Map();
  const oldCoords = oldGeom && typeof oldGeom.getCoordinates === 'function'
    ? flattenCoordinatePairs(oldGeom.getCoordinates())
    : [];
  oldCoords.forEach((c) => {
    const k = keyOf(c);
    remainingOld.set(k, (remainingOld.get(k) || 0) + 1);
  });

  const outside = [];
  flattenCoordinatePairs(newGeom.getCoordinates()).forEach((c) => {
    const k = keyOf(c);
    if ((remainingOld.get(k) || 0) > 0) {
      remainingOld.set(k, remainingOld.get(k) - 1);
      return;
    }
    if (!grids.some((g) => typeof g.intersectsCoordinate === 'function' && g.intersectsCoordinate(c))) {
      outside.push(c);
    }
  });
  return outside;
}

/**
 * KmcMap — OpenLayers Multi-Layer Map Engine
 * 
 * Features:
 * - Basemaps: OSM, Esri Satellite, Google Earth, No Basemap
 * - Multi-layer Server Raster (XYZ MBTiles from TileServer-GL)
 * - Multi-layer Server Vector (PostGIS GeoJSON datasets) with complete error isolation
 * - Zoom-to-Layer capability for any vector or raster dataset
 * - Task grid layer with status-based styling
 * - Live GPS tracking with accuracy circle
 * - Vector feature drawing (Point/Line/Polygon)
 */
export default function KmcMap({
  gpsPosition,
  taskGrids,
  serverVectors = [], // [{ id, name, visible, opacity, features, geometry_type }]
  serverRasters = [], // [{ id, name, visible, opacity, bounds }]
  layerOrderingConfig = null, // Dynamic stacking strategy & custom ranks
  activeBasemap = 'google',
  basemapOpacity = 100,
  zoomTarget = null, // { type: 'vector'|'raster', id, bounds, timestamp }
  selectedTask,
  onTaskClick,
  onFeatureCreate,
  editingGeometry = null, // GeoJSON geometry for newly created feature persistence while field form is open
  drawMode = null, // 'Point', 'LineString', 'Polygon', null
  activeLayerId = null,
  editMode = false,
  editLayerId = null,
  selectedFeature = null,
  inspectedFeature = null,
  selectedFeatureId = null,
  onFeatureSelect = null,
  onFeatureModifyEnd = null,
  snappingEnabled = true,
  snapTolerance = 15,
  onSnappingToggle = null,
  geometryUpdateTrigger = null, // { featureId, geometry, timestamp } for Undo/Redo/Revert
  drawUndoTrigger = null, // { action: 'undo', timestamp } for Draw Undo
  drawRedoTrigger = null, // { action: 'redo', timestamp } for Draw Redo
  onDrawVertexChange = null, // ({ undoCount, redoCount }) => void
  onFeatureInspect = null, // ({ id, layerId, layerName, geometryType, properties, geometry, extent, isWithinAssignedGrid }) => void
  inspectedFeatureId = null,
  drawnBoundary = null, // GeoJSON geometry for task grid canvas drawing preview
  aoiBoundary = null, // persisted project AOI boundary (GeoJSON) rendered as a reference layer
  showTaskGrids = true, // toggle: task grid cells visible
  showAoiBoundary = true, // toggle: project AOI boundary visible
  isTaskPanelOpen = false,
  isCollector = false,
  onFeatureBlocked = null, // ({ reason, message }) => void
  editSubMode = null, // null (none selected = all allowed) | 'tane' | 'bistar' | 'metne'
  outlinedTaskIds = new Set(),
  outlineAllTasks = false,
  pickLinkedFeatureMode = false,
  selectedLinkedFeatureId = null,
  selectedLinkedLayerId = null,
  onLinkedFeatureSelect = null,
  collectorLocations = [],
  showCollectorLocations = false,
  onCollectorSelect = null,
  currentUser = null,
  isAdmin = false,
  // QGIS-style split & merge tools (field data collection edit mode)
  splitBladeMode = false, // when true, draw a blade LineString across the selected feature to split it
  onSplitBladeDrawn = null, // (bladeGeoJSON geometry) => void
  mergeSelectMode = false, // when true, map clicks toggle features into mergeSelection
  mergeSelection = [], // [featureId, ...] currently picked for merge
  onMergeToggleFeature = null, // ({ id }) => void
  // Large-layer viewport (bbox) loading
  onBboxLoadFeatures = null, // async (layerId, bboxStr) => GeoJSON FeatureCollection
  bboxReloadTrigger = null, // { layerId, timestamp } -> refresh the bbox source
  // Linked partner features to highlight on map canvas (visual link verification)
  linkedHighlightFeatures = [],
  showHouseNumbers = false,
  individualHouseNumberFeatureId = null,
}) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const [inspectedCollector, setInspectedCollector] = useState(null);
  const [inspectedCollectorCluster, setInspectedCollectorCluster] = useState([]);
  const [clusterMemberIndex, setClusterMemberIndex] = useState(0);
  const [mapRotation, setMapRotation] = useState(0);
  const layersRef = useRef({
    basemaps: {},
    taskLayer: null,
    taskSource: null,
    gpsLayer: null,
    gpsSource: null,
    collectorTrackingLayer: null,
    collectorTrackingSource: null,
    snappingVerticesLayer: null,
    snappingVerticesSource: null,
    snapIndicatorLayer: null,
    snapIndicatorSource: null,
    featureHighlightLayer: null,
    featureHighlightSource: null,
    sketchPreviewLayer: null,
    sketchPreviewSource: null,
    mergeHighlightLayer: null,
    mergeHighlightSource: null,
    serverRasters: {}, // { [id]: TileLayer }
    serverVectors: {}, // { [id]: { layer: VectorLayer, source: VectorSource } }
  });
  const drawInteractionRef = useRef(null);
  const sketchFeatureRef = useRef(null);
  const drawRedoStackRef = useRef([]);
  const drawUndoCountRef = useRef(0);
  const selectInteractionRef = useRef(null);
  const modifyInteractionRef = useRef(null);
  const snapInteractionsRef = useRef([]);
  const snapIndicatorSourceRef = useRef(null);
  const snappingVerticesSourceRef = useRef(null);
  const featureHighlightSourceRef = useRef(null);
  const hoveredFeatureRef = useRef(null);
  const inspectedFeatureRef = useRef(null);
  const selectedOlFeatureRef = useRef(null);
  const lastActiveFeatureRef = useRef(null);
  const lastActiveOriginalGeomRef = useRef(null);
  const isModifyingRef = useRef(false);
  const modifyTimerRef = useRef(null);
  const selectedVertexIndexRef = useRef(null);
  const modifyOriginalGeomRef = useRef(null);

  const drawModeRef = useRef(drawMode);
  const activeLayerIdRef = useRef(activeLayerId);
  const editModeRef = useRef(editMode);
  const editLayerIdRef = useRef(editLayerId);
  const snappingEnabledRef = useRef(snappingEnabled);
  const snapToleranceRef = useRef(snapTolerance);
  const serverVectorsRef = useRef(serverVectors);
  const selectedTaskRef = useRef(selectedTask);
  const onTaskClickRef = useRef(onTaskClick);
  const showTaskGridsRef = useRef(showTaskGrids);
  const showAoiBoundaryRef = useRef(showAoiBoundary);
  const isTaskPanelOpenRef = useRef(isTaskPanelOpen);
  const showHouseNumbersRef = useRef(showHouseNumbers);
  const individualHouseNumberFeatureIdRef = useRef(individualHouseNumberFeatureId);
  const onFeatureInspectRef = useRef(onFeatureInspect);
  const inspectedFeatureIdRef = useRef(inspectedFeatureId);
  const isCollectorRef = useRef(isCollector);
  const onFeatureBlockedRef = useRef(onFeatureBlocked);
  const editSubModeRef = useRef(editSubMode);
  const outlinedTaskIdsRef = useRef(outlinedTaskIds);
  const outlineAllTasksRef = useRef(outlineAllTasks);
  const pickLinkedFeatureModeRef = useRef(pickLinkedFeatureMode);
  const onLinkedFeatureSelectRef = useRef(onLinkedFeatureSelect);
  const gpsPositionRef = useRef(gpsPosition);
  const splitBladeModeRef = useRef(splitBladeMode);
  const onSplitBladeDrawnRef = useRef(onSplitBladeDrawn);
  const mergeSelectModeRef = useRef(mergeSelectMode);
  const mergeSelectionRef = useRef(mergeSelection);
  const onMergeToggleFeatureRef = useRef(onMergeToggleFeature);
  const onBboxLoadFeaturesRef = useRef(onBboxLoadFeatures);
  const splitDrawRef = useRef(null);
  const isDrawingBladeRef = useRef(false);
  const mergeHighlightSourceRef = useRef(null);
  const [bboxLoadingIds, setBboxLoadingIds] = useState([]);

  // Helper to check if a vector layer allows snapping (configured by Admin)
  const isLayerSnappable = useCallback((layerId) => {
    if (!layerId) return true;
    const lData = (serverVectorsRef.current || []).find((v) => String(v.id) === String(layerId));
    return lData ? (lData.allow_snapping !== false) : true;
  }, []);

  // Per-layer click proximity in pixels (GIS Admin configurable via layer style).
  // Makes features easy to click when near, without exact pinpointing.
  const getLayerClickTolerance = useCallback((layerId) => {
    const DEFAULT_TOL = 14;
    if (!layerId) return DEFAULT_TOL;
    const lData = (serverVectorsRef.current || []).find((v) => String(v.id) === String(layerId));
    const t = lData && lData.style ? Number(lData.style.clickTolerance) : NaN;
    return Number.isFinite(t) && t >= 2 && t <= 60 ? t : DEFAULT_TOL;
  }, []);

  useEffect(() => {
    drawModeRef.current = drawMode;
    activeLayerIdRef.current = activeLayerId;
    editModeRef.current = editMode;
    editLayerIdRef.current = editLayerId;
    snappingEnabledRef.current = snappingEnabled;
    snapToleranceRef.current = snapTolerance;
    serverVectorsRef.current = serverVectors;
    onFeatureInspectRef.current = onFeatureInspect;
    inspectedFeatureIdRef.current = inspectedFeatureId;
    isCollectorRef.current = isCollector;
    onFeatureBlockedRef.current = onFeatureBlocked;
    editSubModeRef.current = editSubMode;
    outlinedTaskIdsRef.current = outlinedTaskIds;
    outlineAllTasksRef.current = outlineAllTasks;
    pickLinkedFeatureModeRef.current = pickLinkedFeatureMode;
    onLinkedFeatureSelectRef.current = onLinkedFeatureSelect;
    gpsPositionRef.current = gpsPosition;
    splitBladeModeRef.current = splitBladeMode;
    onSplitBladeDrawnRef.current = onSplitBladeDrawn;
    mergeSelectModeRef.current = mergeSelectMode;
    mergeSelectionRef.current = mergeSelection;
    onMergeToggleFeatureRef.current = onMergeToggleFeature;
    onBboxLoadFeaturesRef.current = onBboxLoadFeatures;
    selectedTaskRef.current = selectedTask;
    onTaskClickRef.current = onTaskClick;
    showTaskGridsRef.current = showTaskGrids;
    showAoiBoundaryRef.current = showAoiBoundary;
    isTaskPanelOpenRef.current = isTaskPanelOpen;
    showHouseNumbersRef.current = showHouseNumbers;
    individualHouseNumberFeatureIdRef.current = individualHouseNumberFeatureId;
  }, [drawMode, activeLayerId, editMode, editLayerId, snappingEnabled, snapTolerance, serverVectors, onFeatureInspect, inspectedFeatureId, isCollector, onFeatureBlocked, editSubMode, outlinedTaskIds, outlineAllTasks, pickLinkedFeatureMode, onLinkedFeatureSelect, gpsPosition, splitBladeMode, onSplitBladeDrawn, mergeSelectMode, mergeSelection, onMergeToggleFeature, onBboxLoadFeatures, selectedTask, onTaskClick, showTaskGrids, showAoiBoundary, isTaskPanelOpen, showHouseNumbers, individualHouseNumberFeatureId]);

  // Sync house number label display across vector layers
  useEffect(() => {
    showHouseNumbersRef.current = showHouseNumbers;
    individualHouseNumberFeatureIdRef.current = individualHouseNumberFeatureId;
    if (layersRef.current.serverVectors) {
      Object.values(layersRef.current.serverVectors).forEach((obj) => {
        if (obj && obj.layer) obj.layer.changed();
        if (obj && obj.tileLayer) obj.tileLayer.changed();
        if (obj && obj.editLayer) obj.editLayer.changed();
      });
    }
  }, [showHouseNumbers, individualHouseNumberFeatureId]);

  // ---- Sync task grid outline mode across tasks ----
  useEffect(() => {
    outlinedTaskIdsRef.current = outlinedTaskIds;
    outlineAllTasksRef.current = outlineAllTasks;
    if (layersRef.current.taskLayer) {
      layersRef.current.taskLayer.changed();
    }
    if (layersRef.current.aoiLayer) {
      layersRef.current.aoiLayer.changed();
    }
    if (layersRef.current.drawnBoundaryLayer) {
      layersRef.current.drawnBoundaryLayer.changed();
    }
  }, [outlinedTaskIds, outlineAllTasks]);

  // ---- Sync Modify interaction active state with editSubMode, splitBladeMode, and mergeSelectMode ----
  useEffect(() => {
    if (modifyInteractionRef.current) {
      if (splitBladeMode || mergeSelectMode || isExtendSubMode(editSubMode) || isDeleteSubMode(editSubMode)) {
        modifyInteractionRef.current.setActive(false);
      } else {
        modifyInteractionRef.current.setActive(true);
      }
    }
  }, [editSubMode, splitBladeMode, mergeSelectMode]);

  const [olLoaded, setOlLoaded] = useState(false);
  const [olModules, setOlModules] = useState(null);

  // ---- Dynamic OpenLayers import (SSR-safe) ----
  useEffect(() => {
    const loadOL = async () => {
      try {
        const [
          { default: Map },
          { default: View },
          { default: TileLayer },
          { default: VectorLayer },
          { default: VectorTileLayer },
          { default: OSM },
          { default: XYZ },
          { default: VectorSource },
          { default: VectorTileSource },
          { default: MVT },
          { default: GeoJSON },
          { default: Style },
          { default: Fill },
          { default: Stroke },
          { default: CircleStyle },
          { default: Feature },
          { default: Point },
          { default: MultiPoint },
          { default: LineString },
          { default: Draw },
          { default: Snap },
          { default: Select },
          { default: Modify },
          { fromLonLat, toLonLat, transformExtent },
          { default: CircleGeom },
          { default: TextStyle },
          { default: Icon },
          { bbox: bboxStrategy },
          { default: ImageLayer },
          { default: ImageStatic },
        ] = await Promise.all([
          import('ol/Map'),
          import('ol/View'),
          import('ol/layer/Tile'),
          import('ol/layer/Vector'),
          import('ol/layer/VectorTile'),
          import('ol/source/OSM'),
          import('ol/source/XYZ'),
          import('ol/source/Vector'),
          import('ol/source/VectorTile'),
          import('ol/format/MVT'),
          import('ol/format/GeoJSON'),
          import('ol/style/Style'),
          import('ol/style/Fill'),
          import('ol/style/Stroke'),
          import('ol/style/Circle'),
          import('ol/Feature'),
          import('ol/geom/Point'),
          import('ol/geom/MultiPoint'),
          import('ol/geom/LineString'),
          import('ol/interaction/Draw'),
          import('ol/interaction/Snap'),
          import('ol/interaction/Select'),
          import('ol/interaction/Modify'),
          import('ol/proj'),
          import('ol/geom/Circle'),
          import('ol/style/Text'),
          import('ol/style/Icon'),
          import('ol/loadingstrategy'),
          import('ol/layer/Image'),
          import('ol/source/ImageStatic'),
        ]);

        setOlModules({
          Map, View, TileLayer, VectorLayer, VectorTileLayer, ImageLayer, ImageStatic, OSM, XYZ, VectorSource, VectorTileSource, MVT, GeoJSON,
          Style, Fill, Stroke, CircleStyle, Circle: CircleStyle, TextStyle, Text: TextStyle, Icon, Feature, Point, MultiPoint, LineString, Draw, Snap,
          Select, Modify, CircleGeom, fromLonLat, toLonLat, transformExtent, bboxStrategy,
        });
        setOlLoaded(true);
      } catch (err) {
        console.error('[Map] Failed to load OpenLayers modules:', err);
      }
    };

    loadOL();
  }, []);

  // ---- Initialize Map ----
  useEffect(() => {
    if (!olLoaded || !olModules || !mapRef.current || mapInstance.current) return;

    let ro = null;
    try {
      const {
        Map, View, TileLayer, OSM, XYZ, VectorLayer, VectorSource, fromLonLat,
        Style, Fill, Stroke, CircleStyle, Feature, Point, MultiPoint, GeoJSON, TextStyle,
      } = olModules;

      // Basemap layers
      const osmLayer = new TileLayer({
        source: new OSM(),
        visible: activeBasemap === 'osm',
        opacity: basemapOpacity / 100,
      });

      const esriLayer = new TileLayer({
        source: new XYZ({
          url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          maxZoom: 19,
        }),
        visible: activeBasemap === 'esri',
        opacity: basemapOpacity / 100,
      });

      const googleLayer = new TileLayer({
        source: new XYZ({
          url: 'https://mt{0-3}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}',
          maxZoom: 20,
        }),
        visible: activeBasemap === 'google',
        opacity: basemapOpacity / 100,
      });

      // Task grid vector layer
      const taskSource = new VectorSource();
      const taskLayer = new VectorLayer({
        source: taskSource,
        zIndex: 750,
        declutter: true,
        renderBuffer: 100,
        style: (feature, resolution) => {
          const status = feature.get('status');
          const isAssigned = !!feature.get('assigned_to');
          const rawId = feature.getId() ?? feature.get('id') ?? feature.get('_id') ?? (feature.get('properties') || {}).id;
          const curSelected = selectedTaskRef.current;
          const selectedId = curSelected?.id ?? curSelected?.properties?.id;
          const isSelected = rawId !== undefined && selectedId !== undefined && String(rawId) === String(selectedId);
          const gridIndex = feature.get('grid_index');
          const assignedName = feature.get('assigned_to_name');

          const colors = {
            READY: isAssigned ? 'rgba(4, 71, 175, 0.25)' : 'rgba(14, 165, 233, 0.16)',
            LOCKED_FOR_MAPPING: 'rgba(245, 158, 11, 0.35)',
            MAPPED: 'rgba(16, 185, 129, 0.35)',
            LOCKED_FOR_VALIDATION: 'rgba(139, 92, 246, 0.35)',
            VALIDATED: 'rgba(6, 182, 212, 0.35)',
            INVALIDATED: 'rgba(239, 68, 68, 0.35)',
          };
          const strokes = {
            READY: isAssigned ? '#0447af' : '#0284c7',
            LOCKED_FOR_MAPPING: '#d97706',
            MAPPED: '#059669',
            LOCKED_FOR_VALIDATION: '#7c3aed',
            VALIDATED: '#0891b2',
            INVALIDATED: '#c8102e',
          };

          const taskId = feature.get('id');
          const isOutlined = outlineAllTasksRef.current || (
            outlinedTaskIdsRef.current && (
              outlinedTaskIdsRef.current instanceof Set
                ? outlinedTaskIdsRef.current.has(taskId)
                : Array.isArray(outlinedTaskIdsRef.current) && outlinedTaskIdsRef.current.includes(taskId)
            )
          );

          const strokeStyle = new Stroke({
            color: isSelected ? '#eab308' : (strokes[status] || '#0284c7'),
            width: isSelected ? 4.5 : (isOutlined ? 3.0 : (isAssigned ? 2.5 : 2.0)),
            lineDash: isSelected ? undefined : ((!isAssigned && status === 'READY' && !isOutlined) ? [6, 4] : undefined),
          });

          // Only render text label when zoomed in or when selected for ultra-smooth 60fps performance
          const showLabel = isSelected || (resolution < 6.0 && gridIndex);
          const labelText = showLabel && gridIndex ? `#${gridIndex}${assignedName ? ` (${assignedName.split(' ')[0]})` : ''}` : '';

          const fillColor = isSelected
            ? 'rgba(234, 179, 8, 0.40)'
            : (isOutlined ? 'rgba(0, 0, 0, 0)' : (colors[status] || 'rgba(14, 165, 233, 0.15)'));

          return new Style({
            fill: new Fill({ color: fillColor }),
            stroke: strokeStyle,
            zIndex: isSelected ? 100 : 1,
            text: showLabel && TextStyle && labelText ? new TextStyle({
              text: labelText,
              font: isSelected ? 'bold 13px sans-serif' : 'bold 10px sans-serif',
              fill: new Fill({ color: isSelected ? '#0447af' : '#0f172a' }),
              stroke: new Stroke({ color: '#ffffff', width: isSelected ? 3 : 2.5 }),
              overflow: false,
            }) : undefined,
          });
        },
      });

      // Drawn Boundary preview layer (for Task Grid Canvas Drawing Area)
      const drawnBoundarySource = new VectorSource();
      const drawnBoundaryLayer = new VectorLayer({
        source: drawnBoundarySource,
        zIndex: 15,
        style: () => {
          const outlineOnly = Boolean(outlineAllTasksRef.current);
          return new Style({
            fill: new Fill({ color: outlineOnly ? 'rgba(0, 0, 0, 0)' : 'rgba(4, 71, 175, 0.14)' }),
            stroke: new Stroke({
              color: '#f59e0b',
              width: outlineOnly ? 4 : 3.5,
              lineDash: [8, 6],
            }),
          });
        },
      });

      // Persisted project AOI boundary (reference layer, below the task grids)
      const aoiSource = new VectorSource();
      const aoiLayer = new VectorLayer({
        source: aoiSource,
        zIndex: 12,
        style: () => {
          const outlineOnly = Boolean(outlineAllTasksRef.current);
          return new Style({
            fill: new Fill({ color: outlineOnly ? 'rgba(0, 0, 0, 0)' : 'rgba(217, 119, 6, 0.10)' }),
            stroke: new Stroke({
              color: '#b45309',
              width: outlineOnly ? 4 : 3,
              lineDash: [10, 6],
            }),
          });
        },
      });

      // GPS position layer
      const gpsSource = new VectorSource();
      const gpsLayer = new VectorLayer({
        source: gpsSource,
        zIndex: 800,
      });

      // Real-Time Collector Fleet Tracking Layer (with Co-Location Spider Support)
      const collectorTrackingSource = new VectorSource();
      const collectorTrackingLayer = new VectorLayer({
        source: collectorTrackingSource,
        zIndex: 810,
        style: (feature) => {
          const isAccuracyCircle = feature.get('isAccuracyCircle');
          const isSpiderLeg = feature.get('isSpiderLeg');
          const isCoLocationHub = feature.get('isCoLocationHub');
          const isOnline = feature.get('is_online');

          if (isAccuracyCircle) {
            return new Style({
              fill: new Fill({ color: isOnline ? 'rgba(16, 185, 129, 0.12)' : 'rgba(100, 116, 139, 0.08)' }),
              stroke: new Stroke({
                color: isOnline ? 'rgba(16, 185, 129, 0.55)' : 'rgba(100, 116, 139, 0.35)',
                width: 1.5,
                lineDash: [5, 4],
              }),
            });
          }

          if (isSpiderLeg) {
            return new Style({
              stroke: new Stroke({
                color: isOnline ? '#10b981' : '#94a3b8',
                width: 2,
                lineDash: [4, 4],
              }),
            });
          }

          if (isCoLocationHub) {
            const members = feature.get('clusterMembers') || [];
            const count = members.length;
            return [
              new Style({
                image: new CircleStyle({
                  radius: 8,
                  fill: new Fill({ color: '#1e293b' }),
                  stroke: new Stroke({ color: '#ffffff', width: 2 }),
                }),
                text: new TextStyle({
                  text: `📍 साझा बिन्दु (${count})`,
                  font: 'bold 10px sans-serif',
                  offsetY: 16,
                  fill: new Fill({ color: '#0f172a' }),
                  stroke: new Stroke({ color: '#ffffff', width: 3 }),
                  backgroundFill: new Fill({ color: 'rgba(255, 255, 255, 0.95)' }),
                  backgroundStroke: new Stroke({ color: '#94a3b8', width: 1 }),
                  padding: [1, 5, 1, 5],
                }),
              }),
            ];
          }

          const name = feature.get('name') || feature.get('username') || 'संकलक';
          const statusIcon = isOnline ? '🟢' : '⚪';
          const clusterTotal = feature.get('clusterTotal') || 1;
          const clusterIndex = feature.get('clusterIndex');
          const badgeText = clusterTotal > 1 ? ` [${clusterIndex + 1}/${clusterTotal}]` : '';
          const labelText = `${statusIcon} ${name}${badgeText}`;

          return [
            // Outer halo / officer marker
            new Style({
              image: new CircleStyle({
                radius: isOnline ? 12 : 10,
                fill: new Fill({ color: isOnline ? '#10b981' : '#64748b' }),
                stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
              }),
            }),
            // Inner core dot
            new Style({
              image: new CircleStyle({
                radius: isOnline ? 5.5 : 4.5,
                fill: new Fill({ color: isOnline ? '#047857' : '#334155' }),
                stroke: new Stroke({ color: '#ffffff', width: 1 }),
              }),
              text: new TextStyle({
                text: labelText,
                font: 'bold 11px sans-serif',
                offsetY: -18,
                fill: new Fill({ color: isOnline ? '#064e3b' : '#1e293b' }),
                stroke: new Stroke({ color: '#ffffff', width: 3 }),
                backgroundFill: new Fill({ color: isOnline ? 'rgba(236, 253, 245, 0.95)' : 'rgba(241, 245, 249, 0.95)' }),
                backgroundStroke: new Stroke({ color: isOnline ? '#10b981' : '#94a3b8', width: 1 }),
                padding: [2, 6, 2, 6],
              }),
            }),
          ];
        },
      });

      // Snapping Candidate Vertices Display Layer (Displays all vertex handles like Edit Mode)
      const snappingVerticesSource = new VectorSource();
      const snappingVerticesLayer = new VectorLayer({
        source: snappingVerticesSource,
        zIndex: 900,
        style: new Style({
          image: new CircleStyle({
            radius: 5,
            fill: new Fill({ color: '#06b6d4' }), // Cyan vertex circle identical to Edit Mode!
            stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
          }),
        }),
      });
      snappingVerticesSourceRef.current = snappingVerticesSource;

      // Feature Hover & Inspection Highlight Layer (Glowing outline & highlighted fill)
      const featureHighlightSource = new VectorSource();
      const featureHighlightLayer = new VectorLayer({
        source: featureHighlightSource,
        zIndex: 850,
        style: (feature) => {
          const geom = feature ? (typeof feature.getGeometry === 'function' ? feature.getGeometry() : null) : null;
          const type = typeof geom?.getType === 'function' ? geom.getType() : (typeof feature?.getType === 'function' ? feature.getType() : '');
          if (!type) return [];
          const styles = [];

          if (type === 'Polygon' || type === 'MultiPolygon') {
            const layerId = feature.get('_layerId') || feature.get('layer_id');
            const layerData = layerId ? serverVectorsRef.current.find((v) => String(v.id) === String(layerId)) : null;
            const isOutlined = !!(layerData && layerData.outlineOnly);

            styles.push(
              new Style({
                fill: (isOutlined || editModeRef.current) ? new Fill({ color: 'rgba(0, 0, 0, 0)' }) : new Fill({ color: 'rgba(245, 158, 11, 0.28)' }),
                stroke: new Stroke({ color: '#f59e0b', width: 3.5, lineDash: [8, 4] }),
              })
            );
          } else if (type === 'LineString' || type === 'MultiLineString') {
            styles.push(
              new Style({
                stroke: new Stroke({ color: '#f59e0b', width: 5.5 }),
              })
            );
          } else if (type === 'Point' || type === 'MultiPoint') {
            styles.push(
              new Style({
                image: new CircleStyle({
                  radius: 11,
                  fill: new Fill({ color: 'rgba(245, 158, 11, 0.45)' }),
                  stroke: new Stroke({ color: '#f59e0b', width: 3 }),
                }),
              })
            );
          }
          return styles;
        },
      });
      featureHighlightSourceRef.current = featureHighlightSource;

      // Snapping Target Indicator Layer
      // Snapping & Clicked/Tapped Vertex Highlight Layer (Vibrant Golden-Amber glowing marker)
      const snapIndicatorSource = new VectorSource();
      const snapIndicatorLayer = new VectorLayer({
        source: snapIndicatorSource,
        zIndex: 1000,
        style: [
          new Style({
            image: new CircleStyle({
              radius: 12,
              stroke: new Stroke({ color: 'rgba(245, 158, 11, 0.45)', width: 6 }),
            }),
          }),
          new Style({
            image: new CircleStyle({
              radius: 6.5,
              fill: new Fill({ color: '#f59e0b' }),
              stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
            }),
          }),
        ],
      });
      snapIndicatorSourceRef.current = snapIndicatorSource;

      // Merge Selection Highlight Layer (QGIS-style merge: picked features glow purple)
      const mergeHighlightSource = new VectorSource();
      const mergeHighlightLayer = new VectorLayer({
        source: mergeHighlightSource,
        zIndex: 940,
        style: (feature) => {
          const geom = feature ? (typeof feature.getGeometry === 'function' ? feature.getGeometry() : null) : null;
          const type = typeof geom?.getType === 'function' ? geom.getType() : (typeof feature?.getType === 'function' ? feature.getType() : '');
          if (!type) return [];
          if (type === 'Polygon' || type === 'MultiPolygon') {
            return [
              new Style({
                fill: new Fill({ color: 'rgba(139, 92, 246, 0.30)' }),
                stroke: new Stroke({ color: '#7c3aed', width: 3.5, lineDash: [10, 5] }),
              }),
            ];
          }
          if (type === 'LineString' || type === 'MultiLineString') {
            return [
              new Style({
                stroke: new Stroke({ color: '#7c3aed', width: 6, lineDash: [10, 5] }),
              }),
            ];
          }
          return [
            new Style({
              image: new CircleStyle({
                radius: 11,
                fill: new Fill({ color: 'rgba(139, 92, 246, 0.45)' }),
                stroke: new Stroke({ color: '#7c3aed', width: 3 }),
              }),
            }),
          ];
        },
      });
      mergeHighlightSourceRef.current = mergeHighlightSource;
      layersRef.current.mergeHighlightLayer = mergeHighlightLayer;
      layersRef.current.mergeHighlightSource = mergeHighlightSource;

      // Linked Partner Feature Highlight Layer (When any feature is clicked, its linked partner glows)
      const linkedPartnerSource = new VectorSource();
      const linkedPartnerLayer = new VectorLayer({
        source: linkedPartnerSource,
        zIndex: 965,
      });
      layersRef.current.linkedPartnerLayer = linkedPartnerLayer;
      layersRef.current.linkedPartnerSource = linkedPartnerSource;

      // Persistent Sketch Preview Layer (for newly created or finished feature while form is open)
      const sketchPreviewSource = new VectorSource();
      const sketchPreviewLayer = new VectorLayer({
        source: sketchPreviewSource,
        zIndex: 960,
        style: (feature) => {
          const geom = feature ? (typeof feature.getGeometry === 'function' ? feature.getGeometry() : null) : null;
          const type = typeof geom?.getType === 'function' ? geom.getType() : (typeof feature?.getType === 'function' ? feature.getType() : '');
          if (!type) return [];
          const styles = [];

          if (type === 'Polygon' || type === 'MultiPolygon') {
            styles.push(
              new Style({
                fill: new Fill({ color: 'rgba(14, 165, 233, 0.28)' }),
                stroke: new Stroke({ color: '#0284c7', width: 3.5 }),
              })
            );
          } else if (type === 'LineString' || type === 'MultiLineString') {
            styles.push(
              new Style({
                stroke: new Stroke({ color: '#0284c7', width: 4.5 }),
              })
            );
          } else if (type === 'Point' || type === 'MultiPoint') {
            styles.push(
              new Style({
                image: new CircleStyle({
                  radius: 8.5,
                  fill: new Fill({ color: '#0284c7' }),
                  stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
                }),
              })
            );
          }

          // High visibility vertex markers on the newly created feature
          const coords = extractCoordinatesFromGeometry(geom);
          if (coords.length > 0 && type !== 'Point') {
            styles.push(
              new Style({
                geometry: new MultiPoint(coords),
                image: new CircleStyle({
                  radius: 6,
                  fill: new Fill({ color: '#f59e0b' }),
                  stroke: new Stroke({ color: '#ffffff', width: 2 }),
                }),
              })
            );
          }
          return styles;
        },
      });

      const map = new Map({
        target: mapRef.current,
        layers: [osmLayer, esriLayer, googleLayer, aoiLayer, taskLayer, drawnBoundaryLayer, gpsLayer, collectorTrackingLayer, featureHighlightLayer, sketchPreviewLayer, snappingVerticesLayer, snapIndicatorLayer, mergeHighlightLayer, linkedPartnerLayer],
        view: new View({
          center: fromLonLat([85.324, 27.7172]), // Kathmandu default
          zoom: 13,
          maxZoom: 30,
        }),
        controls: [],
      });

      map.getView().on('change:rotation', () => {
        setMapRotation(map.getView().getRotation());
      });

      layersRef.current = {
        basemaps: { osm: osmLayer, esri: esriLayer, google: googleLayer },
        taskLayer,
        taskSource,
        drawnBoundaryLayer,
        drawnBoundarySource,
        aoiLayer,
        aoiSource,
        gpsLayer,
        gpsSource,
        collectorTrackingLayer,
        collectorTrackingSource,
        featureHighlightLayer,
        featureHighlightSource,
        sketchPreviewLayer,
        sketchPreviewSource,
        snappingVerticesLayer,
        snappingVerticesSource,
        snapIndicatorLayer,
        snapIndicatorSource,
        mergeHighlightLayer,
        mergeHighlightSource,
        linkedPartnerLayer,
        linkedPartnerSource,
        serverRasters: {},
        serverVectors: {},
      };

      const getAssignedGridGeometries = () => {
        const source = layersRef.current.taskSource;
        if (!source) return [];
        return source
          .getFeatures()
          .map((f) => f.getGeometry())
          .filter(Boolean);
      };

      const isCoordinateWithinAssignedGrids = (coord) => {
        if (!isCollectorRef.current) return true;
        const grids = getAssignedGridGeometries();
        if (grids.length === 0) return true;
        return grids.some(
          (g) => typeof g.intersectsCoordinate === 'function' && g.intersectsCoordinate(coord)
        );
      };

      // Helper to check if a feature geometry is within collector's assigned task grids
      const checkFeatureWithinAssignedGrids = (olFeature) => {
        if (!isCollectorRef.current) return true;
        const taskSource = layersRef.current.taskSource;
        if (!taskSource) return true;
        const gridFeatures = taskSource.getFeatures();
        if (!gridFeatures || gridFeatures.length === 0) {
          // Project has no task grids - collector can edit directly within project
          return true;
        }
        const featGeom = olFeature ? olFeature.getGeometry() : null;
        if (!featGeom) return true;
        const featExtent = featGeom.getExtent();

        for (const gridFeat of gridFeatures) {
          const gridGeom = gridFeat.getGeometry();
          if (gridGeom && gridGeom.intersectsExtent(featExtent)) {
            return true;
          }
        }
        return false;
      };

      // Helper to immediately highlight a tapped/clicked vertex on any device (Touch/Mobile/Desktop)
      const highlightVertexAtEvent = (evt) => {
        if (!snapIndicatorSourceRef.current) return;
        const currentTargetId = drawModeRef.current ? activeLayerIdRef.current : (editModeRef.current ? editLayerIdRef.current : null);
        if (currentTargetId && !isLayerSnappable(currentTargetId)) {
          snapIndicatorSourceRef.current.clear();
          return;
        }

        const isTouch = evt.originalEvent?.pointerType === 'touch' || ('ontouchstart' in window && evt.originalEvent?.touches?.length > 0);
        const effectiveTol = isTouch ? Math.max(snapToleranceRef.current, 28) : Math.max(snapToleranceRef.current, 15);

        const visibleSources = Object.entries(layersRef.current.serverVectors)
          .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
          .map(([_, obj]) => obj.source);

        const snapResult = findNearestVertex(map, evt.pixel, visibleSources, effectiveTol);
        if (snapResult) {
          snapIndicatorSourceRef.current.clear();
          const snapPoint = new Feature({ geometry: new Point(snapResult.coordinate) });
          snapIndicatorSourceRef.current.addFeature(snapPoint);
        }
      };

      // Helper to validate whether a clicked/tapped feature should be selected
      const isFeatureHitValid = (f, layerId, coordinate, resolution) => {
        if (!f || !coordinate) return false;
        const geom = typeof f.getGeometry === 'function' ? f.getGeometry() : null;
        const type = typeof geom?.getType === 'function' ? geom.getType() : (typeof f?.getType === 'function' ? f.getType() : '');
        const isPoly = type.includes('Polygon');
        if (isPoly && geom && typeof geom.intersectsCoordinate === 'function' && geom.intersectsCoordinate(coordinate)) {
          return true;
        }
        return true;
      };

      // QGIS-like proximity + interior picking: returns { feature, layer, layerId, layerObj } when the
      // click is inside a polygon geometry OR within the layer's configured click proximity (px).
      const pickFeatureWithinProximity = (f, layer, pixel, coordinate) => {
        if (!f || !layer || !pixel || !coordinate) return null;
        const foundEntry = Object.entries(layersRef.current.serverVectors).find(
          ([id, obj]) => obj && (obj.layer === layer || obj.editLayer === layer || obj.tileLayer === layer)
        );
        const layerId = foundEntry ? foundEntry[0] : null;
        const layerObj = foundEntry ? foundEntry[1] : null;
        const tol = getLayerClickTolerance(layerId);
        try {
          const feature = ensureRealOlFeature(f, olModules);
          const geom = feature ? feature.getGeometry() : null;
          if (!geom) return null;
          // If clicking inside a Polygon or MultiPolygon, immediately register hit!
          if (typeof geom.intersectsCoordinate === 'function' && geom.intersectsCoordinate(coordinate)) {
            return { feature, layer, layerId, layerObj };
          }
          if (typeof geom.getClosestPoint === 'function') {
            const closest = geom.getClosestPoint(coordinate);
            const cpx = map.getPixelFromCoordinate(closest);
            if (!cpx) return null;
            const dist = Math.hypot(cpx[0] - pixel[0], cpx[1] - pixel[1]);
            if (dist <= tol) return { feature, layer, layerId, layerObj };
          } else {
            const ext = geom.getExtent ? geom.getExtent() : null;
            if (ext && coordinate[0] >= ext[0] && coordinate[0] <= ext[2] && coordinate[1] >= ext[1] && coordinate[1] <= ext[3]) {
              return { feature, layer, layerId, layerObj };
            }
          }
        } catch (e) {}
        return null;
      };

      // Unified spatial + pixel-proximity feature finder:
      // 1) Checks exact coordinate containment via VectorSource.getFeaturesAtCoordinate(coordinate)
      //    so clicking ANYWHERE inside a polygon always hits immediately (even in outline mode).
      // 2) Falls back to map.forEachFeatureAtPixel with pickFeatureWithinProximity for points/lines/edges/vector tiles.
      const findVectorFeatureAtEvent = (evt, restrictLayerId = null) => {
        if (!evt || !evt.coordinate || !evt.pixel) return null;
        const entries = Object.entries(layersRef.current.serverVectors).filter(([id, obj]) => {
          if (!obj || !obj.layer || !obj.layer.getVisible() || !obj.source) return false;
          if (restrictLayerId != null && String(id) !== String(restrictLayerId)) return false;
          return true;
        });

        // Sort descending by layer z-index so topmost layers (points/lines/buildings) are checked before large backgrounds
        entries.sort((a, b) => (b[1]?.layer?.getZIndex?.() || 0) - (a[1]?.layer?.getZIndex?.() || 0));

        // Pass 1: Direct R-tree spatial containment check (instant & 100% reliable for polygon interiors in vector sources)
        for (const [id, obj] of entries) {
          try {
            if (typeof obj.source.getFeaturesAtCoordinate === 'function') {
              const featsAtCoord = obj.source.getFeaturesAtCoordinate(evt.coordinate);
              if (featsAtCoord && featsAtCoord.length > 0) {
                // If multiple polygons contain this coordinate, pick the smallest polygon (most specific feature)
                let bestFeat = featsAtCoord[0];
                if (featsAtCoord.length > 1) {
                  let minArea = Infinity;
                  for (const f of featsAtCoord) {
                    const g = f.getGeometry();
                    const a = g && g.getArea ? g.getArea() : Infinity;
                    if (a < minArea) {
                      minArea = a;
                      bestFeat = f;
                    }
                  }
                }
                return { feature: bestFeat, layer: obj.editLayer || obj.layer, layerId: id, layerObj: obj };
              }
            }
          } catch (e) {}
        }

        // Pass 2: Pixel proximity check for Points, LineStrings, MVT VectorTiles, and near-boundary clicks
        const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0));
        const allowedLayers = [];
        entries.forEach(([_, obj]) => {
          if (obj.layer) allowedLayers.push(obj.layer);
          if (obj.tileLayer && !allowedLayers.includes(obj.tileLayer)) allowedLayers.push(obj.tileLayer);
          if (obj.editLayer && !allowedLayers.includes(obj.editLayer)) allowedLayers.push(obj.editLayer);
        });
        const hit = map.forEachFeatureAtPixel(
          evt.pixel,
          (f, layer) => pickFeatureWithinProximity(f, layer, evt.pixel, evt.coordinate),
          {
            layerFilter: (l) => allowedLayers.includes(l),
            hitTolerance: isTouchDevice ? 24 : 16,
          }
        );
        return hit || null;
      };

      // Seamlessly synchronizes any clicked/interacted feature from MVT vector tiles into the active edit source
      const loadFeatureIntoEditSource = (feat, targetLId) => {
        if (!feat || targetLId == null) return;
        const targetObj = layersRef.current.serverVectors[String(targetLId)];
        if (targetObj && targetObj.isMvt && targetObj.source) {
          const fId = feat.getId ? feat.getId() : (feat.get ? (feat.get('_id') || feat.get('id')) : null);
          const existing = targetObj.source.getFeatures().find((ef) => {
            const efId = ef.getId ? ef.getId() : (ef.get ? (ef.get('_id') || ef.get('id')) : null);
            return efId != null && fId != null && String(efId) === String(fId);
          });
          if (!existing) {
            try {
              targetObj.source.addFeature(feat);
            } catch (e) {}
          }
        }
      };

      // Helper to validate whether a clicked/tapped task grid should be selected
      const isTaskHitValid = (f, coordinate, resolution) => {
        if (!f) return false;
        const geom = f.getGeometry();
        if (!geom) return false;
        if (coordinate && geom.intersectsCoordinate && geom.intersectsCoordinate(coordinate)) {
          return true;
        }
        // Fallback or near boundary tolerance (e.g. for tap tolerance on touch devices)
        const toleranceMapUnits = Math.max(14, 18) * (resolution || 1);
        return isPointNearPolygonBoundary(geom, coordinate, toleranceMapUnits);
      };

      map.on('pointerdown', (evt) => {
        highlightVertexAtEvent(evt);
      });

      // Click handler for task grids & Edit Mode (Selection + Feature Extension)
      map.on('singleclick', (evt) => {
        // If a drag/modify interaction just finished, ignore trailing click event
        if (isModifyingRef.current) {
          return;
        }

        // While drawing the split blade, the Draw interaction owns all clicks
        if (splitBladeModeRef.current || isDrawingBladeRef.current) {
          return;
        }

        highlightVertexAtEvent(evt);
        const resolution = map.getView().getResolution() || 1;
        const toleranceMapUnits = Math.max(snapToleranceRef.current || 20, 20) * resolution;
        const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || (navigator && navigator.maxTouchPoints > 0));
        const touchHitTol = isTouchDevice ? 24 : 10;

        // --- 00. Collector Marker / Co-Location Hub Click (View Collector Fleet Info) ---
        if (layersRef.current.collectorTrackingLayer) {
          const clickedCollectorFeat = map.forEachFeatureAtPixel(evt.pixel, (f) => {
            if (f && (f.get('isCollectorMarker') || f.get('isCoLocationHub'))) return f;
            return null;
          }, {
            layerFilter: (l) => l === layersRef.current.collectorTrackingLayer,
            hitTolerance: touchHitTol,
          });

          if (clickedCollectorFeat) {
            const colData = clickedCollectorFeat.get('collectorData');
            const clusterMembers = clickedCollectorFeat.get('clusterMembers') || (colData ? [colData] : []);
            const targetCol = colData || (clusterMembers.length > 0 ? clusterMembers[0] : null);
            if (targetCol) {
              const idx = clusterMembers.findIndex((c) => c.user_id === targetCol.user_id);
              setInspectedCollector(targetCol);
              setInspectedCollectorCluster(clusterMembers);
              setClusterMemberIndex(idx >= 0 ? idx : 0);
              if (onCollectorSelect) onCollectorSelect(targetCol);
              return;
            }
          }
        }

        // --- 0. Pick Linked Feature Mode (Direct Feature Selection for Linking) ---
        if (pickLinkedFeatureModeRef.current) {
          const clickedVector = findVectorFeatureAtEvent(evt);

          if (clickedVector && clickedVector.feature && onLinkedFeatureSelectRef.current) {
            const f = clickedVector.feature;
            const lId = parseInt(clickedVector.layerId);
            const targetLayerData = serverVectorsRef.current.find((v) => Number(v.id) === lId);
            const featProps = f.getProperties ? f.getProperties() : (f.properties || {});
            const cleanProps = { ...featProps };
            delete cleanProps.geometry;
            delete cleanProps.geom;

            const fid = f.getId ? f.getId() : (f.get ? f.get('_id') : featProps._id || featProps.id);

            let geomGeojson = null;
            const geom = f.getGeometry ? f.getGeometry() : null;
            if (geom && olModules?.GeoJSON) {
              const format = new olModules.GeoJSON();
              geomGeojson = JSON.parse(format.writeGeometry(geom, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
            }

            onLinkedFeatureSelectRef.current({
              layerId: lId,
              layerName: targetLayerData?.name || `Layer_${lId}`,
              featureId: fid,
              properties: cleanProps,
              geometry: geomGeojson,
            });
            return;
          }
        }

        // --- 0b. Merge Selection Mode (QGIS-style merge: pick features to union or multifeature) ---
        if (mergeSelectModeRef.current) {
          const pickedMerge = (editLayerIdRef.current ? findVectorFeatureAtEvent(evt, editLayerIdRef.current) : null) || findVectorFeatureAtEvent(evt);
          if (pickedMerge && pickedMerge.feature) {
            const clickedMerge = pickedMerge.feature;
            if (editLayerIdRef.current) {
              loadFeatureIntoEditSource(clickedMerge, pickedMerge.layerId);
            }
            const fProps = clickedMerge.getProperties ? clickedMerge.getProperties() : {};
            const fid =
              (clickedMerge.getId && clickedMerge.getId()) ||
              (clickedMerge.get ? clickedMerge.get('_id') : null) ||
              fProps._id ||
              fProps.id;
            let geomGeojson = null;
            const geom = clickedMerge.getGeometry ? clickedMerge.getGeometry() : null;
            if (geom && olModules?.GeoJSON) {
              try {
                const format = new olModules.GeoJSON();
                geomGeojson = JSON.parse(format.writeGeometry(geom, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
              } catch (e) {}
            }
            if (fid != null && onMergeToggleFeatureRef.current) {
              onMergeToggleFeatureRef.current({
                id: fid,
                geometry: geomGeojson,
                properties: fProps,
                layerId: pickedMerge.layerId,
              });
            }
            return;
          }
        }

        // --- 1. Edit Mode Interaction Handling ---
        if (editModeRef.current) {
          const currentLayerObj = editLayerIdRef.current ? layersRef.current.serverVectors[String(editLayerIdRef.current)] : null;

          // CASE A: Delete Vertex Sub-Mode (मेट्ने)
          if (isDeleteSubMode(editSubModeRef.current) && selectedOlFeatureRef.current) {
            const curFeat = selectedOlFeatureRef.current;
            const geom = curFeat.getGeometry();
            const geomType = geom?.getType();

            if (geomType === 'Point') {
              if (onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({ reason: 'MIN_VERTICES', message: '⚠️ बिन्दु फिचर हटाउन विशेषता प्यानलमा रहेको "मेटाउनुहोस्" (Delete) बटन प्रयोग गर्नुहोस्।' });
              }
              return;
            }

            if (!isCoordinateWithinAssignedGrids(evt.coordinate)) {
              if (onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({
                  reason: 'OUTSIDE_GRID',
                  message: '⚠️ तपाईंले आफ्नो ग्रिडभित्रका शीर्षबिन्दु मात्र सम्पादन गर्न सक्नुहुन्छ। (Only vertices inside your assigned grid can be edited.)',
                });
              }
              return;
            }

            // Ring/part-aware deletion (holes, MultiPolygon, closing vertices).
            // The geometry engine refuses to create invalid geometry and explains why.
            const removal = removeNearestVertexFromFeature(curFeat, evt.coordinate, toleranceMapUnits);
            if (!removal.ok) {
              if (onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({
                  reason: String(removal.reason || 'DELETE_FAILED').toUpperCase(),
                  message: describeEditFailure(removal.reason),
                });
              }
              return;
            }

            curFeat.changed();
            if (modifyInteractionRef.current) {
              modifyInteractionRef.current.setActive(false);
              modifyInteractionRef.current.setActive(true);
            }
            const newCoords = extractCoordinatesFromGeometry(curFeat.getGeometry());
            selectedVertexIndexRef.current = Math.max(
              0,
              Math.min(selectedVertexIndexRef.current || 0, Math.max(0, newCoords.length - 1))
            );
            if (olModules) {
              const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke, GeoJSON } = olModules;
              renderSelectedFeatureVertices(curFeat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
              const format = new GeoJSON();
              const geojson = JSON.parse(format.writeFeature(curFeat, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
              const featureId = curFeat.getId() || curFeat.get('_id') || geojson.id || geojson.properties?._id;
              const isWithin = checkFeatureWithinAssignedGrids(curFeat);
              if (onFeatureModifyEnd) {
                onFeatureModifyEnd(featureId, geojson.geometry, isWithin);
              }
            }
            return;
          }

          // CASE B: A feature IS ALREADY selected
          if (selectedOlFeatureRef.current) {
            const curFeat = selectedOlFeatureRef.current;

            // Step 1: Check if user tapped/clicked directly ON an existing vertex of this selected feature (14-pixel hit radius)
            const vertexTapTolerance = 14 * resolution;
            const hitVertex = findVertexIndexNearCoord(curFeat, evt.coordinate, vertexTapTolerance);
            if (hitVertex) {
              // User tapped an existing vertex! Select this vertex and turn its color RED!
              selectedVertexIndexRef.current = hitVertex.index;
              if (olModules) {
                const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
                renderSelectedFeatureVertices(curFeat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
              }
              return;
            }

            // Step 2: Check if user clicked on ANOTHER feature to switch selection
            let clickedOtherFeature = null;
            let otherLayerId = editLayerIdRef.current;
            let otherLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(otherLayerId));

            if (currentLayerObj && (currentLayerObj.layer || currentLayerObj.tileLayer)) {
              const targetLayers = [currentLayerObj.layer];
              if (currentLayerObj.tileLayer && !targetLayers.includes(currentLayerObj.tileLayer)) targetLayers.push(currentLayerObj.tileLayer);
              if (currentLayerObj.editLayer && !targetLayers.includes(currentLayerObj.editLayer)) targetLayers.push(currentLayerObj.editLayer);

              clickedOtherFeature = map.forEachFeatureAtPixel(evt.pixel, (f) => {
                const realF = ensureRealOlFeature(f, olModules);
                if (isFeatureHitValid(realF, editLayerIdRef.current, evt.coordinate, resolution)) {
                  return realF;
                }
                return null;
              }, {
                layerFilter: (l) => targetLayers.includes(l),
                hitTolerance: touchHitTol,
              });
            }

            if (!clickedOtherFeature) {
              const visibleLayers = [];
              Object.entries(layersRef.current.serverVectors)
                .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible())
                .forEach(([id, obj]) => {
                  if (obj.layer) visibleLayers.push(obj.layer);
                  if (obj.tileLayer && !visibleLayers.includes(obj.tileLayer)) visibleLayers.push(obj.tileLayer);
                  if (obj.editLayer && !visibleLayers.includes(obj.editLayer)) visibleLayers.push(obj.editLayer);
                });

              const hit = map.forEachFeatureAtPixel(evt.pixel, (f, layer) => {
                return pickFeatureWithinProximity(f, layer, evt.pixel, evt.coordinate);
              }, {
                layerFilter: (l) => visibleLayers.includes(l),
                hitTolerance: 40,
              });

              if (hit) {
                clickedOtherFeature = hit.feature;
                otherLayerId = parseInt(hit.layerId, 10);
                otherLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(otherLayerId));
                editLayerIdRef.current = otherLayerId;
              }
            }

            if (clickedOtherFeature) {
              loadFeatureIntoEditSource(clickedOtherFeature, otherLayerId || editLayerIdRef.current);
            }

            if (clickedOtherFeature && clickedOtherFeature !== curFeat) {
              if (isCollectorRef.current && !checkFeatureWithinAssignedGrids(clickedOtherFeature)) {
                if (onFeatureBlockedRef.current) {
                  onFeatureBlockedRef.current({
                    reason: 'OUTSIDE_GRID',
                    message: '⚠️ यो फिचर तपाईंलाई तोकिएको कार्यक्षेत्र (ग्रिड) भन्दा बाहिर छ। (This feature is outside your assigned task grids.)',
                  });
                }
                return;
              }

              if (isCollectorRef.current) {
                const gps = gpsPositionRef.current;
                if (!gps || gps.lat == null || gps.lng == null) {
                  if (onFeatureBlockedRef.current) {
                    onFeatureBlockedRef.current({
                      reason: 'NO_GPS',
                      message: '⚠️ GPS स्थान प्राप्त हुन सकेन। सम्पादन गर्न आफ्नो GPS सक्रिय गर्नुहोस् र ५० मिटर भित्र हुनुहोस्। (GPS location required. Must be within 50m to edit.)',
                    });
                  }
                  return;
                }

                if (olModules?.GeoJSON) {
                  const format = new olModules.GeoJSON();
                  const geojsonObj = JSON.parse(format.writeFeature(clickedOtherFeature, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
                  const dist = getDistanceToGeoJsonGeometry(gps.lat, gps.lng, geojsonObj.geometry);
                  if (dist > GEOFENCE_EDIT_RADIUS_METERS) {
                    const distM = Math.round(dist);
                    if (onFeatureBlockedRef.current) {
                      onFeatureBlockedRef.current({
                        reason: 'OUTSIDE_GPS_50M',
                        message: `⚠️ तपाईं यो फिचरबाट ${distM} मिटर टाढा हुनुहुन्छ। सम्पादन गर्न ५० मिटर भित्र हुनुपर्छ। सम्पादन मोड खोलिएन। (You are ${distM}m away from this feature. You must be within 50m to edit.)`,
                      });
                    }
                    return;
                  }
                }
              }

              if (olModules) {
                const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke, GeoJSON } = olModules;
                const format = new GeoJSON();
                const geojson = JSON.parse(format.writeFeature(clickedOtherFeature, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
                const featureId = clickedOtherFeature.getId() || clickedOtherFeature.get('_id') || geojson.id || geojson.properties?._id;
                const targetLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(editLayerIdRef.current));

                selectedOlFeatureRef.current = clickedOtherFeature;
                if (featureHighlightSourceRef.current) {
                  featureHighlightSourceRef.current.clear();
                  featureHighlightSourceRef.current.addFeature(clickedOtherFeature.clone());
                }
                if (selectInteractionRef.current) {
                  selectInteractionRef.current.getFeatures().clear();
                  selectInteractionRef.current.getFeatures().push(clickedOtherFeature);
                }

                const coords = extractCoordinatesFromGeometry(clickedOtherFeature.getGeometry());
                selectedVertexIndexRef.current = Math.max(0, coords.length - 1);
                renderSelectedFeatureVertices(clickedOtherFeature, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);

                if (onFeatureSelect) {
                  onFeatureSelect({
                    id: featureId,
                    layerId: otherLayerId || editLayerIdRef.current,
                    layerName: otherLayerData?.name || targetLayerData?.name || 'तह',
                    geometryType: geojson.geometry?.type || clickedOtherFeature.getGeometry()?.getType(),
                    properties: geojson.properties || {},
                    originalGeom: geojson.geometry,
                    currentGeom: geojson.geometry,
                    isModified: false,
                    isWithinAssignedGrid: true,
                  });
                }
              }
              return;
            }

            // Clicked outside any feature in edit mode -> Deselect and dismiss the panel.
            // In बिस्तार (extend) mode the selection must survive so the user can keep
            // adding vertices; every other tool resets the selection.
            if (!isExtendSubMode(editSubModeRef.current)) {
              selectedOlFeatureRef.current = null;
              selectedVertexIndexRef.current = null;
              if (selectInteractionRef.current) {
                selectInteractionRef.current.getFeatures().clear();
              }
              if (layersRef.current.snappingVerticesSource) {
                layersRef.current.snappingVerticesSource.clear();
              }
              if (featureHighlightSourceRef.current) {
                featureHighlightSourceRef.current.clear();
              }
              if (onFeatureSelect) {
                onFeatureSelect(null);
              }
              return;
            }

            // Step 3: User clicked a NEW location on the map while a feature is selected
            const sub = editSubModeRef.current;
            const geom = curFeat.getGeometry();
            const geomType = geom?.getType();

            // मेट्ने mode: empty clicks must never insert a vertex (CASE A owns deletion).
            if (isDeleteSubMode(sub)) {
              return;
            }

            // ताने mode: extending is disabled. A single Point is relocated instead.
            if (isMoveSubMode(sub)) {
              if (geomType === 'Point') {
                let targetCoord = evt.coordinate;
                const isEditLayerSnappable = isLayerSnappable(editLayerIdRef.current);
                if (snappingEnabledRef.current && isEditLayerSnappable) {
                  const visibleSources = Object.entries(layersRef.current.serverVectors)
                    .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
                    .map(([_, obj]) => obj.source);
                  const snapResult = findNearestVertex(map, evt.pixel, visibleSources, snapToleranceRef.current);
                  if (snapResult) {
                    targetCoord = snapResult.coordinate;
                  }
                }
                geom.setCoordinates(targetCoord);
                curFeat.changed();
                if (olModules) {
                  const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke, GeoJSON } = olModules;
                  renderSelectedFeatureVertices(curFeat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, 0);
                  const isWithin = checkFeatureWithinAssignedGrids(curFeat);
                  const format = new GeoJSON();
                  const geojson = JSON.parse(format.writeFeature(curFeat, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
                  const featureId = curFeat.getId() || curFeat.get('_id') || geojson.id || geojson.properties?._id;
                  if (onFeatureModifyEnd) {
                    onFeatureModifyEnd(featureId, geojson.geometry, isWithin);
                  }
                }
                return;
              }
              // For LineString / Polygon: do NOT insert vertex in ताने mode!
              return;
            }

            // At this point the mode is either null (all tools allowed) or बिस्तार (extend only).
            // A single Point can be relocated, never extended.
            if (geomType === 'Point') {
              if (isExtendSubMode(sub)) {
                if (onFeatureBlockedRef.current) {
                  onFeatureBlockedRef.current({
                    reason: 'POINT_NOT_EXTENDABLE',
                    message: '⚠️ बिन्दु (Point) फिचरलाई बिस्तार गर्न मिल्दैन — स्थान सार्न "ताने" प्रयोग गर्नुहोस्। (A point cannot be extended; use ताने to move it.)',
                  });
                }
                return;
              }
              // In null mode, clicking empty space relocates the point
              let targetCoord = evt.coordinate;
              const isEditLayerSnappable = isLayerSnappable(editLayerIdRef.current);
              if (snappingEnabledRef.current && isEditLayerSnappable) {
                const visibleSources = Object.entries(layersRef.current.serverVectors)
                  .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
                  .map(([_, obj]) => obj.source);
                const snapResult = findNearestVertex(map, evt.pixel, visibleSources, snapToleranceRef.current);
                if (snapResult) {
                  targetCoord = snapResult.coordinate;
                }
              }
              if (!isCoordinateWithinAssignedGrids(targetCoord)) {
                if (onFeatureBlockedRef.current) {
                  onFeatureBlockedRef.current({
                    reason: 'OUTSIDE_GRID',
                    message: '⚠️ बिन्दु तपाईंको तोकिएको ग्रिडभित्र मात्र सार्न सकिन्छ। (The point can only be moved inside your assigned grid.)',
                  });
                }
                return;
              }
              geom.setCoordinates(targetCoord);
              curFeat.changed();
              if (olModules) {
                const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke, GeoJSON } = olModules;
                renderSelectedFeatureVertices(curFeat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, 0);
                const isWithin = checkFeatureWithinAssignedGrids(curFeat);
                const format = new GeoJSON();
                const geojson = JSON.parse(format.writeFeature(curFeat, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
                const featureId = curFeat.getId() || curFeat.get('_id') || geojson.id || geojson.properties?._id;
                if (onFeatureModifyEnd) {
                  onFeatureModifyEnd(featureId, geojson.geometry, isWithin);
                }
              }
              return;
            }

            // For LineString, MultiLineString, Polygon, MultiPolygon:
            // Append/insert new vertex adjacent to selected vertex (बिस्तार)
            let targetCoord = evt.coordinate;

            // Snapping: If enabled and allowed for this layer, snap to nearby vertex of any snappable visible layer
            const isEditLayerSnappable = isLayerSnappable(editLayerIdRef.current);
            if (snappingEnabledRef.current && isEditLayerSnappable) {
              const visibleSources = Object.entries(layersRef.current.serverVectors)
                .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
                .map(([_, obj]) => obj.source);

              const snapResult = findNearestVertex(map, evt.pixel, visibleSources, snapToleranceRef.current);
              if (snapResult) {
                targetCoord = snapResult.coordinate;
              }
            }

            // बिस्तार only makes sense next to the feature: a click far out on the
            // map must not silently append a stray vertex.
            let clickIsNearGeometry = false;
            if (typeof geom.getClosestPoint === 'function') {
              const closestPoint = geom.getClosestPoint(evt.coordinate);
              const clickPx = map.getPixelFromCoordinate(evt.coordinate);
              const closestPx = closestPoint ? map.getPixelFromCoordinate(closestPoint) : null;
              if (clickPx && closestPx) {
                clickIsNearGeometry =
                  Math.hypot(clickPx[0] - closestPx[0], clickPx[1] - closestPx[1]) <= EXTEND_CLICK_TOLERANCE_PX;
              }
            }
            if (!clickIsNearGeometry && typeof geom.intersectsCoordinate === 'function') {
              clickIsNearGeometry = geom.intersectsCoordinate(evt.coordinate);
            }
            if (!clickIsNearGeometry) {
              if (onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({
                  reason: 'EXTEND_FAR',
                  message: '⚠️ नयाँ बिन्दु थप्न फिचरको सिमाना नजिक क्लिक गर्नुहोस्। (Click closer to the feature boundary to add a vertex.)',
                });
              }
              return;
            }

            if (!isCoordinateWithinAssignedGrids(targetCoord)) {
              if (onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({
                  reason: 'OUTSIDE_GRID',
                  message: '⚠️ नयाँ शीर्षबिन्दु तपाईंको तोकिएको ग्रिडभित्र मात्र थप्न सकिन्छ। (New vertices can only be added inside your assigned grid.)',
                });
              }
              return;
            }

            const insertResult = insertCoordinateAtVertex(geom, targetCoord, selectedVertexIndexRef.current);
            if (!insertResult.ok) {
              if (onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({
                  reason: String(insertResult.reason || 'EXTEND_FAILED').toUpperCase(),
                  message: describeEditFailure(insertResult.reason),
                });
              }
              return;
            }
            curFeat.changed();
            // The newly inserted vertex becomes the selected (red) handle.
            selectedVertexIndexRef.current = insertResult.insertedIndex;

            if (modifyInteractionRef.current && !isExtendSubMode(sub) && !isDeleteSubMode(sub)) {
              modifyInteractionRef.current.setActive(false);
              modifyInteractionRef.current.setActive(true);
            }
            if (selectInteractionRef.current) {
              selectInteractionRef.current.getFeatures().clear();
              selectInteractionRef.current.getFeatures().push(curFeat);
            }

            if (olModules) {
              const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke, GeoJSON } = olModules;
              renderSelectedFeatureVertices(curFeat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);

              const isWithin = checkFeatureWithinAssignedGrids(curFeat);
              if (isCollectorRef.current && !isWithin && onFeatureBlockedRef.current) {
                onFeatureBlockedRef.current({
                  reason: 'OUTSIDE_GRID',
                  message: '⚠️ चेतावनी: परिमार्जित भाग तपाईंको कार्यक्षेत्र (ग्रिड) भन्दा बाहिर पुगेको छ। कृपया ग्रिड भित्रै सीमित राख्नुहोस्।',
                });
              }

              const format = new GeoJSON();
              const geojson = JSON.parse(format.writeFeature(curFeat, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
              const featureId = curFeat.getId() || curFeat.get('_id') || geojson.id || geojson.properties?._id;

              if (onFeatureModifyEnd) {
                onFeatureModifyEnd(featureId, geojson.geometry, isWithin);
              }
            }
            return;
          }

          // CASE C: NO feature is currently selected -> check if user clicked an existing feature to select it
          let clickedFeature = null;
          let targetLayerId = editLayerIdRef.current;
          let targetLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(targetLayerId));

          const hitOnCurrent = editLayerIdRef.current ? findVectorFeatureAtEvent(evt, editLayerIdRef.current) : null;
          if (hitOnCurrent && hitOnCurrent.feature) {
            clickedFeature = hitOnCurrent.feature;
            loadFeatureIntoEditSource(clickedFeature, editLayerIdRef.current);
          } else {
            const hitAny = findVectorFeatureAtEvent(evt);
            if (hitAny && hitAny.feature) {
              clickedFeature = hitAny.feature;
              targetLayerId = parseInt(hitAny.layerId, 10);
              targetLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(targetLayerId));
              editLayerIdRef.current = targetLayerId;
              loadFeatureIntoEditSource(clickedFeature, targetLayerId);
            }
          }

            if (clickedFeature) {
              if (isCollectorRef.current && !checkFeatureWithinAssignedGrids(clickedFeature)) {
                if (onFeatureBlockedRef.current) {
                  onFeatureBlockedRef.current({
                    reason: 'OUTSIDE_GRID',
                    message: '⚠️ यो फिचर तपाईंलाई तोकिएको कार्यक्षेत्र (ग्रिड) भन्दा बाहिर छ। (This feature is outside your assigned task grids.)',
                  });
                }
                return;
              }

              if (isCollectorRef.current) {
                const gps = gpsPositionRef.current;
                if (!gps || gps.lat == null || gps.lng == null) {
                  if (onFeatureBlockedRef.current) {
                    onFeatureBlockedRef.current({
                      reason: 'NO_GPS',
                      message: '⚠️ GPS स्थान प्राप्त हुन सकेन। सम्पादन गर्न आफ्नो GPS सक्रिय गर्नुहोस् र ५० मिटर भित्र हुनुहोस्। (GPS location required. Must be within 50m to edit.)',
                    });
                  }
                  return;
                }

                if (olModules?.GeoJSON) {
                  const format = new olModules.GeoJSON();
                  const geojsonObj = JSON.parse(format.writeFeature(clickedFeature, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
                  const dist = getDistanceToGeoJsonGeometry(gps.lat, gps.lng, geojsonObj.geometry);
                  if (dist > GEOFENCE_EDIT_RADIUS_METERS) {
                    const distM = Math.round(dist);
                    if (onFeatureBlockedRef.current) {
                      onFeatureBlockedRef.current({
                        reason: 'OUTSIDE_GPS_50M',
                        message: `⚠️ तपाईं यो फिचरबाट ${distM} मिटर टाढा हुनुहुन्छ। सम्पादन गर्न ५० मिटर भित्र हुनुपर्छ। सम्पादन मोड खोलिएन। (You are ${distM}m away from this feature. You must be within 50m to edit.)`,
                      });
                    }
                    return;
                  }
                }
              }

              if (olModules) {
                const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke, GeoJSON } = olModules;
                const format = new GeoJSON();
                const geojson = JSON.parse(format.writeFeature(clickedFeature, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
                const featureId = clickedFeature.getId() || clickedFeature.get('_id') || geojson.id || geojson.properties?._id;
                const targetLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(editLayerIdRef.current));

                selectedOlFeatureRef.current = clickedFeature;
                if (featureHighlightSourceRef.current) {
                  featureHighlightSourceRef.current.clear();
                  featureHighlightSourceRef.current.addFeature(clickedFeature.clone());
                }
                if (selectInteractionRef.current) {
                  selectInteractionRef.current.getFeatures().clear();
                  selectInteractionRef.current.getFeatures().push(clickedFeature);
                }

                const coords = extractCoordinatesFromGeometry(clickedFeature.getGeometry());
                selectedVertexIndexRef.current = Math.max(0, coords.length - 1);
                renderSelectedFeatureVertices(clickedFeature, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);

                if (onFeatureSelect) {
                  onFeatureSelect({
                    id: featureId,
                    layerId: targetLayerId || editLayerIdRef.current,
                    layerName: targetLayerData?.name || 'तह',
                    geometryType: geojson.geometry?.type || clickedFeature.getGeometry()?.getType(),
                    properties: geojson.properties || {},
                    originalGeom: geojson.geometry,
                    currentGeom: geojson.geometry,
                    isModified: false,
                    isWithinAssignedGrid: true,
                  });
                }
              }
              return;
            }

          // Clicked empty space with no selection
          selectedOlFeatureRef.current = null;
          selectedVertexIndexRef.current = null;
          if (selectInteractionRef.current) {
            selectInteractionRef.current.getFeatures().clear();
          }
          if (layersRef.current.snappingVerticesSource) {
            layersRef.current.snappingVerticesSource.clear();
          }
          if (featureHighlightSourceRef.current) {
            featureHighlightSourceRef.current.clear();
          }
          if (onFeatureSelect) {
            onFeatureSelect(null);
          }
          return;
        }

        // --- 2. Non-Edit Mode: Task Grid Selection and Feature Inspection on Click / Tap ---
        if (!editModeRef.current && !drawModeRef.current) {
          const triggerTaskSelect = (taskFeat) => {
            const rawId = taskFeat.getId() ?? taskFeat.get('id') ?? taskFeat.get('_id');
            const taskObj = {
              id: rawId,
              grid_index: taskFeat.get('grid_index'),
              name: taskFeat.get('name'),
              status: taskFeat.get('status'),
              assigned_to: taskFeat.get('assigned_to'),
              assigned_to_name: taskFeat.get('assigned_to_name'),
              assigned_at: taskFeat.get('assigned_at'),
              locked_by: taskFeat.get('locked_by'),
              locked_at: taskFeat.get('locked_at'),
              properties: taskFeat.get('properties') || { id: rawId, grid_index: taskFeat.get('grid_index') },
            };
            selectedTaskRef.current = taskObj;
            if (layersRef.current.taskLayer) {
              layersRef.current.taskLayer.changed();
            }
            if (onTaskClickRef.current) {
              onTaskClickRef.current(taskObj);
            }
          };

          // Hit-test task grid layer
          let clickedTaskFeature = null;
          if (showTaskGridsRef.current && taskLayer) {
            clickedTaskFeature = map.forEachFeatureAtPixel(evt.pixel, (f) => {
              if (isTaskHitValid(f, evt.coordinate, resolution)) {
                return f;
              }
              return null;
            }, {
              layerFilter: (l) => l === taskLayer,
              hitTolerance: 6,
            });
          }

          // If Task Panel is open and a task grid was clicked, prioritize task selection!
          if (isTaskPanelOpenRef.current && clickedTaskFeature) {
            triggerTaskSelect(clickedTaskFeature);
            return;
          }

          // Otherwise, inspect vector features if clicked
          const clickedVector = findVectorFeatureAtEvent(evt);

          if (clickedVector && clickedVector.feature && clickedVector.layerId) {
            const feat = clickedVector.feature;
            loadFeatureIntoEditSource(feat, clickedVector.layerId);
            inspectedFeatureRef.current = feat;
            if (featureHighlightSourceRef.current) {
              featureHighlightSourceRef.current.clear();
              featureHighlightSourceRef.current.addFeature(feat.clone());
            }

            const format = new GeoJSON();
            const geojson = JSON.parse(
              format.writeFeature(feat, {
                dataProjection: 'EPSG:4326',
                featureProjection: 'EPSG:3857',
              })
            );
            const featureId = feat.getId() || feat.get('_id') || geojson.id || geojson.properties?._id;
            inspectedFeatureIdRef.current = featureId;
            const targetLayerData = serverVectorsRef.current.find((v) => String(v.id) === String(clickedVector.layerId));
            const isWithinGrid = checkFeatureWithinAssignedGrids(feat);

            if (onFeatureInspectRef.current) {
              onFeatureInspectRef.current({
                id: featureId,
                layerId: clickedVector.layerId,
                layerName: targetLayerData?.name || 'तह',
                geometryType: geojson.geometry?.type || feat.getGeometry()?.getType(),
                properties: geojson.properties || {},
                geometry: geojson.geometry,
                extent: feat.getGeometry()?.getExtent(),
                isWithinAssignedGrid: isWithinGrid,
              });
            }
            return;
          }

          // If no vector feature was clicked, but a task grid was clicked, select task grid!
          if (clickedTaskFeature) {
            triggerTaskSelect(clickedTaskFeature);
            return;
          }

          // Clicked empty area outside any vector feature or task grid
          inspectedFeatureRef.current = null;
          inspectedFeatureIdRef.current = null;
          if (featureHighlightSourceRef.current) {
            featureHighlightSourceRef.current.clear();
          }
          if (onFeatureInspectRef.current) {
            onFeatureInspectRef.current(null);
          }
        }
      });

      // Cursor change on hover, Feature Hover Highlighting, & Snapping Visual Target Detection (Throttled for 60fps)
      let lastPointerMoveTime = 0;
      map.on('pointermove', (evt) => {
        if (evt.dragging) return;
        const now = Date.now();
        if (now - lastPointerMoveTime < 80) return;
        lastPointerMoveTime = now;
        const resolution = map.getView().getResolution() || 1;

        // Snapping Visual Detection during Edit / Draw Mode
        const currentTargetLayerId = editModeRef.current ? editLayerIdRef.current : (drawModeRef.current ? activeLayerIdRef.current : null);
        const isCurrentLayerSnappable = !currentTargetLayerId || isLayerSnappable(currentTargetLayerId);
        const isSnappingActive = (editModeRef.current || drawModeRef.current) && snappingEnabledRef.current && isCurrentLayerSnappable;

        if (isSnappingActive && snapIndicatorSourceRef.current) {
          const visibleSources = Object.entries(layersRef.current.serverVectors)
            .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
            .map(([_, obj]) => obj.source);

          const snapResult = findNearestVertex(map, evt.pixel, visibleSources, snapToleranceRef.current);
          if (snapResult) {
            snapIndicatorSourceRef.current.clear();
            const snapPoint = new Feature({ geometry: new Point(snapResult.coordinate) });
            snapIndicatorSourceRef.current.addFeature(snapPoint);
            map.getTargetElement().style.cursor = 'crosshair';
            return;
          } else {
            snapIndicatorSourceRef.current.clear();
          }
        } else if (snapIndicatorSourceRef.current) {
          snapIndicatorSourceRef.current.clear();
        }

        // Non-Edit Mode: Feature Hover Highlighting & Pointer Cursor
        if (!editModeRef.current && !drawModeRef.current && featureHighlightSourceRef.current) {
          const pickedHover = findVectorFeatureAtEvent(evt);

          let hitVector = null;
          if (pickedHover && pickedHover.layerId) {
            const lData = serverVectorsRef.current.find((v) => String(v.id) === String(pickedHover.layerId));
            const hz = lData && lData.style ? lData.style.hoverMinZoom : null;
            const zoom = map.getView().getZoom();
            if (hz == null || hz === '' || !Number.isFinite(Number(hz)) || Number(zoom) >= Number(hz)) {
              hitVector = pickedHover.feature;
            }
          }

          if (hitVector) {
            map.getTargetElement().style.cursor = 'pointer';
            if (hoveredFeatureRef.current !== hitVector) {
              hoveredFeatureRef.current = hitVector;
              // If not currently locked to an inspected or selected feature, show hover highlight
              if (!inspectedFeatureIdRef.current && !inspectedFeatureId && !selectedFeatureId) {
                featureHighlightSourceRef.current.clear();
                featureHighlightSourceRef.current.addFeature(hitVector.clone());
              }
            }
            return;
          } else {
            if (hoveredFeatureRef.current) {
              hoveredFeatureRef.current = null;
              if (!inspectedFeatureIdRef.current && !inspectedFeatureId && !selectedFeatureId) {
                featureHighlightSourceRef.current.clear();
              }
            }
          }
        }

        // Task grid hover cursor
        const hit = map.forEachFeatureAtPixel(evt.pixel, (f) => {
          if (isTaskHitValid(f, evt.coordinate, resolution)) {
            return true;
          }
          return null;
        }, {
          layerFilter: (l) => l === taskLayer,
          hitTolerance: 6,
        });
        map.getTargetElement().style.cursor = hit ? 'pointer' : '';
      });

      // Contextmenu (Right-Click) listener on map viewport for single-vertex deletion in Edit Mode
      map.getViewport().addEventListener('contextmenu', (e) => {
        if (!editModeRef.current || !selectedOlFeatureRef.current) return;
        const sub = editSubModeRef.current;
        if (isMoveSubMode(sub) || isExtendSubMode(sub)) {
          // Deleting vertices is disabled while ताने or बिस्तार is the active tool
          return;
        }
        const pixel = map.getEventPixel(e);
        const coord = map.getCoordinateFromPixel(pixel);
        if (!coord) return;

        const resolution = map.getView().getResolution() || 1;
        const toleranceMapUnits = Math.max(snapToleranceRef.current || 20, 20) * resolution;

        if (!isCoordinateWithinAssignedGrids(coord)) {
          if (onFeatureBlockedRef.current) {
            onFeatureBlockedRef.current({
              reason: 'OUTSIDE_GRID',
              message: '⚠️ तपाईंले आफ्नो ग्रिडभित्रका शीर्षबिन्दु मात्र सम्पादन गर्न सक्नुहुन्छ। (Only vertices inside your assigned grid can be edited.)',
            });
          }
          return;
        }

        const removal = removeNearestVertexFromFeature(selectedOlFeatureRef.current, coord, toleranceMapUnits);
        if (!removal.ok) {
          if (onFeatureBlockedRef.current && removal.reason && removal.reason !== 'no_vertex_nearby') {
            onFeatureBlockedRef.current({ reason: String(removal.reason).toUpperCase(), message: describeEditFailure(removal.reason) });
          }
          return;
        }
        e.preventDefault(); // Prevent browser right-click menu
        const curFeat = selectedOlFeatureRef.current;
        curFeat.changed();
        if (modifyInteractionRef.current) {
          modifyInteractionRef.current.setActive(false);
          modifyInteractionRef.current.setActive(true);
        }
        const coords = extractCoordinatesFromGeometry(curFeat.getGeometry());
        selectedVertexIndexRef.current = Math.max(0, Math.min(selectedVertexIndexRef.current || 0, Math.max(0, coords.length - 1)));

        if (layersRef.current.snappingVerticesSource) {
          renderSelectedFeatureVertices(curFeat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
        }
        const format = new GeoJSON();
        const geojson = JSON.parse(format.writeFeature(curFeat, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
        const featureId = curFeat.getId() || curFeat.get('_id') || geojson.id || geojson.properties?._id;
        const isWithin = checkFeatureWithinAssignedGrids(curFeat);
        if (onFeatureModifyEnd) {
          onFeatureModifyEnd(featureId, geojson.geometry, isWithin);
        }
      });

      mapInstance.current = map;
      if (typeof window !== 'undefined') {
        window.__kmcMap = map;
      }

      // Automatically adapt OpenLayers size on container resize (prevents width/height 0 warning)
      if (typeof ResizeObserver !== 'undefined' && mapRef.current) {
        ro = new ResizeObserver(() => {
          try {
            if (mapInstance.current) {
              mapInstance.current.updateSize();
            }
          } catch (_) {}
        });
        ro.observe(mapRef.current);
      }
      setTimeout(() => {
        try {
          if (mapInstance.current) {
            mapInstance.current.updateSize();
          }
        } catch (_) {}
      }, 50);
    } catch (err) {
      console.error('[Map] Init error:', err);
    }

    return () => {
      if (ro) {
        try { ro.disconnect(); } catch (_) {}
      }
      if (mapInstance.current) {
        mapInstance.current.setTarget(undefined);
        mapInstance.current = null;
      }
    };
  }, [olLoaded, olModules]);

  // ---- Update basemap visibility & opacity (supports 'none' mode) ----
  useEffect(() => {
    if (!layersRef.current.basemaps?.osm) return;
    const { basemaps } = layersRef.current;
    Object.entries(basemaps).forEach(([key, layer]) => {
      if (layer) {
        layer.setVisible(activeBasemap === key);
        layer.setOpacity(activeBasemap === key ? basemapOpacity / 100 : 0);
      }
    });
  }, [activeBasemap, basemapOpacity]);

function getDynamicLayerZIndex(layerId, isRaster, geomType = '', serverRasters = [], serverVectors = [], orderingConfig = null) {
  const strategy = orderingConfig?.strategy || 'golden_rules';
  const customRanks = orderingConfig?.custom_ranks || {};
  const currentLayer = (isRaster ? serverRasters : serverVectors)?.find((l) => String(l.id) === String(layerId));
  const explicitOrder = currentLayer?.display_order ?? (customRanks[String(layerId)] !== undefined ? Number(customRanks[String(layerId)]) : null);

  if (strategy === 'manual_ranking' && explicitOrder !== null && Number.isFinite(explicitOrder)) {
    return 10 + explicitOrder;
  }

  if (strategy === 'golden_rules') {
    if (isRaster) {
      const rank = explicitOrder !== null ? explicitOrder : 0;
      return 10 + Math.min(25, rank);
    }
    const gt = (geomType || currentLayer?.geometry_type || '').toUpperCase();
    const rank = explicitOrder !== null ? explicitOrder : 0;
    if (gt.includes('POLYGON')) return 40 + Math.min(18, rank);
    if (gt.includes('LINE')) return 60 + Math.min(18, rank);
    if (gt.includes('POINT')) return 80 + Math.min(18, rank);
    return 55 + Math.min(18, rank);
  }

  if (strategy === 'recent_on_top') {
    if (isRaster) {
      const sortedRasters = [...(serverRasters || [])].sort((a, b) => (a.created_at || a.lastActivatedAt || 0) - (b.created_at || b.lastActivatedAt || 0));
      const pos = sortedRasters.findIndex((r) => String(r.id) === String(layerId));
      return 10 + (pos >= 0 ? pos * 2 : 0);
    }
    const sortedVectors = [...(serverVectors || [])].sort((a, b) => (a.created_at || a.lastActivatedAt || 0) - (b.created_at || b.lastActivatedAt || 0));
    const pos = sortedVectors.findIndex((v) => String(v.id) === String(layerId));
    return 40 + (pos >= 0 ? pos * 2 : 0);
  }

  if (isRaster) return 10;
  const gt = (geomType || '').toUpperCase();
  if (gt.includes('POLYGON')) return 40;
  if (gt.includes('LINE')) return 60;
  if (gt.includes('POINT')) return 80;
  return 50;
}

  // ---- Sync Server Raster (MBTiles & Uploaded GeoTIFF / Image) Layers ----
  useEffect(() => {
    if (!olModules || !mapInstance.current) return;
    const { TileLayer, ImageLayer, ImageStatic, XYZ, transformExtent } = olModules;
    const existingRasters = layersRef.current.serverRasters;

    // Remove deleted rasters
    Object.keys(existingRasters).forEach((id) => {
      if (!serverRasters.find((r) => String(r.id) === id)) {
        mapInstance.current.removeLayer(existingRasters[id]);
        delete existingRasters[id];
      }
    });

    // Add / update rasters
    serverRasters.forEach((raster) => {
      const id = String(raster.id);
      const isVisible = raster.visible !== false;
      const opacity = (raster.opacity ?? 100) / 100;
      const rasterZIndex = getDynamicLayerZIndex(id, true, '', serverRasters, serverVectors, layerOrderingConfig);
      const bounds = Array.isArray(raster.bounds) && raster.bounds.length === 4
        ? raster.bounds.map(Number)
        : [85.324, 27.683, 85.345, 27.698];
      const extent3857 = transformExtent
        ? transformExtent(bounds, 'EPSG:4326', 'EPSG:3857')
        : undefined;

      let normalizedExtent3857 = undefined;
      if (extent3857 && extent3857.length === 4 && extent3857.every((n) => Number.isFinite(n))) {
        const minX = Math.min(extent3857[0], extent3857[2]);
        const minY = Math.min(extent3857[1], extent3857[3]);
        const maxX = Math.max(extent3857[0], extent3857[2]);
        const maxY = Math.max(extent3857[1], extent3857[3]);
        if (maxX > minX && maxY > minY) {
          normalizedExtent3857 = [minX, minY, maxX, maxY];
        }
      }

      let tileUrl = raster.tile_url || '';
      if (!tileUrl && raster.filename) {
        const stem = String(raster.filename).replace(/\.[^/.]+$/, '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
        tileUrl = `/api/tiles/data/${stem}/{z}/{x}/{y}.png`;
      }
      if (tileUrl.startsWith('/tiles/data/')) {
        tileUrl = '/api' + tileUrl;
      }
      if (!tileUrl) {
        tileUrl = 'https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}';
      }

      // Rebuild layer if image_data_url or tile_url changed
      if (
        existingRasters[id] &&
        (existingRasters[id]._imageDataUrl !== (raster.image_data_url || null) ||
         existingRasters[id]._tileUrl !== tileUrl)
      ) {
        mapInstance.current.removeLayer(existingRasters[id]);
        delete existingRasters[id];
      }

      if (!existingRasters[id]) {
        let rasterLayer = null;
        const isSyntheticSvg = typeof raster.image_data_url === 'string' &&
          (raster.image_data_url.includes('orthoGrid') || raster.image_data_url.includes('uavTint') || raster.image_data_url.includes('data:image/svg+xml'));
        if (raster.image_data_url && !isSyntheticSvg && ImageLayer && ImageStatic && normalizedExtent3857) {
          rasterLayer = new ImageLayer({
            source: new ImageStatic({
              url: raster.image_data_url,
              imageExtent: normalizedExtent3857,
              projection: 'EPSG:3857',
            }),
            visible: isVisible,
            opacity: opacity,
            zIndex: rasterZIndex,
          });
          rasterLayer._imageDataUrl = raster.image_data_url;
          rasterLayer._tileUrl = null;
        } else {
          rasterLayer = new TileLayer({
            source: new XYZ({
              url: tileUrl,
              minZoom: 0,
              maxZoom: Math.max(30, raster.max_zoom || 30),
              crossOrigin: 'anonymous',
              transition: 0,
              cacheSize: 8192,
            }),
            extent: normalizedExtent3857,
            visible: isVisible,
            opacity: opacity,
            zIndex: rasterZIndex,
            preload: 1,
            updateWhileAnimating: false,
            updateWhileInteracting: false,
            renderBuffer: 50,
          });
          rasterLayer._imageDataUrl = null;
          rasterLayer._tileUrl = tileUrl;
        }
        mapInstance.current.addLayer(rasterLayer);
        existingRasters[id] = rasterLayer;
      } else {
        existingRasters[id].setVisible(isVisible);
        existingRasters[id].setOpacity(opacity);
        existingRasters[id].setZIndex(rasterZIndex);
      }
    });
  }, [serverRasters, serverVectors, olModules, layerOrderingConfig]);

  // ---- Sync Server Vector (PostGIS) Layers (With Complete Error Isolation) ----
  useEffect(() => {
    if (!olModules || !mapInstance.current) return;
    const { VectorLayer, VectorTileLayer, VectorSource, VectorTileSource, MVT, GeoJSON, Style, Fill, Stroke, CircleStyle, Icon, bboxStrategy, transformExtent, Feature } = olModules;
    const existingVectors = layersRef.current.serverVectors;

    // Remove deleted vector layers
    Object.keys(existingVectors).forEach((id) => {
      if (!serverVectors.find((v) => String(v.id) === id)) {
        if (existingVectors[id].tileLayer) {
          try { mapInstance.current.removeLayer(existingVectors[id].tileLayer); } catch (e) {}
        }
        if (existingVectors[id].editLayer) {
          try { mapInstance.current.removeLayer(existingVectors[id].editLayer); } catch (e) {}
        }
        if (existingVectors[id].layer && existingVectors[id].layer !== existingVectors[id].tileLayer && existingVectors[id].layer !== existingVectors[id].editLayer) {
          try { mapInstance.current.removeLayer(existingVectors[id].layer); } catch (e) {}
        }
        delete existingVectors[id];
      }
    });

    // Add / update vector layers
    // Distinct default color per layer (admin can override via layer style settings)
    const colorPalette = [
      '#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4',
      '#f97316', '#14b8a6', '#84cc16', '#f43f5e', '#a855f7', '#0ea5e9',
    ];

    serverVectors.forEach((layerData, idx) => {
      const id = String(layerData.id);
      const isVisible = layerData.visible !== false;
      const rawOpacity = layerData.opacity ?? 100;
      const opacity = rawOpacity > 1 ? rawOpacity / 100 : (rawOpacity === 1 ? 1.0 : Math.max(0, Math.min(1, rawOpacity)));
      const adminStyle = layerData.style || {};
      const color = adminStyle.strokeColor || colorPalette[idx % colorPalette.length];
      const adminFill = adminStyle.fillColor || adminStyle.fill;
      const polyFill = adminFill
        ? (adminFill.startsWith('#') && adminFill.length === 7 ? `${adminFill}33` : adminFill)
        : (color.startsWith('#') && color.length === 7 ? `${color}33` : 'rgba(59, 130, 246, 0.25)');
      const adminWidth = Number(adminStyle.strokeWidth);
      const polyWidth = Number.isFinite(adminWidth) && adminWidth > 0 ? adminWidth : 2.5;
      const lineWidth = Number.isFinite(adminWidth) && adminWidth > 0 ? adminWidth : 3;
      const geomType = (layerData.geometry_type || '').toUpperCase();

      // Dynamic Layer Stacking: sovereign GIS golden rules or admin custom order
      const zIndex = getDynamicLayerZIndex(id, false, geomType, serverRasters, serverVectors, layerOrderingConfig);

      try {
        const createLayerStyle = () => {
          // Pre-cache standard styles to eliminate heap allocations per frame on large datasets
          const defaultPolyStyle = new Style({
            fill: new Fill({ color: polyFill }),
            stroke: new Stroke({ color: color, width: polyWidth }),
          });
          const defaultOutlinePolyStyle = new Style({
            fill: new Fill({ color: 'rgba(0, 0, 0, 0.001)' }),
            stroke: new Stroke({ color: color, width: 2.8 }),
          });
          const defaultLineStyle = [
            new Style({
              stroke: new Stroke({ color: 'rgba(0, 0, 0, 0.7)', width: Math.max(4.5, lineWidth + 2.5) }),
              zIndex: 1,
            }),
            new Style({
              stroke: new Stroke({ color: color || '#10b981', width: Math.max(2.5, lineWidth) }),
              zIndex: 2,
            }),
          ];
          const defaultPointStyle = new Style({
            image: new CircleStyle({
              radius: 7,
              fill: new Fill({ color: color || '#ef4444' }),
              stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
            }),
            zIndex: 10,
          });
          const defaultLineStyleZoomedOut = new Style({
            stroke: new Stroke({ color: color || '#10b981', width: 1.8 }),
          });

          return (feature, resolution) => {
            const geom = feature ? (typeof feature.getGeometry === 'function' ? feature.getGeometry() : null) : null;
            let isPoly = feature?._isPoly;
            let isLine = feature?._isLine;
            if (isPoly === undefined && feature) {
              const type = (typeof geom?.getType === 'function' ? geom.getType() : (typeof feature?.getType === 'function' ? feature.getType() : ''))?.toUpperCase() || geomType;
              isPoly = type.includes('POLYGON');
              isLine = type.includes('LINE');
              feature._isPoly = isPoly;
              feature._isLine = isLine;
            } else if (isPoly === undefined) {
              isPoly = geomType.includes('POLYGON');
              isLine = geomType.includes('LINE');
            }

            // TomTom-style sub-pixel LOD culling:
            // When zoomed out, polygons and lines smaller than 1.0px cannot be meaningfully resolved
            // by the eye. Culling them saves thousands of GPU raster draws and prevents visual clutter.
            if (resolution && geom && typeof geom.getExtent === 'function') {
              const ext = geom.getExtent();
              if (isPoly) {
                const widthPx = (ext[2] - ext[0]) / resolution;
                const heightPx = (ext[3] - ext[1]) / resolution;
                if (resolution > 15 && widthPx < 1.0 && heightPx < 1.0) {
                  return null;
                }
              } else if (isLine) {
                const diagPx = Math.hypot((ext[2] - ext[0]) / resolution, (ext[3] - ext[1]) / resolution);
                if (resolution > 20 && diagPx < 1.0) {
                  return null;
                }
              }
            }

            const isLayerOutlined = !!layerData.outlineOnly;

            // Layer-specific Multi-Collector Edit Visualization check
            let isTargetEdit = false;
            let activeColor = null;

            if (layerData.viewEdits && feature) {
              const props = feature.getProperties() || {};
              const editorInfo = extractFeatureCollector(props);

              if (editorInfo.hasEdit) {
                const myUsername = (currentUser?.username || '').toLowerCase();
                const myId = currentUser?.id;
                const isMine = (
                  (myId != null && (editorInfo.createdById === myId || editorInfo.updatedById === myId)) ||
                  (myUsername && (
                    (editorInfo.createdByUsername || '').toLowerCase() === myUsername ||
                    (editorInfo.updatedByUsername || '').toLowerCase() === myUsername ||
                    (editorInfo.kmcEditor || '').toLowerCase() === myUsername
                  ))
                );

                // Normalize selectedCollectors
                let selected = layerData.selectedCollectors;
                if (!selected || (Array.isArray(selected) && selected.length === 0)) {
                  if (layerData.editCollectorId) {
                    selected = [layerData.editCollectorId];
                  } else {
                    selected = isAdmin ? ['all'] : ['my_edits'];
                  }
                }

                if (!isAdmin || selected.includes('my_edits')) {
                  if (isMine) {
                    isTargetEdit = true;
                    activeColor = getCollectorColor(myUsername || myId || 'my_edits');
                  }
                } else if (selected.includes('all')) {
                  isTargetEdit = true;
                  activeColor = getCollectorColor(editorInfo.key);
                } else {
                  const matchSelected = selected.some((sel) => {
                    const s = String(sel).toLowerCase();
                    return (
                      s === editorInfo.key ||
                      s === String(editorInfo.userId) ||
                      s === (editorInfo.username || '').toLowerCase() ||
                      s === (editorInfo.createdByUsername || '').toLowerCase() ||
                      s === (editorInfo.updatedByUsername || '').toLowerCase() ||
                      s === (editorInfo.kmcEditor || '').toLowerCase()
                    );
                  });

                  if (matchSelected) {
                    isTargetEdit = true;
                    activeColor = getCollectorColor(editorInfo.key);
                  }
                }
              }
            }

            // HIGHLIGHT STYLING FOR EDITED FEATURES (Distinct color per collector, elevated Z-index, double casing)
            if (isTargetEdit && activeColor) {
              const casingColor = '#ffffff';
              const strokeColor = activeColor.stroke;
              const fillColor = activeColor.fill;
              const hexColor = activeColor.hex;

              if (isPoly) {
                return [
                  new Style({
                    zIndex: 998,
                    stroke: new Stroke({ color: casingColor, width: 5.5 }),
                  }),
                  new Style({
                    zIndex: 999,
                    fill: new Fill({ color: fillColor }),
                    stroke: new Stroke({ color: strokeColor, width: 3.5 }),
                  }),
                ];
              } else if (isLine) {
                return [
                  new Style({
                    zIndex: 998,
                    stroke: new Stroke({ color: casingColor, width: 6.5 }),
                  }),
                  new Style({
                    zIndex: 999,
                    stroke: new Stroke({ color: strokeColor, width: 4.5 }),
                  }),
                ];
              } else {
                return [
                  new Style({
                    zIndex: 998,
                    image: new CircleStyle({
                      radius: 12,
                      fill: new Fill({ color: fillColor }),
                      stroke: new Stroke({ color: casingColor, width: 2 }),
                    }),
                  }),
                  new Style({
                    zIndex: 999,
                    image: new CircleStyle({
                      radius: 6.5,
                      fill: new Fill({ color: hexColor }),
                      stroke: new Stroke({ color: casingColor, width: 2.5 }),
                    }),
                  }),
                ];
              }
            }

            // STANDARD LAYER STYLING - Instant zero-allocation cached return
            let baseStyle = null;
            if (isLayerOutlined && isPoly) {
              baseStyle = defaultOutlinePolyStyle;
            } else if (isPoly) {
              baseStyle = defaultPolyStyle;
            } else if (isLine) {
              if (resolution && resolution > 3.5) {
                // When zoomed out, use clean hairline styling for smooth uncluttered road rendering
                baseStyle = defaultLineStyleZoomedOut;
              } else {
                baseStyle = defaultLineStyle;
              }
            } else {
              baseStyle = defaultPointStyle;
            }

            // House Number Label Rendering (Zoom-level filtered for 60fps & clean visual organization)
            if (feature) {
              const houseNo = feature.get('house_number') || (feature.getProperties ? feature.getProperties().house_number : null);
              if (houseNo) {
                const fid = feature.getId ? feature.getId() : (feature.get ? feature.get('_id') : null);
                const isIndividuallyShown = individualHouseNumberFeatureIdRef.current && fid != null && String(individualHouseNumberFeatureIdRef.current) === String(fid);
                // When all labels are selected, show based on zoom levels (resolution < 2.5 ~ zoom 16+)
                const shouldShowHouseLabel = isIndividuallyShown || (showHouseNumbersRef.current && resolution < 2.5);

                if (shouldShowHouseLabel && Icon) {
                  const badgeUrl = buildHouseNumberBadgeDataUrl(houseNo, '#1d4ed8');
                  if (badgeUrl) {
                    const labelStyle = new Style({
                      zIndex: 1000,
                      image: new Icon({
                        src: badgeUrl,
                        anchor: [0.5, 1],
                        anchorXUnits: 'fraction',
                        anchorYUnits: 'fraction',
                        scale: isIndividuallyShown ? 1.05 : 0.8,
                      }),
                    });
                    return Array.isArray(baseStyle) ? [...baseStyle, labelStyle] : [baseStyle, labelStyle];
                  }
                }
              }
            }

            return baseStyle;
          };
        };

        // Check for MVT vector tile endpoint (Martin or custom MVT service)
        const rawTileUrl = layerData.mvt_url || layerData.mvtUrl || layerData.tile_url || layerData.tileUrl;
        const isExplicitMvt = Boolean(
          layerData.mvt_url ||
          layerData.mvtUrl ||
          layerData.use_mvt ||
          layerData.is_mvt ||
          layerData.isMvt ||
          layerData.source_type === 'mvt' ||
          (typeof rawTileUrl === 'string' && (rawTileUrl.includes('.pbf') || rawTileUrl.includes('/martin/')))
        );

        let mvtUrl = null;
        if (isExplicitMvt) {
          if (typeof rawTileUrl === 'string' && (rawTileUrl.includes('.pbf') || rawTileUrl.includes('{z}'))) {
            mvtUrl = rawTileUrl;
          } else {
            mvtUrl = `/martin/vector_features/{z}/{x}/{y}.pbf`;
          }
        } else if (
          (layerData.feature_count && layerData.feature_count > 100) ||
          layerData.source_type === 'mvt' ||
          layerData.is_mvt ||
          layerData.bboxMode ||
          !layerData.features ||
          String(id) === '1795243402839' ||
          layerData.name === 'UnetRaw' ||
          (typeof rawTileUrl === 'string' && rawTileUrl.includes('/tiles/vector/'))
        ) {
          mvtUrl = rawTileUrl || `/api/tiles/vector/${id}/{z}/{x}/{y}.pbf`;
        }

        const isCurrentlyMvt = !!existingVectors[id]?.isMvt;
        const willBeMvt = !!mvtUrl;
        if (
          existingVectors[id] &&
          (isCurrentlyMvt !== willBeMvt ||
            (willBeMvt && existingVectors[id].mvtUrl !== mvtUrl) ||
            (!willBeMvt && existingVectors[id].bboxMode !== !!layerData.bboxMode))
        ) {
          try {
            if (existingVectors[id].tileLayer) mapInstance.current.removeLayer(existingVectors[id].tileLayer);
            if (existingVectors[id].editLayer) mapInstance.current.removeLayer(existingVectors[id].editLayer);
            if (existingVectors[id].layer && existingVectors[id].layer !== existingVectors[id].tileLayer) {
              mapInstance.current.removeLayer(existingVectors[id].layer);
            }
          } catch (e) {}
          delete existingVectors[id];
        }

        if (!existingVectors[id]) {
          if (willBeMvt && VectorTileLayer && VectorTileSource && MVT) {
            // MVT VectorTileLayer: binary protocol buffer streaming with GPU/Canvas acceleration
            const vParam = layerData.tile_version || layerData.version || layerData._v;
            let initialMvtUrl = mvtUrl;
            if (mvtUrl && vParam) {
              initialMvtUrl = `${mvtUrl}${mvtUrl.includes('?') ? '&' : '?'}v=${vParam}`;
            }

            const tileSource = new VectorTileSource({
              format: new MVT({
                featureClass: Feature,
              }),
              url: initialMvtUrl,
              maxZoom: 22,
              minZoom: 0,
            });

            const vectorTileLayer = new VectorTileLayer({
              source: tileSource,
              visible: isVisible,
              opacity: opacity,
              zIndex: zIndex,
              style: createLayerStyle(),
              updateWhileAnimating: false,
              updateWhileInteracting: false,
              renderBuffer: 50,
              renderOrder: null,
            });

            // Dedicated active vector edit source and overlay layer for in-flight drawing, snapping, and editing
            const editSource = new VectorSource();
            editSource._tileSource = tileSource;

            const editLayer = new VectorLayer({
              source: editSource,
              visible: isVisible,
              opacity: opacity,
              zIndex: zIndex + 1,
              style: createLayerStyle(),
              updateWhileAnimating: false,
              updateWhileInteracting: false,
              renderBuffer: 50,
            });

            mapInstance.current.addLayer(vectorTileLayer);
            mapInstance.current.addLayer(editLayer);

            existingVectors[id] = {
              layer: vectorTileLayer,
              tileLayer: vectorTileLayer,
              source: editSource,
              editSource,
              editLayer,
              tileSource,
              isMvt: true,
              mvtUrl,
              baseMvtUrl: mvtUrl,
              _lastVersion: vParam,
              bboxMode: false,
            };
          } else {
            const isBboxMode = !!layerData.bboxMode;
            // Unified high-performance VectorSource: Viewport bbox streaming is driven deterministically
            // by the debounced moveend pipeline with request cancellation and incremental deduplication.
            const source = new VectorSource();

            const vectorLayer = new VectorLayer({
              source,
              visible: isVisible,
              opacity: opacity,
              zIndex: zIndex,
              style: createLayerStyle(),
              updateWhileAnimating: false,
              updateWhileInteracting: false,
              renderBuffer: 50,
              renderOrder: null, // Disables CPU sorting overhead across large feature datasets
            });

            mapInstance.current.addLayer(vectorLayer);
            existingVectors[id] = { layer: vectorLayer, source, bboxMode: isBboxMode };
            if (isBboxMode && isVisible) {
              setTimeout(() => {
                mapInstance.current?._refreshBboxLayers?.();
              }, 60);
            }
          }
        } else {
          if (existingVectors[id].isMvt) {
            existingVectors[id].tileLayer.setVisible(isVisible);
            existingVectors[id].tileLayer.setOpacity(opacity);
            existingVectors[id].tileLayer.setZIndex(zIndex);
            existingVectors[id].tileLayer.setStyle(createLayerStyle());
            existingVectors[id].tileLayer.changed();

            existingVectors[id].editLayer.setVisible(isVisible);
            existingVectors[id].editLayer.setOpacity(opacity);
            existingVectors[id].editLayer.setZIndex(zIndex + 1);
            existingVectors[id].editLayer.setStyle(createLayerStyle());
            existingVectors[id].editLayer.changed();

            // Refresh MVT tile cache if layer version has changed
            const currentV = layerData.tile_version || layerData.version || layerData._v;
            if (currentV && existingVectors[id]._lastVersion !== currentV) {
              existingVectors[id]._lastVersion = currentV;
              const base = existingVectors[id].baseMvtUrl || existingVectors[id].mvtUrl || mvtUrl;
              if (base && existingVectors[id].tileSource) {
                const sep = base.includes('?') ? '&' : '?';
                const cleanBase = base.replace(/([?&])v=[^&]+/, '');
                const finalBase = cleanBase.includes('?') ? `${cleanBase}&v=${currentV}` : `${cleanBase}?v=${currentV}`;
                existingVectors[id].tileSource.setUrl(finalBase);
                try { existingVectors[id].tileSource.clear(); } catch (_) {}
                try { existingVectors[id].tileSource.refresh(); } catch (_) {}
              }
            }
          } else {
            const wasVisible = existingVectors[id].layer.getVisible();
            existingVectors[id].layer.setVisible(isVisible);
            existingVectors[id].layer.setOpacity(opacity);
            existingVectors[id].layer.setZIndex(zIndex);
            existingVectors[id].layer.setStyle(createLayerStyle());
            existingVectors[id].layer.changed();
            if (existingVectors[id].bboxMode && isVisible && !wasVisible) {
              setTimeout(() => {
                mapInstance.current?._refreshBboxLayers?.();
              }, 60);
            }
          }
        }

        // Safely parse and add features only if valid and changed
        // (bbox-mode layers load their own features per viewport — skip here)
        if (layerData.features && existingVectors[id] && !existingVectors[id].bboxMode) {
          if (existingVectors[id].lastFeaturesRef !== layerData.features) {
            const source = existingVectors[id].isMvt ? existingVectors[id].editSource : existingVectors[id].source;
            source.clear();

            let geoJsonData = sanitizeGeoJsonForOpenLayers(layerData.features);

            // Normalize: handle raw array of features, object with features, or FeatureCollection
            if (Array.isArray(geoJsonData)) {
              geoJsonData = { type: 'FeatureCollection', features: geoJsonData };
            } else if (geoJsonData && typeof geoJsonData === 'object') {
              if (!geoJsonData.type && Array.isArray(geoJsonData.features)) {
                geoJsonData = { ...geoJsonData, type: 'FeatureCollection' };
              }
            }

            if (
              geoJsonData &&
              (geoJsonData.type === 'FeatureCollection' ||
                geoJsonData.type === 'Feature' ||
                Array.isArray(geoJsonData.features))
            ) {
              const featureList = Array.isArray(geoJsonData.features) ? geoJsonData.features : null;
              const isLargeLayer = featureList && featureList.length > 500;

              if (isLargeLayer) {
                // OPTIMIZED: Progressive chunked rendering for large layers (e.g. roads, buildings)
                const format = new GeoJSON();
                const CHUNK_SIZE = 500;
                let totalAdded = 0;

                const processChunk = (startIdx) => {
                  if (!existingVectors[id] || (!existingVectors[id].source && !existingVectors[id].editSource)) return;
                  const currentSource = existingVectors[id].isMvt ? existingVectors[id].editSource : existingVectors[id].source;
                  const endIdx = Math.min(startIdx + CHUNK_SIZE, featureList.length);
                  const chunk = featureList.slice(startIdx, endIdx);

                  try {
                    const chunkCollection = { type: 'FeatureCollection', features: chunk };
                    const parsed = format.readFeatures(chunkCollection, {
                      dataProjection: 'EPSG:4326',
                      featureProjection: 'EPSG:3857',
                    });
                    const valid = getValidOlFeatures(parsed);
                    if (valid.length > 0) {
                      try {
                        currentSource.addFeatures(valid);
                      } catch (bulkErr) {
                        for (let i = 0; i < valid.length; i++) {
                          try { currentSource.addFeature(valid[i]); } catch (e) {}
                        }
                      }
                      totalAdded += valid.length;
                    }
                  } catch (chunkErr) {
                    for (const feat of chunk) {
                      try {
                        if (feat && feat.geometry && feat.geometry.coordinates && Array.isArray(feat.geometry.coordinates) && feat.geometry.coordinates.length > 0) {
                          const cleanFeat = {
                            type: 'Feature',
                            geometry: feat.geometry,
                            properties: { ...(feat.properties || {}) },
                          };
                          delete cleanFeat.properties.geometry;
                          delete cleanFeat.properties.the_geom;
                          const singleCollection = { type: 'FeatureCollection', features: [cleanFeat] };
                          const parsed = format.readFeatures(singleCollection, {
                            dataProjection: 'EPSG:4326',
                            featureProjection: 'EPSG:3857',
                          });
                          const valid = getValidOlFeatures(parsed);
                          for (const vf of valid) {
                            try { currentSource.addFeature(vf); totalAdded++; } catch (e) {}
                          }
                        }
                      } catch (e) {}
                    }
                  }

                  if (endIdx < featureList.length) {
                    requestAnimationFrame(() => processChunk(endIdx));
                  } else {
                    console.debug(`[Map] Layer ${id}: progressively loaded ${totalAdded} features (chunked)`);
                  }
                };

                processChunk(0);
              } else {
                // STANDARD: Small layers — existing synchronous approach
                try {
                  const format = new GeoJSON();
                  const rawFeatures = format.readFeatures(geoJsonData, {
                    dataProjection: 'EPSG:4326',
                    featureProjection: 'EPSG:3857',
                  });
                  const validFeatures = getValidOlFeatures(rawFeatures);
                  if (validFeatures.length > 0) {
                    try {
                      source.addFeatures(validFeatures);
                    } catch (bulkErr) {
                      console.warn(`[Map] Layer ${id}: Bulk addFeatures failed, inserting individually:`, bulkErr);
                      for (let i = 0; i < validFeatures.length; i++) {
                        try { source.addFeature(validFeatures[i]); } catch (e) {}
                      }
                    }
                    console.debug(`[Map] Layer ${id}: loaded ${source.getFeatures().length} features successfully`);
                  } else {
                    console.warn(`[Map] Layer ${id}: GeoJSON parsed but 0 valid features`);
                  }
                } catch (parseErr) {
                  console.error(`[Map] Layer ${id}: GeoJSON parse error:`, parseErr);
                  // Attempt fallback: parse features one-by-one to skip bad ones
                  if (Array.isArray(geoJsonData.features)) {
                    const format = new GeoJSON();
                    let addedCount = 0;
                    for (const feat of geoJsonData.features) {
                      try {
                        if (feat && feat.geometry && feat.geometry.coordinates && Array.isArray(feat.geometry.coordinates) && feat.geometry.coordinates.length > 0) {
                          const cleanFeat = {
                            type: 'Feature',
                            geometry: feat.geometry,
                            properties: { ...(feat.properties || {}) },
                          };
                          delete cleanFeat.properties.geometry;
                          delete cleanFeat.properties.the_geom;

                          const singleCollection = { type: 'FeatureCollection', features: [cleanFeat] };
                          const parsed = format.readFeatures(singleCollection, {
                            dataProjection: 'EPSG:4326',
                            featureProjection: 'EPSG:3857',
                          });
                          const valid = getValidOlFeatures(parsed);
                          for (const vf of valid) {
                            try {
                              source.addFeature(vf);
                              addedCount++;
                            } catch (e) {}
                          }
                        }
                      } catch (e) {
                        // Skip malformed feature
                      }
                    }
                    console.debug(`[Map] Layer ${id}: fallback parsed ${addedCount} features`);
                  }
                }
              }
            } else {
              console.warn(`[Map] Layer ${id}: unrecognized data format, type="${geoJsonData?.type}"`);
            }
            existingVectors[id].lastFeaturesRef = layerData.features;
          }
        }
      } catch (err) {
        console.warn(`[Map] Safely handled vector dataset rendering for layer ${id}:`, err);
      }
    });
  }, [serverVectors, serverRasters, olModules, editMode, currentUser, isAdmin, layerOrderingConfig]);

  // ---- Update Polygon Styles on Edit Mode Toggle (Outline-Only with Transparent Interior in Edit Mode) ----
  useEffect(() => {
    if (!mapInstance.current || !olModules) return;
    const existingVectors = layersRef.current.serverVectors;
    Object.values(existingVectors).forEach((entry) => {
      if (entry && entry.layer) {
        entry.layer.changed();
      }
      if (entry && entry.tileLayer) {
        entry.tileLayer.changed();
      }
      if (entry && entry.editLayer) {
        entry.editLayer.changed();
      }
    });
  }, [editMode, olModules]);

  // ---- Handle Zoom to Layer (Triggered by zoomTarget prop) ----
  useEffect(() => {
    if (!zoomTarget || !mapInstance.current || !olModules) return;
    const { transformExtent } = olModules;

    try {
      if (zoomTarget.type === 'vector') {
        const vectorObj = layersRef.current.serverVectors[String(zoomTarget.id)];
        if (vectorObj) {
          let extent = null;
          if (vectorObj.source && typeof vectorObj.source.getExtent === 'function') {
            const ext = vectorObj.source.getExtent();
            if (isValidExtent(ext)) extent = ext;
          }
          if (!extent) {
            const lData = (serverVectorsRef.current || []).find((v) => String(v.id) === String(zoomTarget.id));
            const bounds = lData?.bounds || lData?.bbox || lData?.extent;
            if (bounds && Array.isArray(bounds) && bounds.length === 4) {
              const transExt = transformExtent(bounds, 'EPSG:4326', 'EPSG:3857');
              if (isValidExtent(transExt)) extent = transExt;
            }
          }
          if (isValidExtent(extent)) {
            mapInstance.current.getView().fit(extent, {
              padding: [80, 80, 80, 80],
              duration: 700,
              maxZoom: 19,
            });
          }
        }
      } else if (zoomTarget.type === 'raster') {
        if (zoomTarget.bounds && Array.isArray(zoomTarget.bounds) && zoomTarget.bounds.length === 4) {
          const extent = transformExtent(zoomTarget.bounds, 'EPSG:4326', 'EPSG:3857');
          if (isValidExtent(extent)) {
            mapInstance.current.getView().fit(extent, {
              padding: [80, 80, 80, 80],
              duration: 700,
              maxZoom: 20,
            });
          }
        } else {
          // Fallback: resolve the raster bounds from the tile catalog.
          fetch('/api/tiles')
            .then((res) => (res.ok ? res.json() : null))
            .then((tiles) => {
              const tile = Array.isArray(tiles)
                ? tiles.find((t) => String(t.id) === String(zoomTarget.id))
                : null;
              const bounds = tile?.bounds || tile?.bbox;
              if (bounds && Array.isArray(bounds) && bounds.length === 4) {
                const extent = transformExtent(bounds, 'EPSG:4326', 'EPSG:3857');
                if (isValidExtent(extent) && mapInstance.current) {
                  mapInstance.current.getView().fit(extent, {
                    padding: [80, 80, 80, 80],
                    duration: 700,
                    maxZoom: 20,
                  });
                }
              }
            })
            .catch((e) => console.warn('Raster bounds query failed, using extent fallback:', e));
        }
      } else if (zoomTarget.type === 'extent') {
        if (zoomTarget.bounds && Array.isArray(zoomTarget.bounds) && isValidExtent(zoomTarget.bounds)) {
          mapInstance.current.getView().fit(zoomTarget.bounds, {
            padding: [90, 90, 90, 90],
            duration: 600,
            maxZoom: 19,
          });
        }
      }
    } catch (err) {
      console.warn('[Map] Zoom to layer error:', err);
    }
  }, [zoomTarget, olModules]);

  // ---- Sync Inspected Feature Highlight from outside ----
  useEffect(() => {
    if (!featureHighlightSourceRef.current) return;
    if (!inspectedFeatureId) {
      inspectedFeatureRef.current = null;
      if (!selectedFeatureId) {
        featureHighlightSourceRef.current.clear();
      }
      return;
    }

    // If featureHighlightSource already contains this feature, don't clear and don't re-add!
    const existing = featureHighlightSourceRef.current.getFeatures();
    const alreadyHighlighted = existing.some((f) => {
      const fid = f.getId ? f.getId() : (f.get ? (f.get('_id') || f.get('id')) : null);
      return String(fid) === String(inspectedFeatureId);
    });
    if (alreadyHighlighted) return;

    // Direct render from inspectedFeature geometry if available (works instantly for all bbox/vector layers)
    const targetGeom = inspectedFeature?.geometry;
    if (targetGeom && olModules?.GeoJSON && olModules?.Feature) {
      try {
        const format = new olModules.GeoJSON();
        const olGeom = format.readGeometry(targetGeom, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
        if (olGeom) {
          const hFeat = new olModules.Feature({ geometry: olGeom });
          hFeat.setId(inspectedFeatureId);
          featureHighlightSourceRef.current.clear();
          featureHighlightSourceRef.current.addFeature(hFeat);
          return;
        }
      } catch (e) {}
    }

    // Find the feature in visible vector layers and highlight it
    let found = false;
    Object.values(layersRef.current.serverVectors).forEach((vObj) => {
      if (found || !vObj || !vObj.source || typeof vObj.source.getFeatures !== 'function') return;
      const match = vObj.source.getFeatures().find((f) => {
        const fid = f.getId() || f.get('_id') || f.get('id');
        return String(fid) === String(inspectedFeatureId);
      });
      if (match) {
        found = true;
        inspectedFeatureRef.current = match;
        featureHighlightSourceRef.current.clear();
        featureHighlightSourceRef.current.addFeature(match.clone());
      }
    });
  }, [inspectedFeatureId, inspectedFeature, serverVectors, selectedFeatureId, olModules]);

  // ---- Update task grids ----
  useEffect(() => {
    if (!olModules || !layersRef.current.taskSource) return;
    const { GeoJSON } = olModules;
    const source = layersRef.current.taskSource;
    source.clear();

    if (taskGrids && (taskGrids.type === 'FeatureCollection' || Array.isArray(taskGrids.features))) {
      try {
        const format = new GeoJSON();
        const rawFeatures = format.readFeatures(taskGrids, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
        const validFeatures = getValidOlFeatures(rawFeatures);
        if (validFeatures.length > 0) {
          try {
            source.addFeatures(validFeatures);
          } catch (bulkErr) {
            console.warn('[Map] Bulk add task features failed, adding one by one:', bulkErr);
            for (let i = 0; i < validFeatures.length; i++) {
              try {
                source.addFeature(validFeatures[i]);
              } catch (e) {}
            }
          }

          if (mapInstance.current) {
            const extent = source.getExtent();
            if (isValidExtent(extent)) {
              mapInstance.current.getView().fit(extent, { padding: [60, 60, 60, 60], duration: 500, maxZoom: 18 });
            }
          }
        }
      } catch (err) {
        console.warn('[Map] Task grid parse notice:', err);
      }
    }
  }, [taskGrids, olModules]);

  // ---- Redraw task layer when selectedTask changes ----
  useEffect(() => {
    if (layersRef.current.taskLayer) {
      layersRef.current.taskLayer.changed();
    }
  }, [selectedTask]);

  // ---- Render the persisted project AOI boundary (reference layer) ----
  useEffect(() => {
    if (!olModules || !layersRef.current.aoiSource) return;
    const { GeoJSON } = olModules;
    const source = layersRef.current.aoiSource;
    source.clear();

    if (aoiBoundary) {
      try {
        const feats = parseGeoJsonFeatures(aoiBoundary, GeoJSON, 'EPSG:3857');
        if (feats && feats.length > 0) {
          source.addFeatures(feats);
          if (layersRef.current.aoiLayer) layersRef.current.aoiLayer.changed();
        }
      } catch (err) {
        console.warn('[Map] AOI boundary render error:', err);
      }
    }
  }, [aoiBoundary, olModules]);

  // ---- Layer visibility toggles: task grids, AOI boundary & drawn preview ----
  useEffect(() => {
    if (layersRef.current.taskLayer) {
      layersRef.current.taskLayer.setVisible(Boolean(showTaskGrids));
    }
  }, [showTaskGrids, olLoaded]);

  useEffect(() => {
    const isVisible = Boolean(showAoiBoundary);
    if (layersRef.current.aoiLayer) {
      layersRef.current.aoiLayer.setVisible(isVisible);
    }
    if (layersRef.current.drawnBoundaryLayer) {
      layersRef.current.drawnBoundaryLayer.setVisible(isVisible);
    }
  }, [showAoiBoundary, olLoaded, aoiBoundary, drawnBoundary]);

  // ---- Update Drawn Task Boundary Preview on Map ----
  useEffect(() => {
    if (!olModules || !layersRef.current.drawnBoundarySource) return;
    const { GeoJSON } = olModules;
    const source = layersRef.current.drawnBoundarySource;
    source.clear();

    if (drawnBoundary) {
      try {
        const feats = parseGeoJsonFeatures(drawnBoundary, GeoJSON, 'EPSG:3857');
        if (feats && feats.length > 0) {
          source.addFeatures(feats);
          if (layersRef.current.drawnBoundaryLayer) layersRef.current.drawnBoundaryLayer.changed();
          const geom = feats[0]?.getGeometry();
          if (geom) {
            const extent = geom.getExtent();
            if (mapInstance.current && isValidExtent(extent)) {
              mapInstance.current.getView().fit(extent, { padding: [80, 80, 80, 80], duration: 400 });
            }
          }
        }
      } catch (err) {
        console.warn('[Map] Drawn boundary preview error:', err);
      }
    }
  }, [drawnBoundary, olModules]);

  // ---- Update GPS position + accuracy circle ----
  useEffect(() => {
    if (!olModules || !layersRef.current.gpsSource || !gpsPosition) return;
    try {
      const { Feature, Point, Style, Fill, Stroke, CircleStyle, CircleGeom, fromLonLat } = olModules;
      const source = layersRef.current.gpsSource;
      source.clear();

      const coords = fromLonLat([gpsPosition.lng, gpsPosition.lat]);

      // GPS dot
      const gpsDot = new Feature({ geometry: new Point(coords) });
      gpsDot.setStyle(new Style({
        image: new CircleStyle({
          radius: 8,
          fill: new Fill({ color: '#3478ff' }),
          stroke: new Stroke({ color: '#ffffff', width: 3 }),
        }),
      }));
      source.addFeature(gpsDot);

      // Accuracy Circle
      const accuracyCircle = new Feature({
        geometry: new CircleGeom(coords, gpsPosition.accuracy || 30),
      });
      accuracyCircle.setStyle(new Style({
        fill: new Fill({ color: 'rgba(52, 120, 255, 0.08)' }),
        stroke: new Stroke({ color: 'rgba(52, 120, 255, 0.35)', width: 1.5, lineDash: [6, 4] }),
      }));
      source.addFeature(accuracyCircle);
    } catch (err) {
      console.warn('[Map] GPS render notice:', err);
    }
  }, [gpsPosition, olModules]);

  // ---- Update Real-Time Data Collector Tracking Locations on Map (Dynamic Co-Location Spider Dispersal) ----
  useEffect(() => {
    if (!olModules || !layersRef.current.collectorTrackingSource) return;
    const { Feature, Point, LineString, CircleGeom, fromLonLat } = olModules;
    const source = layersRef.current.collectorTrackingSource;
    source.clear();

    if (!showCollectorLocations || !Array.isArray(collectorLocations) || collectorLocations.length === 0) {
      return;
    }

    try {
      // 1. Filter collectors with valid geographic coordinates
      const validCollectors = collectorLocations.filter(
        (col) => col.latitude !== null && col.longitude !== null && !isNaN(col.latitude) && !isNaN(col.longitude)
      );

      // 2. Spatial Clustering: Group co-located or near-identical coordinates (< 10 meters distance)
      const clusters = [];
      validCollectors.forEach((col) => {
        const coords = fromLonLat([col.longitude, col.latitude]);
        let matchedCluster = null;

        for (const cl of clusters) {
          const dx = cl.anchorCoords[0] - coords[0];
          const dy = cl.anchorCoords[1] - coords[1];
          // If within 10 meters in map projection units, group as co-located
          if (Math.hypot(dx, dy) < 10) {
            matchedCluster = cl;
            break;
          }
        }

        if (matchedCluster) {
          matchedCluster.collectors.push(col);
          if (col.accuracy) {
            matchedCluster.maxAccuracy = Math.max(matchedCluster.maxAccuracy || 0, col.accuracy);
          }
          if (col.is_online) {
            matchedCluster.hasOnline = true;
          }
        } else {
          clusters.push({
            anchorCoords: coords,
            collectors: [col],
            maxAccuracy: col.accuracy || 0,
            hasOnline: !!col.is_online,
          });
        }
      });

      // 3. Render Each Cluster (Single Collector vs. Co-located Multi-Collector Spider Dispersal)
      clusters.forEach((cluster) => {
        const N = cluster.collectors.length;
        const anchorCoords = cluster.anchorCoords;

        // Shared Accuracy Halo at true GPS position
        if (cluster.maxAccuracy > 0) {
          const accCircle = new Feature({
            geometry: new CircleGeom(anchorCoords, Math.min(cluster.maxAccuracy, 200)),
          });
          accCircle.set('isAccuracyCircle', true);
          accCircle.set('is_online', cluster.hasOnline);
          source.addFeature(accCircle);
        }

        if (N === 1) {
          // Exactly 1 Collector at this position
          const col = cluster.collectors[0];
          const markerFeat = new Feature({
            geometry: new Point(anchorCoords),
          });
          markerFeat.set('isCollectorMarker', true);
          markerFeat.set('name', col.full_name || col.username);
          markerFeat.set('username', col.username);
          markerFeat.set('is_online', !!col.is_online);
          markerFeat.set('collectorData', col);
          markerFeat.set('clusterMembers', cluster.collectors);
          markerFeat.set('clusterIndex', 0);
          markerFeat.set('clusterTotal', 1);
          source.addFeature(markerFeat);
        } else {
          // 2 or more Collectors co-located at the EXACT same location!
          // Dynamic Spider Dispersal radius based on number of officers
          const R = N === 2 ? 22 : (N <= 4 ? 26 : 32); // meters offset in EPSG:3857

          // Central anchor hub indicating shared location
          const hubFeat = new Feature({
            geometry: new Point(anchorCoords),
          });
          hubFeat.set('isCoLocationHub', true);
          hubFeat.set('clusterMembers', cluster.collectors);
          hubFeat.set('is_online', cluster.hasOnline);
          source.addFeature(hubFeat);

          // Disperse each officer radially around the anchor point
          cluster.collectors.forEach((col, idx) => {
            // Distribute angles evenly: for N=2 use diagonal -45 deg and +135 deg so labels never collide
            const angle = N === 2
              ? (idx === 0 ? -Math.PI / 4 : (3 * Math.PI) / 4)
              : ((2 * Math.PI * idx) / N) - Math.PI / 2;

            const offsetX = anchorCoords[0] + R * Math.cos(angle);
            const offsetY = anchorCoords[1] + R * Math.sin(angle);
            const dispersedCoords = [offsetX, offsetY];

            // Connector Spider Line from center to dispersed position
            if (LineString) {
              const lineFeat = new Feature({
                geometry: new LineString([anchorCoords, dispersedCoords]),
              });
              lineFeat.set('isSpiderLeg', true);
              lineFeat.set('is_online', !!col.is_online);
              source.addFeature(lineFeat);
            }

            // Dispersed Officer Marker
            const markerFeat = new Feature({
              geometry: new Point(dispersedCoords),
            });
            markerFeat.set('isCollectorMarker', true);
            markerFeat.set('isDispersed', true);
            markerFeat.set('name', col.full_name || col.username);
            markerFeat.set('username', col.username);
            markerFeat.set('is_online', !!col.is_online);
            markerFeat.set('collectorData', col);
            markerFeat.set('clusterMembers', cluster.collectors);
            markerFeat.set('clusterIndex', idx);
            markerFeat.set('clusterTotal', N);
            markerFeat.set('anchorCoords', anchorCoords);
            source.addFeature(markerFeat);
          });
        }
      });
    } catch (err) {
      console.warn('[Map] Collector tracking dispersal render notice:', err);
    }
  }, [collectorLocations, showCollectorLocations, olModules]);

  // ---- Handle Zoom Target (Center on Collector or Layer) ----
  useEffect(() => {
    if (!mapInstance.current || !zoomTarget || !olModules) return;
    const { fromLonLat } = olModules;
    try {
      if (zoomTarget.type === 'collector' && zoomTarget.lat && zoomTarget.lng) {
        mapInstance.current.getView().animate({
          center: fromLonLat([zoomTarget.lng, zoomTarget.lat]),
          zoom: 18,
          duration: 800,
        });
      }
    } catch (e) {
      console.warn('[Map] Zoom target notice:', e);
    }
  }, [zoomTarget, olModules]);

  // ---- Update Selected Feature Vertex Handles Display (Displays vertex handles ONLY for selected feature) ----
  useEffect(() => {
    if (!olModules || !layersRef.current.snappingVerticesSource) return;
    const { Feature, Point, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
    const source = layersRef.current.snappingVerticesSource;

    // Only display vertex handles if editMode is active and a feature is selected
    if (!editMode || !selectedFeatureId) {
      source.clear();
      return;
    }

    try {
      const layerObj = layersRef.current.serverVectors[String(editLayerId)];
      if (!layerObj || !layerObj.source) {
        source.clear();
        return;
      }

      let match = null;
      if (typeof layerObj.source.getFeatures === 'function') {
        match = layerObj.source.getFeatures().find((f) => {
          const fid = f.getId() || f.get('_id') || f.get('id');
          return String(fid) === String(selectedFeatureId);
        });
      }
      if (!match && selectedOlFeatureRef.current) {
        const curId = selectedOlFeatureRef.current.getId() || selectedOlFeatureRef.current.get('_id') || selectedOlFeatureRef.current.get('id');
        if (String(curId) === String(selectedFeatureId)) {
          match = selectedOlFeatureRef.current;
        }
      }

      if (match) {
        renderSelectedFeatureVertices(match, source, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
      } else {
        source.clear();
      }
    } catch (err) {
      console.warn('[Map] Selected feature vertices display error:', err);
    }
  }, [editMode, editLayerId, selectedFeatureId, serverVectors, olModules]);

  // ---- Draw interaction with Real-time Vertex Handles and Undo/Redo Tracking ----
  useEffect(() => {
    if (!olModules || !mapInstance.current) return;
    const { Draw, Snap, GeoJSON, Style, Fill, Stroke, CircleStyle, Point, MultiPoint, Feature } = olModules;

    if (drawInteractionRef.current) {
      mapInstance.current.removeInteraction(drawInteractionRef.current);
      drawInteractionRef.current = null;
    }
    sketchFeatureRef.current = null;
    drawRedoStackRef.current = [];
    drawUndoCountRef.current = 0;
    if (onDrawVertexChange) {
      onDrawVertexChange({ undoCount: 0, redoCount: 0 });
    }

    if (drawMode) {
      try {
        // Safe dynamic style function for Draw interaction
        const drawStyle = (feature) => {
          try {
            const geom = feature ? (typeof feature.getGeometry === 'function' ? feature.getGeometry() : null) : null;
            const type = typeof geom?.getType === 'function' ? geom.getType() : (typeof feature?.getType === 'function' ? feature.getType() : '');
            if (!type) return [];
            const styles = [];

            // 1. Polygon Fill
            if (type === 'Polygon' || type === 'MultiPolygon') {
              styles.push(
                new Style({
                  fill: new Fill({ color: 'rgba(4, 71, 175, 0.25)' }),
                })
              );
            }

            // 2. Line / Polygon Boundary Stroke
            styles.push(
              new Style({
                stroke: new Stroke({
                  color: '#0447af',
                  width: 3,
                  lineDash: [6, 4],
                }),
              })
            );

            // 3. Point marker (if drawing a Point)
            if (type === 'Point') {
              styles.push(
                new Style({
                  image: new CircleStyle({
                    radius: 7,
                    fill: new Fill({ color: '#f59e0b' }),
                    stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
                  }),
                })
              );
              return styles;
            }

            // 4. Vertex handles for LineString and Polygon
            let coords = [];
            if (type === 'LineString') {
              coords = geom.getCoordinates() || [];
            } else if (type === 'Polygon') {
              const rings = geom.getCoordinates() || [];
              coords = rings[0] || [];
            }

            const validCoords = coords.filter(
              (c) => Array.isArray(c) && c.length >= 2 && isFinite(c[0]) && isFinite(c[1])
            );

            if (validCoords.length > 0) {
              // Placed vertices in cyan
              styles.push(
                new Style({
                  geometry: new MultiPoint(validCoords),
                  image: new CircleStyle({
                    radius: 5.5,
                    fill: new Fill({ color: '#06b6d4' }),
                    stroke: new Stroke({ color: '#ffffff', width: 2 }),
                  }),
                })
              );

              // Active / latest placed vertex in glowing amber
              if (validCoords.length > 1) {
                const activeCoord = validCoords[validCoords.length - 2];
                if (activeCoord && activeCoord.length >= 2) {
                  styles.push(
                    new Style({
                      geometry: new Point(activeCoord),
                      image: new CircleStyle({
                        radius: 12,
                        stroke: new Stroke({ color: '#f59e0b', width: 2.5 }),
                        fill: new Fill({ color: 'rgba(245, 158, 11, 0.35)' }),
                      }),
                    }),
                    new Style({
                      geometry: new Point(activeCoord),
                      image: new CircleStyle({
                        radius: 6.5,
                        fill: new Fill({ color: '#f59e0b' }),
                        stroke: new Stroke({ color: '#ffffff', width: 2 }),
                      }),
                    })
                  );
                }
              }
            }

            return styles;
          } catch (err) {
            console.warn('[Map] drawStyle fallback:', err);
            return [
              new Style({
                stroke: new Stroke({ color: '#0447af', width: 3 }),
                fill: new Fill({ color: 'rgba(4, 71, 175, 0.25)' }),
                image: new CircleStyle({ radius: 6, fill: new Fill({ color: '#f59e0b' }) }),
              }),
            ];
          }
        };

        const drawInteraction = new Draw({
          type: drawMode,
          style: drawStyle,
        });

        drawInteraction.on('drawstart', (event) => {
          sketchFeatureRef.current = event.feature;
          drawRedoStackRef.current = [];
          const geom = event.feature.getGeometry();

          const updateCounts = () => {
            if (!sketchFeatureRef.current) return;
            const curGeom = sketchFeatureRef.current.getGeometry();
            if (!curGeom) return;
            const type = curGeom.getType();
            let count = 0;
            if (type === 'LineString') {
              const coords = curGeom.getCoordinates();
              count = Math.max(0, coords.length - 1);
            } else if (type === 'Polygon') {
              const rings = curGeom.getCoordinates();
              count = Math.max(0, (rings[0]?.length || 0) - 2);
            }
            drawUndoCountRef.current = count;
            if (onDrawVertexChange) {
              onDrawVertexChange({ undoCount: count, redoCount: drawRedoStackRef.current.length });
            }
          };

          geom.on('change', updateCounts);
        });

        drawInteraction.on('drawend', (event) => {
          sketchFeatureRef.current = null;
          drawRedoStackRef.current = [];
          drawUndoCountRef.current = 0;
          if (onDrawVertexChange) {
            onDrawVertexChange({ undoCount: 0, redoCount: 0 });
          }

          // Immediately render finished feature to persistent sketch preview layer so it stays visible on map canvas
          if (layersRef.current.sketchPreviewSource && event.feature) {
            layersRef.current.sketchPreviewSource.clear();
            layersRef.current.sketchPreviewSource.addFeature(event.feature.clone());
            if (layersRef.current.sketchPreviewLayer) {
              layersRef.current.sketchPreviewLayer.changed();
            }
          }

          const format = new GeoJSON();
          const geojson = JSON.parse(
            format.writeFeature(event.feature, { featureProjection: 'EPSG:3857' })
          );

          // Spatial & Vertex Snapping Link Detection across visible vector layers
          let linkedInfo = null;
          try {
            const drawnGeom = event.feature.getGeometry();
            if (drawnGeom && layersRef.current.serverVectors) {
              const drawnExtent = drawnGeom.getExtent();
              const drawnCoords = extractCoordinatesFromGeometry(drawnGeom);

              let bestMatch = null;
              let minDistance = Infinity;

              const vectorEntries = Object.entries(layersRef.current.serverVectors);
              for (const [layerIdStr, layerObj] of vectorEntries) {
                if (!layerObj || !layerObj.layer || !layerObj.layer.getVisible() || !layerObj.source) continue;
                const lId = parseInt(layerIdStr);
                const layerDef = (serverVectors || []).find((v) => v.id === lId);
                const layerName = layerDef?.name || `Layer_${lId}`;

                const checkDrawnFeat = (feat) => {
                  const featGeom = feat.getGeometry ? feat.getGeometry() : null;
                  if (!featGeom) return;

                  // 1. Exact vertex snap match
                  const featCoords = extractCoordinatesFromGeometry(featGeom);
                  for (const dc of drawnCoords) {
                    for (const fc of featCoords) {
                      const d = Math.hypot(dc[0] - fc[0], dc[1] - fc[1]);
                      if (d < minDistance) {
                        minDistance = d;
                        bestMatch = {
                          layerId: lId,
                          layerName: layerName,
                          feature: feat,
                          distance: d,
                          type: 'snap_vertex',
                        };
                      }
                    }
                  }

                  // 2. Spatial intersection match if no close vertex snap
                  if (minDistance > 5 && typeof featGeom.intersectsExtent === 'function' && featGeom.intersectsExtent(drawnExtent)) {
                    if (!bestMatch || bestMatch.type !== 'snap_vertex') {
                      bestMatch = {
                        layerId: lId,
                        layerName: layerName,
                        feature: feat,
                        distance: 5,
                        type: 'spatial_intersect',
                      };
                    }
                  }
                };

                if (typeof layerObj.source.forEachFeatureInExtent === 'function') {
                  layerObj.source.forEachFeatureInExtent(drawnExtent, checkDrawnFeat);
                }
                if (layerObj.tileSource && typeof layerObj.tileSource.getFeaturesInExtent === 'function') {
                  try {
                    const tileFeats = layerObj.tileSource.getFeaturesInExtent(drawnExtent) || [];
                    for (let i = 0; i < tileFeats.length; i++) {
                      checkDrawnFeat(ensureRealOlFeature(tileFeats[i], olModules));
                    }
                  } catch (e) {}
                }
              }

              if (bestMatch && bestMatch.feature) {
                const feat = bestMatch.feature;
                const featProps = feat.getProperties ? feat.getProperties() : (feat.properties || {});
                const cleanProps = { ...featProps };
                delete cleanProps.geometry;
                delete cleanProps.geom;

                const fid = feat.getId ? feat.getId() : (feat.get ? feat.get('_id') : featProps._id || featProps.id);

                linkedInfo = {
                  layerId: bestMatch.layerId,
                  layerName: bestMatch.layerName,
                  featureId: fid,
                  properties: cleanProps,
                  matchType: bestMatch.type,
                };
              }
            }
          } catch (err) {
            console.warn('[Map] Link detection on draw end error:', err);
          }

          if (onFeatureCreate) {
            onFeatureCreate(geojson.geometry, linkedInfo);
          }
        });

        mapInstance.current.addInteraction(drawInteraction);
        drawInteractionRef.current = drawInteraction;

        // Add Snapping interactions for all visible vector layers that allow snapping
        const isDrawTargetSnappable = !activeLayerId || isLayerSnappable(activeLayerId);
        if (snappingEnabled && Snap && isDrawTargetSnappable) {
          Object.entries(layersRef.current.serverVectors).forEach(([id, obj]) => {
            if (obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id)) {
              const snapInt = new Snap({
                source: obj.source,
                pixelTolerance: snapTolerance || 15,
                edge: true,
                vertex: true,
              });
              mapInstance.current.addInteraction(snapInt);
              snapInteractionsRef.current.push(snapInt);
            }
          });
        }
      } catch (err) {
        console.warn('[Map] Draw interaction notice:', err);
      }
    }

    return () => {
      if (mapInstance.current) {
        if (drawInteractionRef.current) {
          mapInstance.current.removeInteraction(drawInteractionRef.current);
          drawInteractionRef.current = null;
        }
        if (snapInteractionsRef.current && snapInteractionsRef.current.length > 0) {
          snapInteractionsRef.current.forEach((int) => {
            mapInstance.current.removeInteraction(int);
          });
          snapInteractionsRef.current = [];
        }
      }
      sketchFeatureRef.current = null;
      drawRedoStackRef.current = [];
      drawUndoCountRef.current = 0;
      if (onDrawVertexChange) {
        onDrawVertexChange({ undoCount: 0, redoCount: 0 });
      }
    };
  }, [drawMode, olModules, onFeatureCreate, onDrawVertexChange, snappingEnabled, snapTolerance, serverVectors]);

  // Pause/Resume Draw interaction during map feature picking mode
  useEffect(() => {
    if (drawInteractionRef.current) {
      drawInteractionRef.current.setActive(!pickLinkedFeatureMode);
    }
  }, [pickLinkedFeatureMode]);

  // Highlight Selected Linked Feature on Map Canvas (Vibrant Purple Halo)
  useEffect(() => {
    if (!olModules || !featureHighlightSourceRef.current) return;
    const { Style, Stroke, Fill, CircleStyle } = olModules;

    if (!selectedLinkedFeatureId || !selectedLinkedLayerId) {
      if (!inspectedFeatureId) {
        featureHighlightSourceRef.current.clear();
      }
      return;
    }

    const layerObj = layersRef.current.serverVectors[String(selectedLinkedLayerId)];
    if (layerObj && layerObj.source) {
      const feat = layerObj.source.getFeatures().find((f) => {
        const fid = f.getId ? f.getId() : (f.get ? f.get('_id') : f.get('id'));
        return String(fid) === String(selectedLinkedFeatureId);
      });

      if (feat && feat.getGeometry()) {
        featureHighlightSourceRef.current.clear();
        const clone = feat.clone();
        clone.setStyle([
          new Style({
            stroke: new Stroke({ color: '#9333ea', width: 4.5 }),
            fill: new Fill({ color: 'rgba(147, 51, 234, 0.25)' }),
            image: new CircleStyle({
              radius: 8,
              fill: new Fill({ color: '#9333ea' }),
              stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
            }),
          }),
          new Style({
            stroke: new Stroke({ color: '#c084fc', width: 2, lineDash: [6, 4] }),
          }),
        ]);
        featureHighlightSourceRef.current.addFeature(clone);
      }
    }
  }, [selectedLinkedFeatureId, selectedLinkedLayerId, olModules, inspectedFeatureId]);

  // ---- Highlight Linked Partner Features on Map Canvas (Glowing Amber & Tie-Line) ----
  useEffect(() => {
    if (!olModules || !layersRef.current?.linkedPartnerSource) return;
    const { Style, Stroke, Fill, CircleStyle, GeoJSON, Feature, LineString, Point } = olModules;
    const TextClass = olModules.Text || olModules.TextStyle;
    const src = layersRef.current.linkedPartnerSource;
    src.clear();

    if (!Array.isArray(linkedHighlightFeatures) || linkedHighlightFeatures.length === 0) {
      return;
    }

    const geojsonFormat = new GeoJSON();
    let primaryCentroid = null;
    const activeGeom = selectedFeature?.geometry || inspectedFeature?.geometry;
    if (activeGeom) {
      try {
        const olPGeom = geojsonFormat.readGeometry(activeGeom, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
        if (olPGeom) {
          const type = olPGeom.getType();
          if (type === 'Point') {
            primaryCentroid = olPGeom.getCoordinates();
          } else if (olPGeom.getInteriorPoint) {
            primaryCentroid = olPGeom.getInteriorPoint().getCoordinates();
          } else if (olPGeom.getExtent) {
            const ext = olPGeom.getExtent();
            primaryCentroid = [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2];
          }
        }
      } catch (_) {}
    }

    linkedHighlightFeatures.forEach((lf) => {
      const geom = lf.geometry;
      if (!geom) return;
      try {
        const olGeom = geojsonFormat.readGeometry(geom, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
        if (!olGeom) return;

        const fId = lf.feature_id || lf.id;
        const type = olGeom.getType();
        const feat = new Feature({ geometry: olGeom });

        const styles = [];
        if (type === 'Polygon' || type === 'MultiPolygon') {
          styles.push(
            new Style({
              fill: new Fill({ color: 'rgba(245, 158, 11, 0.28)' }),
              stroke: new Stroke({ color: '#d97706', width: 4, lineDash: [8, 4] }),
            })
          );
        } else if (type === 'LineString' || type === 'MultiLineString') {
          styles.push(
            new Style({
              stroke: new Stroke({ color: '#d97706', width: 6, lineDash: [8, 4] }),
            })
          );
        } else {
          styles.push(
            new Style({
              image: new CircleStyle({
                radius: 12,
                fill: new Fill({ color: 'rgba(245, 158, 11, 0.45)' }),
                stroke: new Stroke({ color: '#d97706', width: 3.5 }),
              }),
            })
          );
        }

        // Add Centroid Badge: "🔗 लिङ्क: #ID"
        let center = null;
        if (type === 'Point') {
          center = olGeom.getCoordinates();
        } else if (olGeom.getInteriorPoint) {
          center = olGeom.getInteriorPoint().getCoordinates();
        } else if (olGeom.getExtent) {
          const ext = olGeom.getExtent();
          center = [(ext[0] + ext[2]) / 2, (ext[1] + ext[3]) / 2];
        }

        if (center) {
          styles.push(
            new Style({
              geometry: new Point(center),
              text: TextClass ? new TextClass({
                text: `🔗 लिङ्क #${fId}`,
                font: 'bold 11px sans-serif',
                fill: new Fill({ color: '#78350f' }),
                backgroundFill: new Fill({ color: '#fef3c7' }),
                backgroundStroke: new Stroke({ color: '#d97706', width: 1.5 }),
                padding: [3, 6, 2, 6],
                offsetY: -16,
              }) : undefined,
            })
          );

          // If primary clicked feature has centroid, draw a connecting dashed tie-line!
          if (primaryCentroid && Array.isArray(primaryCentroid) && primaryCentroid.length >= 2 && Array.isArray(center) && center.length >= 2) {
            const tieLineFeat = new Feature({
              geometry: new LineString([primaryCentroid, center]),
            });
            tieLineFeat.setStyle(
              new Style({
                stroke: new Stroke({
                  color: '#d97706',
                  width: 2.5,
                  lineDash: [6, 6],
                }),
              })
            );
            src.addFeature(tieLineFeat);
          }
        }

        feat.setStyle(styles);
        src.addFeature(feat);
      } catch (err) {
        console.warn('Error highlighting linked feature:', err);
      }
    });
  }, [linkedHighlightFeatures, selectedFeature, inspectedFeature, olModules]);

  // ---- Handle Draw Undo Trigger ----
  useEffect(() => {
    if (!drawUndoTrigger || !drawMode || !drawInteractionRef.current || !sketchFeatureRef.current) return;
    try {
      const geom = sketchFeatureRef.current.getGeometry();
      if (!geom) return;
      const type = geom.getType();

      if (type === 'LineString') {
        const coords = geom.getCoordinates();
        if (coords.length > 1) {
          const removed = coords[coords.length - 2];
          drawRedoStackRef.current.push(removed);
        }
      } else if (type === 'Polygon') {
        const rings = geom.getCoordinates();
        if (rings[0] && rings[0].length > 2) {
          const removed = rings[0][rings[0].length - 3];
          drawRedoStackRef.current.push(removed);
        }
      }

      drawInteractionRef.current.removeLastPoint();

      let count = 0;
      if (type === 'LineString') {
        const curCoords = geom.getCoordinates();
        count = Math.max(0, curCoords.length - 1);
      } else if (type === 'Polygon') {
        const curRings = geom.getCoordinates();
        count = Math.max(0, (curRings[0]?.length || 0) - 2);
      }
      drawUndoCountRef.current = count;
      if (onDrawVertexChange) {
        onDrawVertexChange({ undoCount: count, redoCount: drawRedoStackRef.current.length });
      }
    } catch (err) {
      console.warn('[Map] Draw undo error:', err);
    }
  }, [drawUndoTrigger, drawMode, onDrawVertexChange]);

  // ---- Handle Draw Redo Trigger ----
  useEffect(() => {
    if (!drawRedoTrigger || !drawMode || !sketchFeatureRef.current || drawRedoStackRef.current.length === 0) return;
    try {
      const geom = sketchFeatureRef.current.getGeometry();
      if (!geom) return;
      const type = geom.getType();
      const redoPoint = drawRedoStackRef.current.pop();
      if (!redoPoint) return;

      if (type === 'LineString') {
        const coords = geom.getCoordinates().slice();
        if (coords.length > 0) {
          coords.splice(coords.length - 1, 0, redoPoint);
          geom.setCoordinates(coords);
        }
      } else if (type === 'Polygon') {
        const rings = geom.getCoordinates().slice();
        if (rings.length > 0 && rings[0].length > 0) {
          const outerRing = rings[0].slice();
          outerRing.splice(outerRing.length - 2, 0, redoPoint);
          rings[0] = outerRing;
          geom.setCoordinates(rings);
        }
      }

      sketchFeatureRef.current.changed();

      let count = 0;
      if (type === 'LineString') {
        count = Math.max(0, geom.getCoordinates().length - 1);
      } else if (type === 'Polygon') {
        const rings = geom.getCoordinates();
        count = Math.max(0, (rings[0]?.length || 0) - 2);
      }
      drawUndoCountRef.current = count;
      if (onDrawVertexChange) {
        onDrawVertexChange({ undoCount: count, redoCount: drawRedoStackRef.current.length });
      }
    } catch (err) {
      console.warn('[Map] Draw redo error:', err);
    }
  }, [drawRedoTrigger, drawMode, onDrawVertexChange]);

  // ---- Sync Newly Created Feature Persistence on Map Canvas while Form is Open ----
  useEffect(() => {
    if (!olModules || !layersRef.current.sketchPreviewSource) return;
    const source = layersRef.current.sketchPreviewSource;

    if (!editingGeometry) {
      source.clear();
      return;
    }

    try {
      const { GeoJSON, Feature } = olModules;
      const format = new GeoJSON();
      const olGeom = format.readGeometry(editingGeometry, {
        dataProjection: 'EPSG:4326',
        featureProjection: 'EPSG:3857',
      });
      source.clear();
      source.addFeature(new Feature({ geometry: olGeom }));
      if (layersRef.current.sketchPreviewLayer) {
        layersRef.current.sketchPreviewLayer.changed();
      }
      if (mapInstance.current) {
        mapInstance.current.render();
      }
    } catch (err) {
      console.warn('[Map] Failed to render persistent editingGeometry preview:', err);
    }
  }, [editingGeometry, olModules]);

  // ---- Edit Mode: Feature Selection & Spatial Modification ----
  useEffect(() => {
    if (!olModules || !mapInstance.current) return;
    const { Select, Modify, GeoJSON, Style, Fill, Stroke, CircleStyle, Feature, Point } = olModules;

    // Clean up previous edit interactions
    if (selectInteractionRef.current) {
      mapInstance.current.removeInteraction(selectInteractionRef.current);
      selectInteractionRef.current = null;
    }
    if (modifyInteractionRef.current) {
      mapInstance.current.removeInteraction(modifyInteractionRef.current);
      modifyInteractionRef.current = null;
    }

    if (!editMode || !editLayerId) {
      lastActiveFeatureRef.current = null;
      lastActiveOriginalGeomRef.current = null;
      selectedOlFeatureRef.current = null;
      if (snapIndicatorSourceRef.current) {
        snapIndicatorSourceRef.current.clear();
      }
      return;
    }

    const layerObj = layersRef.current.serverVectors[String(editLayerId)];
    if (!layerObj || !layerObj.layer) return;

    try {
      // 1. Setup Select Interaction
      // Note: Condition returns false for default click handling because our map singleclick listener
      // handles both feature selection and canvas feature-extension without losing selection!
      const selectLayers = [layerObj.layer];
      if (layerObj.editLayer) selectLayers.push(layerObj.editLayer);
      if (layerObj.tileLayer && !selectLayers.includes(layerObj.tileLayer)) selectLayers.push(layerObj.tileLayer);

      const selectInteraction = new Select({
        layers: selectLayers,
        condition: () => false,
        style: (feature) => {
          const geom = feature ? (typeof feature.getGeometry === 'function' ? feature.getGeometry() : null) : null;
          const geomType = (typeof geom?.getType === 'function' ? geom.getType() : (typeof feature?.getType === 'function' ? feature.getType() : ''))?.toUpperCase() || '';
          const isPolygon = geomType.includes('POLYGON');

          return [
            new Style({
              stroke: new Stroke({ color: 'rgba(245, 158, 11, 0.45)', width: 8 }),
            }),
            new Style({
              fill: isPolygon ? new Fill({ color: 'rgba(0, 0, 0, 0)' }) : new Fill({ color: 'rgba(245, 158, 11, 0.25)' }),
              stroke: new Stroke({ color: '#f59e0b', width: 3.5 }),
              image: new CircleStyle({
                radius: 7,
                fill: new Fill({ color: '#f59e0b' }),
                stroke: new Stroke({ color: '#ffffff', width: 2 }),
              }),
            }),
          ];
        },
      });

      // 2. Setup Modify Interaction attached to the selected features collection.
      // ताने (Move/Reshape) is the ONLY tool that drags vertices. Vertex insertion
      // is deliberately disabled here: OpenLayers would otherwise append a vertex
      // whenever a segment is dragged, so "ताने" silently behaved like "बिस्तार".
      // बिस्तार owns insertion through an explicit click, and मेट्ने owns deletion.
      const modifyInteraction = new Modify({
        features: selectInteraction.getFeatures(),
        pixelTolerance: Math.max(snapTolerance, 15),
        insertVertexCondition: () => false,
        deleteCondition: (e) => {
          const sub = editSubModeRef.current;
          if (isMoveSubMode(sub) || isExtendSubMode(sub)) {
            return false;
          }
          return Boolean(e.originalEvent && (e.originalEvent.altKey || e.originalEvent.shiftKey || e.originalEvent.ctrlKey));
        },
        style: [
          // Outer luminous red halo for dragging handles
          new Style({
            image: new CircleStyle({
              radius: 12,
              stroke: new Stroke({ color: '#ef4444', width: 2.5 }),
              fill: new Fill({ color: 'rgba(239, 68, 68, 0.3)' }),
            }),
          }),
          // Inner red handle dot
          new Style({
            image: new CircleStyle({
              radius: 6,
              fill: new Fill({ color: '#dc2626' }),
              stroke: new Stroke({ color: '#ffffff', width: 2 }),
            }),
          }),
        ],
      });

      // Track modify start
      modifyInteraction.on('modifystart', (evt) => {
        // Snapshot the pre-edit geometry so out-of-grid vertex moves can be reverted.
        const started = evt.features && evt.features.getArray ? evt.features.getArray() : [];
        const startedGeom = started[0] && started[0].getGeometry ? started[0].getGeometry() : null;
        modifyOriginalGeomRef.current = startedGeom ? startedGeom.clone() : null;

        const mapEvt = evt.mapBrowserEvent;
        const isEditSnappable = isLayerSnappable(editLayerId);
        if (mapEvt && snapIndicatorSourceRef.current && mapInstance.current && snappingEnabled && isEditSnappable) {
          const visibleSources = Object.entries(layersRef.current.serverVectors)
            .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
            .map(([_, obj]) => obj.source);
          const res = findNearestVertex(mapInstance.current, mapEvt.pixel, visibleSources, Math.max(snapTolerance, 25));
          if (res) {
            snapIndicatorSourceRef.current.clear();
            snapIndicatorSourceRef.current.addFeature(new Feature({ geometry: new Point(res.coordinate) }));
          }
        }
      });

      // 3. Handle modify end (spatial drag completed)
      modifyInteraction.on('modifyend', (evt) => {
        isModifyingRef.current = true;
        if (modifyTimerRef.current) clearTimeout(modifyTimerRef.current);
        modifyTimerRef.current = setTimeout(() => {
          isModifyingRef.current = false;
        }, 200);

        const modifiedFeatures = evt.features.getArray();
        if (modifiedFeatures && modifiedFeatures.length > 0) {
          const feat = modifiedFeatures[0];
          const mapEvt = evt.mapBrowserEvent;

          if (mapEvt && mapEvt.coordinate) {
            const hit = findVertexIndexNearCoord(feat, mapEvt.coordinate, 50);
            if (hit) {
              selectedVertexIndexRef.current = hit.index;
            }
          }

          if (layersRef.current.snappingVerticesSource && olModules) {
            const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
            renderSelectedFeatureVertices(feat, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
          }

          const format = new GeoJSON();
          const geojson = JSON.parse(
            format.writeFeature(feat, {
              dataProjection: 'EPSG:4326',
              featureProjection: 'EPSG:3857',
            })
          );

          const featureId = feat.getId() || feat.get('_id') || geojson.id || geojson.properties?._id;

          // Vertex-level rule: only vertices inside the collector's grid may move.
          const preEditGeometry = modifyOriginalGeomRef.current;
          modifyOriginalGeomRef.current = null;
          const assignedGrids = (layersRef.current.taskSource?.getFeatures() || [])
            .map((gridFeature) => gridFeature.getGeometry())
            .filter(Boolean);
          const outsideVertices = isCollectorRef.current
            ? changedVerticesOutsideGrids(assignedGrids, preEditGeometry, feat.getGeometry())
            : [];
          if (isCollectorRef.current && outsideVertices.length > 0) {
            if (preEditGeometry && typeof feat.setGeometry === 'function') {
              feat.setGeometry(preEditGeometry.clone());
            }
            if (layersRef.current.snappingVerticesSource && olModules) {
              const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
              renderSelectedFeatureVertices(
                feat,
                layersRef.current.snappingVerticesSource,
                Point, Feature, Style, CircleStyle, Fill, Stroke,
                selectedVertexIndexRef.current
              );
            }
            if (onFeatureBlockedRef.current) {
              onFeatureBlockedRef.current({
                reason: 'OUTSIDE_GRID',
                message: `⚠️ तपाईंले आफ्नो ग्रिडभित्रका शीर्षबिन्दु मात्र सम्पादन गर्न सक्नुहुन्छ — ${outsideVertices.length} शीर्षबिन्दु बाहिर छन्। (Only vertices inside your assigned grid can be moved.)`,
              });
            }
            return;
          }

          // Check if modified geometry is within assigned task grid
          let isWithin = true;
          if (isCollectorRef.current && layersRef.current.taskSource) {
            const gridFeatures = layersRef.current.taskSource.getFeatures();
            if (gridFeatures && gridFeatures.length > 0) {
              const featGeom = feat.getGeometry();
              if (featGeom) {
                const featExtent = featGeom.getExtent();
                isWithin = gridFeatures.some((g) => g.getGeometry() && g.getGeometry().intersectsExtent(featExtent));
              }
            }
          }

          if (isCollectorRef.current && !isWithin && onFeatureBlockedRef.current) {
            onFeatureBlockedRef.current({
              reason: 'OUTSIDE_GRID',
              message: '⚠️ चेतावनी: परिमार्जित भाग तपाईंको कार्यक्षेत्र (ग्रिड) भन्दा बाहिर पुगेको छ। कृपया ग्रिड भित्रै सीमित राख्नुहोस्।',
            });
          }

          if (onFeatureModifyEnd) {
            onFeatureModifyEnd(featureId, geojson.geometry, isWithin);
          }
        }
      });

      mapInstance.current.addInteraction(selectInteraction);
      mapInstance.current.addInteraction(modifyInteraction);

      // Deactivate vertex dragging while बिस्तार or मेट्ने owns the interaction
      if (isExtendSubMode(editSubMode) || isDeleteSubMode(editSubMode)) {
        modifyInteraction.setActive(false);
      }

      selectInteractionRef.current = selectInteraction;
      modifyInteractionRef.current = modifyInteraction;

      // Sync if feature was already selected
      if (selectedFeatureId && layerObj.source) {
        let match = null;
        if (typeof layerObj.source.getFeatures === 'function') {
          match = layerObj.source.getFeatures().find((f) => {
            const fid = f.getId() || f.get('_id') || f.get('id');
            return String(fid) === String(selectedFeatureId);
          });
        }
        if (!match && selectedOlFeatureRef.current) {
          const curId = selectedOlFeatureRef.current.getId() || selectedOlFeatureRef.current.get('_id') || selectedOlFeatureRef.current.get('id');
          if (String(curId) === String(selectedFeatureId)) {
            match = selectedOlFeatureRef.current;
            try { layerObj.source.addFeature(match); } catch (e) {}
          }
        }
        if (!match && inspectedFeature && (inspectedFeature.id || inspectedFeature._id)) {
          const inspId = inspectedFeature.id || inspectedFeature._id;
          if (String(inspId) === String(selectedFeatureId) && (inspectedFeature.geometry || inspectedFeature.coordinates)) {
            try {
              const format = new olModules.GeoJSON();
              const geom = format.readGeometry(inspectedFeature.geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
              match = new olModules.Feature({ ...(inspectedFeature.properties || {}), geometry: geom });
              match.setId(inspId);
              layerObj.source.addFeature(match);
            } catch (e) {}
          }
        }
        if (match) {
          // Check grid boundary & GPS 50m geofence for Data Collector
          let allowed = true;
          if (isCollectorRef.current) {
            const gps = gpsPositionRef.current;
            if (!gps || gps.lat == null || gps.lng == null) {
              allowed = false;
            } else if (layersRef.current.taskSource) {
              const gridFeatures = layersRef.current.taskSource.getFeatures();
              if (gridFeatures && gridFeatures.length > 0) {
                const featGeom = match.getGeometry();
                if (featGeom) {
                  const featExtent = featGeom.getExtent();
                  allowed = gridFeatures.some((g) => g.getGeometry() && g.getGeometry().intersectsExtent(featExtent));
                }
              }
            }

            if (allowed && olModules?.GeoJSON) {
              const format = new olModules.GeoJSON();
              const geojsonObj = JSON.parse(format.writeFeature(match, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
              const dist = getDistanceToGeoJsonGeometry(gps.lat, gps.lng, geojsonObj.geometry);
              if (dist > GEOFENCE_EDIT_RADIUS_METERS) {
                allowed = false;
              }
            }
          }
          if (allowed) {
            selectedOlFeatureRef.current = match;
            lastActiveFeatureRef.current = match;
            lastActiveOriginalGeomRef.current = match.getGeometry() ? match.getGeometry().clone() : null;
            const coords = extractCoordinatesFromGeometry(match.getGeometry());
            selectedVertexIndexRef.current = Math.max(0, coords.length - 1);
            selectInteraction.getFeatures().clear();
            selectInteraction.getFeatures().push(match);

            if (layersRef.current.snappingVerticesSource && olModules) {
              const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
              renderSelectedFeatureVertices(match, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
            }
          }
        }
      }
    } catch (err) {
      console.warn('[Map] Edit interaction setup error:', err);
    }

    return () => {
      if (mapInstance.current) {
        if (selectInteractionRef.current) {
          mapInstance.current.removeInteraction(selectInteractionRef.current);
          selectInteractionRef.current = null;
        }
        if (modifyInteractionRef.current) {
          mapInstance.current.removeInteraction(modifyInteractionRef.current);
          modifyInteractionRef.current = null;
        }
      }
      if (layersRef.current.snappingVerticesSource) {
        layersRef.current.snappingVerticesSource.clear();
      }
      if (featureHighlightSourceRef.current) {
        featureHighlightSourceRef.current.clear();
      }
      if (snapIndicatorSourceRef.current) {
        snapIndicatorSourceRef.current.clear();
      }
    };
  }, [editMode, editLayerId, olModules, serverVectors, onFeatureModifyEnd, snapTolerance, snappingEnabled]);

  // ---- Sync Selected Feature when selectedFeatureId prop changes ----
  useEffect(() => {
    if (!editMode || !editLayerId || !layersRef.current.serverVectors[String(editLayerId)]) {
      selectedOlFeatureRef.current = null;
      selectedVertexIndexRef.current = null;
      if (selectInteractionRef.current) {
        selectInteractionRef.current.getFeatures().clear();
      }
      if (layersRef.current.snappingVerticesSource) {
        layersRef.current.snappingVerticesSource.clear();
      }
      // Never clear highlight if a feature is still being inspected or selected
      if (!inspectedFeatureId && !inspectedFeature && !selectedFeatureId) {
        if (featureHighlightSourceRef.current) {
          featureHighlightSourceRef.current.clear();
        }
      }
      return;
    }

    const layerObj = layersRef.current.serverVectors[String(editLayerId)];
    if (!layerObj || !layerObj.source || !selectInteractionRef.current || !olModules) return;

    if (!selectedFeatureId) {
      lastActiveFeatureRef.current = null;
      lastActiveOriginalGeomRef.current = null;
      selectedOlFeatureRef.current = null;
      selectedVertexIndexRef.current = null;
      if (selectInteractionRef.current) {
        selectInteractionRef.current.getFeatures().clear();
      }
      if (layersRef.current.snappingVerticesSource) {
        layersRef.current.snappingVerticesSource.clear();
      }
      if (!inspectedFeatureId && !inspectedFeature) {
        if (featureHighlightSourceRef.current) {
          featureHighlightSourceRef.current.clear();
        }
      }
    } else {
      let match = null;
      if (typeof layerObj.source.getFeatures === 'function') {
        match = layerObj.source.getFeatures().find((f) => {
          const fid = f.getId() || f.get('_id') || f.get('id');
          return String(fid) === String(selectedFeatureId);
        });
      }
      if (!match && selectedOlFeatureRef.current) {
        const curId = selectedOlFeatureRef.current.getId() || selectedOlFeatureRef.current.get('_id') || selectedOlFeatureRef.current.get('id');
        if (String(curId) === String(selectedFeatureId)) {
          match = selectedOlFeatureRef.current;
          try { layerObj.source.addFeature(match); } catch (e) {}
        }
      }
      if (!match && inspectedFeature && (inspectedFeature.id || inspectedFeature._id)) {
        const inspId = inspectedFeature.id || inspectedFeature._id;
        if (String(inspId) === String(selectedFeatureId) && (inspectedFeature.geometry || inspectedFeature.coordinates)) {
          try {
            const format = new olModules.GeoJSON();
            const geom = format.readGeometry(inspectedFeature.geometry, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' });
            match = new olModules.Feature({ ...(inspectedFeature.properties || {}), geometry: geom });
            match.setId(inspId);
            layerObj.source.addFeature(match);
          } catch (e) {}
        }
      }
      if (match) {
        let allowed = true;
        if (isCollectorRef.current) {
          const gps = gpsPositionRef.current;
          if (!gps || gps.lat == null || gps.lng == null) {
            allowed = false;
          } else if (olModules?.GeoJSON) {
            const format = new olModules.GeoJSON();
            const geojsonObj = JSON.parse(format.writeFeature(match, { dataProjection: 'EPSG:4326', featureProjection: 'EPSG:3857' }));
            const dist = getDistanceToGeoJsonGeometry(gps.lat, gps.lng, geojsonObj.geometry);
            if (dist > GEOFENCE_EDIT_RADIUS_METERS) {
              allowed = false;
            }
          }
        }

        if (allowed) {
          selectedOlFeatureRef.current = match;
          lastActiveFeatureRef.current = match;
          lastActiveOriginalGeomRef.current = match.getGeometry() ? match.getGeometry().clone() : null;
          const coords = extractCoordinatesFromGeometry(match.getGeometry());
          selectedVertexIndexRef.current = Math.max(0, coords.length - 1);

          selectInteractionRef.current.getFeatures().clear();
          selectInteractionRef.current.getFeatures().push(match);

          if (layersRef.current.snappingVerticesSource && olModules) {
            const { Point, Feature, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
            renderSelectedFeatureVertices(match, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
          }
        } else {
          selectedOlFeatureRef.current = null;
          selectedVertexIndexRef.current = null;
          selectInteractionRef.current.getFeatures().clear();
          if (layersRef.current.snappingVerticesSource) {
            layersRef.current.snappingVerticesSource.clear();
          }
          if (!inspectedFeatureId && !inspectedFeature) {
            if (featureHighlightSourceRef.current) {
              featureHighlightSourceRef.current.clear();
            }
          }
        }
      } else {
        selectedOlFeatureRef.current = null;
        selectedVertexIndexRef.current = null;
        selectInteractionRef.current.getFeatures().clear();
        if (layersRef.current.snappingVerticesSource) {
          layersRef.current.snappingVerticesSource.clear();
        }
        if (!inspectedFeatureId && !inspectedFeature) {
          if (featureHighlightSourceRef.current) {
            featureHighlightSourceRef.current.clear();
          }
        }
      }
    }
  }, [selectedFeatureId, inspectedFeatureId, inspectedFeature, editMode, editLayerId, snappingEnabled, olModules]);

  // ---- Sync External Geometry/Property Update (Save / Undo / Redo / Revert / Pop Vertex / Cancel) to OpenLayers Feature ----
  useEffect(() => {
    if (!geometryUpdateTrigger || !olModules || !mapInstance.current) return;
    const { GeoJSON, Point, Feature, Style, Circle: CircleStyle, Fill, Stroke } = olModules;
    const { featureId, layerId, geometry, properties } = geometryUpdateTrigger;
    if (!geometry && !properties) return;

    try {
      let readGeom = null;
      if (geometry) {
        const format = new GeoJSON();
        readGeom = format.readGeometry(geometry, {
          dataProjection: 'EPSG:4326',
          featureProjection: 'EPSG:3857',
        });
      }

      const matchesFid = (f, idToMatch) => {
        if (!f || !idToMatch) return false;
        const fid = f.getId?.() || f.get?.('_id') || f.get?.('id') || f.get?.('gid') || f.get?.('feature_uid');
        return String(fid) === String(idToMatch);
      };

      // Find the target feature to update/revert
      let targetFeature = selectedOlFeatureRef.current;
      if (!targetFeature || (featureId && !matchesFid(targetFeature, featureId))) {
        if (lastActiveFeatureRef.current && (!featureId || matchesFid(lastActiveFeatureRef.current, featureId))) {
          targetFeature = lastActiveFeatureRef.current;
        } else {
          for (const vObj of Object.values(layersRef.current.serverVectors || {})) {
            if (!vObj) continue;
            if (vObj.source?.getFeatures) {
              const match = vObj.source.getFeatures().find((f) => matchesFid(f, featureId));
              if (match) {
                targetFeature = match;
                break;
              }
            }
            if (vObj.editSource?.getFeatures) {
              const match = vObj.editSource.getFeatures().find((f) => matchesFid(f, featureId));
              if (match) {
                targetFeature = match;
                break;
              }
            }
          }
        }
      }

      if (targetFeature) {
        if (readGeom) {
          targetFeature.setGeometry(readGeom);
        }
        if (properties && typeof properties === 'object') {
          targetFeature.setProperties({ ...targetFeature.getProperties(), ...properties });
        }
        targetFeature.changed();

        // Notify source, editSource and layer of change to trigger immediate canvas rerender
        Object.values(layersRef.current.serverVectors || {}).forEach((vObj) => {
          if (!vObj) return;
          if (vObj.source?.hasFeature && vObj.source.hasFeature(targetFeature)) {
            vObj.source.changed();
            if (vObj.layer) vObj.layer.changed();
          }
          if (vObj.editSource?.hasFeature && vObj.editSource.hasFeature(targetFeature)) {
            vObj.editSource.changed();
            if (vObj.editLayer) vObj.editLayer.changed();
          }
        });

        // For MVT layers with an active editSource, ensure the updated feature is mirrored in editSource
        if (layerId && layersRef.current.serverVectors?.[layerId]?.editSource && readGeom) {
          const editSrc = layersRef.current.serverVectors[layerId].editSource;
          const existing = editSrc.getFeatures().find((f) => matchesFid(f, featureId));
          if (!existing) {
            const overlayFeat = targetFeature.clone();
            if (targetFeature.getId()) overlayFeat.setId(targetFeature.getId());
            editSrc.addFeature(overlayFeat);
            editSrc.changed();
            if (layersRef.current.serverVectors[layerId].editLayer) {
              layersRef.current.serverVectors[layerId].editLayer.changed();
            }
          }
        }

        if (readGeom) {
          const coords = extractCoordinatesFromGeometry(readGeom);
          selectedVertexIndexRef.current = Math.max(0, coords.length - 1);
        }

        if (selectInteractionRef.current && selectedOlFeatureRef.current === targetFeature) {
          selectInteractionRef.current.getFeatures().clear();
          selectInteractionRef.current.getFeatures().push(targetFeature);
        }

        if (layersRef.current.snappingVerticesSource) {
          if (selectedOlFeatureRef.current === targetFeature && readGeom) {
            renderSelectedFeatureVertices(targetFeature, layersRef.current.snappingVerticesSource, Point, Feature, Style, CircleStyle, Fill, Stroke, selectedVertexIndexRef.current);
          } else {
            layersRef.current.snappingVerticesSource.clear();
          }
        }

        if (modifyInteractionRef.current && selectedOlFeatureRef.current === targetFeature) {
          modifyInteractionRef.current.setActive(false);
          modifyInteractionRef.current.setActive(true);
        }

        if (mapInstance.current) {
          mapInstance.current.render();
        }
      }
    } catch (err) {
      console.warn('[Map] Geometry update trigger error:', err);
    }
  }, [geometryUpdateTrigger, olModules]);

  // ---- Sync Multi-Layer Snapping Interactions in Edit Mode & Draw Mode ----
  useEffect(() => {
    if (!mapInstance.current || !olModules) return;
    const { Snap } = olModules;

    // Remove existing snap interactions
    snapInteractionsRef.current.forEach((snap) => {
      try {
        mapInstance.current.removeInteraction(snap);
      } catch (e) {}
    });
    snapInteractionsRef.current = [];

    const currentTargetId = drawMode ? activeLayerId : (editMode ? editLayerId : null);
    const isTargetSnappable = !currentTargetId || isLayerSnappable(currentTargetId);

    if ((editMode || drawMode) && snappingEnabled && isTargetSnappable) {
      const visibleSources = Object.entries(layersRef.current.serverVectors)
        .filter(([id, obj]) => obj && obj.layer && obj.layer.getVisible() && obj.source && isLayerSnappable(id))
        .map(([_, obj]) => obj.source);

      visibleSources.forEach((source) => {
        try {
          const snapInt = new Snap({
            source,
            pixelTolerance: snapTolerance,
            vertex: true,
            edge: true,
          });
          mapInstance.current.addInteraction(snapInt);
          snapInteractionsRef.current.push(snapInt);
        } catch (e) {
          console.warn('[Map] Snap interaction attach notice:', e);
        }
      });
    }

    return () => {
      if (mapInstance.current) {
        snapInteractionsRef.current.forEach((snap) => {
          try {
            mapInstance.current.removeInteraction(snap);
          } catch (e) {}
        });
        snapInteractionsRef.current = [];
      }
    };
  }, [editMode, drawMode, activeLayerId, editLayerId, snappingEnabled, snapTolerance, serverVectors, olModules, isLayerSnappable]);

  // ---- QGIS-style SPLIT: blade LineString drawing interaction ----
  // Active while splitBladeMode is on. The user draws a line across the selected
  // feature; on finish the blade geometry (WGS84) is handed to onSplitBladeDrawn.
  useEffect(() => {
    if (!mapInstance.current || !olModules) return;
    const { Draw, VectorSource, VectorLayer, Style, Stroke } = olModules;

    // Remove any previous blade interaction
    if (splitDrawRef.current) {
      try {
        mapInstance.current.removeInteraction(splitDrawRef.current);
      } catch (e) {}
      splitDrawRef.current = null;
    }

    if (!splitBladeMode) {
      if (modifyInteractionRef.current && editMode) {
        modifyInteractionRef.current.setActive(true);
      }
      return;
    }

    // Immediately disable modify interaction so clicking near an existing vertex to cut doesn't drag that vertex
    if (modifyInteractionRef.current) {
      modifyInteractionRef.current.setActive(false);
    }

    const bladeSource = new VectorSource();
    const bladeLayer = new VectorLayer({
      source: bladeSource,
      zIndex: 980,
      style: new Style({
        stroke: new Stroke({ color: '#dc2626', width: 3, lineDash: [12, 8] }),
      }),
    });
    mapInstance.current.addLayer(bladeLayer);

    const draw = new Draw({
      source: bladeSource,
      type: 'LineString',
      maxPoints: 50,
      style: new Style({
        stroke: new Stroke({ color: '#dc2626', width: 3, lineDash: [12, 8] }),
      }),
    });

    draw.on('drawend', (event) => {
      try {
        const { GeoJSON } = olModules;
        const format = new GeoJSON();
        const geojson = JSON.parse(
          format.writeFeature(event.feature, {
            dataProjection: 'EPSG:4326',
            featureProjection: 'EPSG:3857',
          })
        );
        if (geojson?.geometry?.type === 'LineString' && geojson.geometry.coordinates?.length >= 2) {
          if (onSplitBladeDrawnRef.current) {
            onSplitBladeDrawnRef.current(geojson.geometry);
          }
        }
      } catch (e) {
        console.warn('[Map] Split blade drawend error:', e);
      } finally {
        try {
          mapInstance.current.removeLayer(bladeLayer);
        } catch (e) {}
      }
    });

    mapInstance.current.addInteraction(draw);
    splitDrawRef.current = draw;

    return () => {
      if (splitDrawRef.current) {
        try {
          mapInstance.current.removeInteraction(splitDrawRef.current);
        } catch (e) {}
        splitDrawRef.current = null;
      }
      try {
        mapInstance.current.removeLayer(bladeLayer);
      } catch (e) {}
      if (modifyInteractionRef.current && editMode) {
        modifyInteractionRef.current.setActive(true);
      }
    };
  }, [splitBladeMode, editMode, olModules]);

  // ---- QGIS-style MERGE: sync picked features into the merge highlight layer ----
  useEffect(() => {
    if (!mapInstance.current || !olModules || !mergeHighlightSourceRef.current) return;
    const src = mergeHighlightSourceRef.current;
    src.clear();
    if (!mergeSelectMode || !editLayerId) return;
    const layerObj = layersRef.current.serverVectors[String(editLayerId)];
    if (!layerObj || !layerObj.source) return;
    const ids = new Set((mergeSelection || []).map((x) => String(x)));
    if (ids.size === 0) return;
    layerObj.source.forEachFeature((f) => {
      const fid = f.getId() || f.get('_id') || f.get('id');
      if (fid != null && ids.has(String(fid))) {
        try {
          src.addFeature(f.clone());
        } catch (e) {}
      }
    });
  }, [mergeSelectMode, mergeSelection, editLayerId, olModules, serverVectors]);

  // ---- Dynamic TomTom-Style Progressive LOD on Pan & Zoom & bbox reload ----
  useEffect(() => {
    if (!mapInstance.current || !olModules) return;
    const map = mapInstance.current;
    const { transformExtent, GeoJSON } = olModules;
    const format = new GeoJSON();
    let moveEndTimer = null;

    const refreshBboxLayers = async () => {
      const view = map.getView();
      if (!view) return;
      const extent = view.calculateExtent(map.getSize());
      const currentZoom = view.getZoom();
      if (!extent || currentZoom == null) return;

      const wgs = transformExtent(extent, 'EPSG:3857', 'EPSG:4326');
      const bboxStr = `${wgs[0].toFixed(6)},${wgs[1].toFixed(6)},${wgs[2].toFixed(6)},${wgs[3].toFixed(6)}`;

      const loaderFn = onBboxLoadFeaturesRef.current;
      if (!loaderFn) return;

      const serverVectorsObj = layersRef.current?.serverVectors || {};
      for (const [idStr, vEntry] of Object.entries(serverVectorsObj)) {
        if (!vEntry || !vEntry.bboxMode || !vEntry.source || !vEntry.layer?.getVisible()) continue;
        const layerId = Number(idStr);

        vEntry._reqSeq = (vEntry._reqSeq || 0) + 1;
        const reqSeq = vEntry._reqSeq;

        // Abort previous in-flight request for this layer so rapid panning doesn't stall the network
        if (vEntry._abortController) {
          try {
            vEntry._abortController.abort();
          } catch (_) {}
        }
        const controller = new AbortController();
        vEntry._abortController = controller;

        setBboxLoadingIds((prev) => (prev.includes(layerId) ? prev : [...prev, layerId]));

        try {
          const fc = await loaderFn(layerId, bboxStr, currentZoom, { signal: controller.signal });
          if (vEntry._reqSeq !== reqSeq) return; // Stale sequence, drop

          let geoJsonData = sanitizeGeoJsonForOpenLayers(fc);
          if (geoJsonData && !geoJsonData.type && Array.isArray(geoJsonData)) {
            geoJsonData = { type: 'FeatureCollection', features: geoJsonData };
          }
          if (geoJsonData && (geoJsonData.type === 'FeatureCollection' || Array.isArray(geoJsonData.features))) {
            const parsed = format.readFeatures(geoJsonData, {
              dataProjection: 'EPSG:4326',
              featureProjection: 'EPSG:3857',
            });
            const valid = getValidOlFeatures(parsed);

            // Preserve currently inspected or edited feature so user interactions aren't dropped
            const activeOlFeat = selectedOlFeatureRef.current;
            const activeFid = activeOlFeat ? (activeOlFeat.getId() ?? activeOlFeat.get('id') ?? activeOlFeat.get('_id')) : null;

            // Dynamic LOD tier transition:
            // When zooming OUT, or when zoom level changes across major LOD bands, clear higher-density features
            // so the cleaner, generalized features for the current zoom level replace them immediately:
            const lastZ = vEntry._lastZoom;
            const isZoomOut = lastZ != null && (currentZoom < lastZ - 0.5);
            const isBigZoomChange = lastZ != null && Math.abs(currentZoom - lastZ) >= 1.0;
            if (isZoomOut || isBigZoomChange) {
              vEntry.source.clear(true);
            }
            vEntry._lastZoom = currentZoom;

            // Dynamic feature merging & in-place geometry updates by unique ID
            const existingMap = new Map();
            for (const f of vEntry.source.getFeatures()) {
              const fid = f.getId() ?? f.get('id') ?? f.get('_id');
              if (fid != null) existingMap.set(String(fid), f);
            }

            const toAdd = [];
            for (const f of valid) {
              const fid = f.getId() ?? f.get('id') ?? f.get('_id') ?? f.get('properties')?.id ?? f.get('properties')?.objectid;
              if (fid != null) {
                const sFid = String(fid);
                f.setId(sFid);
                const existingFeat = existingMap.get(sFid);
                if (!existingFeat) {
                  toAdd.push(f);
                } else {
                  // Geometry was modified (e.g. split or vertex edit): update existing OpenLayers feature in-place
                  const newGeom = f.getGeometry();
                  if (newGeom) {
                    existingFeat.setGeometry(newGeom);
                  }
                  existingFeat.setProperties(f.getProperties());
                }
              } else {
                toAdd.push(f);
              }
            }

            if (toAdd.length > 0) {
              vEntry.source.addFeatures(toAdd);
            }
            vEntry.source.changed();
            if (vEntry.layer) {
              vEntry.layer.changed();
            }

            // Distant feature memory management: keep memory bounded if pan cache exceeds 3500 features
            const allFeatures = vEntry.source.getFeatures();
            if (allFeatures.length > 3500) {
              const viewExt = mapInstance.current?.getView()?.calculateExtent();
              if (viewExt) {
                const spanX = viewExt[2] - viewExt[0];
                const spanY = viewExt[3] - viewExt[1];
                const keepExt = [
                  viewExt[0] - spanX * 1.5,
                  viewExt[1] - spanY * 1.5,
                  viewExt[2] + spanX * 1.5,
                  viewExt[3] + spanY * 1.5,
                ];
                const toRemove = [];
                for (const f of allFeatures) {
                  const fid = f.getId() ?? f.get('id') ?? f.get('_id');
                  if (activeFid != null && String(fid) === String(activeFid)) continue;
                  const geom = f.getGeometry();
                  if (geom && !geom.intersectsExtent(keepExt)) {
                    toRemove.push(f);
                  }
                }
                for (const f of toRemove) {
                  vEntry.source.removeFeature(f);
                }
              }
            }

            if (activeOlFeat && activeFid != null) {
              const present = vEntry.source.getFeatures().some((f) => {
                const fid = f.getId() ?? f.get('id') ?? f.get('_id');
                return String(fid) === String(activeFid);
              });
              if (!present) {
                try {
                  vEntry.source.addFeature(activeOlFeat);
                } catch (_) {}
              }
            }
          }
        } catch (err) {
          if (err.name === 'AbortError' || err.name === 'CanceledError' || err.code === 'ERR_CANCELED') {
            // Aborted cleanly on rapid pan
          } else {
            console.warn(`[Map] Dynamic LOD reload failed for layer ${idStr}:`, err?.message || err);
          }
        } finally {
          setBboxLoadingIds((prev) => prev.filter((x) => x !== layerId));
        }
      }
    };

    map._refreshBboxLayers = refreshBboxLayers;

    const handleMoveEnd = () => {
      if (moveEndTimer) clearTimeout(moveEndTimer);
      moveEndTimer = setTimeout(refreshBboxLayers, 200);
    };

    map.on('moveend', handleMoveEnd);

    if (bboxReloadTrigger && bboxReloadTrigger.layerId) {
      const targetLyrId = String(bboxReloadTrigger.layerId);
      const vEntry = layersRef.current?.serverVectors?.[targetLyrId];
      if (vEntry) {
        if (bboxReloadTrigger.featureId) {
          const fidStr = String(bboxReloadTrigger.featureId);
          [vEntry.source, vEntry.editSource].forEach((src) => {
            if (src && typeof src.getFeatures === 'function') {
              const matched = src.getFeatures().filter((f) => {
                const id = f.getId ? f.getId() : null;
                const p = f.getProperties ? f.getProperties() : {};
                const cands = [
                  id != null ? String(id) : null,
                  p._id != null ? String(p._id) : null,
                  p.id != null ? String(p.id) : null,
                  p.feature_uid != null ? String(p.feature_uid) : null,
                  p.gid != null ? String(p.gid) : null,
                  p.object_id != null ? String(p.object_id) : null,
                ].filter(Boolean);
                return cands.includes(fidStr) || (fidStr.endsWith('.0') && cands.includes(fidStr.slice(0, -2))) || cands.some((c) => c === `${fidStr}.0`);
              });
              matched.forEach((f) => { try { src.removeFeature(f); } catch (e) {} });
            }
          });
        }
        if (vEntry.isMvt && vEntry.tileSource) {
          const newV = bboxReloadTrigger.timestamp || Date.now();
          const base = vEntry.baseMvtUrl || vEntry.mvtUrl;
          if (base) {
            const sep = base.includes('?') ? '&' : '?';
            const cleanBase = base.replace(/([?&])v=[^&]+/, '');
            const finalBase = cleanBase.includes('?') ? `${cleanBase}&v=${newV}` : `${cleanBase}?v=${newV}`;
            try { vEntry.tileSource.setUrl(finalBase); } catch (e) {}
          }
          try { vEntry.tileSource.clear(); } catch (e) {}
          try { vEntry.tileSource.expireCache(); } catch (e) {}
          try { vEntry.tileSource.refresh(); } catch (e) {}
          if (vEntry.tileLayer) vEntry.tileLayer.changed();
          if (vEntry.editLayer) vEntry.editLayer.changed();
          map.render();
        } else if (vEntry.source) {
          if (vEntry.bboxMode) {
            vEntry.source.clear();
            refreshBboxLayers();
          } else {
            vEntry.source.changed();
            if (vEntry.layer) vEntry.layer.changed();
            map.render();
          }
        }
      }
    }

    return () => {
      if (moveEndTimer) clearTimeout(moveEndTimer);
      map.un('moveend', handleMoveEnd);
      const serverVectorsObj = layersRef.current?.serverVectors || {};
      for (const vEntry of Object.values(serverVectorsObj)) {
        if (vEntry?._abortController) {
          try { vEntry._abortController.abort(); } catch (_) {}
        }
      }
    };
  }, [olModules, bboxReloadTrigger]);

  // ---- Fly to GPS ----
  const flyToGPS = useCallback(() => {
    if (!mapInstance.current || !gpsPosition || !olModules) return;
    const { fromLonLat } = olModules;
    try {
      mapInstance.current.getView().animate({
        center: fromLonLat([gpsPosition.lng, gpsPosition.lat]),
        zoom: 18,
        duration: 800,
      });
    } catch (e) {
      console.warn('[Map] Fly to GPS notice:', e);
    }
  }, [gpsPosition, olModules]);

  return (
    <div className="relative w-full h-full">
      <div ref={mapRef} className="w-full h-full map-container" id="kmc-map" />

      {/* Government Map Quick Controls (Bottom Left) */}
      <div className="absolute bottom-[max(2rem,calc(env(safe-area-inset-bottom,0px)+1.75rem))] left-3 flex flex-col gap-1.5 z-20">
        <button type="button"
          id="zoom-in-btn"
          onClick={() => {
            if (mapInstance.current) {
              const view = mapInstance.current.getView();
              const z = view.getZoom() || 0;
              view.animate({ zoom: Math.min(z + 1, view.getMaxZoom() ?? 30), duration: 250 });
            }
          }}
          className="w-9 h-9 rounded-md bg-white hover:bg-gov-blue-50 text-gov-blue-800 border border-slate-300
                     flex items-center justify-center transition-all shadow-md group"
          title="जुम इन गर्नुहोस् (Zoom In)"
        >
          <Plus className="w-4.5 h-4.5 group-hover:scale-110 transition-transform" />
        </button>

        <button type="button"
          id="zoom-out-btn"
          onClick={() => {
            if (mapInstance.current) {
              const view = mapInstance.current.getView();
              const z = view.getZoom() || 0;
              view.animate({ zoom: Math.max(z - 1, view.getMinZoom() ?? 0), duration: 250 });
            }
          }}
          className="w-9 h-9 rounded-md bg-white hover:bg-gov-blue-50 text-gov-blue-800 border border-slate-300
                     flex items-center justify-center transition-all shadow-md group"
          title="जुम आउट गर्नुहोस् (Zoom Out)"
        >
          <Minus className="w-4.5 h-4.5 group-hover:scale-110 transition-transform" />
        </button>

        <button type="button"
          id="gps-center-btn"
          onClick={flyToGPS}
          className="w-9 h-9 rounded-md bg-white hover:bg-gov-blue-50 text-gov-blue-800 border border-slate-300
                     flex items-center justify-center transition-all shadow-md group"
          title="वर्तमान जीपीएस स्थानमा जानुहोस् (Center on GPS)"
        >
          <Navigation className="w-4.5 h-4.5 group-hover:scale-110 transition-transform" />
        </button>

        <button type="button"
          id="reset-north-btn"
          onClick={() => {
            if (mapInstance.current) {
              mapInstance.current.getView().animate({ rotation: 0, duration: 400 });
            }
          }}
          className="w-9 h-9 rounded-md bg-white hover:bg-gov-blue-50 text-gov-blue-800 border border-slate-300
                     flex items-center justify-center transition-all shadow-md group"
          title="उत्तरतिर रिसेट गर्नुहोस् (Reset to North)"
        >
          <Compass
            className="w-4.5 h-4.5 group-hover:scale-110 transition-transform"
            style={{ transform: `rotate(${-mapRotation}rad)` }}
          />
        </button>

        <button type="button"
          id="fit-extent-btn"
          onClick={() => {
            if (mapInstance.current && layersRef.current.taskSource) {
              const extent = layersRef.current.taskSource.getExtent();
              if (isValidExtent(extent)) {
                mapInstance.current.getView().fit(extent, { padding: [60, 60, 60, 60], duration: 500 });
              }
            }
          }}
          className="w-9 h-9 rounded-md bg-white hover:bg-gov-blue-50 text-gov-blue-800 border border-slate-300
                     flex items-center justify-center transition-all shadow-md group"
          title="कार्य ग्रिड क्षेत्रमा जुम गर्नुहोस् (Fit to Tasks)"
        >
          <Maximize className="w-4.5 h-4.5 group-hover:scale-110 transition-transform" />
        </button>
      </div>

      {/* Large-layer viewport loading indicator */}
      {bboxLoadingIds.length > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 pointer-events-none">
          <div className="flex items-center gap-2 bg-gov-blue-950/90 text-white text-[11px] font-nepali font-bold px-3 py-1.5 rounded-full shadow-lg border border-gov-blue-400/40">
            <span className="w-3 h-3 rounded-full border-2 border-white/40 border-t-white animate-spin" />
            <span>ठूलो तह लोड हुँदैछ… (Loading viewport features…)</span>
          </div>
        </div>
      )}

      {/* Collector Info Popup Card (When GisAdmin clicks a collector marker) */}
      {inspectedCollector && (
        <div className="absolute top-4 right-4 z-40 bg-white/95 backdrop-blur-md rounded-2xl shadow-2xl border border-slate-300 p-4 w-80 max-w-[calc(100vw-32px)] font-sans animate-slide-up">
          {/* Multi-officer Co-Location Switcher Header */}
          {inspectedCollectorCluster.length > 1 && (
            <div className="bg-gov-blue-50 border border-gov-blue-200/90 rounded-xl p-2 mb-2.5 text-xs font-nepali space-y-1.5 shadow-xs">
              <div className="flex items-center justify-between text-gov-blue-950 font-bold text-[11px]">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5 text-gov-blue-800" />
                  <span>यस साझा स्थानमा {inspectedCollectorCluster.length} जना संकलकहरू</span>
                </span>
                <span className="text-[10px] bg-gov-blue-200 text-gov-blue-900 px-1.5 py-0.5 rounded font-mono font-bold">
                  {clusterMemberIndex + 1} / {inspectedCollectorCluster.length}
                </span>
              </div>

              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => {
                    const prevIdx = (clusterMemberIndex - 1 + inspectedCollectorCluster.length) % inspectedCollectorCluster.length;
                    setClusterMemberIndex(prevIdx);
                    setInspectedCollector(inspectedCollectorCluster[prevIdx]);
                  }}
                  className="p-1 rounded bg-white hover:bg-gov-blue-100 border border-gov-blue-200 text-gov-blue-800 shadow-xs flex items-center justify-center transition-colors shrink-0"
                  title="अघिल्लो संकलक"
                >
                  <ChevronLeft className="w-3.5 h-3.5" />
                </button>

                <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-none py-0.5">
                  {inspectedCollectorCluster.map((col, cIdx) => (
                    <button
                      key={col.user_id}
                      type="button"
                      onClick={() => {
                        setClusterMemberIndex(cIdx);
                        setInspectedCollector(col);
                      }}
                      className={`px-2 py-0.5 rounded text-[10px] font-bold truncate flex-1 transition-all ${
                        cIdx === clusterMemberIndex
                          ? 'bg-gov-blue-800 text-white shadow-xs'
                          : 'bg-white text-slate-700 hover:bg-slate-100 border border-slate-200'
                      }`}
                    >
                      {col.full_name ? col.full_name.split(' ')[0] : col.username}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const nextIdx = (clusterMemberIndex + 1) % inspectedCollectorCluster.length;
                    setClusterMemberIndex(nextIdx);
                    setInspectedCollector(inspectedCollectorCluster[nextIdx]);
                  }}
                  className="p-1 rounded bg-white hover:bg-gov-blue-100 border border-gov-blue-200 text-gov-blue-800 shadow-xs flex items-center justify-center transition-colors shrink-0"
                  title="पछिल्लो संकलक"
                >
                  <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="flex items-start justify-between pb-2.5 border-b border-slate-100">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm shrink-0 ${
                inspectedCollector.is_online ? 'bg-emerald-100 text-emerald-800 ring-2 ring-emerald-400' : 'bg-slate-100 text-slate-700'
              }`}>
                {inspectedCollector.full_name ? inspectedCollector.full_name.charAt(0).toUpperCase() : 'U'}
              </div>
              <div className="min-w-0">
                <div className="font-bold text-slate-900 text-sm font-nepali truncate">
                  {inspectedCollector.full_name || inspectedCollector.username}
                </div>
                <div className="text-[10px] text-slate-500 font-mono">
                  @{inspectedCollector.username}
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                setInspectedCollector(null);
                setInspectedCollectorCluster([]);
              }}
              className="text-slate-400 hover:text-slate-700 p-1 rounded-lg hover:bg-slate-100"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="py-2.5 space-y-2 text-xs">
            <div className="flex items-center justify-between">
              <span className="text-slate-500 text-[11px] font-nepali">स्थिति (Status):</span>
              <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold flex items-center gap-1 ${
                inspectedCollector.is_online
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-slate-100 text-slate-700'
              }`}>
                <span className={`w-2 h-2 rounded-full ${inspectedCollector.is_online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                <span>{inspectedCollector.is_online ? 'सक्रिय (Online)' : `बन्द (${inspectedCollector.minutes_ago !== null && inspectedCollector.minutes_ago !== undefined ? `${inspectedCollector.minutes_ago} मिनेट अघि` : 'Offline'})`}</span>
              </span>
            </div>

            <div className="flex items-center justify-between">
              <span className="text-slate-500 text-[11px] font-nepali">जीपीएस स्थान (GPS):</span>
              <span className="font-mono text-[10px] text-slate-800 font-bold">
                {inspectedCollector.latitude?.toFixed(6)}°N, {inspectedCollector.longitude?.toFixed(6)}°E
              </span>
            </div>

            {inspectedCollector.accuracy && (
              <div className="flex items-center justify-between">
                <span className="text-slate-500 text-[11px] font-nepali">शुद्धता (Accuracy):</span>
                <span className="font-mono text-[10px] text-slate-700">
                  ±{inspectedCollector.accuracy.toFixed(1)}m
                </span>
              </div>
            )}

            {inspectedCollector.assigned_projects?.length > 0 && (
              <div className="pt-1 border-t border-slate-100">
                <span className="text-slate-500 text-[10px] block mb-1 font-nepali">तोकिएका परियोजनाहरू:</span>
                <div className="flex flex-wrap gap-1">
                  {inspectedCollector.assigned_projects.map((p) => (
                    <span key={p.id} className="px-1.5 py-0.5 bg-gov-blue-50 text-gov-blue-800 rounded text-[10px] font-nepali font-semibold">
                      {p.name}
                    </span>
                  ))}
                </div>
              </div>
            )}

            {inspectedCollector.active_task && (
              <div className="bg-amber-50 p-2 rounded-lg border border-amber-200 text-[11px] text-amber-900 font-nepali">
                हाल कार्य भइरहेको ग्रिड: <strong>ग्रिड #{inspectedCollector.active_task.grid_index}</strong>
              </div>
            )}
          </div>

          <div className="pt-2 border-t border-slate-100 flex gap-2">
            <button
              type="button"
              onClick={() => {
                if (mapInstance.current && olModules && inspectedCollector.latitude && inspectedCollector.longitude) {
                  const { fromLonLat } = olModules;
                  mapInstance.current.getView().animate({
                    center: fromLonLat([inspectedCollector.longitude, inspectedCollector.latitude]),
                    zoom: 18,
                    duration: 600,
                  });
                }
              }}
              className="flex-1 bg-gov-blue-800 hover:bg-gov-blue-900 text-white text-[11px] font-bold py-1.5 px-3 rounded-lg flex items-center justify-center gap-1.5 transition-all font-nepali"
            >
              <Crosshair className="w-3.5 h-3.5" />
              <span>केन्द्रमा देखाउनुहोस्</span>
            </button>
          </div>
        </div>
      )}

      {/* Bottom Coordinates & Government System Ribbon with Live GPS */}
      <div className="absolute bottom-0 left-0 right-0 min-h-[1.5rem] bg-slate-900/95 text-slate-300 backdrop-blur-sm border-t border-slate-700/60 px-3 flex items-center justify-between text-[10px] z-20 font-sans pb-[env(safe-area-inset-bottom,0px)]">
        <div className="flex items-center gap-2.5">
          <span className="font-semibold text-gov-gold-400 font-nepali">काठमाडौँ महानगरपालिका</span>
          <span className="text-slate-500 hidden sm:inline">|</span>
          <span className="text-slate-400 font-mono hidden md:inline">CRS: EPSG:3857 (WGS 84)</span>
        </div>

        <div className="flex items-center gap-3 font-sans">
          {gpsPosition ? (
            <div className="flex items-center gap-1.5 text-emerald-400 font-medium">
              <div className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              <span className="font-mono">{gpsPosition.lat.toFixed(6)}°N, {gpsPosition.lng.toFixed(6)}°E</span>
              <span className="text-slate-400 hidden sm:inline">(±{gpsPosition.accuracy?.toFixed(1) || '?'}m)</span>
            </div>
          ) : (
            <div className="text-slate-500 hidden sm:inline">जीपीएस निष्क्रिय (GPS Off)</div>
          )}
        </div>
      </div>

      {!olLoaded && (
        <div className="absolute inset-0 bg-slate-100 flex items-center justify-center z-30">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-4 border-gov-blue-800 border-t-transparent rounded-full animate-spin" />
            <p className="text-slate-700 text-xs font-semibold font-nepali">काठमाडौँ महानगर नक्सा इन्जिन लोड हुँदैछ...</p>
          </div>
        </div>
      )}
    </div>
  );
}
