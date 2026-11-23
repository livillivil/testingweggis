'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  X,
  Layers,
  MapPin,
  Calendar,
  Tag,
  Hash,
  FileText,
  UserCheck,
  Navigation,
  Copy,
  Check,
  Link2,
  ExternalLink,
  Loader2,
  Edit3,
  Scissors,
  Combine,
  Plus,
  Trash2,
  MousePointerClick,
  Search,
  Home,
  Sparkles,
  Compass,
  Ruler,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { featuresAPI } from '../lib/api';
import { formatApiError } from '../lib/apiError';

/**
 * Helper to compute quick spatial metrics (area m², length/perimeter m, vertex count, centroid)
 * from a GeoJSON geometry in EPSG:4326.
 */
function computeSpatialMetrics(geometry) {
  if (!geometry || !geometry.type || !geometry.coordinates) {
    return { vertexCount: 0, centroid: null, areaSqM: null, lengthM: null };
  }
  const type = geometry.type;
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;

  const distM = (a, b) => {
    if (!a || !b || a.length < 2 || b.length < 2) return 0;
    const dLat = toRad(b[1] - a[1]);
    const dLon = toRad(b[0] - a[0]);
    const lat1 = toRad(a[1]);
    const lat2 = toRad(b[1]);
    const s =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
    return 2 * R * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  };

  const ringAreaAndPerim = (ring) => {
    if (!Array.isArray(ring) || ring.length < 3) return { area: 0, perim: 0 };
    let area = 0;
    let perim = 0;
    const lat0 = toRad(ring[0][1] || 27.69);
    const cosLat = Math.cos(lat0);
    for (let i = 0; i < ring.length - 1; i++) {
      const p1 = ring[i];
      const p2 = ring[i + 1];
      perim += distM(p1, p2);
      const x1 = toRad(p1[0]) * R * cosLat;
      const y1 = toRad(p1[1]) * R;
      const x2 = toRad(p2[0]) * R * cosLat;
      const y2 = toRad(p2[1]) * R;
      area += x1 * y2 - x2 * y1;
    }
    return { area: Math.abs(area) / 2, perim };
  };

  if (type === 'Point') {
    const c = geometry.coordinates;
    return {
      vertexCount: 1,
      centroid: Array.isArray(c) && c.length >= 2 ? [c[0], c[1]] : null,
      areaSqM: null,
      lengthM: null,
    };
  }

  if (type === 'LineString') {
    const coords = geometry.coordinates || [];
    let len = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < coords.length; i++) {
      sx += coords[i][0];
      sy += coords[i][1];
      if (i > 0) len += distM(coords[i - 1], coords[i]);
    }
    return {
      vertexCount: coords.length,
      centroid: coords.length ? [sx / coords.length, sy / coords.length] : null,
      areaSqM: null,
      lengthM: Math.round(len * 10) / 10,
    };
  }

  if (type === 'Polygon') {
    const ring = geometry.coordinates?.[0] || [];
    const { area, perim } = ringAreaAndPerim(ring);
    let sx = 0;
    let sy = 0;
    const n = Math.max(1, ring.length - 1);
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    return {
      vertexCount: n,
      centroid: ring.length ? [sx / n, sy / n] : null,
      areaSqM: Math.round(area * 10) / 10,
      lengthM: Math.round(perim * 10) / 10,
    };
  }

  if (type === 'MultiPolygon') {
    const polys = geometry.coordinates || [];
    let totalArea = 0;
    let totalPerim = 0;
    let vCount = 0;
    let sx = 0;
    let sy = 0;
    polys.forEach((poly) => {
      const ring = poly?.[0] || [];
      const { area, perim } = ringAreaAndPerim(ring);
      totalArea += area;
      totalPerim += perim;
      const n = Math.max(0, ring.length - 1);
      for (let i = 0; i < n; i++) {
        sx += ring[i][0];
        sy += ring[i][1];
        vCount++;
      }
    });
    return {
      vertexCount: vCount,
      centroid: vCount > 0 ? [sx / vCount, sy / vCount] : null,
      areaSqM: Math.round(totalArea * 10) / 10,
      lengthM: Math.round(totalPerim * 10) / 10,
    };
  }

  return { vertexCount: 0, centroid: null, areaSqM: null, lengthM: null };
}

/**
 * Converts square meters into Ropani-Aana-Paisa-Daam (Nepal Standard Land Measurement)
 */
function formatNepaliLandArea(sqMeters) {
  if (!sqMeters || sqMeters <= 0) return null;
  let remaining = sqMeters;
  const ropani = Math.floor(remaining / 508.72);
  remaining -= ropani * 508.72;
  const aana = Math.floor(remaining / 31.80);
  remaining -= aana * 31.80;
  const paisa = Math.floor(remaining / 7.95);
  remaining -= paisa * 7.95;
  const daam = (remaining / 1.99).toFixed(1);
  return `${ropani}-${aana}-${paisa}-${daam} (रो-आ-पै-दा)`;
}

const RELATIONSHIP_LABELS = {
  spatial_feature_link: 'भौगोलिक लिङ्क (Spatial Link)',
  road_frontage: 'सडक पहुँच (Road Frontage)',
  cadastral_parcel: 'कित्ता जग्गा (Cadastral Parcel)',
  spatial_utility_link: 'उपयोगिता बिन्दु (Utility / Point Link)',
  adjacent_neighbor: 'छिमेकी फिचर (Adjacent Neighbor)',
  spatial_join: 'तह सम्बन्ध (Layer Join)',
};

const NON_FIELD_KEYS = new Set(['geometry', 'geom', 'the_geom', 'linked_feature_id', 'linked_feature_ids', 'linked_feature_ref']);

/** Every attribute a layer exposes, for choosing either side of a link. */
function collectFieldNames(layerObj, sampleProps = null) {
  const set = new Set(['_id', 'id']);
  const addFields = (list) => {
    if (!Array.isArray(list)) return;
    list.forEach((field) => {
      if (field?.name && !String(field.name).startsWith('_')) set.add(field.name);
    });
  };
  if (layerObj) {
    addFields(layerObj.fields_config);
    addFields(layerObj.editable_fields);
    addFields(layerObj.form_schema?.fields);
    if (layerObj.geometry_fields_config && typeof layerObj.geometry_fields_config === 'object') {
      Object.values(layerObj.geometry_fields_config).forEach(addFields);
    }
    if (Array.isArray(layerObj.questionnaire?.sections)) {
      layerObj.questionnaire.sections.forEach((section) => addFields(section?.fields));
    }
  }
  Object.keys(sampleProps || {}).forEach((key) => {
    if (!NON_FIELD_KEYS.has(key) && !key.startsWith('_')) set.add(key);
  });
  return Array.from(set);
}

export default function ReadOnlyAttributePopup({
  feature,
  layer,
  allLayers = [],
  currentUser = null,
  onClose,
  onZoomToFeature,
  onSelectLinkedFeature,
  onEditFeature,
  onStartSplit,
  onStartMerge,
  onStartMapLinkPick,
  onFeatureLinksUpdated,
  onLinkedFeaturesLoaded,
  canEdit = true,
  onDeleteFeature = null,
  deletingFeature = false,
  onStartSurvey = null,
  onToggleIndividualHouseNumber = null,
  isIndividualHouseNumberShown = null,
}) {
  const [copiedKey, setCopiedKey] = useState(null);
  const [linkedFeatures, setLinkedFeatures] = useState([]);
  const [loadingLinked, setLoadingLinked] = useState(false);
  const [attrSearch, setAttrSearch] = useState('');

  // Feature-to-feature linker state (both sides may be on different layers).
  const [showAddLinkPanel, setShowAddLinkPanel] = useState(false);
  const [selectedLinkAttribute, setSelectedLinkAttribute] = useState('_id');
  const [targetLinkAttribute, setTargetLinkAttribute] = useState('_id');
  const [linkTargetLayerId, setLinkTargetLayerId] = useState('');
  const [fetchedTargetFields, setFetchedTargetFields] = useState([]);
  const [baseLayerFeatures, setBaseLayerFeatures] = useState([]);
  const [loadingBaseFeatures, setLoadingBaseFeatures] = useState(false);
  const [selectedTargetFeatureId, setSelectedTargetFeatureId] = useState('');
  const [linkingBusy, setLinkingBusy] = useState(false);
  const [linkStatusMsg, setLinkStatusMsg] = useState(null);

  const [isMinimized, setIsMinimized] = useState(false);

  const rawProps = feature?.properties || {};
  const featureId = feature?.id || rawProps._id || rawProps.id;
  const geomType = feature?.geometry?.type || 'Polygon';

  const resolvedLayer = layer || (allLayers || []).find(
    (item) => String(item.id) === String(feature?.layerId || feature?.layer_id || rawProps.layer_id || rawProps._layerId)
  );

  const targetLayerOptions = useMemo(() => {
    const list = (Array.isArray(allLayers) && allLayers.length > 0 ? allLayers : [layer]).filter(Boolean);
    const seen = new Set();
    return list.filter((item) => {
      const key = String(item.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [allLayers, layer]);

  const targetLayerForLink = useMemo(() => {
    const wanted = String(linkTargetLayerId || layer?.id || '');
    return targetLayerOptions.find((item) => String(item.id) === wanted) || layer || null;
  }, [targetLayerOptions, linkTargetLayerId, layer]);

  // Every attribute of this feature's layer, and of the chosen target layer.
  const availableLinkAttributes = useMemo(
    () => collectFieldNames(resolvedLayer, rawProps),
    [resolvedLayer, rawProps]
  );
  useEffect(() => {
    const targetId = linkTargetLayerId || targetLayerForLink?.id;
    if (!showAddLinkPanel || !targetId) {
      setFetchedTargetFields([]);
      return;
    }
    let alive = true;
    layersAPI.getFields(targetId)
      .then((res) => {
        if (!alive) return;
        const data = res?.data;
        const list = Array.isArray(data)
          ? data
          : (Array.isArray(data?.fields) ? data.fields : (Array.isArray(data?.fields_config) ? data.fields_config : []));
        setFetchedTargetFields(list);
      })
      .catch(() => {
        if (alive) setFetchedTargetFields([]);
      });
    return () => { alive = false; };
  }, [showAddLinkPanel, linkTargetLayerId, targetLayerForLink?.id]);

  const targetLinkAttributes = useMemo(() => {
    const mergedProps = {};
    (baseLayerFeatures || []).forEach((feat) => {
      if (feat?.properties && typeof feat.properties === 'object') {
        Object.keys(feat.properties).forEach((k) => {
          if (!(k in mergedProps)) mergedProps[k] = feat.properties[k];
        });
      }
    });
    const baseNames = collectFieldNames(targetLayerForLink, mergedProps);
    const seen = new Set(baseNames);
    const out = [...baseNames];
    (fetchedTargetFields || []).forEach((f) => {
      const name = typeof f === 'string' ? f : f?.name;
      if (name && !seen.has(name)) {
        seen.add(name);
        out.push(name);
      }
    });
    return out;
  }, [targetLayerForLink, baseLayerFeatures, fetchedTargetFields]);

  useEffect(() => {
    if (!availableLinkAttributes.includes(selectedLinkAttribute)) {
      setSelectedLinkAttribute(
        availableLinkAttributes.find((name) => name !== '_id' && name !== 'id')
        || availableLinkAttributes[0]
        || '_id'
      );
    }
  }, [availableLinkAttributes, selectedLinkAttribute]);

  useEffect(() => {
    if (!targetLinkAttributes.includes(targetLinkAttribute)) {
      setTargetLinkAttribute(
        targetLinkAttributes.includes(selectedLinkAttribute)
          ? selectedLinkAttribute
          : (targetLinkAttributes.find((name) => name !== '_id' && name !== 'id') || '_id')
      );
    }
  }, [targetLinkAttributes, targetLinkAttribute, selectedLinkAttribute]);

  useEffect(() => {
    if (showAddLinkPanel && !linkTargetLayerId && layer?.id != null) {
      setLinkTargetLayerId(String(layer.id));
    }
  }, [showAddLinkPanel, linkTargetLayerId, layer?.id]);

  const fetchLinked = async () => {
    if (!featureId) {
      setLinkedFeatures([]);
      if (onLinkedFeaturesLoaded) onLinkedFeaturesLoaded([]);
      return;
    }
    setLoadingLinked(true);
    try {
      const res = await featuresAPI.getLinked(featureId);
      const list = res.data?.linked_features || [];
      setLinkedFeatures(list);
      if (onLinkedFeaturesLoaded) onLinkedFeaturesLoaded(list);
    } catch (_) {
      setLinkedFeatures([]);
      if (onLinkedFeaturesLoaded) onLinkedFeaturesLoaded([]);
    } finally {
      setLoadingLinked(false);
    }
  };

  useEffect(() => {
    fetchLinked();
    setShowAddLinkPanel(false);
    setLinkStatusMsg(null);
  }, [featureId]);

  // Load features of the chosen target layer for direct selection.
  useEffect(() => {
    if (!showAddLinkPanel || !targetLayerForLink?.id) return;
    let cancelled = false;
    setLoadingBaseFeatures(true);
    featuresAPI
      .list(Number(targetLayerForLink.id))
      .then((res) => {
        if (cancelled) return;
        const feats = res.data?.features || (Array.isArray(res.data) ? res.data : []);
        const sameLayer = String(targetLayerForLink.id) === String(layer?.id);
        const filtered = sameLayer
          ? feats.filter((f) => Number(f.id || f.properties?._id) !== Number(featureId))
          : feats;
        setBaseLayerFeatures(filtered);
        setSelectedTargetFeatureId(
          filtered.length > 0 ? String(filtered[0].id || filtered[0].properties?._id) : ''
        );
      })
      .catch(() => {
        if (!cancelled) {
          setBaseLayerFeatures([]);
          setSelectedTargetFeatureId('');
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingBaseFeatures(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showAddLinkPanel, targetLayerForLink?.id, layer?.id, featureId]);

  const selectedTargetFeature = useMemo(
    () => baseLayerFeatures.find(
      (item) => String(item.id || item.properties?._id) === String(selectedTargetFeatureId)
    ) || null,
    [baseLayerFeatures, selectedTargetFeatureId]
  );

  const linkValueFor = (props, field, featureObj) => {
    if (field === '_id' || field === 'id') {
      return featureObj?.id ?? props?._id ?? props?.id ?? null;
    }
    return props?.[field] ?? null;
  };

  const handleCreateDirectLink = async (e) => {
    if (e) e.preventDefault();
    if (!selectedTargetFeatureId || !featureId || !selectedTargetFeature) return;
    setLinkingBusy(true);
    setLinkStatusMsg(null);
    try {
      await featuresAPI.link(featureId, {
        target_feature_id: selectedTargetFeatureId,
        source_layer_id: layer?.id,
        target_layer_id: targetLayerForLink?.id,
        source_link_attribute: selectedLinkAttribute,
        target_link_attribute: targetLinkAttribute,
        link_attribute: selectedLinkAttribute,
        relationship_type: 'base_layer_link',
      });
      setLinkStatusMsg({ type: 'success', text: 'सफलतापूर्वक सम्बन्ध जोडियो! (Features linked successfully)' });
      await fetchLinked();
      if (onFeatureLinksUpdated) onFeatureLinksUpdated();
      setTimeout(() => setShowAddLinkPanel(false), 1200);
    } catch (err) {
      setLinkStatusMsg({ type: 'error', text: formatApiError(err, 'लिङ्क गर्न सकिएन।') });
    } finally {
      setLinkingBusy(false);
    }
  };

  const handleUnlinkFeature = async (targetId, linkId) => {
    if (!window.confirm('के तपाईं यो सम्बन्ध हटाउन निश्चित हुनुहुन्छ? (Remove this feature link?)')) return;
    try {
      await featuresAPI.unlink(featureId, { target_feature_id: targetId, link_id: linkId });
      setLinkStatusMsg({ type: 'success', text: 'सम्बन्ध हटाइयो। (Link removed)' });
      await fetchLinked();
      if (onFeatureLinksUpdated) onFeatureLinksUpdated();
    } catch (err) {
      setLinkStatusMsg({
        type: 'error',
        text: formatApiError(err, 'सम्बन्ध हटाउन सकिएन। (Failed to remove link)'),
      });
    }
  };

  const metrics = useMemo(() => computeSpatialMetrics(feature?.geometry), [feature?.geometry]);
  const nepaliArea = useMemo(() => {
    if (metrics.areaSqM != null && metrics.areaSqM > 0) {
      return formatNepaliLandArea(metrics.areaSqM);
    }
    return null;
  }, [metrics.areaSqM]);

  if (!feature) return null;

  const sourceLinkValue = linkValueFor(rawProps, selectedLinkAttribute, feature);
  const targetLinkValue = linkValueFor(
    selectedTargetFeature?.properties || {},
    targetLinkAttribute,
    selectedTargetFeature
  );
  const isIdLink = ['_id', 'id'].includes(selectedLinkAttribute) || ['_id', 'id'].includes(targetLinkAttribute);
  const linkValuesMatch = isIdLink || (
    sourceLinkValue !== null && sourceLinkValue !== undefined
    && targetLinkValue !== null && targetLinkValue !== undefined
    && String(sourceLinkValue).trim() === String(targetLinkValue).trim()
  );

  const createdBy =
    rawProps._created_by_name || rawProps._created_by_username || rawProps.Kmc_Creator || rawProps.created_by || null;
  const updatedBy =
    rawProps._updated_by_name || rawProps._updated_by_username || rawProps.Kmc_Editor || rawProps.updated_by || null;
  const updatedAt = rawProps._updated_at || rawProps.updated_at || null;
  const version = rawProps._version || 1;

  // Primary display title for the feature
  const primaryTitle =
    rawProps.owner_name ||
    rawProps.road_name ||
    rawProps.asset_name ||
    rawProps.bldg_code ||
    rawProps.parcel_no ||
    rawProps.name ||
    `${layer?.name || 'Feature'} #${featureId}`;

  const fieldsConfig = resolvedLayer?.fields_config || [];
  const fieldPermissions = resolvedLayer?.field_permissions || {};
  const userRole = currentUser?.role || 'BasicViewer';
  const readRole = userRole === 'MunicipalUser' ? 'BasicViewer' : userRole;
  const isAdmin = ['SuperAdmin', 'MasterAdmin', 'GisAdmin', 'DepartmentAdmin'].includes(userRole);

  const labelMap = {};
  const visibilityMap = {};
  const fieldOrderMap = {};
  fieldsConfig.forEach((f, idx) => {
    if (f && f.name) {
      labelMap[f.name] = f.label || f.name;
      visibilityMap[f.name] = f.visible_in_popup !== false;
      fieldOrderMap[f.name] = idx;
    }
  });

  const hasConfiguredFields = Array.isArray(fieldsConfig) && fieldsConfig.length > 0;
  const configuredFieldNames = new Set(fieldsConfig.map((f) => f.name));
  const fieldDefinitionMap = new Map(
    fieldsConfig.filter((f) => f?.name).map((f) => [f.name, f])
  );
  const isValidatorViewer = userRole === 'Validator' || isAdmin;

  const hiddenSystemKeys = new Set([
    '_id',
    'id',
    'geometry',
    '_layerId',
    'layer_id',
    '_status',
    '_created_by',
    '_created_by_username',
    '_created_by_name',
    '_updated_by',
    '_updated_by_username',
    '_updated_by_name',
    '_created_at',
    '_updated_at',
    '_version',
    '_record_id',
    '_questionnaire_id',
    '_task_grid_id',
    '_layer_id',
    'linked_feature_id',
    'linked_feature_ref',
    'link_attribute',
    'target_id',
    '_target_feature_id',
  ]);

  const displayEntries = Object.entries(rawProps)
    .filter(([key, val]) => {
      if (key === 'geometry' || key === 'geom' || key === 'the_geom') return false;
      // Role-based field permissions:
      if (!isAdmin && fieldPermissions[key]) {
        const allowedRoles = fieldPermissions[key];
        if (Array.isArray(allowedRoles) && !allowedRoles.includes(readRole)) {
          return false;
        }
      }
      // Admin-set access level is the fallback when permissions were trimmed server-side.
      if (!isAdmin) {
        const accessLevel = fieldDefinitionMap.get(key)?.access_level;
        if (accessLevel === 'admin' || accessLevel === 'admin_only') return false;
        if (accessLevel === 'validator' && !isValidatorViewer) return false;
      }
      // Internal/system metadata (underscore-prefixed) never appears in the
      // public inspector, even when a legacy auto-discovered schema listed it.
      if (key.startsWith('_') || key.endsWith('_linked_id')) return false;
      // If admin has configured specific allowed fields, show ONLY those where visible_in_popup is true
      if (hasConfiguredFields) {
        if (!configuredFieldNames.has(key)) return false;
        if (visibilityMap[key] === false) return false;
      } else if (hiddenSystemKeys.has(key)) {
        return false;
      }
      if (val === null || val === undefined || val === '') return false;
      if (attrSearch.trim()) {
        const q = attrSearch.toLowerCase();
        const label = (labelMap[key] || key).toLowerCase();
        return key.toLowerCase().includes(q) || label.includes(q) || String(val).toLowerCase().includes(q);
      }
      return true;
    })
    .sort(([keyA], [keyB]) => {
      const orderA = fieldOrderMap[keyA] !== undefined ? fieldOrderMap[keyA] : 999;
      const orderB = fieldOrderMap[keyB] !== undefined ? fieldOrderMap[keyB] : 999;
      return orderA - orderB;
    });

  const handleCopy = (key, text) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(String(text));
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1500);
    }
  };

  const isMultipart =
    geomType === 'MultiPolygon' ||
    geomType === 'MultiLineString' ||
    (feature?.geometry?.type && feature.geometry.type.startsWith('Multi')) ||
    (Array.isArray(feature?.geometry?.coordinates) &&
      (feature.geometry.type === 'MultiPolygon' || feature.geometry.type === 'MultiLineString' || feature.geometry.coordinates.length > 1));

  const canSplit =
    geomType === 'Polygon' ||
    geomType === 'MultiPolygon' ||
    geomType === 'LineString' ||
    geomType === 'MultiLineString';

  if (isMinimized) {
    return (
      <div
        id="feature-inspector-popup-min"
        className="fixed bottom-4 right-3 sm:right-4 z-40 bg-white/95 backdrop-blur-md rounded-xl shadow-2xl border border-slate-300 px-3 py-2 flex items-center justify-between gap-2 text-xs font-sans animate-fade-in max-w-[calc(100vw-24px)]"
      >
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-5 h-5 rounded bg-[#0447AF] text-white flex items-center justify-center shrink-0">
            <Layers className="w-3 h-3" />
          </div>
          <span className="font-bold text-slate-800 font-nepali truncate">
            {primaryTitle} {featureId ? `(#${featureId})` : ''}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => setIsMinimized(false)}
            className="p-1.5 text-slate-500 hover:text-gov-blue-800 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            title="विस्तृत हेर्नुहोस् (Expand)"
          >
            <ChevronUp className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-rose-600 rounded-lg hover:bg-slate-100 transition-colors cursor-pointer"
            title="बन्द गर्नुहोस् (Close)"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      id="feature-inspector-popup"
      className="fixed bottom-3 right-3 sm:bottom-4 sm:right-4 z-40 w-[calc(100vw-24px)] sm:w-96 sm:max-w-[560px] max-h-[80dvh] min-h-[260px] bg-white/98 backdrop-blur-xl rounded-xl shadow-2xl border border-slate-200/90 flex flex-col overflow-hidden animate-fade-in text-xs font-sans transition-all"
    >
      {/* Sleek Top Header (Gov-Blue Standard) */}
      <div className="bg-gradient-to-r from-[#032B69] to-[#0447AF] text-white px-3 py-2 shrink-0">
        <div className="flex items-start justify-between gap-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1 mb-0.5">
              <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded text-[9.5px] font-bold font-nepali tracking-wide truncate max-w-[120px] bg-white/15 text-sky-100">
                <Layers className="w-2.5 h-2.5 text-amber-300 shrink-0" />
                <span className="truncate">{layer?.name || 'तह'}</span>
              </span>
              <span className="px-1.5 py-0.2 rounded font-mono font-bold text-[9px] bg-amber-400/20 border border-amber-300/40 text-amber-200">
                {geomType}
              </span>
              {featureId && (
                <span className="px-1 py-0.2 rounded font-mono text-[9px] bg-slate-900/40 text-slate-200">
                  #{featureId}
                </span>
              )}
            </div>
            <h3 className="text-xs sm:text-sm font-bold font-nepali text-white truncate leading-tight flex items-center gap-1.5">
              <span>{primaryTitle}</span>
            </h3>
          </div>

          <div className="flex items-center gap-0.5 shrink-0">
            {onZoomToFeature && (
              <button
                type="button"
                onClick={() => onZoomToFeature(feature)}
                className="p-1 rounded bg-white/10 hover:bg-white/25 text-amber-300 transition-colors cursor-pointer"
                title="फिचरमा जुम गर्नुहोस् (Zoom to Feature)"
              >
                <Navigation className="w-3.5 h-3.5" />
              </button>
            )}
            <button
              type="button"
              onClick={() => setIsMinimized(true)}
              className="p-1 rounded bg-white/10 hover:bg-white/25 text-white transition-colors cursor-pointer"
              title="सानो बनाउनुहोस् (Minimize)"
            >
              <ChevronUp className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded bg-white/10 hover:bg-rose-600 text-white transition-colors shrink-0 cursor-pointer"
              title="बन्द गर्नुहोस् (Close)"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Spatial Telemetry Strip */}
        <div className="mt-1 pt-1 border-t border-white/15 flex flex-wrap items-center justify-between gap-1 text-[10px] text-sky-100">
          <div className="flex items-center gap-2 font-mono flex-wrap">
            {metrics.areaSqM !== null && (
              <span className="inline-flex items-center gap-0.5">
                <Ruler className="w-2.5 h-2.5 text-amber-300" />
                <strong>{metrics.areaSqM.toLocaleString()}</strong> m²
              </span>
            )}
            {nepaliArea && (
              <span className="inline-flex items-center gap-0.5 text-amber-300 font-nepali font-semibold">
                <span>{nepaliArea}</span>
              </span>
            )}
            {metrics.lengthM !== null && (
              <span className="inline-flex items-center gap-0.5">
                <Compass className="w-2.5 h-2.5 text-emerald-300" />
                <strong>{metrics.lengthM.toLocaleString()}</strong> m
              </span>
            )}
            {metrics.vertexCount > 0 && (
              <span className="text-[9px] text-sky-200/90 font-mono">
                {metrics.vertexCount} pts
              </span>
            )}
          </div>

          {metrics.centroid && (
            <button
              type="button"
              onClick={() =>
                handleCopy(
                  '_coords',
                  `${metrics.centroid[1].toFixed(6)}, ${metrics.centroid[0].toFixed(6)}`
                )
              }
              className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded bg-white/10 hover:bg-white/20 text-[9px] font-mono text-white transition-colors cursor-pointer"
              title="निर्देशांक कपी गर्नुहोस्"
            >
              {copiedKey === '_coords' ? (
                <Check className="w-2.5 h-2.5 text-emerald-300" />
              ) : (
                <MapPin className="w-2.5 h-2.5 text-sky-200" />
              )}
              <span>
                {metrics.centroid[1].toFixed(4)}, {metrics.centroid[0].toFixed(4)}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Draft Feature Notification Banner */}
      {(rawProps._status === 'DRAFT' || rawProps.status === 'DRAFT') && (
        <div className="bg-amber-50 border-b border-amber-200 px-3 py-2 flex items-center justify-between text-[11px] font-nepali text-amber-900 shrink-0">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-amber-500 animate-pulse shrink-0" />
            <div>
              <span className="font-bold block">मस्यौदा फिचर (Draft Feature)</span>
              {rawProps._created_by_username && (
                <span className="text-[10px] text-amber-700 font-mono">
                  संकलक: {rawProps._created_by_username}
                </span>
              )}
            </div>
          </div>
          {onStartSurvey && (
            <button
              type="button"
              onClick={() => onStartSurvey(feature, layer)}
              className="py-1 px-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-bold font-nepali text-xs transition-all shadow-xs cursor-pointer flex items-center gap-1 shrink-0"
              title="मस्यौदा फारम/प्रश्नावली खोली बाँकी विवरण भर्नुहोस्"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span>मस्यौदा जारी राख्नुहोस्</span>
            </button>
          )}
        </div>
      )}

      {/* House Number Metric Address Badge (If Assigned) */}
      {rawProps.house_number && (
        <div className="bg-gradient-to-r from-amber-50 to-amber-100/70 border-b border-amber-200 px-3 py-2 flex items-center justify-between gap-2 shrink-0">
          <div className="min-w-0">
            <div className="text-[10px] font-bold text-amber-900 font-nepali flex items-center gap-1.5">
              <Home className="w-3.5 h-3.5 text-amber-700 shrink-0" />
              <span>घर नम्बर (House Number):</span>
            </div>
            <div className="text-sm font-extrabold text-gov-blue-950 font-mono tracking-wide mt-0.5">
              {rawProps.house_number}
            </div>
            <div className="text-[9px] text-amber-800 font-nepali mt-0.5 flex items-center gap-2">
              <span>दिशा: {rawProps.side === 'LEFT' ? 'बायाँ (Left - बिजोर)' : 'दायाँ (Right - जोर)'}</span>
              {rawProps.road_name && <span>सडक: {rawProps.road_name}</span>}
              {rawProps.metric_distance_m !== undefined && <span>{rawProps.metric_distance_m}m</span>}
            </div>
          </div>
          {onToggleIndividualHouseNumber && (
            <button
              type="button"
              onClick={() => onToggleIndividualHouseNumber(featureId)}
              className={`px-2 py-1 rounded text-[10px] font-bold flex items-center gap-1 border transition-colors cursor-pointer shrink-0 ${
                isIndividualHouseNumberShown && isIndividualHouseNumberShown(featureId)
                  ? 'bg-amber-600 text-white border-amber-700 shadow-xs'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
              title="नक्सामा यो घर नम्बर लेबल देखाउने/लुकाउने"
            >
              <Tag className="w-3 h-3" />
              <span>{isIndividualHouseNumberShown && isIndividualHouseNumberShown(featureId) ? 'लेबल सक्रिय' : 'नक्सामा हेर्नुहोस्'}</span>
            </button>
          )}
        </div>
      )}

      {/* Quick Action Bar: Edit, Link Feature, Split, Merge, Delete */}
      {canEdit && (
        <div className="px-2.5 py-1.5 bg-slate-50 border-b border-slate-200 flex items-center gap-1.5 shrink-0 overflow-x-auto text-[11px] select-none scrollbar-none">
          {onStartSurvey && (
            <button
              type="button"
              onClick={() => onStartSurvey(feature, layer)}
              className={`flex items-center gap-1 py-1 px-2.5 rounded-lg font-bold font-nepali transition-all shadow-xs cursor-pointer shrink-0 ${
                (rawProps._status === 'DRAFT' || rawProps.status === 'DRAFT')
                  ? 'bg-amber-600 hover:bg-amber-700 text-white'
                  : 'bg-emerald-700 hover:bg-emerald-800 text-white'
              }`}
              title="यस फिचरको जियोमेट्री प्रयोग गरी प्रश्नावली/सर्वेक्षण भर्नुहोस्"
            >
              <FileText className="w-3.5 h-3.5 shrink-0" />
              <span>{(rawProps._status === 'DRAFT' || rawProps.status === 'DRAFT') ? 'मस्यौदा जारी राख्नुहोस्' : 'प्रश्नावली'}</span>
            </button>
          )}

          {onEditFeature && (
            <button
              type="button"
              onClick={() => onEditFeature(feature, layer)}
              className="flex items-center gap-1 py-1 px-2.5 rounded-lg bg-[#0447AF] hover:bg-[#032B69] text-white font-bold font-nepali transition-all shadow-xs cursor-pointer shrink-0"
              title="सीमा र विशेषता सम्पादन गर्नुहोस् (Edit Feature)"
            >
              <Edit3 className="w-3.5 h-3.5 shrink-0" />
              <span>सम्पादन</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setShowAddLinkPanel((v) => !v)}
            className={`flex items-center gap-1 py-1 px-2 rounded-lg font-bold font-nepali transition-all border cursor-pointer shrink-0 ${showAddLinkPanel
              ? 'bg-purple-700 text-white border-purple-800 shadow-xs'
              : 'bg-white hover:bg-purple-50 text-purple-900 border-purple-200'
              }`}
            title="अर्को फिचरसँग लिङ्क गर्नुहोस्"
          >
            <Link2 className="w-3.5 h-3.5 shrink-0" />
            <span>लिङ्क ({linkedFeatures.length})</span>
          </button>

          {canSplit && onStartSplit && (
            <button
              type="button"
              onClick={() => onStartSplit(feature, layer)}
              className="flex items-center gap-1 py-1 px-2 rounded-lg bg-white hover:bg-amber-50 text-amber-900 border border-amber-200 font-bold font-nepali transition-all cursor-pointer shrink-0"
              title={
                isMultipart
                  ? 'मल्टिपार्टलाई अलग-अलग एकल फिचरमा विभाजन गर्नुहोस् (Explode Multipart to Singleparts)'
                  : 'फिचरलाई दुई भागमा काट्नुहोस् (Split Feature)'
              }
            >
              <Scissors className="w-3.5 h-3.5 shrink-0 text-amber-700" />
              <span>{isMultipart ? 'मल्टिपार्ट अलग' : 'काट्नुहोस्'}</span>
            </button>
          )}

          {onStartMerge && (
            <button
              type="button"
              onClick={() => onStartMerge(feature, layer)}
              className="flex items-center gap-1 py-1 px-2 rounded-lg bg-white hover:bg-emerald-50 text-emerald-900 border border-emerald-200 font-bold font-nepali transition-all cursor-pointer shrink-0"
              title="अर्को फिचरसँग मर्ज गर्नुहोस् (Merge Features)"
            >
              <Combine className="w-3.5 h-3.5 shrink-0 text-emerald-700" />
              <span>मर्ज</span>
            </button>
          )}

          {onDeleteFeature && (
            <button
              type="button"
              onClick={() => {
                if (window.confirm('के तपाईं यो फिचर मेटाउन निश्चित हुनुहुन्छ? (Are you sure you want to delete this feature?)')) {
                  onDeleteFeature(featureId, layer?.id || feature?.layerId);
                  onClose();
                }
              }}
              disabled={deletingFeature}
              className="flex items-center gap-1 py-1 px-2 rounded-lg bg-white hover:bg-rose-50 text-rose-700 border border-rose-200 font-bold font-nepali transition-all cursor-pointer shrink-0 disabled:opacity-50"
              title="यो फिचर मेटाउनुहोस् (Delete Feature)"
            >
              <Trash2 className="w-3.5 h-3.5 shrink-0 text-rose-600" />
              <span>{deletingFeature ? 'मेटाउँदै...' : 'मेटाउनुहोस्'}</span>
            </button>
          )}
        </div>
      )}

      {/* Scrollable Inspector Body */}
      <div className="p-2.5 overflow-y-auto flex-1 min-h-0 space-y-2.5 overscroll-contain scrollbar-thin">
        {/* Interactive Feature-to-Feature Linker Drawer */}
        {showAddLinkPanel && (
          <div className="p-3 rounded-xl bg-purple-50/95 border border-purple-200 space-y-2.5 animate-slide-up shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-purple-950 font-nepali flex items-center gap-1.5">
                <Link2 className="w-3.5 h-3.5 text-purple-700" />
                <span>अर्को फिचरसँग जोड्नुहोस् (Link this Feature to Another)</span>
              </span>
              <button
                type="button"
                onClick={() => setShowAddLinkPanel(false)}
                className="text-purple-600 hover:text-purple-900 p-0.5 rounded cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <p className="text-[10px] text-purple-800 font-nepali leading-relaxed">
              जोड्ने तह र फिचर छान्नुहोस्, त्यसपछि दुवै फिचरको कुनै पनि फिल्ड छान्नुहोस्। दुवैमा उही फिल्डको उही मान भएमा सम्बन्ध स्थापित हुन्छ।
            </p>

            {onStartMapLinkPick && (
              <button
                type="button"
                onClick={() => onStartMapLinkPick(feature, layer, selectedLinkAttribute, targetLinkAttribute, targetLayerForLink?.id)}
                className="w-full py-1.5 px-3 rounded-lg bg-gradient-to-r from-purple-700 to-indigo-700 hover:from-purple-800 hover:to-indigo-800 text-white text-xs font-bold font-nepali flex items-center justify-center gap-1.5 shadow-sm transition-all cursor-pointer"
              >
                <MousePointerClick className="w-3.5 h-3.5 text-amber-300" />
                <span>नक्सामा फिचर क्लिक गरी जोड्नुहोस् (Pick on Map)</span>
              </button>
            )}

            <form onSubmit={handleCreateDirectLink} className="space-y-2 pt-1 border-t border-purple-200/80">
              {/* 1. Target layer */}
              <div>
                <label className="text-[10px] font-bold text-purple-950 block mb-1 font-nepali">
                  १. जोड्ने तह (Target Layer):
                </label>
                <select
                  value={String(targetLayerForLink?.id ?? '')}
                  onChange={(e) => {
                    setLinkTargetLayerId(e.target.value);
                    setSelectedTargetFeatureId('');
                    setLinkStatusMsg(null);
                  }}
                  className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-purple-700 cursor-pointer font-medium"
                >
                  {targetLayerOptions.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name || `Layer #${item.id}`} ({item.is_global ? 'महानगर' : 'परियोजना'})
                    </option>
                  ))}
                </select>
              </div>

              {/* 2. Source field + target field */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="text-[10px] font-bold text-purple-950 block mb-1 font-nepali">
                    २. यो फिचरको फिल्ड:
                  </label>
                  <select
                    value={selectedLinkAttribute}
                    onChange={(e) => setSelectedLinkAttribute(e.target.value)}
                    className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-purple-700 cursor-pointer font-medium"
                  >
                    {availableLinkAttributes.map((attr) => (
                      <option key={attr} value={attr}>
                        {attr}{rawProps[attr] !== undefined && rawProps[attr] !== null && rawProps[attr] !== '' ? ` [${rawProps[attr]}]` : ''}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="text-[10px] font-bold text-purple-950 block mb-1 font-nepali">
                    ३. लक्षित फिचरको फिल्ड:
                  </label>
                  <select
                    value={targetLinkAttribute}
                    onChange={(e) => setTargetLinkAttribute(e.target.value)}
                    className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-purple-700 cursor-pointer font-medium"
                  >
                    {targetLinkAttributes.map((attr) => (
                      <option key={attr} value={attr}>
                        {attr}{selectedTargetFeature?.properties?.[attr] !== undefined && selectedTargetFeature?.properties?.[attr] !== null && selectedTargetFeature?.properties?.[attr] !== '' ? ` [${selectedTargetFeature.properties[attr]}]` : ''}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* 4. Target feature */}
              <div>
                <label className="text-[10px] font-bold text-purple-950 block mb-1 font-nepali">
                  ४. लक्षित फिचर छान्नुहोस् (Target Feature):
                </label>
                {loadingBaseFeatures ? (
                  <div className="text-[11px] text-purple-700 py-1 flex items-center gap-1.5">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>फिचरहरू लोड हुँदैछ...</span>
                  </div>
                ) : (
                  <select
                    value={selectedTargetFeatureId}
                    onChange={(e) => setSelectedTargetFeatureId(e.target.value)}
                    className="w-full bg-white border border-purple-300 rounded-lg px-2.5 py-1.5 text-xs text-slate-800 outline-none focus:border-purple-700 cursor-pointer"
                    required
                  >
                    {baseLayerFeatures.length === 0 ? (
                      <option value="">यस तहमा फिचर उपलब्ध छैन</option>
                    ) : (
                      baseLayerFeatures.map((tf) => {
                        const tfId = tf.id || tf.properties?._id;
                        const tfProps = tf.properties || {};
                        const tfLabel =
                          tfProps[targetLinkAttribute] ||
                          tfProps.owner_name ||
                          tfProps.road_name ||
                          tfProps.bldg_code ||
                          tfProps.name ||
                          `Feature #${tfId}`;
                        return (
                          <option key={tfId} value={tfId}>
                            #{tfId} — {tfLabel} ({tf.geometry?.type || 'Geom'})
                          </option>
                        );
                      })
                    )}
                  </select>
                )}
              </div>

              {selectedTargetFeature && (
                <div className={`p-2 rounded-lg border text-[10px] font-mono ${
                  linkValuesMatch
                    ? 'bg-emerald-50 text-emerald-900 border-emerald-300'
                    : 'bg-amber-50 text-amber-900 border-amber-300'
                }`}>
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">यो: <strong>{String(sourceLinkValue ?? '—')}</strong></span>
                    <span className="shrink-0 font-nepali font-bold">{linkValuesMatch ? 'मिल्यो ✓' : 'मिलेन ✗'}</span>
                  </div>
                  <div className="truncate mt-0.5">लक्षित: <strong>{String(targetLinkValue ?? '—')}</strong></div>
                </div>
              )}

              {linkStatusMsg && (
                <div
                  className={`p-2 rounded-lg text-[11px] font-bold font-nepali ${linkStatusMsg.type === 'success'
                    ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                    : 'bg-red-100 text-red-800 border border-red-300'
                    }`}
                >
                  {linkStatusMsg.text}
                </div>
              )}

              <button
                type="submit"
                disabled={linkingBusy || !selectedTargetFeatureId || !linkValuesMatch}
                className="w-full py-1.5 px-3 rounded-lg bg-purple-700 hover:bg-purple-800 disabled:bg-slate-300 text-white text-xs font-bold font-nepali flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
              >
                {linkingBusy ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Link2 className="w-3.5 h-3.5" />
                )}
                <span>सम्बन्ध जोड्नुहोस् (Link Features)</span>
              </button>
            </form>
          </div>
        )}

        {/* Linked Features Section (Base Layer Relationships) */}
        {(loadingLinked || linkedFeatures.length > 0) && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5 text-[11px] font-bold text-purple-950 font-nepali">
                <Link2 className="w-3.5 h-3.5 text-purple-700" />
                <span>आधार तहमा जोडिएका फिचरहरू ({linkedFeatures.length})</span>
              </div>
              {!showAddLinkPanel && canEdit && (
                <button
                  type="button"
                  onClick={() => setShowAddLinkPanel(true)}
                  className="text-[10px] font-bold text-purple-700 hover:text-purple-950 font-nepali flex items-center gap-0.5 cursor-pointer"
                >
                  <Plus className="w-3 h-3" />
                  <span>फिचर जोड्नुहोस्</span>
                </button>
              )}
            </div>

            {linkStatusMsg && !showAddLinkPanel && (
              <div
                className={`p-2 rounded-lg text-[11px] font-bold font-nepali ${linkStatusMsg.type === 'success'
                  ? 'bg-emerald-100 text-emerald-900 border border-emerald-300'
                  : 'bg-red-100 text-red-800 border border-red-300'
                  }`}
              >
                {linkStatusMsg.text}
              </div>
            )}

            {loadingLinked ? (
              <div className="p-2.5 rounded-xl bg-purple-50/60 border border-purple-200 flex items-center gap-2 text-xs text-purple-800 font-nepali">
                <Loader2 className="w-3.5 h-3.5 animate-spin text-purple-700" />
                <span>सम्बन्धित फिचर खोजिँदैछ...</span>
              </div>
            ) : (
              <div className="space-y-1.5">
                {linkedFeatures.map((lf) => {
                  const lfProps = lf.properties || {};
                  const lfId = lf.feature_id || lf.id;
                  const lfTitle =
                    lfProps.owner_name ||
                    lfProps.road_name ||
                    lfProps.asset_name ||
                    lfProps.bldg_code ||
                    lfProps.parcel_no ||
                    lfProps.name ||
                    `Feature #${lfId}`;
                  const sourceAttr = lf.source_link_attribute || lf.link_attribute || lfProps.link_attribute;
                  const targetAttr = lf.target_link_attribute || lf.link_attribute || lfProps.link_attribute;
                  const sharedVal = lf.link_value ?? lf.source_link_value ?? lf.target_link_value ?? lfProps[sourceAttr] ?? lfProps.linked_feature_ref;

                  return (
                    <div
                      key={`${lf.link_id || lf.layer_id}-${lfId}`}
                      className="p-2.5 rounded-xl bg-gradient-to-r from-amber-50/90 via-purple-50/70 to-indigo-50/60 border border-amber-300/80 shadow-xs transition-all flex items-center justify-between gap-2"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1">
                          <span className="px-1.5 py-0.2 rounded bg-purple-200/80 text-purple-950 font-bold text-[9.5px] font-nepali truncate max-w-[130px]">
                            {lf.layer_name || layer?.name || 'Base Layer'}
                          </span>
                          <span className="px-1.5 py-0.2 rounded bg-indigo-100 text-indigo-900 font-mono font-bold text-[9px]">
                            {lf.geometry_type || 'Geom'}
                          </span>
                          <span className="px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 font-bold text-[9px] flex items-center gap-0.5">
                            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 animate-pulse" />
                            🔗 लिङ्क
                          </span>
                        </div>
                        <div className="text-xs font-bold text-slate-900 truncate mt-0.5 font-nepali">
                          {lfTitle}{' '}
                          <span className="text-[10px] font-mono text-purple-700 font-semibold">
                            (#{lfId})
                          </span>
                        </div>
                        {sourceAttr && (
                          <div className="text-[9.5px] text-amber-800 font-mono mt-0.5 truncate">
                            {sourceAttr === targetAttr || !targetAttr
                              ? `विशेषता (${sourceAttr})`
                              : `विशेषता (${sourceAttr} ↔ ${targetAttr})`}:{' '}
                            <span className="font-bold">{String(sharedVal || '-')}</span>
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {onSelectLinkedFeature && (
                          <button
                            type="button"
                            onClick={() => onSelectLinkedFeature(lf)}
                            className="px-2 py-1 rounded-lg bg-purple-700 hover:bg-purple-800 text-white text-[10px] font-bold font-nepali flex items-center gap-1 transition-colors cursor-pointer"
                            title="यस फिचरमा जानुहोस् (Inspect Linked Feature)"
                          >
                            <ExternalLink className="w-3 h-3" />
                            <span>हेर्नुहोस्</span>
                          </button>
                        )}
                        {canEdit && (
                          <button
                            type="button"
                            onClick={() => handleUnlinkFeature(lf.feature_id || lf.id, lf.link_id)}
                            className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors cursor-pointer"
                            title="सम्बन्ध हटाउनुहोस् (Unlink Feature)"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* Attribute Search Filter (when > 4 attributes) */}
        {Object.keys(rawProps).length > 5 && (
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={attrSearch}
              onChange={(e) => setAttrSearch(e.target.value)}
              placeholder="विशेषता खोज्नुहोस् (Filter attributes)..."
              className="w-full pl-8 pr-3 py-1.5 bg-slate-50 border border-slate-200 rounded-xl text-xs text-slate-800 outline-none focus:border-[#0447AF] focus:bg-white transition-colors"
            />
          </div>
        )}

        {/* Attributes Grid */}
        {displayEntries.length === 0 ? (
          <div className="text-center py-6 px-4 bg-slate-50 rounded-xl border border-dashed border-slate-200">
            <FileText className="w-7 h-7 text-slate-300 mx-auto mb-1.5" />
            <p className="text-xs font-bold text-slate-600 font-nepali">
              कुनै विशेषता विवरण फेला परेन
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-2">
            {displayEntries.map(([key, val]) => {
              const displayLabel = labelMap[key] || key.replace(/_/g, ' ');
              const valStr = typeof val === 'object' ? JSON.stringify(val) : String(val);
              const isLinkedField = key.startsWith('linked_') || key.endsWith('_link_id');

              return (
                <div
                  key={key}
                  className={`group px-3 py-2 rounded-xl border transition-all flex items-center justify-between gap-2 ${isLinkedField
                    ? 'bg-purple-50/50 border-purple-200'
                    : 'bg-slate-50/70 hover:bg-sky-50/50 border-slate-200/80 hover:border-sky-200'
                    }`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-[10px] font-bold text-slate-500 uppercase tracking-wider flex items-center gap-1">
                      <Tag className="w-2.5 h-2.5 text-[#0447AF] shrink-0" />
                      <span className="truncate font-nepali">{displayLabel}</span>
                      {labelMap[key] && labelMap[key] !== key && (
                        <span className="text-[9px] font-mono text-slate-400 lowercase">({key})</span>
                      )}
                    </div>
                    <div className="text-xs font-bold text-slate-900 break-words mt-0.5 font-nepali">
                      {valStr}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleCopy(key, valStr)}
                    className="opacity-70 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-[#0447AF] hover:bg-white rounded-lg transition-all shrink-0 cursor-pointer"
                    title="मान कपी गर्नुहोस् (Copy Value)"
                  >
                    {copiedKey === key ? (
                      <Check className="w-3.5 h-3.5 text-emerald-600" />
                    ) : (
                      <Copy className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              );
            })}
          </div>
        )}

        {/* Provenance & Audit Footer */}
        {(createdBy || updatedBy) && (
          <div className="p-2.5 rounded-xl bg-slate-100/80 border border-slate-200/80 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-600">
            <div className="flex items-center gap-1.5">
              <UserCheck className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              <span>
                सम्पादक: <strong className="text-slate-800">{updatedBy || createdBy}</strong>
              </span>
            </div>
            <div className="flex items-center gap-2 font-mono text-slate-500">
              <span>v{version}</span>
              {updatedAt && (
                <span>• {new Date(updatedAt).toLocaleDateString()}</span>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
