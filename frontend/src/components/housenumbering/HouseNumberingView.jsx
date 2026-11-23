'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Home, Compass, ZoomIn, ZoomOut, Search, Play,
  CheckCircle2, AlertTriangle, Download, Plus, Trash2,
  Edit2, Save, X, ChevronLeft, ChevronRight, Layers,
  Route, Check, Sparkles
} from 'lucide-react';
import { houseNumberingAPI, layersAPI, triggerFileDownload } from '../../lib/api';
import { buildHouseNumberBadgeDataUrl } from '../../lib/houseNumberBadge';

export default function HouseNumberingView({ user, isAdmin = false }) {
  const mapRef = useRef(null);
  const mapInstance = useRef(null);
  const numbersLayerRef = useRef(null);
  const numbersSourceRef = useRef(null);

  const [olLoaded, setOlLoaded] = useState(false);
  const [olModules, setOlModules] = useState(null);

  // Centralized Layers
  const [availableLayers, setAvailableLayers] = useState([]);
  const [roadLayerId, setRoadLayerId] = useState('');
  const [buildingLayerId, setBuildingLayerId] = useState('');
  const [roadFeatures, setRoadFeatures] = useState([]);
  const [selectedRoadId, setSelectedRoadId] = useState('');

  // Numbering Generator Settings
  const [numberingScheme, setNumberingScheme] = useState('METRIC'); // METRIC | SEQUENTIAL
  const [intervalM, setIntervalM] = useState(5.0);
  const [startNumber, setStartNumber] = useState(1);
  const [labelVisibilityMode, setLabelVisibilityMode] = useState('all'); // 'all' | 'individual'
  const labelVisibilityModeRef = useRef('all');
  const inspectedIdRef = useRef(null);
  const [prefix, setPrefix] = useState('W10-');
  const [ward, setWard] = useState('10');
  const [generating, setGenerating] = useState(false);
  const [generatedPreview, setGeneratedPreview] = useState(null);

  // Address Registry & Stats
  const [stats, setStats] = useState(null);
  const [numbersList, setNumbersList] = useState([]);
  const [registrySearch, setRegistrySearch] = useState('');
  const [loadingRegistry, setLoadingRegistry] = useState(false);
  const [activeTab, setActiveTab] = useState('generator'); // generator | registry

  // Collapsible Panels
  const [toolsCollapsed, setToolsCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);
  const [registryCollapsed, setRegistryCollapsed] = useState(() => typeof window !== 'undefined' && window.innerWidth < 768);

  // Selected Number for Inspection / Edit
  const [inspectedNumber, setInspectedNumber] = useState(null);
  const [editStatus, setEditStatus] = useState('ASSIGNED');
  const [statusNotice, setStatusNotice] = useState(null);

  const showNotice = useCallback((text, type = 'success') => {
    setStatusNotice({ text, type });
    setTimeout(() => setStatusNotice(null), 3500);
  }, []);

  // Dynamic OpenLayers Import (SSR-safe)
  useEffect(() => {
    let isMounted = true;
    const loadOpenLayers = async () => {
      try {
        const [
          { default: Map },
          { default: View },
          { default: TileLayer },
          { default: VectorLayer },
          { default: OSM },
          { default: XYZ },
          { default: VectorSource },
          { default: GeoJSON },
          { default: Style },
          { default: Icon },
          { default: CircleStyle },
          { default: Fill },
          { default: Stroke },
          { fromLonLat, toLonLat },
        ] = await Promise.all([
          import('ol/Map'),
          import('ol/View'),
          import('ol/layer/Tile'),
          import('ol/layer/Vector'),
          import('ol/source/OSM'),
          import('ol/source/XYZ'),
          import('ol/source/Vector'),
          import('ol/format/GeoJSON'),
          import('ol/style/Style'),
          import('ol/style/Icon'),
          import('ol/style/Circle'),
          import('ol/style/Fill'),
          import('ol/style/Stroke'),
          import('ol/proj'),
        ]);

        if (isMounted) {
          setOlModules({
            Map, View, TileLayer, VectorLayer, OSM, XYZ, VectorSource,
            GeoJSON, Style, Icon, CircleStyle, Fill, Stroke,
            fromLonLat, toLonLat,
          });
          setOlLoaded(true);
        }
      } catch (err) {
        console.error('Error loading OpenLayers in HouseNumbering:', err);
      }
    };
    loadOpenLayers();
    return () => { isMounted = false; };
  }, []);

  // Fetch Centralized Layers
  const loadLayers = useCallback(async () => {
    try {
      const res = await layersAPI.list();
      const layers = res.data || [];
      setAvailableLayers(layers);

      // Auto-pick candidate road and building layers
      const candidateRoad = layers.find(
        (l) => l.name.toLowerCase().includes('road') || l.name.toLowerCase().includes('street') || String(l.geometry_type).toUpperCase().includes('LINE')
      );
      const candidateBldg = layers.find(
        (l) => l.name.toLowerCase().includes('building') || l.name.toLowerCase().includes('ghar') || String(l.geometry_type).toUpperCase().includes('POLY')
      );

      if (candidateRoad) setRoadLayerId(String(candidateRoad.id));
      if (candidateBldg) setBuildingLayerId(String(candidateBldg.id));
    } catch (e) {
      console.error('Failed to load layers for house numbering:', e);
    }
  }, []);

  useEffect(() => {
    loadLayers();
  }, [loadLayers]);

  // Load Road Features when road layer is selected
  useEffect(() => {
    if (!roadLayerId) {
      setRoadFeatures([]);
      return;
    }
    const loadRoads = async () => {
      try {
        const res = await layersAPI.getFeatures(roadLayerId);
        const feats = res.data?.features || [];
        setRoadFeatures(feats);
        if (feats.length > 0) {
          setSelectedRoadId(String(feats[0].id));
        }
      } catch (e) {
        console.error('Failed to load road features:', e);
      }
    };
    loadRoads();
  }, [roadLayerId]);

  // Fetch Stats and Numbers
  const refreshRegistry = useCallback(async () => {
    setLoadingRegistry(true);
    try {
      const [sRes, nRes] = await Promise.all([
        houseNumberingAPI.getStats(),
        houseNumberingAPI.listNumbers({ search: registrySearch }),
      ]);
      setStats(sRes.data);
      const featArray = nRes.data?.features || (Array.isArray(nRes.data) ? nRes.data : []);
      setNumbersList(featArray);

      // Update map features
      if (numbersSourceRef.current && olModules) {
        const { GeoJSON } = olModules;
        numbersSourceRef.current.clear();
        const collection = nRes.data?.type === 'FeatureCollection'
          ? nRes.data
          : { type: 'FeatureCollection', features: featArray };
        if (collection.features?.length > 0) {
          const parsed = new GeoJSON().readFeatures(collection, {
            featureProjection: 'EPSG:3857',
            dataProjection: 'EPSG:4326',
          });
          numbersSourceRef.current.addFeatures(parsed);
        }
      }
    } catch (e) {
      console.error('Failed to load house numbering data:', e);
    } finally {
      setLoadingRegistry(false);
    }
  }, [registrySearch, olModules]);

  useEffect(() => {
    if (olLoaded) {
      refreshRegistry();
    }
  }, [olLoaded, refreshRegistry]);

  // Initialize Map
  useEffect(() => {
    if (!olLoaded || !olModules || !mapRef.current || mapInstance.current) return;

    const {
      Map, View, TileLayer, VectorLayer, XYZ, VectorSource,
      Style, Icon, CircleStyle, Fill, Stroke, fromLonLat
    } = olModules;

    const ktmCenter = fromLonLat([85.3325, 27.6895]);

    const baseTile = new TileLayer({
      source: new XYZ({
        url: 'https://mt1.google.com/vt/lyrs=y&x={x}&y={y}&z={z}',
        maxZoom: 30,
      }),
    });

    const houseNumbersSource = new VectorSource();
    numbersSourceRef.current = houseNumbersSource;

    const houseNumbersLayer = new VectorLayer({
      source: houseNumbersSource,
      declutter: true,
      style: (feature, resolution) => {
        const props = feature.getProperties();
        const featId = feature.getId() ?? props.id;
        const isLeft = String(props.side || '').toUpperCase().includes('LEFT') || String(props.side || '').toUpperCase().includes('ODD');
        const color = isLeft ? '#2563EB' : '#059669'; // Blue for Left/Odd, Emerald for Right/Even
        const isSelected = inspectedIdRef.current != null && String(featId) === String(inspectedIdRef.current);
        const mode = labelVisibilityModeRef.current;
        const showBadge = mode === 'individual' ? isSelected : (resolution < 2.5 || isSelected);

        if (!showBadge) {
          return new Style({
            image: new CircleStyle({
              radius: isSelected ? 6 : 4,
              fill: new Fill({ color }),
              stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
            }),
          });
        }

        const houseNum = String(props.house_number || props.metric_house_no || '');
        const badgeUrl = buildHouseNumberBadgeDataUrl(houseNum, color);
        if (!badgeUrl) return new Style({});

        return new Style({
          image: new Icon({
            src: badgeUrl,
            anchor: [0.5, 1],
            anchorXUnits: 'fraction',
            anchorYUnits: 'fraction',
            scale: isSelected ? 1.15 : 1,
          }),
          zIndex: isSelected ? 30 : 20,
        });
      },
      zIndex: 20,
    });
    numbersLayerRef.current = houseNumbersLayer;

    const map = new Map({
      target: mapRef.current,
      layers: [baseTile, houseNumbersLayer],
      view: new View({
        center: ktmCenter,
        zoom: 16,
        maxZoom: 30,
      }),
      controls: [],
    });

    map.on('singleclick', (evt) => {
      const feat = map.forEachFeatureAtPixel(evt.pixel, (f) => f);
      if (feat) {
        const p = feat.getProperties();
        setInspectedNumber({ ...p, id: feat.getId() ?? p.id });
        setEditStatus(p.status || 'ASSIGNED');
      } else {
        setInspectedNumber(null);
      }
    });

    mapInstance.current = map;

    return () => {
      map.setTarget(null);
      mapInstance.current = null;
    };
  }, [olLoaded, olModules]);

  // Keep declutter/label mode refs in sync and refresh houseNumbersLayer
  useEffect(() => {
    labelVisibilityModeRef.current = labelVisibilityMode;
    inspectedIdRef.current = inspectedNumber?.id ?? null;
    if (numbersLayerRef.current) {
      numbersLayerRef.current.changed();
    }
  }, [labelVisibilityMode, inspectedNumber]);

  // Handle Generate Numbers (Preview or Save)
  const handleGenerate = async (save = false) => {
    if (!roadLayerId || !selectedRoadId || !buildingLayerId) {
      showNotice('कृपया सडक तह, लक्षित सडक, र भवन तह छान्नुहोस्', 'error');
      return;
    }
    setGenerating(true);
    try {
      const selectedRoad = roadFeatures.find((r) => String(r.id) === String(selectedRoadId));
      const roadName = selectedRoad?.properties?.name || selectedRoad?.properties?.road_name || `Road-${selectedRoadId}`;

      const res = await houseNumberingAPI.generateNumbers({
        road_layer_id: parseInt(roadLayerId, 10),
        road_feature_id: parseInt(selectedRoadId, 10),
        building_layer_id: parseInt(buildingLayerId, 10),
        road_name: roadName,
        ward,
        numbering_scheme: numberingScheme,
        interval_m: parseFloat(intervalM),
        start_number: parseInt(startNumber, 10),
        parity: 'ODD_LEFT_EVEN_RIGHT',
        prefix,
        max_distance_from_road_m: 60.0,
        save_to_database: save,
      });

      setGeneratedPreview(res.data);
      if (save) {
        await refreshRegistry();
        showNotice(`${res.data?.saved_count || res.data?.proposals?.length || 0} घर नम्बरहरू डेटाबेसमा सुरक्षित गरियो!`, 'success');
      } else {
        showNotice(`${res.data?.proposals?.length || 0} प्रस्तावित घर नम्बरहरूको पूर्वावलोकन तयार भयो`, 'success');
      }
    } catch (e) {
      showNotice(e.response?.data?.detail || 'घर नम्बर उत्पादन गर्न सकिएन', 'error');
    } finally {
      setGenerating(false);
    }
  };

  // Export Registry
  const handleExport = async (format) => {
    try {
      const res = await houseNumberingAPI.exportRegistry(format, { ward: ward || '' });
      const ext = format === 'csv' ? 'csv' : 'geojson';
      const payload = typeof res.data === 'string' || res.data instanceof Blob
        ? res
        : { ...res, data: JSON.stringify(res.data, null, 2) };
      triggerFileDownload(payload, `kmc_house_numbers_ward_${ward || 'all'}.${ext}`);
    } catch (err) {
      console.error('Export failed:', err);
    }
  };

  return (
    <div className="relative w-full h-full flex overflow-hidden select-none bg-slate-900" id="house-numbering-container">
      {/* Status Toast Banner */}
      {statusNotice && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-xl shadow-xl border text-xs font-bold font-nepali flex items-center gap-2 bg-slate-900/95 text-white border-slate-700">
          {statusNotice.type === 'error' ? (
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          ) : (
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          )}
          <span>{statusNotice.text}</span>
        </div>
      )}

      {/* 1. Map Canvas */}
      <div ref={mapRef} className="absolute inset-0 w-full h-full z-0" tabIndex={0} />

      {/* 2. Top-Left Floating Numbering Generator Tools */}
      <div className="absolute top-3 left-3 z-30">
        <div
          className={`bg-white/95 backdrop-blur-md border border-slate-200 shadow-xl rounded-xl transition-all duration-300 flex flex-col max-h-[calc(100vh-130px)] ${
            toolsCollapsed ? 'w-12 overflow-hidden' : 'w-80 sm:w-96'
          }`}
        >
          {/* Header */}
          <div className="p-3 bg-gradient-to-r from-gov-blue-900 to-indigo-950 text-white flex items-center justify-between border-b border-slate-800 rounded-t-xl select-none">
            <div className="flex items-center gap-2 min-w-0">
              <div className="w-7 h-7 rounded-lg bg-indigo-600 flex items-center justify-center text-white shrink-0 shadow-sm">
                <Home className="w-4 h-4" />
              </div>
              {!toolsCollapsed && (
                <div className="truncate">
                  <h2 className="text-xs font-bold font-nepali text-white truncate">
                    घर नम्बर प्रणाली (House Numbering)
                  </h2>
                  <span className="text-[10px] text-gov-gold-400 font-semibold font-mono">
                    चेनिएज तथा बिजोर/जोर साइड इन्जिन
                  </span>
                </div>
              )}
            </div>

            <button type="button"
              onClick={() => setToolsCollapsed(!toolsCollapsed)}
              className="p-1 rounded-md hover:bg-slate-800 text-slate-300 transition-colors"
            >
              {toolsCollapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
            </button>
          </div>

          {!toolsCollapsed && (
            <div className="p-3.5 overflow-y-auto flex-1 space-y-3.5 text-xs text-slate-700 scrollbar-thin">
              {/* Layer Selection */}
              <div className="space-y-2 p-2.5 bg-slate-50 border border-slate-200 rounded-lg">
                <div className="font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                  <Route className="w-3.5 h-3.5 text-gov-blue-800" />
                  केन्द्रिय GIS तहहरू (Centralized Layers):
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 font-medium font-nepali mb-0.5">
                    सडक तह (Road Layer):
                  </label>
                  <select
                    value={roadLayerId}
                    onChange={(e) => setRoadLayerId(e.target.value)}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs bg-white"
                  >
                    <option value="">सडक तह छान्नुहोस्...</option>
                    {availableLayers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.geometry_type})
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 font-medium font-nepali mb-0.5">
                    लक्षित सडक (Target Road):
                  </label>
                  <select
                    value={selectedRoadId}
                    onChange={(e) => setSelectedRoadId(e.target.value)}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs bg-white"
                    disabled={roadFeatures.length === 0}
                  >
                    {roadFeatures.map((rf) => (
                      <option key={rf.id} value={rf.id}>
                        {rf.properties?.name || rf.properties?.road_name || `Road Feature #${rf.id}`}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-[11px] text-slate-500 font-medium font-nepali mb-0.5">
                    भवन/प्रवेशद्वार तह (Building Layer):
                  </label>
                  <select
                    value={buildingLayerId}
                    onChange={(e) => setBuildingLayerId(e.target.value)}
                    className="w-full p-1.5 border border-slate-300 rounded text-xs bg-white"
                  >
                    <option value="">भवन तह छान्नुहोस्...</option>
                    {availableLayers.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.name} ({l.geometry_type})
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Numbering Scheme Parameters */}
              <div className="space-y-2.5 p-2.5 bg-white border border-slate-200 rounded-lg">
                <div className="font-bold text-slate-800 font-nepali">
                  नम्बरिङ ढाँचा तथा मापदण्ड (Scheme Settings):
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <label
                    onClick={() => setNumberingScheme('METRIC')}
                    className={`p-2 rounded-lg border text-center cursor-pointer transition-colors ${
                      numberingScheme === 'METRIC'
                        ? 'bg-gov-blue-50 border-gov-blue-800 text-gov-blue-800 font-bold'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <div className="font-nepali">मेट्रिक चेनिएज</div>
                    <div className="text-[10px] text-slate-400 font-mono">Distance Based</div>
                  </label>
                  <label
                    onClick={() => setNumberingScheme('SEQUENTIAL')}
                    className={`p-2 rounded-lg border text-center cursor-pointer transition-colors ${
                      numberingScheme === 'SEQUENTIAL'
                        ? 'bg-gov-blue-50 border-gov-blue-800 text-gov-blue-800 font-bold'
                        : 'border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <div className="font-nepali">क्रमिक बिजोर/जोर</div>
                    <div className="text-[10px] text-slate-400 font-mono">Sequential Parity</div>
                  </label>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500 font-nepali mb-0.5">
                      अन्तर (Interval):
                    </label>
                    <input
                      type="number"
                      step="0.5"
                      value={intervalM}
                      onChange={(e) => setIntervalM(e.target.value)}
                      className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 font-nepali mb-0.5">
                      वडा नम्बर (Ward):
                    </label>
                    <input
                      type="text"
                      value={ward}
                      onChange={(e) => setWard(e.target.value)}
                      className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] text-slate-500 font-nepali mb-0.5">
                      प्रारम्भिक नम्बर (Start No.):
                    </label>
                    <input
                      type="number"
                      min="1"
                      step="1"
                      value={startNumber}
                      onChange={(e) => setStartNumber(Math.max(1, parseInt(e.target.value, 10) || 1))}
                      className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] text-slate-500 font-nepali mb-0.5">
                      प्रिफिक्स (Prefix, e.g. W4-):
                    </label>
                    <input
                      type="text"
                      value={prefix}
                      onChange={(e) => setPrefix(e.target.value)}
                      placeholder="W4-"
                      className="w-full p-1.5 border border-slate-300 rounded text-xs font-mono"
                    />
                  </div>
                </div>

                {/* Label Visibility Mode Toggle (All at Zoom vs Individual Selected) */}
                <div className="flex items-center justify-between gap-2 pt-1">
                  <span className="text-[10px] text-slate-600 font-nepali font-semibold">लेबल दृश्यता (Labels):</span>
                  <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-[10px] font-nepali">
                    <button
                      type="button"
                      onClick={() => setLabelVisibilityMode('all')}
                      className={`px-2 py-0.5 rounded transition-colors ${
                        labelVisibilityMode === 'all' ? 'bg-gov-blue-800 text-white font-bold' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      सबै (All)
                    </button>
                    <button
                      type="button"
                      onClick={() => setLabelVisibilityMode('individual')}
                      className={`px-2 py-0.5 rounded transition-colors ${
                        labelVisibilityMode === 'individual' ? 'bg-gov-blue-800 text-white font-bold' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      छानिएको मात्र (Selected)
                    </button>
                  </div>
                </div>
              </div>

              {/* Action Buttons */}
              <div className="flex items-center gap-2">
                <button type="button"
                  onClick={() => handleGenerate(false)}
                  disabled={generating}
                  className="flex-1 py-2 px-3 rounded-lg border border-gov-blue-800 text-gov-blue-800 hover:bg-gov-blue-50 font-bold font-nepali transition-colors flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-50"
                >
                  <Play className="w-3.5 h-3.5" />
                  पूर्वावलोकन (Preview)
                </button>
                <button type="button"
                  onClick={() => handleGenerate(true)}
                  disabled={generating}
                  className="flex-1 py-2 px-3 rounded-lg bg-gov-blue-800 hover:bg-gov-blue-900 text-white font-bold font-nepali transition-colors flex items-center justify-center gap-1.5 shadow-md disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  सुरक्षित (Save)
                </button>
              </div>

              {/* Proposal Preview Table */}
              {generatedPreview && (
                <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                  <div className="flex items-center justify-between text-xs font-bold text-slate-800 font-nepali">
                    <span>उत्पादित घर नम्बरहरू ({generatedPreview.total_buildings_detected})</span>
                    <span className="text-[10px] text-slate-500 font-mono">
                      L: {generatedPreview.left_side_count} | R: {generatedPreview.right_side_count}
                    </span>
                  </div>

                  <div className="max-h-44 overflow-y-auto border border-slate-200 rounded bg-white">
                    <table className="w-full text-left text-[11px] font-mono">
                      <thead className="bg-slate-100 text-slate-500 text-[10px] sticky top-0">
                        <tr>
                          <th className="p-1.5">घर नं</th>
                          <th className="p-1.5">चेनिएज</th>
                          <th className="p-1.5">दिशा</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {(generatedPreview.proposals || []).map((p, idx) => (
                          <tr key={idx} className="hover:bg-slate-50">
                            <td className="p-1.5 font-bold text-slate-900">{p.house_number}</td>
                            <td className="p-1.5 text-slate-600">{p.chainage_m}m</td>
                            <td className="p-1.5">
                              <span
                                className={`px-1 rounded text-[9px] font-bold ${
                                  p.side === 'LEFT'
                                    ? 'bg-blue-100 text-blue-800'
                                    : 'bg-emerald-100 text-emerald-800'
                                }`}
                              >
                                {p.side}
                              </span>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* 3. Top-Right Floating Address Registry & KPI Panel */}
      <div className="absolute top-3 right-3 z-30">
        <div
          className={`bg-white/95 backdrop-blur-md border border-slate-200 shadow-xl rounded-xl transition-all duration-300 flex flex-col max-h-[calc(100vh-130px)] ${
            registryCollapsed ? 'w-12 overflow-hidden' : 'w-80 sm:w-96'
          }`}
        >
          {/* Header */}
          <div className="p-3 bg-slate-900 text-white flex items-center justify-between border-b border-slate-800 rounded-t-xl select-none">
            <button type="button"
              onClick={() => setRegistryCollapsed(!registryCollapsed)}
              className="p-1 rounded-md hover:bg-slate-800 text-slate-300 transition-colors"
            >
              {registryCollapsed ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            </button>

            {!registryCollapsed && (
              <div className="flex items-center gap-2 min-w-0 flex-1 ml-1">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <div className="truncate">
                  <h2 className="text-xs font-bold font-nepali text-white truncate">
                    ठेगाना सूची तथा तथ्याङ्क (Address Registry)
                  </h2>
                  <span className="text-[10px] text-gov-gold-400 font-mono">
                    {stats?.total_house_numbers || 0} घर नम्बर दर्ता
                  </span>
                </div>
              </div>
            )}
          </div>

          {!registryCollapsed && (
            <div className="p-3 overflow-y-auto flex-1 space-y-3 text-xs scrollbar-thin">
              {/* KPI Cards */}
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-lg border border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-xs">
                  <div className="text-[10px] text-slate-500 font-nepali">दर्ता संख्या (Total)</div>
                  <div className="text-lg font-bold text-slate-900 font-mono mt-0.5">
                    {stats?.total_house_numbers || 0}
                  </div>
                </div>
                <div className="p-2.5 rounded-lg border border-slate-200 bg-gradient-to-br from-white to-slate-50 shadow-xs">
                  <div className="text-[10px] text-slate-500 font-nepali">प्रमाणीकृत (Verified)</div>
                  <div className="text-lg font-bold text-emerald-700 font-mono mt-0.5">
                    {stats?.verified_count || 0}
                  </div>
                </div>
              </div>

              {/* Side Balance Info */}
              <div className="p-2.5 rounded-lg border border-slate-200 bg-slate-50 text-[11px] font-mono flex items-center justify-between">
                <span className="text-blue-700 font-bold">देब्रे (Left): {stats?.by_side?.LEFT || 0}</span>
                <span className="text-slate-400">|</span>
                <span className="text-emerald-700 font-bold">दाहिने (Right): {stats?.by_side?.RIGHT || 0}</span>
              </div>

              {/* Search Registry */}
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={registrySearch}
                  onChange={(e) => setRegistrySearch(e.target.value)}
                  placeholder="घर नम्बर वा सडक खोज्नुहोस्..."
                  className="w-full pl-8 pr-3 py-1.5 rounded-lg border border-slate-200 text-xs bg-white"
                />
              </div>

              {/* Numbers List Table */}
              <div className="border border-slate-200 rounded-lg overflow-y-auto max-h-56 bg-white">
                <table className="w-full text-left text-xs font-mono">
                  <thead className="bg-slate-100 text-slate-600 text-[10px] sticky top-0 font-nepali">
                    <tr>
                      <th className="p-2">घर नं</th>
                      <th className="p-2">सडक</th>
                      <th className="p-2">स्थिति</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {numbersList.length === 0 ? (
                      <tr>
                        <td colSpan="3" className="p-4 text-center text-slate-400 font-nepali">
                          कुनै घर नम्बर फेला परेन।
                        </td>
                      </tr>
                    ) : (
                      numbersList.map((num) => (
                        <tr
                          key={num.id}
                          onClick={() => {
                            setInspectedNumber({ ...(num.properties || {}), id: num.id ?? num.properties?.id });
                            setEditStatus(num.properties?.status || 'ASSIGNED');
                          }}
                          className="hover:bg-slate-50 cursor-pointer transition-colors"
                        >
                          <td className="p-2 font-bold text-slate-900">{num.properties?.house_number}</td>
                          <td className="p-2 text-slate-600 truncate max-w-[100px]">
                            {num.properties?.road_name}
                          </td>
                          <td className="p-2">
                            <span
                              className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                                num.properties?.status === 'VERIFIED'
                                  ? 'bg-emerald-100 text-emerald-800'
                                  : 'bg-blue-100 text-blue-800'
                              }`}
                            >
                              {num.properties?.status || 'ASSIGNED'}
                            </span>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* Export Registry Actions */}
              <div className="pt-2 border-t border-slate-100 flex items-center gap-2">
                <button type="button"
                  onClick={() => handleExport('csv')}
                  className="flex-1 py-1.5 px-2 rounded-lg border border-slate-300 hover:bg-slate-100 font-semibold text-slate-700 flex items-center justify-center gap-1.5 transition-colors text-xs font-nepali"
                >
                  <Download className="w-3.5 h-3.5" />
                  CSV निर्यात
                </button>
                <button type="button"
                  onClick={() => handleExport('geojson')}
                  className="flex-1 py-1.5 px-2 rounded-lg border border-slate-300 hover:bg-slate-100 font-semibold text-slate-700 flex items-center justify-center gap-1.5 transition-colors text-xs font-nepali"
                >
                  <Download className="w-3.5 h-3.5" />
                  GeoJSON निर्यात
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* 4. Clicked House Number Details Box (Bottom Center) */}
      {inspectedNumber && (
        <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-30 bg-white/95 backdrop-blur-md border border-slate-200 shadow-2xl rounded-xl p-3 w-80 sm:w-96 max-w-[calc(100vw-2rem)] max-h-[75dvh] overflow-y-auto text-xs animate-fade-in">
          <div className="flex items-center justify-between border-b border-slate-200 pb-1.5 mb-2">
            <div className="font-bold text-slate-900 flex items-center gap-1.5 font-nepali">
              <Home className="w-4 h-4 text-indigo-600" />
              <span>घर नम्बर विवरण: {inspectedNumber.house_number}</span>
            </div>
            <button type="button"
              onClick={() => setInspectedNumber(null)}
              className="p-0.5 rounded text-slate-400 hover:text-slate-600"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="space-y-1 font-mono text-[11px] mb-3">
            <div className="flex justify-between">
              <span className="text-slate-500">सडक नाम (Road):</span>
              <span className="font-bold text-slate-800">{inspectedNumber.road_name}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">चेनिएज (Chainage):</span>
              <span>{inspectedNumber.metric_distance}m</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">दिशा/छेउ (Side):</span>
              <span className="font-bold text-blue-700">{inspectedNumber.side}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">वडा (Ward):</span>
              <span>{inspectedNumber.ward || 'N/A'}</span>
            </div>
          </div>

          {/* Verification Status updater */}
          <div className="flex items-center gap-2 pt-2 border-t border-slate-100 font-nepali">
            <select
              value={editStatus}
              onChange={(e) => setEditStatus(e.target.value)}
              className="p-1 border border-slate-300 rounded text-xs bg-white flex-1"
            >
              <option value="ASSIGNED">तोकिएको (ASSIGNED)</option>
              <option value="VERIFIED">प्रमाणीकृत (VERIFIED)</option>
              <option value="PROPOSED">प्रस्तावित (PROPOSED)</option>
            </select>
            <button type="button"
              onClick={async () => {
                try {
                  await houseNumberingAPI.updateNumber(inspectedNumber.id, { status: editStatus });
                  showNotice('घर नम्बर स्थिति अद्यावधिक भयो!', 'success');
                  setInspectedNumber(null);
                  refreshRegistry();
                } catch (e) {
                  showNotice('अद्यावधिक गर्न सकिएन', 'error');
                }
              }}
              className="px-3 py-1 bg-gov-blue-800 text-white rounded text-xs font-bold hover:bg-gov-blue-900"
            >
              अपडेट
            </button>
          </div>
        </div>
      )}

      {/* 5. Zoom Controls (Bottom Left) */}
      <div className="absolute bottom-6 left-3 z-20 flex flex-col bg-white/95 backdrop-blur-md border border-slate-200 rounded-lg shadow-lg overflow-hidden">
        <button type="button"
          onClick={() => {
            if (mapInstance.current) {
              const view = mapInstance.current.getView();
              view.animate({ zoom: view.getZoom() + 1, duration: 250 });
            }
          }}
          className="p-2 hover:bg-slate-100 text-slate-700 transition-colors border-b border-slate-100"
          title="जुम इन (+)"
        >
          <ZoomIn className="w-4 h-4" />
        </button>
        <button type="button"
          onClick={() => {
            if (mapInstance.current) {
              const view = mapInstance.current.getView();
              view.animate({ zoom: view.getZoom() - 1, duration: 250 });
            }
          }}
          className="p-2 hover:bg-slate-100 text-slate-700 transition-colors"
          title="जुम आउट (-)"
        >
          <ZoomOut className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
