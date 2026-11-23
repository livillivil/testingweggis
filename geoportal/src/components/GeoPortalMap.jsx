'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import * as maplibregl from 'maplibre-gl';
import {
  ZoomIn, ZoomOut, Compass, Navigation, Loader2, Eye, EyeOff, PenTool, MapPin,
  ChevronUp, ChevronDown, Tag, X, Ruler
} from 'lucide-react';

// Configure self-hosted Web Worker before any Map instantiation
if (typeof window !== 'undefined') {
  maplibregl.setWorkerUrl('/geoportal/maplibre-gl-worker.mjs');
}

// 32 Municipal Wards Palette
const WARD_PALETTE = [
  '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6',
  '#ec4899', '#06b6d4', '#f97316', '#84cc16',
];

function wardBaseColor(wardNo) {
  const n = Number(wardNo) || 0;
  return WARD_PALETTE[(n - 1 + WARD_PALETTE.length) % WARD_PALETTE.length];
}

const LAYER_PALETTE = [
  '#0447AF', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899',
  '#06b6d4', '#84cc16', '#f97316', '#14b8a6', '#a855f7', '#0ea5e9',
];

export default function GeoPortalMap({
  catalog,
  activeLayerIds,
  layerOpacities = {},
  layerOutlines = {},
  onExtentChange,
  onFeatureClick,
  activeBasemap = 'osm',
  basemapOpacity = 100,
  zoomToLayerTrigger = null,
  isAdmin = false,
}) {
  const mapContainerRef = useRef(null);
  const mapInstance = useRef(null);
  const clickPopupRef = useRef(null);
  const wardMarkersRef = useRef([]);
  const catalogRef = useRef(catalog);
  useEffect(() => { catalogRef.current = catalog; }, [catalog]);

  const [mapLoaded, setMapLoaded] = useState(false);
  const [mapRotation, setMapRotation] = useState(0);
  const [locating, setLocating] = useState(false);

  // Dynamic callbacks and state references
  const onExtentChangeRef = useRef(onExtentChange);
  const onFeatureClickRef = useRef(onFeatureClick);
  useEffect(() => { onExtentChangeRef.current = onExtentChange; }, [onExtentChange]);
  useEffect(() => { onFeatureClickRef.current = onFeatureClick; }, [onFeatureClick]);

  // Municipal Ward Boundaries State
  const [wardOutlineOnly, setWardOutlineOnly] = useState(false);
  const [wardVisible, setWardVisible] = useState(true);
  const [wardCollapsed, setWardCollapsed] = useState(true);
  const [wardList, setWardList] = useState([]);
  const [hoveredWard, setHoveredWard] = useState(null);
  const [wardZoomSel, setWardZoomSel] = useState('');
  const [isolatedWard, setIsolatedWard] = useState(null);
  const [wardLabels, setWardLabels] = useState(true);
  const [showWardArea, setShowWardArea] = useState(() => {
    try {
      const v = localStorage.getItem('kmc_ward_show_area');
      return v === null ? true : v === '1';
    } catch (e) { return true; }
  });

  const wardDataRef = useRef(null);
  const wardOutlineOnlyRef = useRef(wardOutlineOnly);
  const hoveredWardRef = useRef(hoveredWard);
  const isolatedWardRef = useRef(isolatedWard);
  const wardLabelsRef = useRef(wardLabels);
  const showWardAreaRef = useRef(showWardArea);
  const wardVisibleRef = useRef(wardVisible);

  useEffect(() => { wardOutlineOnlyRef.current = wardOutlineOnly; }, [wardOutlineOnly]);
  useEffect(() => { hoveredWardRef.current = hoveredWard; }, [hoveredWard]);
  useEffect(() => { isolatedWardRef.current = isolatedWard; }, [isolatedWard]);
  useEffect(() => {
    wardLabelsRef.current = wardLabels;
    wardMarkersRef.current.forEach((m) => {
      const el = m.getElement();
      if (el) el.style.display = wardLabels && wardVisibleRef.current ? 'block' : 'none';
    });
  }, [wardLabels]);
  useEffect(() => {
    showWardAreaRef.current = showWardArea;
    try { localStorage.setItem('kmc_ward_show_area', showWardArea ? '1' : '0'); } catch (e) {}
  }, [showWardArea]);
  useEffect(() => {
    wardVisibleRef.current = wardVisible;
    wardMarkersRef.current.forEach((m) => {
      const el = m.getElement();
      if (el) el.style.display = wardVisible && wardLabelsRef.current ? 'block' : 'none';
    });
  }, [wardVisible]);

  // Track active layer sources and layers added to MapLibre
  const activeSourcesRef = useRef(new Set());
  const activeLayersRef = useRef(new Set());

  // =========================================================================
  // 1. SINGLE-MOUNT WEBGL CONTEXT INITIALIZATION
  // =========================================================================
  useEffect(() => {
    if (!mapContainerRef.current || mapInstance.current) return;

    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: {
        version: 8,
        sources: {
          'osm-tiles': {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            attribution: '&copy; OpenStreetMap Contributors',
          },
          'satellite-tiles': {
            type: 'raster',
            tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '&copy; Esri World Imagery',
          },
          'google-satellite': {
            type: 'raster',
            tiles: ['https://mt1.google.com/vt/lyrs=s&x={x}&y={y}&z={z}'],
            tileSize: 256,
            maxzoom: 20,
          },
          'google-roads': {
            type: 'raster',
            tiles: ['https://mt1.google.com/vt/lyrs=m&x={x}&y={y}&z={z}'],
            tileSize: 256,
            maxzoom: 20,
          },
          'dark-tiles': {
            type: 'raster',
            tiles: ['https://a.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 20,
          },
        },
        layers: [
          {
            id: 'basemap-osm',
            type: 'raster',
            source: 'osm-tiles',
            layout: { visibility: activeBasemap === 'osm' ? 'visible' : 'none' },
            paint: { 'raster-opacity': (basemapOpacity ?? 100) / 100 },
          },
          {
            id: 'basemap-esri',
            type: 'raster',
            source: 'satellite-tiles',
            layout: { visibility: activeBasemap === 'esri' ? 'visible' : 'none' },
            paint: { 'raster-opacity': (basemapOpacity ?? 100) / 100 },
          },
          {
            id: 'basemap-google',
            type: 'raster',
            source: 'google-satellite',
            layout: { visibility: activeBasemap === 'google' ? 'visible' : 'none' },
            paint: { 'raster-opacity': (basemapOpacity ?? 100) / 100 },
          },
          {
            id: 'basemap-road',
            type: 'raster',
            source: 'google-roads',
            layout: { visibility: activeBasemap === 'road' ? 'visible' : 'none' },
            paint: { 'raster-opacity': (basemapOpacity ?? 100) / 100 },
          },
          {
            id: 'basemap-dark',
            type: 'raster',
            source: 'dark-tiles',
            layout: { visibility: activeBasemap === 'dark' ? 'visible' : 'none' },
            paint: { 'raster-opacity': (basemapOpacity ?? 100) / 100 },
          },
        ],
      },
      center: [85.3240, 27.7172],
      zoom: 13,
      minZoom: 9,
      maxZoom: 22,
      transformRequest: (url) => {
        const isLocalApi = url.startsWith('/api/') || (url.startsWith('/tiles/') && !url.startsWith('//'));
        if (isLocalApi) {
          const token = typeof window !== 'undefined' ? localStorage.getItem('kmc_access_token') : null;
          return {
            url,
            headers: token ? { Authorization: `Bearer ${token}` } : {},
            credentials: 'same-origin',
          };
        }
        return { url };
      },
    });

    mapInstance.current = map;

    map.on('load', () => {
      // 1. Add Highlight source & layer for selected feature
      map.addSource('source-selected-highlight', {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      });
      map.addLayer({
        id: 'layer-selected-highlight-fill',
        type: 'fill',
        source: 'source-selected-highlight',
        paint: {
          'fill-color': '#f59e0b',
          'fill-opacity': 0.35,
        },
      });
      map.addLayer({
        id: 'layer-selected-highlight-line',
        type: 'line',
        source: 'source-selected-highlight',
        paint: {
          'line-color': '#f59e0b',
          'line-width': 4,
        },
      });

      // 2. Load 32 Municipal Ward boundaries GeoJSON
      fetch('/geoportal/wards.geojson')
        .then((res) => (res.ok ? res.json() : null))
        .then((fc) => {
          if (!fc || !map.getSource) return;
          wardDataRef.current = fc;
          const list = (fc.features || [])
            .map((f) => Number(f.properties?.ward_no))
            .filter((n) => Number.isFinite(n))
            .sort((a, b) => a - b);
          setWardList(list);

          map.addSource('source-wards', {
            type: 'geojson',
            data: fc,
          });

          // Build categorical match expressions for ward colors using clean numeric match
          const fillMatch = ['match', ['to-number', ['get', 'ward_no']]];
          const lineMatch = ['match', ['to-number', ['get', 'ward_no']]];
          for (let w = 1; w <= 32; w++) {
            const col = wardBaseColor(w);
            fillMatch.push(w, col);
            lineMatch.push(w, col);
          }
          fillMatch.push('#3b82f6');
          lineMatch.push('#1d4ed8');

          // Wards Fill Layer
          map.addLayer({
            id: 'layer-wards-fill',
            type: 'fill',
            source: 'source-wards',
            paint: {
              'fill-color': fillMatch,
              'fill-opacity': 0.18,
            },
          });

          // Wards Line Outline Layer
          map.addLayer({
            id: 'layer-wards-line',
            type: 'line',
            source: 'source-wards',
            paint: {
              'line-color': lineMatch,
              'line-width': 2.0,
            },
          });

          // Zero-external font dependency: DOM markers for ward labels
          (fc.features || []).forEach((feat) => {
            const wn = feat.properties?.ward_no;
            const coords = feat.geometry?.coordinates;
            if (!coords) return;
            let sumLng = 0, sumLat = 0, ptCount = 0;
            const flatten = (arr) => {
              if (Array.isArray(arr[0])) {
                arr.forEach(flatten);
              } else {
                sumLng += arr[0];
                sumLat += arr[1];
                ptCount++;
              }
            };
            flatten(coords);
            if (ptCount > 0) {
              const el = document.createElement('div');
              el.className = 'ward-label-marker px-1.5 py-0.5 rounded text-[10px] font-bold font-nepali bg-white/90 text-slate-800 border border-slate-300 shadow-sm pointer-events-none select-none';
              el.innerText = `वडा ${wn}`;
              const marker = new maplibregl.Marker({ element: el })
                .setLngLat([sumLng / ptCount, sumLat / ptCount])
                .addTo(map);
              wardMarkersRef.current.push(marker);
            }
          });
        })
        .catch((err) => console.warn('[GeoPortalMap] Wards loading note:', err));

      setMapLoaded(true);
    });

    // Compass / Rotation tracking
    map.on('rotate', () => {
      setMapRotation((map.getBearing() * Math.PI) / 180);
    });

    // Viewport bounds change -> live analytics
    let boundsTimer = null;
    map.on('moveend', () => {
      clearTimeout(boundsTimer);
      boundsTimer = setTimeout(() => {
        try {
          const b = map.getBounds();
          onExtentChangeRef.current?.([
            parseFloat(b.getWest().toFixed(6)),
            parseFloat(b.getSouth().toFixed(6)),
            parseFloat(b.getEast().toFixed(6)),
            parseFloat(b.getNorth().toFixed(6)),
          ]);
        } catch (_) {}
      }, 300);
    });

    // Map Click Feature Inspection
    map.on('click', async (e) => {
      const bbox = [
        [e.point.x - 6, e.point.y - 6],
        [e.point.x + 6, e.point.y + 6],
      ];
      const clickedFeatures = map.queryRenderedFeatures(bbox);
      if (!clickedFeatures || clickedFeatures.length === 0) {
        onFeatureClickRef.current?.(null);
        if (clickPopupRef.current) clickPopupRef.current.remove();
        const hlSource = map.getSource('source-selected-highlight');
        if (hlSource) hlSource.setData({ type: 'FeatureCollection', features: [] });
        return;
      }

      // Check if clicked feature belongs to a Vector MVT Layer
      const vectorFeat = clickedFeatures.find((f) =>
        f.layer.id.startsWith('fill-') || f.layer.id.startsWith('line-') || f.layer.id.startsWith('circle-')
      );

      if (vectorFeat) {
        const lid = vectorFeat.layer.id.replace('fill-', '').replace('line-', '').replace('circle-', '');
        const allL = [
          ...(catalogRef.current?.categories?.flatMap((c) => c.layers) || []),
          ...(catalogRef.current?.layers || []),
        ];
        const foundLayer = allL.find((l) => String(l.id) === String(lid) || l.name === lid);
        const lname = foundLayer?.name || 'Building Feature';
        const fUid = vectorFeat.properties?.feature_uid || vectorFeat.properties?.id || vectorFeat.id;

        // Visual highlight immediately
        const hlSource = map.getSource('source-selected-highlight');
        if (hlSource && vectorFeat.geometry) {
          hlSource.setData({
            type: 'FeatureCollection',
            features: [{
              type: 'Feature',
              geometry: vectorFeat.geometry,
              properties: {},
            }],
          });
        }

        // Fetch full role-filtered attributes from /api/features
        let props = { ...vectorFeat.properties };
        if (fUid) {
          try {
            const token = typeof window !== 'undefined' ? localStorage.getItem('kmc_access_token') : null;
            const res = await fetch(`/api/features?layerId=${lid}&featureUid=${fUid}`, {
              headers: token ? { Authorization: `Bearer ${token}` } : {},
              credentials: 'same-origin',
            });
            if (res.ok) {
              const fullFeat = await res.json();
              if (fullFeat && fullFeat.properties) {
                props = fullFeat.properties;
              }
            }
          } catch (_) {}
        }

        // Interactive MapLibre popup at the clicked location
        if (clickPopupRef.current) clickPopupRef.current.remove();
        const popupContent = `
          <div style="font-family: sans-serif; padding: 4px 6px; font-size: 12px; color: #0f172a; min-width: 150px;">
            <div style="font-weight: bold; border-bottom: 1px solid #e2e8f0; padding-bottom: 4px; margin-bottom: 6px; color: #0447af;">
              ${lname} ${fUid ? '#' + fUid : ''}
            </div>
            ${props.area ? `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>क्षेत्रफल:</span><b>${props.area} m²</b></div>` : ''}
            ${props.perimeter ? `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>परिधि:</span><b>${props.perimeter} m</b></div>` : ''}
            ${props.confidence ? `<div style="display:flex; justify-content:space-between; margin-bottom: 2px;"><span>विश्वसनीयता:</span><b>${(props.confidence * 100).toFixed(1)}%</b></div>` : ''}
            ${props.building_type ? `<div style="display:flex; justify-content:space-between;"><span>प्रकार:</span><b>${props.building_type}</b></div>` : ''}
          </div>
        `;
        clickPopupRef.current = new maplibregl.Popup({ closeButton: true, maxWidth: '300px', offset: 12 })
          .setLngLat(e.lngLat)
          .setHTML(popupContent)
          .addTo(map);

        onFeatureClickRef.current?.({
          properties: props,
          layerName: lname,
          layerId: lid,
        });
        return;
      }

      // Check if clicked feature belongs to Municipal Wards
      const wardFeat = clickedFeatures.find((f) => f.layer.id === 'layer-wards-fill' || f.layer.id === 'layer-wards-line');
      if (wardFeat) {
        if (wardOutlineOnlyRef.current && wardFeat.layer.id === 'layer-wards-fill') {
          onFeatureClickRef.current?.(null);
          return;
        }
        const props = { ...wardFeat.properties };
        if (!showWardAreaRef.current) {
          delete props.area_km2;
        }
        onFeatureClickRef.current?.({
          properties: props,
          layerName: 'वडा सीमा (Ward Boundary)',
          layerId: 'wards',
        });
        return;
      }

      onFeatureClickRef.current?.(null);
    });

    // Pointer cursor on hover
    map.on('mousemove', (e) => {
      const feats = map.queryRenderedFeatures(e.point);
      const isInteractive = feats.some((f) =>
        f.layer.id.startsWith('fill-') ||
        f.layer.id.startsWith('line-') ||
        f.layer.id.startsWith('circle-') ||
        f.layer.id.startsWith('layer-wards-')
      );
      map.getCanvas().style.cursor = isInteractive ? 'pointer' : '';

      // Ward hover highlight
      const wFeat = feats.find((f) => f.layer.id.startsWith('layer-wards-'));
      const wn = wFeat ? Number(wFeat.properties?.ward_no) : null;
      setHoveredWard(wn);
    });

    return () => {
      if (clickPopupRef.current) clickPopupRef.current.remove();
      wardMarkersRef.current.forEach((m) => m.remove());
      map.remove();
      mapInstance.current = null;
    };
  }, []);

  // =========================================================================
  // 2. BASEMAP SYNC
  // =========================================================================
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !mapLoaded) return;

    const basemaps = ['osm', 'esri', 'google', 'road', 'dark'];
    const op = Math.max(0, Math.min(1, (basemapOpacity ?? 100) / 100));

    basemaps.forEach((bKey) => {
      const layerId = `basemap-${bKey}`;
      if (map.getLayer(layerId)) {
        const isCurrent = bKey === activeBasemap && activeBasemap !== 'none';
        map.setLayoutProperty(layerId, 'visibility', isCurrent ? 'visible' : 'none');
        if (isCurrent) {
          map.setPaintProperty(layerId, 'raster-opacity', op);
        }
      }
    });
  }, [activeBasemap, basemapOpacity, mapLoaded]);

  // =========================================================================
  // 3. WARD DISPLAY & CONTROLS SYNC
  // =========================================================================
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !mapLoaded) return;

    const fillLayer = 'layer-wards-fill';
    const lineLayer = 'layer-wards-line';

    if (map.getLayer(fillLayer)) {
      map.setLayoutProperty(fillLayer, 'visibility', wardVisible && !wardOutlineOnly ? 'visible' : 'none');
    }
    if (map.getLayer(lineLayer)) {
      map.setLayoutProperty(lineLayer, 'visibility', wardVisible ? 'visible' : 'none');
    }

    // Single ward isolation filter
    const filter = isolatedWard ? ['==', ['to-number', ['get', 'ward_no']], Number(isolatedWard)] : null;
    if (map.getLayer(fillLayer)) map.setFilter(fillLayer, filter);
    if (map.getLayer(lineLayer)) map.setFilter(lineLayer, filter);

    // Filter markers
    wardMarkersRef.current.forEach((m) => {
      const el = m.getElement();
      if (!el) return;
      if (!wardVisible || !wardLabels) {
        el.style.display = 'none';
      } else if (isolatedWard) {
        el.style.display = el.innerText.includes(String(isolatedWard)) ? 'block' : 'none';
      } else {
        el.style.display = 'block';
      }
    });
  }, [wardVisible, wardOutlineOnly, wardLabels, isolatedWard, mapLoaded]);

  // Zoom to Ward
  const zoomToWard = useCallback((wardNo) => {
    const map = mapInstance.current;
    if (!map || !wardNo || !wardDataRef.current) return;
    const feat = (wardDataRef.current.features || []).find(
      (f) => String(f.properties?.ward_no) === String(wardNo)
    );
    if (!feat || !feat.geometry) return;

    let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
    const processCoord = (coord) => {
      if (Array.isArray(coord[0])) {
        coord.forEach(processCoord);
      } else {
        const [lng, lat] = coord;
        if (lng < minLng) minLng = lng;
        if (lat < minLat) minLat = lat;
        if (lng > maxLng) maxLng = lng;
        if (lat > maxLat) maxLat = lat;
      }
    };
    processCoord(feat.geometry.coordinates);

    if (Number.isFinite(minLng) && Number.isFinite(maxLng)) {
      map.fitBounds([[minLng, minLat], [maxLng, maxLat]], {
        padding: 80,
        duration: 800,
        maxZoom: 16,
      });
    }
  }, []);

  // Zoom to Layer Trigger
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !mapLoaded || !zoomToLayerTrigger?.bounds) return;
    const [w, s, e, n] = zoomToLayerTrigger.bounds;
    try {
      map.fitBounds([[w, s], [e, n]], {
        padding: 80,
        duration: 800,
        maxZoom: 19,
      });
    } catch (_) {}
  }, [zoomToLayerTrigger, mapLoaded]);

  // =========================================================================
  // 4. CARTOGRAPHIC DATA LAYERS SYNC (Bottom -> Top: MBTiles -> Vector MVT)
  // =========================================================================
  useEffect(() => {
    const map = mapInstance.current;
    if (!map || !mapLoaded || !catalog) return;

    const allLayers = [
      ...(catalog?.categories?.flatMap((c) => c.layers) || []),
      ...(catalog?.layers || []),
      ...(catalog?.rasters || []),
    ];

    const uniqueLayers = [];
    const seenIds = new Set();
    for (const l of allLayers) {
      if (!l || !l.id || seenIds.has(String(l.id))) continue;
      seenIds.add(String(l.id));
      uniqueLayers.push(l);
    }

    uniqueLayers.forEach((layer) => {
      const layerKey = `${layer.type}_${layer.id}`;
      const isActive = activeLayerIds.has(layerKey) || activeLayerIds.has(String(layer.id));
      const layerOpacity = layerOpacities[layerKey] !== undefined ? layerOpacities[layerKey] : (layerOpacities[String(layer.id)] ?? 1.0);
      const isOutlined = layerOutlines[layer.id] !== undefined ? layerOutlines[layer.id] : true;

      // --- A. RASTER MBTILES LAYERS ---
      if (layer.type === 'raster') {
        const sourceId = `source-raster-${layer.id}`;
        const layerId = `layer-raster-${layer.id}`;

        if (isActive) {
          if (!map.getSource(sourceId)) {
            const tileUrl = layer.tile_url || `/api/tiles/raster/${layer.id}/{z}/{x}/{y}.webp`;
            const bounds = Array.isArray(layer.bounds) && layer.bounds.length === 4
              ? layer.bounds
              : [85.2655, 27.6734, 85.3680, 27.7514];

            map.addSource(sourceId, {
              type: 'raster',
              tiles: [tileUrl],
              tileSize: 256,
              bounds,
              minzoom: layer.minzoom || 11,
              maxzoom: layer.maxzoom || 22,
            });
            activeSourcesRef.current.add(sourceId);

            const beforeLayer = map.getLayer('layer-wards-fill') ? 'layer-wards-fill' : undefined;
            map.addLayer({
              id: layerId,
              type: 'raster',
              source: sourceId,
              paint: { 'raster-opacity': layerOpacity },
            }, beforeLayer);
            activeLayersRef.current.add(layerId);
          } else {
            if (map.getLayer(layerId)) {
              map.setLayoutProperty(layerId, 'visibility', 'visible');
              map.setPaintProperty(layerId, 'raster-opacity', layerOpacity);
            }
          }
        } else {
          if (map.getLayer(layerId)) {
            map.setLayoutProperty(layerId, 'visibility', 'none');
          }
        }
      }

      // --- B. VECTOR MVT LAYERS (MVT Protobuf v2.1) ---
      if (layer.type === 'vector') {
        const sourceId = `source-vector-${layer.id}`;
        const fillId = `fill-${layer.id}`;
        const lineId = `line-${layer.id}`;
        const casingId = `casing-${layer.id}`;
        const circleId = `circle-${layer.id}`;

        if (isActive) {
          const geomType = (layer.geometry_type || 'POLYGON').toUpperCase();
          const isPolygon = geomType.includes('POLYGON') || geomType === 'MIX' || geomType === 'GEOMETRY';
          const isLine = geomType.includes('LINE');
          const isPoint = geomType.includes('POINT');

          const paletteColor = LAYER_PALETTE[Math.abs(Number(layer.id) || 0) % LAYER_PALETTE.length];
          const strokeColor = layer.style?.strokeColor || paletteColor;
          const fillColor = layer.style?.fillColor || paletteColor;

          if (!map.getSource(sourceId)) {
            const tileVersion = layer.tileVersion || layer.version || 1;
            const tileUrl = layer.tile_url || `/api/tiles/vector/${layer.id}/{z}/{x}/{y}.pbf?v=${tileVersion}`;

            map.addSource(sourceId, {
              type: 'vector',
              tiles: [tileUrl],
              maxzoom: 18,
            });
            activeSourcesRef.current.add(sourceId);

            const beforeLayer = map.getLayer('layer-wards-fill') ? 'layer-wards-fill' : undefined;
            const sourceLayerName = layer.name || 'layer';

            // Polygons: Fill + Line Outline
            if (isPolygon) {
              map.addLayer({
                id: fillId,
                type: 'fill',
                source: sourceId,
                'source-layer': sourceLayerName,
                paint: {
                  'fill-color': fillColor,
                  'fill-opacity': isOutlined ? 0.08 : 0.45 * layerOpacity,
                },
              }, beforeLayer);
              activeLayersRef.current.add(fillId);

              map.addLayer({
                id: lineId,
                type: 'line',
                source: sourceId,
                'source-layer': sourceLayerName,
                paint: {
                  'line-color': strokeColor,
                  'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2.2, 20, 3.5],
                  'line-opacity': layerOpacity,
                },
              }, beforeLayer);
              activeLayersRef.current.add(lineId);
            }

            // Lines: Dark Casing + Centerline
            if (isLine) {
              map.addLayer({
                id: casingId,
                type: 'line',
                source: sourceId,
                'source-layer': sourceLayerName,
                paint: {
                  'line-color': '#0f172a',
                  'line-width': ['interpolate', ['linear'], ['zoom'], 11, 2.5, 16, 5, 20, 8],
                  'line-opacity': layerOpacity,
                },
                layout: { 'line-cap': 'round', 'line-join': 'round' },
              }, beforeLayer);
              activeLayersRef.current.add(casingId);

              map.addLayer({
                id: lineId,
                type: 'line',
                source: sourceId,
                'source-layer': sourceLayerName,
                paint: {
                  'line-color': strokeColor,
                  'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1.2, 16, 3, 20, 5],
                  'line-opacity': layerOpacity,
                },
                layout: { 'line-cap': 'round', 'line-join': 'round' },
              }, beforeLayer);
              activeLayersRef.current.add(lineId);
            }

            // Points: Circle Markers
            if (isPoint) {
              map.addLayer({
                id: circleId,
                type: 'circle',
                source: sourceId,
                'source-layer': sourceLayerName,
                paint: {
                  'circle-radius': ['interpolate', ['linear'], ['zoom'], 11, 4, 16, 7, 20, 10],
                  'circle-color': fillColor,
                  'circle-stroke-color': '#ffffff',
                  'circle-stroke-width': 1.8,
                  'circle-opacity': layerOpacity,
                },
              }, beforeLayer);
              activeLayersRef.current.add(circleId);
            }
          } else {
            // Update live opacity and visibility
            if (map.getLayer(fillId)) {
              map.setLayoutProperty(fillId, 'visibility', 'visible');
              map.setPaintProperty(fillId, 'fill-opacity', isOutlined ? 0.08 : 0.45 * layerOpacity);
            }
            if (map.getLayer(lineId)) {
              map.setLayoutProperty(lineId, 'visibility', 'visible');
              map.setPaintProperty(lineId, 'line-opacity', layerOpacity);
            }
            if (map.getLayer(casingId)) {
              map.setLayoutProperty(casingId, 'visibility', 'visible');
              map.setPaintProperty(casingId, 'line-opacity', layerOpacity);
            }
            if (map.getLayer(circleId)) {
              map.setLayoutProperty(circleId, 'visibility', 'visible');
              map.setPaintProperty(circleId, 'circle-opacity', layerOpacity);
            }
          }
        } else {
          // Hide layers if not active
          if (map.getLayer(fillId)) map.setLayoutProperty(fillId, 'visibility', 'none');
          if (map.getLayer(lineId)) map.setLayoutProperty(lineId, 'visibility', 'none');
          if (map.getLayer(casingId)) map.setLayoutProperty(casingId, 'visibility', 'none');
          if (map.getLayer(circleId)) map.setLayoutProperty(circleId, 'visibility', 'none');
        }
      }
    });

    // --- C. DYNAMIC Z-ORDERING: The layer that is turned on last/recent is at the top ---
    const anchorLayer = map.getLayer('layer-wards-fill') ? 'layer-wards-fill' : undefined;
    const activeKeys = Array.from(activeLayerIds);
    activeKeys.forEach((key) => {
      const layer = uniqueLayers.find(
        (l) => `${l.type}_${l.id}` === key || String(l.id) === key
      );
      if (!layer) return;

      if (layer.type === 'raster') {
        const rasterId = `layer-raster-${layer.id}`;
        if (map.getLayer(rasterId)) {
          try {
            map.moveLayer(rasterId, anchorLayer);
          } catch (e) {}
        }
      } else if (layer.type === 'vector') {
        const fillId = `fill-${layer.id}`;
        const lineId = `line-${layer.id}`;
        const casingId = `casing-${layer.id}`;
        const circleId = `circle-${layer.id}`;

        if (map.getLayer(casingId)) {
          try { map.moveLayer(casingId, anchorLayer); } catch (e) {}
        }
        if (map.getLayer(fillId)) {
          try { map.moveLayer(fillId, anchorLayer); } catch (e) {}
        }
        if (map.getLayer(lineId)) {
          try { map.moveLayer(lineId, anchorLayer); } catch (e) {}
        }
        if (map.getLayer(circleId)) {
          try { map.moveLayer(circleId, anchorLayer); } catch (e) {}
        }
      }
    });
  }, [catalog, activeLayerIds, layerOpacities, layerOutlines, mapLoaded]);

  // =========================================================================
  // 5. NAVIGATION & CONTROLS HANDLERS
  // =========================================================================
  const handleZoomIn = () => {
    if (!mapInstance.current) return;
    mapInstance.current.zoomIn({ duration: 250 });
  };

  const handleZoomOut = () => {
    if (!mapInstance.current) return;
    mapInstance.current.zoomOut({ duration: 250 });
  };

  const handleZoomToMyLocation = () => {
    if (!mapInstance.current) return;
    if (typeof window === 'undefined' || !navigator.geolocation) {
      alert('यस ब्राउजरमा जीपीएस सुविधा उपलब्ध छैन (Geolocation is not supported by your browser)');
      return;
    }
    setLocating(true);
    const zoomTo = (lng, lat, zoom) => {
      try {
        mapInstance.current.flyTo({
          center: [lng, lat],
          zoom,
          duration: 700,
        });
      } catch (_) {}
    };

    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        zoomTo(pos.coords.longitude, pos.coords.latitude, 16);
      },
      () => {
        setLocating(false);
        alert('जीपीएस स्थान पत्ता लगाउन सकिएन। कृपया स्थान अनुमति दिनुहोस्। (Unable to retrieve GPS location.)');
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  };

  const handleResetToNorth = () => {
    if (!mapInstance.current) return;
    const map = mapInstance.current;
    if (Math.abs(map.getBearing()) > 1.0) {
      map.resetNorth({ duration: 400 });
    } else {
      map.flyTo({ center: [85.3240, 27.7172], zoom: 13, duration: 500 });
    }
  };

  return (
    <div className="w-full h-full relative overflow-hidden">
      {/* WebGL Map Container */}
      <div ref={mapContainerRef} className="w-full h-full" />

      {/* Floating Map Navigation Controls — Top Left */}
      <div className="absolute top-4 left-4 z-20 flex flex-col gap-1.5 shadow-lg rounded-xl overflow-hidden bg-white/95 backdrop-blur-md border border-slate-200 p-1">
        <button
          onClick={handleZoomIn}
          className="p-2 hover:bg-slate-100 text-slate-700 rounded-lg transition-colors"
          title="जुम इन (Zoom In)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button
          onClick={handleZoomOut}
          className="p-2 hover:bg-slate-100 text-slate-700 rounded-lg transition-colors"
          title="जुम आउट (Zoom Out)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
        <button
          onClick={handleZoomToMyLocation}
          disabled={locating}
          className="p-2 hover:bg-gov-blue-50 text-gov-blue-800 rounded-lg transition-colors group"
          title="मेरो हालको स्थानमा जुम गर्नुहोस् (Zoom to My Location)"
        >
          {locating ? (
            <Loader2 className="w-4 h-4 animate-spin text-gov-blue-800" />
          ) : (
            <Navigation className="w-4 h-4 group-hover:scale-110 transition-transform" />
          )}
        </button>
        <button
          onClick={handleResetToNorth}
          className="p-2 hover:bg-gov-blue-50 text-gov-blue-800 rounded-lg transition-colors group"
          title="उत्तर दिशा रिसेट / काठमाडौँ केन्द्र (Reset to North & Center Kathmandu)"
        >
          <Compass
            className="w-4 h-4 group-hover:scale-110 transition-transform"
            style={{ transform: `rotate(${-mapRotation}rad)` }}
          />
        </button>
      </div>

      {/* Municipal Ward Boundaries control — Bottom Right */}
      <div className="absolute bottom-4 sm:bottom-6 right-4 z-20 w-44 sm:w-52 shadow-xl rounded-xl overflow-hidden bg-white/95 backdrop-blur-md border border-slate-200">
        <div className="flex items-center justify-between px-3 py-2 bg-gov-blue-900 text-white">
          <span className="flex items-center gap-1.5 text-[11px] font-bold font-nepali">
            <MapPin className="w-3.5 h-3.5 text-gov-gold-400" />
            वडा सीमाना
          </span>
          <div className="flex items-center gap-0.5">
            <button
              onClick={() => setWardVisible((v) => !v)}
              className="p-1 hover:bg-white/15 rounded transition-colors"
              title={wardVisible ? 'वडा सीमा लुकाउनुहोस् (Hide from map)' : 'वडा सीमा देखाउनुहोस् (Show on map)'}
            >
              {wardVisible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
            </button>
            <button
              onClick={() => setWardCollapsed((v) => !v)}
              className="p-1 hover:bg-white/15 rounded transition-colors"
              title={wardCollapsed ? 'डायलग खोल्नुहोस् (Expand)' : 'डायलग सङ्कुचित गर्नुहोस् (Collapse)'}
            >
              {wardCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
        {!wardCollapsed && (
          <div className="p-2.5 flex flex-col gap-2">
            <button
              onClick={() => setWardOutlineOnly((v) => !v)}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-bold font-nepali border transition-colors ${
                wardOutlineOnly
                  ? 'bg-gov-blue-800 text-white border-gov-blue-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
              title="वडा सीमाको बाहिरी रेखा मात्र देखाउनुहोस् (Outline only)"
            >
              <PenTool className="w-3.5 h-3.5" />
              {wardOutlineOnly ? 'रंग भर्नुहोस् (Fill)' : 'रेखा मात्र (Outline)'}
            </button>
            <button
              onClick={() => setWardLabels((v) => !v)}
              className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-bold font-nepali border transition-colors ${
                wardLabels
                  ? 'bg-gov-blue-800 text-white border-gov-blue-900'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
              title="वडा नम्बर लेबल देखाउने / लुकाउने (Toggle ward labels)"
            >
              <Tag className="w-3.5 h-3.5" />
              {wardLabels ? 'लेबल लुकाउनुहोस्' : 'लेबल देखाउनुहोस्'}
            </button>
            {isAdmin && (
              <button
                onClick={() => setShowWardArea((v) => !v)}
                className={`flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-bold font-nepali border transition-colors ${
                  showWardArea
                    ? 'bg-emerald-700 text-white border-emerald-800'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
                title="वडामा क्लिक गर्दा क्षेत्रफल देखाउने / लुकाउने (Admin: show area in ward info)"
              >
                <Ruler className="w-3.5 h-3.5" />
                {showWardArea ? 'क्षेत्रफल: देखाइँदै' : 'क्षेत्रफल: लुकाइएको'}
              </button>
            )}
            <label className="text-[10px] font-bold text-slate-500 font-nepali">
              वडामा जुम गर्नुहोस्
              <select
                value={wardZoomSel}
                onChange={(e) => {
                  const v = e.target.value;
                  setWardZoomSel(v);
                  setIsolatedWard(v || null);
                  if (v) zoomToWard(v);
                }}
                className="mt-1 w-full text-[11px] font-sans border border-slate-300 rounded-lg px-2 py-1.5 bg-white text-slate-800 focus:outline-none focus:ring-2 focus:ring-gov-blue-500"
              >
                <option value="">वडा छान्नुहोस्…</option>
                {wardList.map((wn) => (
                  <option key={wn} value={wn}>
                    वडा नं. {wn} (Ward {wn})
                  </option>
                ))}
              </select>
            </label>
            {isolatedWard != null && isolatedWard !== '' && (
              <button
                onClick={() => {
                  setIsolatedWard(null);
                  setWardZoomSel('');
                }}
                className="flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[11px] font-bold font-nepali border bg-white text-slate-700 border-slate-300 hover:bg-slate-50 transition-colors"
                title="सबै वडाको सीमा फेरि देखाउनुहोस् (Show all ward boundaries)"
              >
                <X className="w-3.5 h-3.5" />
                सबै वडा देखाउनुहोस्
              </button>
            )}
            {hoveredWard != null && (
              <div className="text-[11px] font-bold text-gov-blue-900 font-nepali bg-gov-blue-50 border border-gov-blue-200 rounded-lg px-2 py-1 text-center">
                वडा नं. {hoveredWard}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
