'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  Grid3X3, Settings, Layers, PenTool, Circle, Triangle,
  Minus, MapPin, Pencil, Plus, Edit3, Magnet, Sparkles, MousePointerClick,
  Crosshair, Check, CheckCircle2, Move, Undo2, Redo2, RotateCcw, ChevronDown, ChevronUp, X, AlertTriangle,
  Trash2, Link2, Scissors, Combine, Shapes, Save
} from 'lucide-react';
import { useAuth } from '../../lib/auth';
import {
  projectsAPI, tasksAPI, layersAPI, featuresAPI, tilesAPI, trackingAPI,
  questionnairesAPI, recordsAPI,
} from '../../lib/api';
import { setupOnlineSync } from '../../lib/offlineSync';
import api from '../../lib/api';
import useGeolocation from '../../hooks/useGeolocation';
import Navbar from '../../components/Navbar';
import KmcMap from '../../components/KmcMap';
import LayerControl from '../../components/LayerControl';
import TaskPanel from '../../components/TaskPanel';
import DynamicFormRenderer from '../../components/DynamicFormRenderer';
import FeatureEditPanel from '../../components/FeatureEditPanel';
import ReadOnlyAttributePopup from '../../components/ReadOnlyAttributePopup';
import AdminPanel from '../../components/AdminPanel';
import LinkLayersModal from '../../components/LinkLayersModal';
import GpsGuardModal from '../../components/GpsGuardModal';
import LayerEditsModal from '../../components/LayerEditsModal';
import ErrorBoundary from '../../components/ErrorBoundary';
import GeoPortalView from '../../components/geoportal/GeoPortalView';
import QuestionnaireForm from '../../components/questionnaire/QuestionnaireForm';
import MyRecordsPanel from '../../components/questionnaire/MyRecordsPanel';
import SplitFeatureModal from '../../components/SplitFeatureModal';
import MergeFeaturesModal from '../../components/MergeFeaturesModal';
import CreateLayerModal from '../../components/CreateLayerModal';
import { getDistanceToGeoJsonGeometry, GEOFENCE_EDIT_RADIUS_METERS } from '../../lib/geoDistance';
import { removeLastVertex, describeEditFailure } from '../../lib/geometryEditing';
import { formatApiError } from '../../lib/apiError';

function DashboardContent() {
  const router = useRouter();
  const { user, isAuthenticated, loading: authLoading, isAdmin, isCollector, isValidator } = useAuth();
  const {
    position: gpsPosition,
    error: gpsError,
    isTracking: gpsTracking,
    startTracking: restartGps,
  } = useGeolocation();

  // ---- Unified Platform Module State ----
  const [activeModule, setActiveModule] = useState('field_data'); // 'field_data' | 'geoportal' | 'house_numbering'

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const urlParams = new URLSearchParams(window.location.search);
      const mod = urlParams.get('module');
      if (mod === 'geoportal' || user?.role === 'BasicViewer') {
        window.location.href = '/geoportal';
        return;
      }
      if (mod && ['field_data', 'house_numbering'].includes(mod)) {
        setActiveModule(mod);
      }
    }
  }, [user]);

  // ---- Real-Time Fleet Tracking State ----
  const [collectorLocations, setCollectorLocations] = useState([]);
  const [showCollectorTracking, setShowCollectorTracking] = useState(false);

  // ---- House Numbering Map View States ----
  const [showHouseNumbers, setShowHouseNumbers] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = window.localStorage.getItem('kmc_show_house_numbers');
      return saved !== null ? saved === 'true' : true;
    }
    return true;
  });
  const [individualHouseNumberFeatureId, setIndividualHouseNumberFeatureId] = useState(null);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('kmc_show_house_numbers', String(showHouseNumbers));
    }
  }, [showHouseNumbers]);

  // ---- Projects ----
  const [projects, setProjects] = useState([]);
  const [activeProject, setActiveProject] = useState(null);
  const isHouseNumberingOn = Boolean(
    activeProject && (
      activeProject.house_numbering_enabled === true ||
      activeProject.house_numbering_config?.house_numbering_enabled === true
    )
  );
  const [taskGrids, setTaskGrids] = useState(null);

  // ---- Server Raster (MBTiles) & Vector (PostGIS) Layers ----
  const [serverRasters, setServerRasters] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('kmc_cached_raster_layers');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) return parsed.map((r) => ({ ...r, visible: false }));
        }
      } catch (e) {}
    }
    return [];
  });
  const [serverVectors, setServerVectors] = useState(() => {
    if (typeof window !== 'undefined') {
      try {
        const cached = localStorage.getItem('kmc_cached_vector_layers');
        if (cached) {
          const parsed = JSON.parse(cached);
          if (Array.isArray(parsed)) return parsed.map((v) => ({ ...v, visible: false }));
        }
      } catch (e) {}
    }
    return [];
  });
  const [activeLayerId, setActiveLayerId] = useState(null);
  const [layerOrderingConfig, setLayerOrderingConfig] = useState(null);

  useEffect(() => {
    api.get('/platform/layer-ordering')
      .then((res) => {
        if (res.data) setLayerOrderingConfig(res.data);
      })
      .catch((err) => console.warn('Notice loading layer ordering:', err));
  }, []);
  const [formLayerId, setFormLayerId] = useState(null);
  const [questionnaireExtraFields, setQuestionnaireExtraFields] = useState([]);

  // ---- UI / Basemap / Zoom State ----
  const [activeBasemap, setActiveBasemap] = useState('google');
  const [basemapOpacity, setBasemapOpacity] = useState(100);
  const [zoomTarget, setZoomTarget] = useState(null);
  const [selectedTask, setSelectedTask] = useState(null);
  const [showLayerControl, setShowLayerControl] = useState(false);
  const [showTaskPanel, setShowTaskPanel] = useState(false);
  const [layerEditsModalTarget, setLayerEditsModalTarget] = useState(null);
  const [showAdminPanel, setShowAdminPanel] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [formCollapsed, setFormCollapsed] = useState(false);
  const [formSaving, setFormSaving] = useState(false);
  const [drawMode, setDrawMode] = useState(null);
  const [showDrawTypeSelector, setShowDrawTypeSelector] = useState(false);
  const [editingGeometry, setEditingGeometry] = useState(null);
  const [initialFormAttributes, setInitialFormAttributes] = useState({});
  const [activeLayerFormSchema, setActiveLayerFormSchema] = useState(null);
  const [activeLayerLinkingIdField, setActiveLayerLinkingIdField] = useState('_id');
  const [refLayerId, setRefLayerId] = useState('auto');
  const [refLayerLinkingIdField, setRefLayerLinkingIdField] = useState('_id');
  const [enableLayerLinking, setEnableLayerLinking] = useState(false);
  const [pickFeatureMode, setPickFeatureMode] = useState(false);
  const [selectedLinkedFeature, setSelectedLinkedFeature] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [isOnline, setIsOnline] = useState(true);

  // ---- Advanced Questionnaire & Feature Creation Draft State ----
  const [activeQuestionnaire, setActiveQuestionnaire] = useState(null);
  const [formQuestionnaire, setFormQuestionnaire] = useState(null);
  const [showMyRecords, setShowMyRecords] = useState(false);
  const [resumedRecord, setResumedRecord] = useState(null);
  const [unfinishedDraft, setUnfinishedDraft] = useState(null);

  // ---- Task Grid Boundary Drawing State ----
  const [drawingTaskBoundary, setDrawingTaskBoundary] = useState(false);
  const [drawnTaskBoundary, setDrawnTaskBoundary] = useState(null);

  const handleStartDrawBoundary = useCallback((mode = 'Polygon') => {
    setDrawingTaskBoundary(true);
    setDrawMode(mode === 'Box' ? 'Box' : 'Polygon');
  }, []);

  const handleClearDrawnBoundary = useCallback(() => {
    setDrawnTaskBoundary(null);
    setDrawingTaskBoundary(false);
    if (drawMode === 'Polygon' || drawMode === 'Box') {
      setDrawMode(null);
    }
  }, [drawMode]);

  // ---- Edit Mode State ----
  const [editMode, setEditMode] = useState(false);
  const [editLayerId, setEditLayerId] = useState(null);
  const [selectedFeature, setSelectedFeature] = useState(null);
  // Mirror of `selectedFeature` so map edit callbacks can compare against the
  // previous geometry without mutating state inside a React updater function.
  const selectedFeatureRef = useRef(null);
  useEffect(() => {
    selectedFeatureRef.current = selectedFeature;
  }, [selectedFeature]);
  const [attributePopupFeature, setAttributePopupFeature] = useState(null);
  const [highlightedLinkedFeatures, setHighlightedLinkedFeatures] = useState([]);
  const [featureSaving, setFeatureSaving] = useState(false);
  const [featureDeleting, setFeatureDeleting] = useState(false);
  const [editToolsCollapsed, setEditToolsCollapsed] = useState(false);
  const [drawToolsCollapsed, setDrawToolsCollapsed] = useState(false);
  const [toolsCollapsed, setToolsCollapsed] = useState(false);
  const [editSubMode, setEditSubMode] = useState(null); // null (none selected = all allowed) | 'tane' | 'bistar' | 'metne'

  // ---- QGIS-style Split & Merge tool state ----
  const [splitBladeMode, setSplitBladeMode] = useState(false); // draw blade to split selected feature
  const [mergeSelectMode, setMergeSelectMode] = useState(false); // click features to pick merge set
  const [mergeSelection, setMergeSelection] = useState([]); // [featureId, ...]
  const [mergeFeaturesMap, setMergeFeaturesMap] = useState({}); // { [id]: featureObj }
  const [splitMerging, setSplitMerging] = useState(false); // API busy flag
  const [showSplitModal, setShowSplitModal] = useState(false);
  const [splitModalData, setSplitModalData] = useState(null);
  const [showMergeModal, setShowMergeModal] = useState(false);

  // ---- Large-layer viewport (bbox) loading ----
  // Layers with more features than this load per-viewport instead of all-at-once.
  const BBOX_FEATURE_THRESHOLD = 150;
  const [bboxReloadTrigger, setBboxReloadTrigger] = useState(null); // { layerId, timestamp }

  // ---- Post-Save Success Toast State ----
  const [saveSuccessToast, setSaveSuccessToast] = useState(null); // { id, timestamp }

  // ---- Task Grid Outline State ----
  const [outlinedTaskIds, setOutlinedTaskIds] = useState(new Set());
  const [outlineAllTasks, setOutlineAllTasks] = useState(isCollector);
  // Map layer visibility (persisted so a reload keeps the surveyor's view).
  const [showTaskGrids, setShowTaskGrids] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('kmc_show_task_grids') !== 'false';
  });
  const [showAoiBoundary, setShowAoiBoundary] = useState(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('kmc_show_aoi_boundary') !== 'false';
  });

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('kmc_show_task_grids', String(showTaskGrids));
    }
  }, [showTaskGrids]);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('kmc_show_aoi_boundary', String(showAoiBoundary));
    }
  }, [showAoiBoundary]);

  // By default all grids should be outlined for Data Collectors
  useEffect(() => {
    if (isCollector) {
      setOutlineAllTasks(true);
    }
  }, [isCollector]);

  const handleToggleTaskOutline = useCallback((taskId) => {
    setOutlinedTaskIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  }, []);

  const handleToggleAllTasksOutline = useCallback((allTaskIds = []) => {
    setOutlineAllTasks((prev) => {
      const nextState = !prev;
      if (!nextState) {
        setOutlinedTaskIds(new Set());
      } else {
        setOutlinedTaskIds(new Set(allTaskIds));
      }
      return nextState;
    });
  }, []);

  // ---- Vector Layer Outline Toggle Handler ----
  const handleVectorOutlineToggle = useCallback((layerId) => {
    setServerVectors((prev) =>
      prev.map((v) =>
        v.id === layerId ? { ...v, outlineOnly: !v.outlineOnly } : v
      )
    );
  }, []);

  // ---- Undo / Redo History State for Edit Mode ----
  const [undoStack, setUndoStack] = useState([]);
  const [redoStack, setRedoStack] = useState([]);
  const [geometryUpdateTrigger, setGeometryUpdateTrigger] = useState(null);

  // ---- Undo / Redo History State for Drawing Mode ----
  const [drawUndoCount, setDrawUndoCount] = useState(0);
  const [drawRedoCount, setDrawRedoCount] = useState(0);
  const [drawUndoTrigger, setDrawUndoTrigger] = useState(null);
  const [drawRedoTrigger, setDrawRedoTrigger] = useState(null);

  const handleDrawUndo = useCallback(() => {
    setDrawUndoTrigger({ timestamp: Date.now() });
  }, []);

  const handleDrawRedo = useCallback(() => {
    setDrawRedoTrigger({ timestamp: Date.now() });
  }, []);

  const handleDrawVertexChange = useCallback(({ undoCount, redoCount }) => {
    setDrawUndoCount(undoCount || 0);
    setDrawRedoCount(redoCount || 0);
  }, []);

  // ---- Vertex Snapping State ----
  const [snappingEnabled, setSnappingEnabled] = useState(true);
  const [snapTolerance, setSnapTolerance] = useState(15); // tolerance in pixels

  // ---- Auth redirect ----
  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.replace('/login');
    }
  }, [authLoading, isAuthenticated, router]);

  // ---- Online/Offline detection ----
  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    setIsOnline(navigator.onLine);
    setupOnlineSync(api);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  // ---- Load initial projects and global layers ----
  // ---- Load project-scoped or global layers ----
  const loadAllLayers = useCallback(async (project = null) => {
    try {
      let vLayers = [];
      let rTiles = [];

      const targetProject = project !== undefined ? project : activeProject;

      if (targetProject && targetProject.id) {
        // When a project is selected then only its corresponding layers should be available
        const [projLayersRes, projTilesRes] = await Promise.allSettled([
          layersAPI.listProject(targetProject.id),
          tilesAPI.listProject(targetProject.id),
        ]);
        vLayers = projLayersRes.status === 'fulfilled' ? projLayersRes.value.data : [];
        rTiles = projTilesRes.status === 'fulfilled' ? projTilesRes.value.data : [];
      } else if (isAdmin) {
        // GIS Admin displays all layers of any projects and all global layers when no project is selected
        const [allLayersRes, allTilesRes] = await Promise.allSettled([
          layersAPI.listAll(),
          tilesAPI.listAll(),
        ]);
        vLayers = allLayersRes.status === 'fulfilled' ? allLayersRes.value.data : [];
        rTiles = allTilesRes.status === 'fulfilled' ? allTilesRes.value.data : [];
      } else {
        // Non-admin or DataCollector without active project: load global layers
        const [globalLayersRes, globalTilesRes] = await Promise.allSettled([
          layersAPI.listGlobal(),
          tilesAPI.listGlobal(),
        ]);
        vLayers = globalLayersRes.status === 'fulfilled' ? globalLayersRes.value.data : [];
        rTiles = globalTilesRes.status === 'fulfilled' ? globalTilesRes.value.data : [];
      }

      // Preserve existing visibility, dynamic z-index stacking rank, and feature data
      setServerVectors((prev) => {
        const prevMap = new Map(prev.map((l) => [l.id, l]));
        return vLayers.map((l) => {
          const existing = prevMap.get(l.id);
          const isLarge = (l.feature_count ?? 0) > BBOX_FEATURE_THRESHOLD || l.bbox_mode || l.is_mvt || (l.filename && (l.filename.includes('buildings') || l.filename.includes('roads')));
          const nextVis = existing?.visible != null ? existing.visible : false;
          return {
            ...l,
            visible: nextVis,
            opacity: typeof existing?.opacity === 'number' && existing.opacity <= 1 && existing.opacity > 0
              ? Math.round(existing.opacity * 100)
              : (existing?.opacity ?? (typeof l.opacity === 'number' && l.opacity <= 1 && l.opacity > 0 ? Math.round(l.opacity * 100) : (l.opacity ?? 100))),
            features: existing?.features || null,
            bboxMode: existing?.bboxMode != null ? existing.bboxMode : isLarge,
            is_mvt: l.is_mvt || isLarge,
            viewEdits: existing?.viewEdits ?? false,
            editCollectorId: existing?.editCollectorId ?? 'all',
            selectedCollectors: existing?.selectedCollectors ?? (isAdmin ? ['all'] : ['my_edits']),
            lastActivatedAt: existing?.lastActivatedAt || (nextVis ? Date.now() : 0),
          };
        });
      });

      if (vLayers.length > 0) {
        setActiveLayerId((currentActive) => {
          if (currentActive && vLayers.some((l) => l.id === currentActive)) {
            return currentActive;
          }
          return vLayers[0].id;
        });
      } else {
        setActiveLayerId(null);
      }

      setServerRasters((prev) => {
        const prevMap = new Map(prev.map((r) => [r.id, r]));
        return rTiles.map((t) => {
          const existing = prevMap.get(t.id);
          const nextVis = existing?.visible != null ? existing.visible : false;
          return {
            ...t,
            visible: nextVis,
            opacity: typeof existing?.opacity === 'number' && existing.opacity <= 1 && existing.opacity > 0
              ? Math.round(existing.opacity * 100)
              : (existing?.opacity ?? (typeof t.opacity === 'number' && t.opacity <= 1 && t.opacity > 0 ? Math.round(t.opacity * 100) : (t.opacity ?? 100))),
            lastActivatedAt: existing?.lastActivatedAt || (nextVis ? Date.now() : 0),
          };
        });
      });

      if (typeof window !== 'undefined' && Array.isArray(vLayers) && vLayers.length > 0) {
        try {
          const cleanMeta = vLayers.map((l) => ({ ...l, features: null }));
          localStorage.setItem('kmc_cached_vector_layers', JSON.stringify(cleanMeta));
        } catch (e) {}
      }
      if (typeof window !== 'undefined' && Array.isArray(rTiles) && rTiles.length > 0) {
        try {
          localStorage.setItem('kmc_cached_raster_layers', JSON.stringify(rTiles));
        } catch (e) {}
      }
    } catch (err) {
      console.error('Failed to load layers:', err);
    }
  }, [isAdmin, isCollector]);

  // Helper to discover all field names from a vector layer
  const getLayerFields = useCallback((layerId) => {
    if (!layerId) return ['_id', 'id'];
    const layer = serverVectors.find((l) => String(l.id) === String(layerId));
    const fieldsSet = new Set(['_id', 'id']);

    if (layer) {
      // 1. fields_config (Primary GIS schema) and the role-editable subset
      [layer.fields_config, layer.editable_fields].forEach((fieldList) => {
        if (!Array.isArray(fieldList)) return;
        fieldList.forEach((f) => {
          if (f?.name && !f.name.startsWith('_')) fieldsSet.add(f.name);
        });
      });

      // 2. geometry_fields_config
      if (layer.geometry_fields_config && typeof layer.geometry_fields_config === 'object') {
        Object.values(layer.geometry_fields_config).forEach((fieldList) => {
          if (Array.isArray(fieldList)) {
            fieldList.forEach((f) => {
              if (f?.name && !f.name.startsWith('_')) fieldsSet.add(f.name);
            });
          }
        });
      }

      // 3. form_schema fields
      if (layer.form_schema?.fields && Array.isArray(layer.form_schema.fields)) {
        layer.form_schema.fields.forEach((f) => {
          if (f.name && !f.name.startsWith('_')) fieldsSet.add(f.name);
        });
      }

      // 4. questionnaire questions / fields
      if (layer.questionnaire?.sections && Array.isArray(layer.questionnaire.sections)) {
        layer.questionnaire.sections.forEach((sec) => {
          if (Array.isArray(sec.fields)) {
            sec.fields.forEach((q) => {
              if (q.name && !q.name.startsWith('_')) fieldsSet.add(q.name);
            });
          }
        });
      }

      // 5. feature sample properties
      const features = layer.features?.features || (Array.isArray(layer.features) ? layer.features : []);
      features.slice(0, 100).forEach((f) => {
        const props = f.properties || {};
        Object.keys(props).forEach((k) => {
          if (!['geom', 'the_geom', 'geometry', 'geometry_type'].includes(k) && !k.startsWith('_')) {
            fieldsSet.add(k);
          }
        });
      });
    }

    return Array.from(fieldsSet);
  }, [serverVectors]);

  // Available linking fields: when a feature is clicked on the map, use that feature's layer and properties!
  // Fields of the layer being drawn into (source side of a link).
  const activeLayerLinkFields = useMemo(
    () => getLayerFields(activeLayerId),
    [activeLayerId, getLayerFields]
  );

  // Fields of the reference feature's layer (target side of a link).
  const targetLayerFields = useMemo(() => {
    const targetLid = selectedLinkedFeature?.layerId || refLayerId || activeLayerId;
    const baseFields = getLayerFields(targetLid);
    const fieldsSet = new Set(baseFields);

    if (selectedLinkedFeature?.properties) {
      Object.keys(selectedLinkedFeature.properties).forEach((k) => {
        if (!['geom', 'the_geom', 'geometry', 'geometry_type'].includes(k) && !k.startsWith('_')) {
          fieldsSet.add(k);
        }
      });
    }

    return Array.from(fieldsSet);
  }, [selectedLinkedFeature, refLayerId, activeLayerId, getLayerFields]);

  const refLayerFields = useMemo(() => (refLayerId !== 'auto' ? getLayerFields(refLayerId) : []), [refLayerId, getLayerFields]);

  // Link chosen during new-feature capture, forwarded to the survey submit so the
  // questionnaire-created feature is linked in the same request.
  const questionnaireLinkTo = useMemo(() => {
    if (!selectedLinkedFeature?.featureId) return null;
    const sourceField = activeLayerLinkingIdField || null;
    const targetField = refLayerLinkingIdField || sourceField;
    return {
      target_feature_id: selectedLinkedFeature.featureId,
      target_layer_id: selectedLinkedFeature.layerId || null,
      source_link_attribute: sourceField,
      target_link_attribute: targetField,
      link_attribute: sourceField || targetField,
      relationship_type: 'connected_to',
    };
  }, [selectedLinkedFeature, activeLayerLinkingIdField, refLayerLinkingIdField]);

  // Pair the source field and the reference feature's field. Both sides offer
  // every attribute of their own layer so a matching value can establish the link.
  useEffect(() => {
    if (selectedLinkedFeature) {
      const props = selectedLinkedFeature.properties || {};
      const targetFields = getLayerFields(selectedLinkedFeature.layerId);
      const preferred = ['building_id', 'bldg_code', 'house_no', 'parcel_id', 'code', 'id', 'name']
        .find((f) => targetFields.includes(f) && props[f] !== undefined)
        || targetFields.find((f) => props[f] !== undefined && f !== '_id')
        || '_id';
      setRefLayerLinkingIdField(preferred);
      const sourceFields = getLayerFields(activeLayerId);
      setActiveLayerLinkingIdField(
        sourceFields.includes(preferred)
          ? preferred
          : (sourceFields.find((f) => ['id', 'code', 'building_id', 'parcel_id', 'ward_no', 'fid', 'house_no'].includes(f.toLowerCase())) || '_id')
      );
    } else if (activeLayerId) {
      const fields = getLayerFields(activeLayerId);
      const preferred = fields.find((f) => ['id', 'code', 'building_id', 'parcel_id', 'ward_no', 'fid', 'house_no'].includes(f.toLowerCase())) || '_id';
      setActiveLayerLinkingIdField(preferred);
      setRefLayerLinkingIdField(preferred);
    }
  }, [selectedLinkedFeature, activeLayerId, getLayerFields]);

  // Auto-select preferred linking field when refLayerId changes
  useEffect(() => {
    if (refLayerId && refLayerId !== 'auto') {
      const fields = getLayerFields(refLayerId);
      const preferred = fields.find((f) => ['id', 'code', 'building_id', 'parcel_id', 'ward_no', 'fid', 'house_no'].includes(f.toLowerCase())) || '_id';
      setRefLayerLinkingIdField(preferred);
    }
  }, [refLayerId, getLayerFields]);

  // Load projects on startup
  useEffect(() => {
    if (!isAuthenticated) return;
    projectsAPI.list().then((res) => {
      const projList = res.data || [];
      setProjects(projList);
      if (isCollector && projList.length > 0) {
        // Automatically select the active project for DataCollector so they start with their linked layers
        const defaultProj = projList.find((p) => p.status === 'ACTIVE') || projList[0];
        setActiveProject(defaultProj);
      }
    }).catch(console.error);

    loadAllLayers(null);
  }, [isAuthenticated, isCollector, loadAllLayers]);

  // ---- Load project-specific data when activeProject changes ----
  useEffect(() => {
    if (!activeProject) {
      setTaskGrids(null);
      setSelectedTask(null);
      setShowTaskPanel(false);
      setActiveQuestionnaire(null);
      setResumedRecord(null);
      setShowMyRecords(false);
      loadAllLayers(null);
      return;
    }

    // Load tasks
    tasksAPI.list(activeProject.id)
      .then((res) => setTaskGrids(res.data))
      .catch(console.error);

    // Load active questionnaire for project (if any)
    questionnairesAPI.getActive(activeProject.id)
      .then((res) => setActiveQuestionnaire(res.data))
      .catch(() => setActiveQuestionnaire(null));

    loadAllLayers(activeProject);
  }, [activeProject, isCollector, loadAllLayers]);

  // ---- Restore Unfinished Feature Creation Draft from localStorage ----
  useEffect(() => {
    if (typeof window !== 'undefined') {
      try {
        const raw = localStorage.getItem('kmc_unfinished_feature_creation_draft');
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && parsed.geometry) {
            setUnfinishedDraft(parsed);
          }
        }
      } catch (e) {
        console.warn('Failed to parse unfinished draft from localStorage', e);
      }
    }
  }, []);

  const handleResumeUnfinishedDraft = useCallback(async () => {
    if (!unfinishedDraft) return;
    const draft = unfinishedDraft;
    setEditingGeometry(draft.geometry);
    if (draft.layerId) {
      setActiveLayerId(draft.layerId);
      setFormLayerId(draft.layerId);
      setServerVectors((prev) =>
        prev.map((l) => (l.id === draft.layerId ? { ...l, visible: true, lastActivatedAt: l.lastActivatedAt || Date.now() } : l))
      );
    }
    if (draft.questionnaireId) {
      try {
        const qRes = await questionnairesAPI.get(draft.questionnaireId);
        setActiveQuestionnaire(qRes.data);
        setFormQuestionnaire(qRes.data);
      } catch (e) {
        console.warn('Failed to load questionnaire for draft', e);
        setActiveQuestionnaire(null);
        setFormQuestionnaire(null);
      }
      // Restore the server-side record id as well: otherwise submitting a resumed
      // draft creates a second record for the same survey.
      setResumedRecord({
        record_id: draft.recordId || draft.id || null,
        id: draft.recordId || draft.id,
        geom_geojson: draft.geometry,
        answers: draft.answers || {},
        repeat_data: draft.repeatData || {},
        calculated_values: draft.calculatedValues || {},
        media_refs: Array.isArray(draft.mediaRefs) ? draft.mediaRefs : [],
        status: 'IN_PROGRESS',
      });
    } else {
      setInitialFormAttributes(draft.answers || {});
    }
    setZoomTarget({
      type: 'geometry',
      geometry: draft.geometry,
      timestamp: Date.now(),
    });
    setShowForm(true);
    setUnfinishedDraft(null);
  }, [unfinishedDraft]);

  const handleDiscardUnfinishedDraft = useCallback(() => {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('kmc_unfinished_feature_creation_draft');
    }
    setUnfinishedDraft(null);
  }, []);

  // ---- Layer Toggle & Opacity Handlers ----
  const handleRasterToggle = useCallback((id) => {
    const now = Date.now();
    setServerRasters((prev) =>
      prev.map((r) => {
        if (r.id === id) {
          const nextVis = !r.visible;
          return { ...r, visible: nextVis, lastActivatedAt: nextVis ? now : 0 };
        }
        return r;
      })
    );
  }, []);

  const handleRasterOpacityChange = useCallback((id, opacity) => {
    setServerRasters((prev) =>
      prev.map((r) => (r.id === id ? { ...r, opacity } : r))
    );
  }, []);

  const handleVectorToggle = useCallback(async (id) => {
    const now = Date.now();
    setServerVectors((prev) =>
      prev.map((v) => {
        if (v.id === id) {
          const nextVis = !v.visible;
          const rawOp = v.opacity;
          const normalizedOp = typeof rawOp === 'number' && rawOp <= 1 && rawOp > 0 ? Math.round(rawOp * 100) : (rawOp ?? 100);
          const isLargeLayer = (v.feature_count ?? 0) > BBOX_FEATURE_THRESHOLD || v.bboxMode || v.is_mvt || v.bbox_mode || (v.filename && (v.filename.includes('buildings') || v.filename.includes('roads')));
          if (nextVis && !v.features) {
            if (isLargeLayer || v.bboxMode) {
              // LARGE LAYER: viewport (bbox) loading — the map fetches only the
              // visible extent per pan/zoom. No full download.
              setTimeout(() => setBboxReloadTrigger({ layerId: id, timestamp: Date.now() }), 60);
              return { ...v, visible: nextVis, opacity: normalizedOp, bboxMode: true, lastActivatedAt: now };
            }
            // Mark as loading, then fetch features
            featuresAPI.list(id)
              .then((res) => {
                // Normalize: res.data could be the FeatureCollection directly,
                // or it could have features nested inside
                let featureData = res.data;

                // If the response is not a valid FeatureCollection, try to wrap it
                if (featureData && !featureData.type && Array.isArray(featureData)) {
                  featureData = { type: 'FeatureCollection', features: featureData };
                }

                setServerVectors((current) =>
                  current.map((item) =>
                    item.id === id ? { ...item, features: featureData } : item
                  )
                );
              })
              .catch((err) => {
                console.error(`[Dashboard] Failed to load features for layer ${id}:`, err);
                // Reset visible so user can retry
                setServerVectors((current) =>
                  current.map((item) =>
                    item.id === id ? { ...item, visible: false, lastActivatedAt: 0 } : item
                  )
                );
              });
          }
          if (nextVis && (isLargeLayer || v.bboxMode)) {
            setTimeout(() => setBboxReloadTrigger({ layerId: id, timestamp: Date.now() }), 60);
          }
          return { ...v, visible: nextVis, opacity: normalizedOp, lastActivatedAt: nextVis ? now : 0 };
        }
        return v;
      })
    );
  }, []);

  const handleVectorOpacityChange = useCallback((id, opacity) => {
    setServerVectors((prev) =>
      prev.map((v) => (v.id === id ? { ...v, opacity } : v))
    );
  }, []);

  // ---- Zoom to Layer Handlers ----
  const handleZoomToVector = useCallback(async (layer) => {
    if (!layer.visible) {
      handleVectorToggle(layer.id);
    }
    const useBbox = layer.bboxMode || layer.is_mvt || layer.bbox_mode || (layer.feature_count ?? 0) > BBOX_FEATURE_THRESHOLD || (layer.filename && (layer.filename.includes('buildings') || layer.filename.includes('roads')));
    if (useBbox) {
      // Large layer: zoom via cheap server-side extent — never downloads all features
      try {
        const res = await featuresAPI.getExtent(layer.id);
        const [w, s, e, n] = res.data?.extent || res.data?.bounds || res.data?.bbox || [];
        if ([w, s, e, n].every((v) => typeof v === 'number' && isFinite(v))) {
          const toMerc = ([lon, lat]) => {
            const x = (lon * 20037508.34) / 180;
            const y = (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180) * 20037508.34) / 180;
            return [x, y];
          };
          const [minX, minY] = toMerc([w, s]);
          const [maxX, maxY] = toMerc([e, n]);
          setZoomTarget({ type: 'extent', bounds: [minX, minY, maxX, maxY], timestamp: Date.now() });
          return;
        }
      } catch (err) {
        console.error('Failed to fetch layer extent:', err);
      }
    }
    if (!layer.features) {
      try {
        const res = await featuresAPI.list(layer.id);
        setServerVectors((prev) =>
          prev.map((v) => (v.id === layer.id ? { ...v, features: res.data, visible: true, lastActivatedAt: v.lastActivatedAt || Date.now() } : v))
        );
      } catch (err) {
        console.error('Failed to fetch features for zoom:', err);
      }
    }
    setZoomTarget({ type: 'vector', id: layer.id, timestamp: Date.now() });
  }, [handleVectorToggle]);

  // ---- Admin Toggle Vector Layer Snapping Permission ----
  const handleToggleLayerSnapping = useCallback(async (layerId, newStatus) => {
    try {
      await layersAPI.update(layerId, { allow_snapping: newStatus });
      setServerVectors((prev) =>
        prev.map((l) => (l.id === layerId ? { ...l, allow_snapping: newStatus } : l))
      );
    } catch (err) {
      console.error('[Dashboard] Error toggling layer snapping:', err);
      alert(formatApiError(err, 'स्न्यापिङ स्थिति परिवर्तन गर्न सकिएन'));
    }
  }, []);

  // Snapping allowed flags for active layer
  const activeDrawLayer = serverVectors.find((v) => v.id === activeLayerId);
  const isDrawLayerSnappingAllowed = !activeDrawLayer || activeDrawLayer.allow_snapping !== false;

  const activeEditLayer = serverVectors.find((v) => v.id === editLayerId);
  const isEditLayerSnappingAllowed = !activeEditLayer || activeEditLayer.allow_snapping !== false;

  // ---- Zoom to Collector Handler ----
  const handleZoomToCollector = useCallback((col) => {
    if (col && col.latitude && col.longitude) {
      setZoomTarget({
        type: 'collector',
        lat: col.latitude,
        lng: col.longitude,
        timestamp: Date.now(),
      });
    }
  }, []);

  // ---- Compulsory Location Streaming & Presence for Data Collectors ----
  useEffect(() => {
    if (!isAuthenticated || !isCollector) return;

    const getIsActive = () => typeof document !== 'undefined' && document.visibilityState === 'visible';

    const sendLocationPing = async () => {
      const active = getIsActive();
      try {
        if (gpsPosition && gpsPosition.lat && gpsPosition.lng) {
          await trackingAPI.ping({
            latitude: gpsPosition.lat,
            longitude: gpsPosition.lng,
            accuracy: gpsPosition.accuracy || null,
            altitude: gpsPosition.altitude || null,
            heading: gpsPosition.heading || null,
            speed: gpsPosition.speed || null,
            battery_level: null,
            app_state: active ? 'active' : 'inactive',
          });
        } else {
          // If GPS not yet acquired, still report active presence status
          await trackingAPI.setStatus({
            is_online: active,
            app_state: active ? 'active' : 'inactive',
          });
        }
      } catch (e) {
        // Silently handle intermittent network
      }
    };

    // 1. Send initial ping on mount
    sendLocationPing();

    // 2. Regular heartbeat every 10 seconds while tab is active
    const interval = setInterval(() => {
      if (getIsActive()) {
        sendLocationPing();
      }
    }, 10000);

    // 3. Browser minimize / window focus change handler
    const handleVisibilityChange = () => {
      const isVisible = document.visibilityState === 'visible';
      if (isVisible) {
        // Unminimized / focused -> immediately active
        trackingAPI.setStatus({
          is_online: true,
          app_state: 'active',
          latitude: gpsPosition?.lat || null,
          longitude: gpsPosition?.lng || null,
        }).catch(() => {});
        sendLocationPing();
      } else {
        // Minimized / hidden -> immediately inactive
        trackingAPI.sendBeaconStatus({
          is_online: false,
          app_state: 'inactive',
          latitude: gpsPosition?.lat || null,
          longitude: gpsPosition?.lng || null,
        });
      }
    };

    // 4. Browser close / tab close handler
    const handleUnload = () => {
      trackingAPI.sendBeaconStatus({
        is_online: false,
        app_state: 'inactive',
        latitude: gpsPosition?.lat || null,
        longitude: gpsPosition?.lng || null,
      });
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pagehide', handleUnload);
    window.addEventListener('beforeunload', handleUnload);

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pagehide', handleUnload);
      window.removeEventListener('beforeunload', handleUnload);
      handleUnload();
    };
  }, [isAuthenticated, isCollector, gpsPosition]);

  // ---- Live Collector Fleet Tracking Polling (All Users: Admin, Validator, DataCollector) ----
  const loadCollectorLocations = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await trackingAPI.getCollectors(activeProject?.id);
      setCollectorLocations(res.data || []);
    } catch (err) {
      // Gracefully handle backend startup / proxy glitch without spamming error console
      if (err?.response?.status !== 500 && err?.code !== 'ERR_BAD_RESPONSE') {
        console.warn('[Dashboard] Tracking polling paused temporarily:', err?.message || err);
      }
    }
  }, [isAuthenticated, activeProject?.id]);

  useEffect(() => {
    if (!isAuthenticated) return;
    loadCollectorLocations();
    const interval = setInterval(loadCollectorLocations, 10000);
    return () => clearInterval(interval);
  }, [isAuthenticated, loadCollectorLocations]);

  const handleZoomToRaster = useCallback((raster) => {
    if (!raster.visible) {
      handleRasterToggle(raster.id);
    }
    setZoomTarget({
      type: 'raster',
      id: raster.id,
      bounds: raster.bounds,
      timestamp: Date.now(),
    });
  }, [handleRasterToggle]);

  // ---- Select Project ----
  const handleProjectSelect = useCallback((project) => {
    setActiveProject(project);
    setSelectedTask(null);
    setShowTaskPanel(false);
    loadAllLayers(project);
  }, [loadAllLayers]);

  // ---- Task Lifecycle Actions ----
  const handleTaskAction = useCallback(async (taskId, action) => {
    setActionLoading(true);
    try {
      const gpsData = gpsPosition
        ? { collector_lat: gpsPosition.lat, collector_lng: gpsPosition.lng }
        : {};

      switch (action) {
        case 'lock':
          await tasksAPI.lock(taskId, gpsData);
          break;
        case 'unlock':
          await tasksAPI.unlock(taskId);
          break;
        case 'submit':
          await tasksAPI.submit(taskId);
          break;
        case 'validate':
          await tasksAPI.validate(taskId, 'validate');
          break;
        case 'invalidate':
          await tasksAPI.validate(taskId, 'invalidate');
          break;
      }

      if (activeProject) {
        const res = await tasksAPI.list(activeProject.id);
        setTaskGrids(res.data);
      }
    } catch (err) {
      alert(formatApiError(err, `कार्य असफल भयो: ${err.message}`));
    }
    setActionLoading(false);
  }, [gpsPosition, activeProject]);

  // ---- Feature creation from map drawing ----
  const handleFeatureCreate = useCallback(async (geometry, linkedInfo = null) => {
    if (drawingTaskBoundary) {
      setDrawnTaskBoundary(geometry);
      setDrawingTaskBoundary(false);
      setDrawMode(null);
      setShowTaskPanel(true);
      return;
    }

    // A newly drawn feature always belongs to the active/edit layer; a matched
    // reference feature only supplies link values, never the destination.
    const activeTargetId = editMode && editLayerId ? editLayerId : activeLayerId;
    const targetLayer = serverVectors.find((l) => String(l.id) === String(activeTargetId));

    // A drawn feature must always land on a concrete layer: without one there is
    // nothing to attach the geometry (or the questionnaire record) to.
    if (!activeTargetId) {
      alert('कृपया पहिले बाँया-तल रहेको सूचीबाट सक्रिय भेक्टर तह (Target Vector Layer) छान्नुहोस्');
      return;
    }

    const hasAssociatedQuestionnaire = Boolean(targetLayer?.questionnaire_id);

    if (hasAssociatedQuestionnaire) {
      let qIdToLoad = targetLayer.questionnaire_id;
      let currentQ = activeQuestionnaire;
      if (qIdToLoad && (!currentQ || String(currentQ.id) !== String(qIdToLoad))) {
        try {
          const qRes = await questionnairesAPI.get(qIdToLoad);
          currentQ = qRes.data;
          setActiveQuestionnaire(currentQ);
          setFormQuestionnaire(currentQ);
        } catch (e) {
          console.warn('Failed to fetch linked questionnaire for layer', e);
          currentQ = null;
          setActiveQuestionnaire(null);
          setFormQuestionnaire(null);
        }
      } else if (currentQ) {
        setFormQuestionnaire(currentQ);
      }
      if (!currentQ) {
        alert('यो तहसँग जोडिएको प्रश्नावली लोड गर्न सकिएन। (Could not load questionnaire linked to this layer.)');
        return;
      }

      // Layer attributes that are not survey questions are shown alongside the
      // questionnaire, using the role-filtered creation schema.
      let extraFieldDefs = [];
      try {
        const fRes = await layersAPI.getFields(activeTargetId);
        const geomTypeForSchema = geometry?.type || 'Point';
        const geomConfig = fRes.data?.geometry_fields_config?.[geomTypeForSchema];
        const editableFields = Array.isArray(fRes.data?.editable_fields) ? fRes.data.editable_fields : null;
        const baseFields = (Array.isArray(geomConfig) && geomConfig.length > 0)
          ? geomConfig
          : (editableFields !== null ? editableFields : (fRes.data?.fields || []));
        const qNames = new Set(
          (currentQ?.schema_definition?.questions || currentQ?.questions || []).map((q) => q.name || q.id).filter(Boolean)
        );
        extraFieldDefs = baseFields.filter(
          (f) => f?.name && !String(f.name).startsWith('_') && !qNames.has(f.name)
        );
        setServerVectors((prev) =>
          prev.map((l) => (l.id === activeTargetId ? {
            ...l,
            fields_config: Array.isArray(fRes.data?.fields) ? fRes.data.fields : l.fields_config,
            editable_fields: editableFields !== null ? editableFields : l.editable_fields,
            geometry_fields_config: fRes.data?.geometry_fields_config || l.geometry_fields_config,
            creation_geometry_types: fRes.data?.creation_geometry_types || l.creation_geometry_types,
          } : l))
        );
      } catch (e) {
        console.warn('Failed to fetch layer attribute schema for questionnaire form:', e);
      }
      if (extraFieldDefs.length === 0) {
        const feats = targetLayer?.features?.features || (Array.isArray(targetLayer?.features) ? targetLayer.features : []);
        const keysSet = new Set();
        feats.slice(0, 50).forEach((f) => {
          const props = f.properties || {};
          Object.keys(props).forEach((k) => {
            if (!['geom', 'the_geom', 'geometry_type', '_version', '_created_by', '_updated_by', 'target_id', '_target_feature_id'].includes(k) && !String(k).startsWith('_')) {
              keysSet.add(k);
            }
          });
        });
        const qNames = new Set(
          (currentQ?.schema_definition?.questions || currentQ?.questions || []).map((q) => q.name || q.id).filter(Boolean)
        );
        extraFieldDefs = Array.from(keysSet)
          .filter((k) => !qNames.has(k))
          .map((k) => ({
            name: k,
            label: k,
            type: 'text',
            required: false,
          }));
      }
      setQuestionnaireExtraFields(extraFieldDefs);

      setEditingGeometry(geometry);
      // If resuming an existing feature or draft survey:
      if (linkedInfo?.existingFeatureId || linkedInfo?.feature) {
        const featProps = linkedInfo.properties || linkedInfo.feature?.properties || {};
        const recordCode = featProps._record_id || linkedInfo.existingFeatureId || ('KMC-REC-' + Date.now());
        setResumedRecord({
          record_id: recordCode,
          id: recordCode,
          project_id: targetLayer?.project_id || activeProject?.id,
          layer_id: targetLayer?.id || activeTargetId,
          questionnaire_id: targetLayer?.questionnaire_id || currentQ?.id,
          geom_geojson: geometry,
          answers: { ...featProps },
          status: featProps._status || 'DRAFT',
        });
      } else {
        setResumedRecord(null);
      }
      try {
        if (typeof window !== 'undefined') {
          const draftObj = {
            id: 'draft_' + Date.now(),
            projectId: activeProject?.id || null,
            layerId: activeTargetId || null,
            layerName: targetLayer?.name || 'फिचर तह',
            geometry,
            geometryType: geometry?.type || 'POINT',
            questionnaireId: targetLayer?.questionnaire_id || currentQ?.id || null,
            questionnaireTitle: targetLayer?.name || currentQ?.title || 'प्रश्नावली',
            answers: {},
            savedAt: new Date().toISOString(),
          };
          localStorage.setItem('kmc_unfinished_feature_creation_draft', JSON.stringify(draftObj));
        }
      } catch (e) {}
      setFormLayerId(targetLayer?.id || activeTargetId);
      setDrawMode(null);
      setShowForm(true);
      return;
    }

    const geomType = geometry?.type || 'Point';

    // 1. Pick fields configuration: geometry-specific schema or default layer schema
    let layerFields = [];
    if (targetLayer?.geometry_fields_config && Array.isArray(targetLayer.geometry_fields_config[geomType]) && targetLayer.geometry_fields_config[geomType].length > 0) {
      layerFields = targetLayer.geometry_fields_config[geomType];
    } else if (Array.isArray(targetLayer?.fields_config) && targetLayer.fields_config.length > 0) {
      layerFields = targetLayer.fields_config;
    }

    // Fetch the role-filtered schema so admin-restricted fields never render.
    let editableFieldsKnown = false;
    try {
      const res = await layersAPI.getFields(activeTargetId);
      const fetchedGeomConfig = res.data?.geometry_fields_config?.[geomType];
      const editable = Array.isArray(res.data?.editable_fields) ? res.data.editable_fields : null;
      editableFieldsKnown = editable !== null;
      if (Array.isArray(fetchedGeomConfig) && fetchedGeomConfig.length > 0) {
        layerFields = fetchedGeomConfig;
      } else if (editable !== null) {
        // The server decides which fields this role may enter; never fall back
        // to readable fields here or a restricted field becomes editable.
        layerFields = editable;
      } else if (Array.isArray(res.data?.fields)) {
        layerFields = res.data.fields;
      }
      setServerVectors((prev) =>
        prev.map((l) => (l.id === activeTargetId ? {
          ...l,
          fields_config: Array.isArray(res.data?.fields) ? res.data.fields : l.fields_config,
          editable_fields: Array.isArray(res.data?.editable_fields) ? res.data.editable_fields : l.editable_fields,
          geometry_fields_config: res.data?.geometry_fields_config || l.geometry_fields_config,
          creation_geometry_types: res.data?.creation_geometry_types || l.creation_geometry_types,
        } : l))
      );
    } catch (err) {
      console.warn('Failed to fetch layer fields schema:', err);
    }

    // Fallback: detect keys from existing features in memory only for legacy
    // responses that carry no role-filtered schema at all.
    if (layerFields.length === 0 && !editableFieldsKnown) {
      const feats = targetLayer?.features?.features || (Array.isArray(targetLayer?.features) ? targetLayer.features : []);
      const keysSet = new Set();
      feats.slice(0, 50).forEach((f) => {
        const props = f.properties || {};
        Object.keys(props).forEach((k) => {
          if (!['geom', 'the_geom', 'geometry_type', '_version', '_created_by', '_updated_by', 'target_id', '_target_feature_id'].includes(k)) {
            keysSet.add(k);
          }
        });
      });
      layerFields = Array.from(keysSet).map((k) => ({
        name: k,
        label: k,
        type: 'text',
        required: false,
      }));
    }

    // Check if there is an auto-generated unique ID configured for this layer/geometry
    const autoUniqueField = layerFields.find((f) => f.is_unique && f.id_mode === 'auto');
    let autoNextId = '';
    if (autoUniqueField && activeTargetId) {
      try {
        const nextIdRes = await layersAPI.getNextId(activeTargetId, { geom_type: geomType });
        if (nextIdRes.data?.next_id) {
          autoNextId = nextIdRes.data.next_id;
        }
      } catch (e) {
        console.warn('Could not auto-fetch next sequential ID:', e);
      }
    }

    // Construct the vector layer's dynamic schema
    const dynamicSchema = {
      fields: layerFields.map((f) => ({
        name: f.name,
        label: f.label || f.name,
        type: f.type || 'text',
        required: Boolean(f.required),
        is_unique: Boolean(f.is_unique),
        id_mode: f.id_mode,
        options: f.options || [],
        placeholder: f.is_unique && f.id_mode === 'auto' ? `स्वतः उत्पादन: ${autoNextId || '...'}` : (f.placeholder || ''),
      })),
    };

    // Initialize all field values strictly empty (""), or auto ID if configured
    let initialAttrs = {};
    dynamicSchema.fields.forEach((f) => {
      if (f.is_unique && f.id_mode === 'auto' && autoNextId) {
        initialAttrs[f.name] = autoNextId;
      } else {
        initialAttrs[f.name] = '';
      }
    });

    // ONLY populate linking attributes if the user explicitly enabled Linking Feature.
    // Nothing from the reference feature is copied wholesale; only the chosen
    // matching field value is written so both features share the same value.
    if (enableLayerLinking) {
      const reference = selectedLinkedFeature || linkedInfo || null;
      const sourceField = activeLayerLinkingIdField || '_id';
      const targetField = refLayerLinkingIdField || sourceField;
      const activeUniqueField = layerFields.find((f) => f.is_unique)?.name;

      if (reference) {
        const rawValue = (targetField === '_id' || targetField === 'id')
          ? (reference.featureId || reference.properties?._id || reference.properties?.id)
          : reference.properties?.[targetField];

        if (rawValue !== null && rawValue !== undefined && String(rawValue).trim() !== '') {
          const strVal = String(rawValue).trim();
          const typedVal = (typeof rawValue === 'number' || (/^\d+$/.test(strVal) && !strVal.startsWith('0'))) ? Number(rawValue) : strVal;

          // The link contract is the same value in the same chosen field; never
          // overwrite the active layer's unique identifier with a foreign value.
          if (
            sourceField !== '_id' && sourceField !== 'id'
            && sourceField !== activeUniqueField
            && Object.prototype.hasOwnProperty.call(initialAttrs, sourceField)
          ) {
            initialAttrs[sourceField] = typedVal;
          }

          if (reference.featureId) {
            initialAttrs['_target_feature_id'] = reference.featureId;
          }

          const targetLinkedLayer = serverVectors.find((l) => String(l.id) === String(reference.layerId));
          if (targetLinkedLayer) {
            const cleanName = targetLinkedLayer.name.replace(/[^\p{L}\p{N}_]/gu, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
            initialAttrs[`${cleanName || 'target'}_linked_id`] = typedVal;
          }
        }
      }
    }

    setEditingGeometry(geometry);
    setActiveLayerFormSchema(dynamicSchema);
    setInitialFormAttributes(initialAttrs);
    setFormLayerId(targetLayer?.id || activeTargetId);
    setDrawMode(null);
    try {
      if (typeof window !== 'undefined') {
        const draftObj = {
          id: 'draft_' + Date.now(),
          projectId: activeProject?.id || null,
          layerId: activeTargetId || null,
          layerName: targetLayer?.name || 'फिचर तह',
          geometry,
          geometryType: geometry?.type || 'POINT',
          answers: initialAttrs || {},
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem('kmc_unfinished_feature_creation_draft', JSON.stringify(draftObj));
      }
    } catch (e) {}
    setShowForm(true);
  }, [drawingTaskBoundary, activeProject, activeLayerId, selectedLinkedFeature, enableLayerLinking, refLayerId, refLayerLinkingIdField, activeLayerLinkingIdField, serverVectors]);

  // Only reset pick mode if user changed draw mode to another tool, not when sketch finishes
  useEffect(() => {
    if (drawMode !== null) {
      setPickFeatureMode(false);
    }
  }, [drawMode]);

  // ---- Form submit ----
  const handleFormSubmit = useCallback(async (attributes, isDraft = false) => {
    // Write to the layer the geometry was actually drawn on (formLayerId or edit layer wins).
    const targetLid = formLayerId || (editMode && editLayerId ? editLayerId : activeLayerId);
    if (!editingGeometry || !targetLid) return;

    setFormSaving(true);
    try {
      const finalAttrs = { ...(attributes || {}) };
      if (isCollector && user?.username) {
        finalAttrs['Kmc_Editor'] = user.username;
      }
      finalAttrs['_status'] = isDraft ? 'DRAFT' : (finalAttrs['_status'] || 'SUBMITTED');
      const payloadBody = {
        layer_id: targetLid,
        geom_geojson: editingGeometry,
        properties: finalAttrs,
        collector_lat: gpsPosition?.lat,
        collector_lng: gpsPosition?.lng,
      };

      const linkTargetFid = selectedLinkedFeature?.featureId || finalAttrs['_target_feature_id'];
      if (linkTargetFid) {
        const sourceField = activeLayerLinkingIdField || null;
        const targetField = refLayerLinkingIdField || sourceField;
        payloadBody.link_to = {
          target_feature_id: linkTargetFid,
          target_layer_id: selectedLinkedFeature?.layerId || null,
          source_link_attribute: sourceField,
          target_link_attribute: targetField,
          link_attribute: sourceField || targetField,
          relationship_type: 'connected_to',
        };
      }

      const createRes = await featuresAPI.create(payloadBody);
      const newFeature = createRes.data;

      // Optimistically append the newly created feature into serverVectors right away
      if (newFeature) {
        setServerVectors((prev) =>
          prev.map((v) => {
            if (String(v.id) === String(targetLid)) {
              const currentFeatures = Array.isArray(v.features)
                ? [...v.features]
                : (Array.isArray(v.features?.features) ? [...v.features.features] : []);
              return {
                ...v,
                features: {
                  type: 'FeatureCollection',
                  features: [...currentFeatures, newFeature],
                },
                tile_version: (v.tile_version || 0) + 1,
                _v: Date.now(),
              };
            }
            return v;
          })
        );
        setGeometryUpdateTrigger({
          featureId: newFeature.id || newFeature.properties?._id,
          layerId: targetLid,
          geometry: newFeature.geometry,
          properties: newFeature.properties,
          timestamp: Date.now(),
        });
      }

      // Close form and reset feature capture states immediately without delay
      if (typeof window !== 'undefined') {
        localStorage.removeItem('kmc_unfinished_feature_creation_draft');
      }
      setUnfinishedDraft(null);
      setShowForm(false);
      setEditingGeometry(null);
      setFormLayerId(null);
      setInitialFormAttributes({});
      setActiveLayerFormSchema(null);
      setSelectedLinkedFeature(null);
      setPickFeatureMode(false);
      setEnableLayerLinking(false);
      setDrawMode(null);
      if (isDraft) {
        alert('मस्यौदा फिचर सफलतापूर्वक सुरक्षित गरियो (Draft feature saved successfully)!');
      }

      // Trigger bbox reload for bbox-mode layers
      setBboxReloadTrigger({ layerId: targetLid, timestamp: Date.now() });

      // Refresh authoritative layer GeoJSON in background without blocking UI
      const linkedLayerId = selectedLinkedFeature?.layerId;
      (async () => {
        try {
          const res = await featuresAPI.list(targetLid);
          let featureData = res.data;
          if (Array.isArray(featureData)) {
            featureData = { type: 'FeatureCollection', features: featureData };
          }

          let linkedLayerData = null;
          if (linkedLayerId && String(linkedLayerId) !== String(targetLid)) {
            try {
              const lRes = await featuresAPI.list(linkedLayerId);
              linkedLayerData = Array.isArray(lRes.data)
                ? { type: 'FeatureCollection', features: lRes.data }
                : lRes.data;
            } catch (e) {
              console.warn('Failed to refresh linked layer in background:', e);
            }
          }

          setServerVectors((prev) =>
            prev.map((v) => {
              if (String(v.id) === String(targetLid)) return { ...v, features: featureData };
              if (linkedLayerData && String(v.id) === String(linkedLayerId)) return { ...v, features: linkedLayerData };
              return v;
            })
          );
        } catch (syncErr) {
          console.warn('Background sync after feature creation:', syncErr);
        }
      })();
    } catch (err) {
      alert(formatApiError(err, 'तथ्याङ्क सुरक्षित गर्न सकिएन'));
    } finally {
      setFormSaving(false);
    }
  }, [editingGeometry, activeLayerId, editMode, editLayerId, gpsPosition, selectedLinkedFeature, isCollector, user, activeLayerLinkingIdField, refLayerLinkingIdField]);

  // ---- Spatial Grid Boundary & Geofence Alert State ----
  const [gridAlert, setGridAlert] = useState(null);
  const gridAlertTimeoutRef = useRef(null);

  const handleFeatureBlocked = useCallback(({ reason, message }) => {
    if (gridAlertTimeoutRef.current) {
      clearTimeout(gridAlertTimeoutRef.current);
    }
    setGridAlert(message);
    gridAlertTimeoutRef.current = setTimeout(() => {
      setGridAlert(null);
    }, 4500);
  }, []);

  // Field users may only edit layers an admin explicitly unlocked; admins may
  // always edit. Everything else is viewer-only.
  const isLayerEditableForField = useCallback((layerId) => {
    if (isAdmin) return true;
    if (!isCollector && !isValidator) return false;
    const layer = serverVectors.find((l) => String(l.id) === String(layerId));
    return layer?.editable_by_collectors === true;
  }, [isAdmin, isCollector, isValidator, serverVectors]);

  // ---- Edit Mode Toggle ----
  const toggleEditMode = useCallback((targetLayerId = null) => {
    const requestedId =
      targetLayerId ||
      (editLayerId && serverVectors.some((l) => String(l.id) === String(editLayerId)) ? editLayerId : null) ||
      activeLayerId ||
      serverVectors.find((v) => v.visible !== false)?.id ||
      serverVectors[0]?.id ||
      null;
    if (!editMode && !isLayerEditableForField(requestedId)) {
      handleFeatureBlocked({
        reason: 'LAYER_LOCKED',
        message: '🔒 यो तह प्रशासकले सम्पादनका लागि खोलेको छैन — दर्शक मोड मात्र उपलब्ध छ। (This layer is locked by the admin; viewer mode only.)',
      });
      return;
    }
    setAttributePopupFeature(null);
    setEditMode((prev) => {
      const nextMode = !prev;
      if (nextMode) {
        if (isCollector && (!gpsPosition || gpsPosition.lat == null || gpsPosition.lng == null)) {
          handleFeatureBlocked({
            reason: 'NO_GPS',
            message: '⚠️ GPS स्थान प्राप्त हुन सकेन। सम्पादन मोड प्रयोग गर्न आफ्नो GPS सक्रिय गर्नुहोस्। (GPS position required to use Edit Mode.)',
          });
          return false;
        }
        setDrawMode(null);
        setEditToolsCollapsed(false);
        setEditSubMode(null);
        const visibleLayers = serverVectors.filter((v) => v.visible !== false);
        const target =
          targetLayerId ||
          (editLayerId && visibleLayers.some((l) => String(l.id) === String(editLayerId)) ? editLayerId : null) ||
          activeLayerId ||
          (visibleLayers[0]?.id || serverVectors[0]?.id || null);
        setEditLayerId(target);
        setUndoStack([]);
        setRedoStack([]);

        // If a feature is already open in inspector popup, directly unlock it for edit mode
        if (attributePopupFeature) {
          setSelectedFeature(attributePopupFeature);
          setAttributePopupFeature(null);
        }

        if (target) {
          // Ensure target layer is visible & loaded
          setServerVectors((current) =>
            current.map((v) => {
              if (v.id === target) {
                if (!v.features) {
                  featuresAPI.list(target).then((res) => {
                    let featureData = res.data;
                    if (featureData && !featureData.type && Array.isArray(featureData)) {
                      featureData = { type: 'FeatureCollection', features: featureData };
                    }
                    setServerVectors((cur) =>
                      cur.map((item) => (item.id === target ? { ...item, features: featureData } : item))
                    );
                  });
                }
                return { ...v, visible: true, lastActivatedAt: v.lastActivatedAt || Date.now() };
              }
              return v;
            })
          );
        }
      } else {
        if (selectedFeature && selectedFeature.originalGeom && selectedFeature.isModified) {
          setGeometryUpdateTrigger({
            featureId: selectedFeature.id,
            geometry: selectedFeature.originalGeom,
            timestamp: Date.now(),
          });
        }
        setSelectedFeature(null);
        setAttributePopupFeature(null);
        setEditSubMode(null);
        setUndoStack([]);
        setRedoStack([]);
      }
      return nextMode;
    });
  }, [editMode, editLayerId, activeLayerId, serverVectors, isCollector, gpsPosition, handleFeatureBlocked, selectedFeature, attributePopupFeature, isLayerEditableForField]);

  // ---- Feature Inspection Handlers (Non-Edit Mode) ----
  const handleFeatureInspect = useCallback((feat) => {
    if (editMode || drawMode) return;
    if (!feat) {
      setAttributePopupFeature(null);
      return;
    }
    setAttributePopupFeature({ ...feat, sourceMode: 'inspect' });
    const featId = feat.id || feat.properties?.id || feat.properties?._id;
    if (featId) {
      featuresAPI.get(featId).then((res) => {
        if (res.data?.properties) {
          setAttributePopupFeature((prev) => {
            if (prev && String(prev.id) === String(featId)) {
              return {
                ...prev,
                properties: { ...res.data.properties, ...(prev.properties || {}) },
              };
            }
            return prev;
          });
        }
      }).catch(() => {});
    }
  }, [editMode, drawMode]);

  const handleZoomToInspectedFeature = useCallback((geometry, extent) => {
    if (extent && Array.isArray(extent)) {
      setZoomTarget({ type: 'extent', bounds: extent, timestamp: Date.now() });
      return;
    }
    if (geometry && geometry.coordinates) {
      const coords = [];
      const extractCoords = (c) => {
        if (!Array.isArray(c)) return;
        if (typeof c[0] === 'number') coords.push(c);
        else c.forEach(extractCoords);
      };
      extractCoords(geometry.coordinates);
      if (coords.length > 0) {
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        coords.forEach(([lng, lat]) => {
          if (typeof lng !== 'number' || typeof lat !== 'number') return;
          const x = (lng * 20037508.34) / 180;
          const clampedLat = Math.max(-89.9, Math.min(89.9, lat));
          let y = Math.log(Math.tan(((90 + clampedLat) * Math.PI) / 360)) / (Math.PI / 180);
          y = (y * 20037508.34) / 180;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        });
        if (minX !== Infinity && isFinite(minX)) {
          if (minX === maxX && minY === maxY) {
            minX -= 50;
            maxX += 50;
            minY -= 50;
            maxY += 50;
          }
          setZoomTarget({ type: 'extent', bounds: [minX, minY, maxX, maxY], timestamp: Date.now() });
        }
      }
    }
  }, []);

  const handleToggleViewEdits = useCallback((layerId) => {
    setServerVectors((prev) =>
      prev.map((v) => (v.id === layerId ? { ...v, viewEdits: !v.viewEdits } : v))
    );
  }, []);

  const handleToggleMyEdits = useCallback((layerId) => {
    setServerVectors((prev) =>
      prev.map((v) => {
        if (v.id !== layerId) return v;
        const isMyEditsActive = v.viewEdits && Array.isArray(v.selectedCollectors) && v.selectedCollectors.length === 1 && v.selectedCollectors[0] === 'my_edits';
        if (isMyEditsActive) {
          return { ...v, viewEdits: false };
        } else {
          return { ...v, viewEdits: true, selectedCollectors: ['my_edits'], editCollectorId: 'my_edits' };
        }
      })
    );
  }, []);

  const handleToggleCollectorInLayer = useCallback((layerId, collectorKey) => {
    setServerVectors((prev) =>
      prev.map((v) => {
        if (v.id !== layerId) return v;
        const current = Array.isArray(v.selectedCollectors) ? v.selectedCollectors : ['all'];
        let updated;
        if (current.includes('all')) {
          updated = [collectorKey];
        } else if (current.includes(collectorKey)) {
          updated = current.filter((k) => k !== collectorKey);
        } else {
          updated = [...current.filter((k) => k !== 'my_edits'), collectorKey];
        }
        return {
          ...v,
          selectedCollectors: updated,
          editCollectorId: updated[0] || 'all',
          viewEdits: true,
        };
      })
    );
  }, []);

  const handleSetLayerCollectors = useCallback((layerId, collectorKeys) => {
    setServerVectors((prev) =>
      prev.map((v) => {
        if (v.id !== layerId) return v;
        return {
          ...v,
          selectedCollectors: collectorKeys,
          editCollectorId: collectorKeys[0] || 'all',
          viewEdits: true,
        };
      })
    );
  }, []);

  const handleChangeEditCollector = useCallback((layerId, collectorId) => {
    setServerVectors((prev) =>
      prev.map((v) => (v.id === layerId ? { ...v, editCollectorId: collectorId, selectedCollectors: [collectorId] } : v))
    );
  }, []);

  const handleZoomToLayerEditFeature = useCallback((geometry, extent, rawFeature) => {
    handleZoomToInspectedFeature(geometry, extent);
    if (rawFeature && layerEditsModalTarget) {
      setAttributePopupFeature({
        id: rawFeature.id || rawFeature.properties?._id,
        layerId: layerEditsModalTarget.id,
        layerName: layerEditsModalTarget.name || 'तह',
        geometryType: rawFeature.geometry?.type,
        properties: rawFeature.properties || {},
        geometry: rawFeature.geometry,
        extent: extent,
        isWithinAssignedGrid: true,
      });
    }
  }, [handleZoomToInspectedFeature, layerEditsModalTarget]);

  const activeModalLayer = useMemo(() => {
    if (!layerEditsModalTarget) return null;
    return serverVectors.find((l) => l.id === layerEditsModalTarget.id) || layerEditsModalTarget;
  }, [layerEditsModalTarget, serverVectors]);

  // ---- Vector Layer Feature Linking Modal State & Handlers ----
  const [showLinkModal, setShowLinkModal] = useState(false);
  const [linkModalSourceLayerId, setLinkModalSourceLayerId] = useState(null);

  const handleOpenLinkModal = useCallback((sourceLayer = null) => {
    const lid = (typeof sourceLayer === 'object' && sourceLayer !== null) ? sourceLayer.id : sourceLayer;
    setLinkModalSourceLayerId(lid || null);
    setShowLinkModal(true);
  }, []);

  const handleLayerLinkedSuccess = useCallback(async ({ sourceLayerId, targetLayerId, fieldName, linkedCount }) => {
    try {
      // Refresh features for source layer
      const res = await featuresAPI.list(sourceLayerId);
      let featureData = res.data;
      if (featureData && !featureData.type && Array.isArray(featureData)) {
        featureData = { type: 'FeatureCollection', features: featureData };
      }
      setServerVectors((prev) =>
        prev.map((v) => (v.id === sourceLayerId ? { ...v, features: featureData, visible: true } : v))
      );

      // If inspected feature is from source layer, update its properties
      if (attributePopupFeature && attributePopupFeature.layerId === sourceLayerId) {
        const updatedFeat = featureData?.features?.find((f) => (f.id || f.properties?._id) === attributePopupFeature.id);
        if (updatedFeat) {
          setAttributePopupFeature((prev) => ({
            ...prev,
            properties: updatedFeat.properties || {},
          }));
        }
      }
    } catch (err) {
      console.error('Failed to reload linked layer features:', err);
    }
  }, [attributePopupFeature]);

  const handleInspectLinkedFeature = useCallback(async (linkedItem) => {
    if (!linkedItem) return;
    const targetLayerId = linkedItem.layer_id;
    const targetFeatureId = linkedItem.feature_id;

    if (targetLayerId) {
      let targetFeaturesCollection = null;
      const targetLayer = serverVectors.find((v) => v.id === targetLayerId);
      if (targetLayer && targetLayer.features) {
        targetFeaturesCollection = targetLayer.features;
      } else {
        try {
          const res = await featuresAPI.list(targetLayerId);
          targetFeaturesCollection = res.data?.features ? res.data : { type: 'FeatureCollection', features: res.data || [] };
          setServerVectors((prev) =>
            prev.map((v) => (v.id === targetLayerId ? { ...v, features: targetFeaturesCollection, visible: true } : v))
          );
        } catch (err) {
          console.error('Failed to load target layer for linked inspection:', err);
        }
      }

      setServerVectors((prev) =>
        prev.map((v) => (v.id === targetLayerId ? { ...v, visible: true } : v))
      );

      let targetGeom = linkedItem.geom_geojson;
      if (!targetGeom && targetFeaturesCollection && targetFeaturesCollection.features) {
        const found = targetFeaturesCollection.features.find((f) => (f.id || f.properties?._id) === targetFeatureId);
        if (found) targetGeom = found.geometry;
      }

      if (targetGeom) {
        setZoomTarget({ type: 'geometry', geometry: targetGeom, timestamp: Date.now() });
      }

      if (targetFeaturesCollection && targetFeaturesCollection.features) {
        const found = targetFeaturesCollection.features.find((f) => (f.id || f.properties?._id) === targetFeatureId);
        if (found) {
          setAttributePopupFeature({
            id: found.id || found.properties?._id,
            layerId: targetLayerId,
            layerName: linkedItem.layer_name || targetLayer?.name || 'Target Layer',
            geometryType: found.geometry?.type,
            properties: found.properties || {},
            geometry: found.geometry,
          });
          return;
        }
      }
    }

    if (linkedItem.geom_geojson) {
      setZoomTarget({ type: 'geometry', geometry: linkedItem.geom_geojson, timestamp: Date.now() });
    }
  }, [serverVectors]);

  // Auto-sync editLayerId to only visible vector layers
  // Uses String() comparison to avoid type mismatches (string vs number IDs)
  useEffect(() => {
    if (editMode) {
      const visibleLayers = serverVectors.filter((v) => v.visible !== false);
      if (visibleLayers.length > 0) {
        const editLayerStr = editLayerId != null ? String(editLayerId) : null;
        if (!editLayerStr || !visibleLayers.some((l) => String(l.id) === editLayerStr)) {
          setEditLayerId(visibleLayers[0].id);
          setSelectedFeature(null);
          setUndoStack([]);
          setRedoStack([]);
        }
      } else if (editLayerId) {
        setEditLayerId(null);
        setSelectedFeature(null);
        setUndoStack([]);
        setRedoStack([]);
      }
    }
  }, [serverVectors, editMode, editLayerId]);

  // ---- Feature Selection & Spatial Modification Handlers ----
  const handleFeatureSelect = useCallback((feat) => {
    if (!feat) {
      setSelectedFeature(null);
      setAttributePopupFeature(null);
      return;
    }
    if (isCollector && feat) {
      const geom = feat.geometry || feat.originalGeom || feat.currentGeom;
      if (!gpsPosition || gpsPosition.lat == null || gpsPosition.lng == null) {
        handleFeatureBlocked({
          reason: 'NO_GPS',
          message: '⚠️ GPS स्थान प्राप्त हुन सकेन। सम्पादन गर्न ५० मिटर भित्र हुनुपर्छ। (GPS position required. Must be within 50m to edit.)',
        });
        return;
      }
      if (geom) {
        const dist = getDistanceToGeoJsonGeometry(gpsPosition.lat, gpsPosition.lng, geom);
        if (dist > GEOFENCE_EDIT_RADIUS_METERS) {
          handleFeatureBlocked({
            reason: 'OUTSIDE_GPS_50M',
            message: `⚠️ तपाईं यो फिचरबाट ${Math.round(dist)} मिटर टाढा हुनुहुन्छ। सम्पादन गर्न ५० मिटर भित्र हुनुपर्छ। सम्पादन मोड खोलिएन। (You are ${Math.round(dist)}m away from this feature. You must be within 50m to edit.)`,
          });
          return;
        }
      }
    }
    if (feat.layerId && feat.layerId !== editLayerId) {
      setEditLayerId(feat.layerId);
    }
    setSelectedFeature(feat);
    setUndoStack([]);
    setRedoStack([]);
    setAttributePopupFeature(null);
  }, [isCollector, gpsPosition, handleFeatureBlocked, editLayerId]);

  const handleFeatureModifyEnd = useCallback((featureId, newGeometry, isWithin = true) => {
    if (!newGeometry) return;
    const prev = selectedFeatureRef.current;
    if (!prev) return;
    // Only apply geometry updates that belong to the feature currently in the panel.
    const prevId = prev.id;
    if (prevId != null && featureId != null && String(prevId) !== String(featureId)) {
      return;
    }

    const prevGeom = prev.currentGeom || prev.originalGeom;
    const geometryChanged = !prevGeom || JSON.stringify(prevGeom) !== JSON.stringify(newGeometry);

    if (!geometryChanged) {
      // Re-adding the same vertex (e.g. a tap) must not pollute the undo stack.
      if (prev.isWithinAssignedGrid !== isWithin) {
        setSelectedFeature((current) => (current ? { ...current, isWithinAssignedGrid: isWithin } : current));
      }
      return;
    }

    const nextIsModified = JSON.stringify(newGeometry) !== JSON.stringify(prev.originalGeom);
    // State updaters must stay pure: push history and replace geometry here, not inside one.
    setUndoStack((current) => [...current, prevGeom]);
    setRedoStack([]);
    setSelectedFeature((current) =>
      current
        ? {
            ...current,
            currentGeom: newGeometry,
            isModified: nextIsModified,
            isWithinAssignedGrid: isWithin,
          }
        : current
    );
  }, []);

  // ---- Undo Action (Restores previous geometry state) ----
  const handleUndo = useCallback(() => {
    if (undoStack.length === 0 || !selectedFeature) return;
    const prevGeom = undoStack[undoStack.length - 1];
    const newUndoStack = undoStack.slice(0, -1);
    const currentGeom = selectedFeature.currentGeom || selectedFeature.originalGeom;

    setUndoStack(newUndoStack);
    setRedoStack((r) => [...r, currentGeom]);

    const isStillModified = JSON.stringify(prevGeom) !== JSON.stringify(selectedFeature.originalGeom);

    setSelectedFeature((prev) =>
      prev
        ? {
            ...prev,
            currentGeom: prevGeom,
            isModified: isStillModified,
          }
        : null
    );

    setGeometryUpdateTrigger({
      featureId: selectedFeature.id,
      geometry: prevGeom,
      timestamp: Date.now(),
    });
  }, [undoStack, selectedFeature]);

  // ---- Redo Action (Re-applies undone geometry state) ----
  const handleRedo = useCallback(() => {
    if (redoStack.length === 0 || !selectedFeature) return;
    const nextGeom = redoStack[redoStack.length - 1];
    const newRedoStack = redoStack.slice(0, -1);
    const currentGeom = selectedFeature.currentGeom || selectedFeature.originalGeom;

    setRedoStack(newRedoStack);
    setUndoStack((u) => [...u, currentGeom]);

    const isStillModified = JSON.stringify(nextGeom) !== JSON.stringify(selectedFeature.originalGeom);

    setSelectedFeature((prev) =>
      prev
        ? {
            ...prev,
            currentGeom: nextGeom,
            isModified: isStillModified,
          }
        : null
    );

    setGeometryUpdateTrigger({
      featureId: selectedFeature.id,
      geometry: nextGeom,
      timestamp: Date.now(),
    });
  }, [redoStack, selectedFeature]);

  const handleFeatureRevert = useCallback(() => {
    if (!selectedFeature) return;
    const currentGeom = selectedFeature.currentGeom || selectedFeature.originalGeom;
    if (currentGeom && JSON.stringify(currentGeom) !== JSON.stringify(selectedFeature.originalGeom)) {
      setUndoStack((u) => [...u, currentGeom]);
      setRedoStack([]);
    }
    setSelectedFeature((prev) =>
      prev ? { ...prev, currentGeom: prev.originalGeom, isModified: false } : null
    );
    setGeometryUpdateTrigger({
      featureId: selectedFeature.id,
      geometry: selectedFeature.originalGeom,
      timestamp: Date.now(),
    });
  }, [selectedFeature]);

  // ---- Close / Cancel Feature Editing with Immediate Map Reversion ----
  const handleCloseEdit = useCallback(() => {
    if (selectedFeature) {
      if (selectedFeature.originalGeom) {
        setGeometryUpdateTrigger({
          featureId: selectedFeature.id,
          geometry: selectedFeature.originalGeom,
          timestamp: Date.now(),
        });
      }
    }
    setSelectedFeature(null);
    setEditMode(false);
    setEditSubMode(null);
    setUndoStack([]);
    setRedoStack([]);
  }, [selectedFeature]);

  // ---- Remove Last Vertex from Selected Feature (Pop Last Vertex) ----
  const handleRemoveLastVertex = useCallback(() => {
    if (!selectedFeature) return;
    const currentGeom = selectedFeature.currentGeom || selectedFeature.originalGeom;
    if (!currentGeom) return;

    // Ring/part-aware: polygons drop their last real vertex (never the closing
    // duplicate) and the engine refuses to make the geometry invalid.
    const result = removeLastVertex(currentGeom);
    if (!result.ok) {
      alert(describeEditFailure(result.reason));
      return;
    }

    handleFeatureModifyEnd(selectedFeature.id, result.geometry);
    setGeometryUpdateTrigger({
      featureId: selectedFeature.id,
      geometry: result.geometry,
      timestamp: Date.now(),
    });
  }, [selectedFeature, handleFeatureModifyEnd]);

  // ---- Global Backspace & Keyboard Shortcuts for Undo/Redo in Edit Mode & Draw Mode ----
  useEffect(() => {
    if ((!editMode || !selectedFeature) && (!drawMode || drawUndoCount === 0)) return;

    const handleKeyDown = (e) => {
      // Do not intercept if focus is inside any text input or textarea
      const tag = e.target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target?.isContentEditable) {
        return;
      }

      // Backspace key for Undo
      if (e.key === 'Backspace') {
        e.preventDefault();
        if (editMode && selectedFeature) {
          handleUndo();
        } else if (drawMode) {
          handleDrawUndo();
        }
        return;
      }

      // Ctrl+Z or Cmd+Z for Undo, Ctrl+Shift+Z for Redo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) {
          if (editMode && selectedFeature) handleRedo();
          else if (drawMode) handleDrawRedo();
        } else {
          if (editMode && selectedFeature) handleUndo();
          else if (drawMode) handleDrawUndo();
        }
        return;
      }

      // Ctrl+Y or Cmd+Y for Redo
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        if (editMode && selectedFeature) handleRedo();
        else if (drawMode) handleDrawRedo();
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [editMode, drawMode, selectedFeature, drawUndoCount, handleUndo, handleRedo, handleDrawUndo, handleDrawRedo]);

  const handleSaveFeature = useCallback(async (payload) => {
    if (!payload || !payload.id) return;
    setFeatureSaving(true);
    try {
      const updatedProps = { ...(payload.properties || {}) };
      if (isCollector && user?.username) {
        updatedProps['Kmc_Editor'] = user.username;
      }
      const updateBody = {
        // Pin the write to this layer: imported layers reuse feature ids (1..N).
        layer_id: payload.layer_id || payload.properties?._layer_id || editLayerId,
        properties: updatedProps,
        geom_geojson: payload.geometry,
        collector_lat: gpsPosition?.lat || null,
        collector_lng: gpsPosition?.lng || null,
      };
      const res = await featuresAPI.update(payload.id, updateBody);

      const returnedProps = res.data?.properties || updatedProps;
      const returnedGeom = res.data?.geometry || payload.geometry;
      const targetLid = payload.layer_id || payload.properties?._layer_id || editLayerId;

      // 1. Immediately trigger instant map canvas feature update with 0ms latency
      setGeometryUpdateTrigger({
        featureId: payload.id,
        layerId: targetLid,
        geometry: returnedGeom,
        properties: returnedProps,
        timestamp: Date.now(),
      });

      // 2. Update in serverVectors state (handles both GeoJSON arrays & FeatureCollection objects)
      setServerVectors((prev) =>
        prev.map((v) => {
          if (String(v.id) === String(targetLid)) {
            let updatedFeatures = v.features;
            if (Array.isArray(v.features)) {
              updatedFeatures = v.features.map((f) => {
                const fid = f.id || f.properties?._id;
                if (String(fid) === String(payload.id)) {
                  return {
                    ...f,
                    geometry: returnedGeom,
                    properties: { ...(f.properties || {}), ...returnedProps },
                  };
                }
                return f;
              });
            } else if (v.features?.features && Array.isArray(v.features.features)) {
              updatedFeatures = {
                ...v.features,
                features: v.features.features.map((f) => {
                  const fid = f.id || f.properties?._id;
                  if (String(fid) === String(payload.id)) {
                    return {
                      ...f,
                      geometry: returnedGeom,
                      properties: { ...(f.properties || {}), ...returnedProps },
                    };
                  }
                  return f;
                }),
              };
            }
            return {
              ...v,
              features: updatedFeatures,
              tile_version: (v.tile_version || 0) + 1,
              _v: Date.now(),
            };
          }
          return v;
        })
      );

      // 3. Invalidate vector tile & bbox query caches
      setBboxReloadTrigger({ layerId: targetLid, featureId: payload.id, timestamp: Date.now() });

      setSelectedFeature((prev) =>
        prev
          ? {
              ...prev,
              properties: { ...(prev.properties || {}), ...returnedProps },
              originalGeom: returnedGeom,
              currentGeom: returnedGeom,
              isModified: false,
            }
          : null
      );

      // Non-blocking Save Success Floating Toast
      setSaveSuccessToast({
        id: payload.id,
        timestamp: Date.now(),
      });
      setTimeout(() => setSaveSuccessToast(null), 3000);
    } catch (err) {
      console.error('Failed to save feature:', err);
      alert(`विशेषता सुरक्षित गर्न असफल भयो: ${formatApiError(err, err.message)}`);
    } finally {
      setFeatureSaving(false);
    }
  }, [editLayerId, gpsPosition, isCollector, user, selectedFeature]);

  const handleDeleteFeature = useCallback(async (featureId, layerId = null) => {
    if (!featureId) return;
    setFeatureDeleting(true);
    try {
      await featuresAPI.delete(featureId, layerId || editLayerId);
      const targetLid = layerId || editLayerId || activeLayerId;
      // Trigger map cache expiration and immediate tile/source removal across all vector modes
      if (targetLid) {
        setBboxReloadTrigger({ layerId: targetLid, featureId, timestamp: Date.now() });
      }
      setServerVectors((prev) =>
        prev.map((v) => {
          const matches = !layerId || String(v.id) === String(layerId);
          if (matches) {
            let updatedFeatures = v.features;
            if (Array.isArray(v.features)) {
              updatedFeatures = v.features.filter((f) => {
                const fid = f.id || f.properties?._id;
                return String(fid) !== String(featureId);
              });
            } else if (v.features?.features && Array.isArray(v.features.features)) {
              updatedFeatures = {
                ...v.features,
                features: v.features.features.filter((f) => {
                  const fid = f.id || f.properties?._id;
                  return String(fid) !== String(featureId);
                }),
              };
            }
            return {
              ...v,
              features: updatedFeatures,
              tile_version: (v.tile_version || 0) + 1,
              _v: Date.now(),
            };
          }
          return v;
        })
      );
      setSelectedFeature(null);
      setAttributePopupFeature(null);
      setEditMode(false);
    } catch (err) {
      console.error('Failed to delete feature:', err);
      alert(`वस्तु मेटाउन असफल भयो: ${formatApiError(err, err.message)}`);
    } finally {
      setFeatureDeleting(false);
    }
  }, [serverVectors, editLayerId]);

  // ---- Reload a vector layer's features (bbox layers refresh their viewport source) ----
  const reloadVectorLayerFeatures = useCallback(async (layerId) => {
    if (!layerId) return;
    const layer = serverVectors.find((v) => String(v.id) === String(layerId));
    const isLarge = layer ? (layer.bboxMode || (layer.feature_count ?? 0) > BBOX_FEATURE_THRESHOLD) : false;
    if (isLarge) {
      setBboxReloadTrigger({ layerId, timestamp: Date.now() });
      return;
    }
    try {
      const res = await featuresAPI.list(layerId);
      setServerVectors((prev) =>
        prev.map((v) => (String(v.id) === String(layerId) ? { ...v, features: res.data } : v))
      );
    } catch (err) {
      console.warn('Failed to reload layer features:', err);
    }
  }, [serverVectors]);

  // ---- Viewport (bbox) feature loader for large layers ----
  const handleBboxLoadFeatures = useCallback(async (layerId, bboxStr, zoom, options) => {
    const res = await featuresAPI.list(layerId, bboxStr, zoom, options);
    return res.data;
  }, []);

  // ---- QGIS-style SPLIT: blade drawn across the selected feature ----
  const handleSplitBladeDrawn = useCallback(async (blade) => {
    setSplitBladeMode(false);
    const targetId = selectedFeature?.id || selectedFeature?.properties?._id || selectedFeature?.properties?.id;
    const targetLid = selectedFeature?.layerId || selectedFeature?.layer_id || selectedFeature?.properties?.layer_id || editLayerId;
    if (!targetId) {
      alert('कृपया पहिले विभाजन गर्नुपर्ने फिचर छान्नुहोस्।');
      return;
    }
    setSplitMerging(true);
    try {
      const bladePayload = (blade && blade.type) ? { blade, layer_id: targetLid } : { ...(blade || {}), layer_id: targetLid };
      const res = await featuresAPI.splitPreview(targetId, bladePayload);
      setSplitModalData(res.data);
      setShowSplitModal(true);
    } catch (err) {
      console.error('Split preview failed:', err);
      alert(err.response?.data?.detail || 'विभाजन रेखा (Blade) ले छानिएको ज्यामितिलाई पूर्ण २ भागमा काटेको छैन। कृपया दुवै छेउ पार हुने गरी लामो रेखा खिच्नुहोस्।');
    } finally {
      setSplitMerging(false);
    }
  }, [selectedFeature, editLayerId]);

  const handleStartMultipartSplit = useCallback(async (feat, lyr) => {
    const featId = feat?.id || feat?.properties?._id || feat?.properties?.id;
    if (!featId) return;
    const targetLayerId = lyr?.id || feat?.layerId || feat?.layer_id || feat?.properties?.layer_id || editLayerId;
    if (targetLayerId) setEditLayerId(targetLayerId);
    setSelectedFeature(feat);
    setSplitMerging(true);
    try {
      const res = await featuresAPI.splitPreview(featId, { split_multipart: true, layer_id: targetLayerId });
      setSplitModalData(res.data);
      setShowSplitModal(true);
    } catch (err) {
      console.error('Multipart split preview failed:', err);
      alert(err.response?.data?.detail || 'मल्टिपार्ट विभाजन पूर्वावलोकन लोड हुन सकेन।');
    } finally {
      setSplitMerging(false);
    }
  }, [editLayerId]);

  const handleConfirmSplit = useCallback(async (partsOrPayload) => {
    const parts = Array.isArray(partsOrPayload) ? partsOrPayload : (partsOrPayload?.parts || []);
    const targetId = (partsOrPayload && !Array.isArray(partsOrPayload) && partsOrPayload.originalFeatureId) || splitModalData?.feature_id || selectedFeature?.id || selectedFeature?.properties?._id || selectedFeature?.properties?.id;
    const targetLayerId = (partsOrPayload && !Array.isArray(partsOrPayload) && partsOrPayload.layerId) || splitModalData?.layer_id || selectedFeature?.layerId || selectedFeature?.properties?.layer_id || editLayerId;

    if (!targetId) {
      alert('विभाजन गर्न छानिएको फिचर ID फेला परेन।');
      return;
    }
    setSplitMerging(true);
    try {
      const res = await featuresAPI.splitConfirm(targetId, { parts, layer_id: targetLayerId });
      const newFeatures = res.data?.new_features || [];

      // Instantly reflect split in serverVectors state in real-time
      setServerVectors((prev) =>
        prev.map((v) => {
          if (String(v.id) === String(targetLayerId)) {
            const currentFeatures = Array.isArray(v.features)
              ? v.features
              : (Array.isArray(v.features?.features) ? v.features.features : []);
            const newIds = new Set(newFeatures.map((nf) => String(nf.id || nf.properties?._id)));
            const filtered = currentFeatures.filter((f) => {
              const fid = String(f.id || f.properties?._id);
              return fid !== String(targetId) && !newIds.has(fid);
            });
            return {
              ...v,
              features: {
                type: 'FeatureCollection',
                features: [...filtered, ...newFeatures],
              },
              tile_version: (v.tile_version || 0) + 1,
              _v: Date.now(),
            };
          }
          return v;
        })
      );

      setShowSplitModal(false);
      setSplitModalData(null);
      setSelectedFeature(null);
      setAttributePopupFeature(null);
      setEditSubMode(null);
      setBboxReloadTrigger({ layerId: targetLayerId, timestamp: Date.now() });
      await reloadVectorLayerFeatures(targetLayerId);
      alert('फिचर सफलतापूर्वक विभाजन गरियो! (Feature split confirmed successfully)');
    } catch (err) {
      console.error('Split confirm failed:', err);
      alert(err.response?.data?.detail || 'विभाजन सुरक्षित गर्न सकिएन।');
    } finally {
      setSplitMerging(false);
    }
  }, [selectedFeature, editLayerId, splitModalData, reloadVectorLayerFeatures]);

  // ---- QGIS-style MERGE: toggle picked features ----
  const handleMergeToggleFeature = useCallback((featObj) => {
    const id = featObj?.id;
    if (id == null) return;
    const s = String(id);
    setMergeSelection((prev) => {
      const exists = prev.map(String).includes(s);
      return exists ? prev.filter((x) => String(x) !== s) : [...prev, id];
    });
    setMergeFeaturesMap((prev) => {
      const next = { ...prev };
      if (next[s]) {
        delete next[s];
      } else {
        next[s] = featObj;
      }
      return next;
    });
  }, []);

  const handleMergeConfirm = useCallback(() => {
    const targetLid = editLayerId || activeLayerId || (mergeSelection.length > 0 && mergeFeaturesMap[String(mergeSelection[0])]?.layerId);
    if (mergeSelection.length < 2 || !targetLid) {
      alert('एकीकरण (Merge) का लागि कम्तीमा २ फिचरहरू छान्न आवश्यक छ।');
      return;
    }
    if (!editLayerId && targetLid) setEditLayerId(targetLid);
    setShowMergeModal(true);
  }, [mergeSelection, editLayerId, activeLayerId, mergeFeaturesMap]);

  const handleConfirmMerge = useCallback(async (mergePayload) => {
    const targetLid = editLayerId || activeLayerId || (mergeSelection.length > 0 && mergeFeaturesMap[String(mergeSelection[0])]?.layerId);
    if (!targetLid) return;
    setSplitMerging(true);
    try {
      const res = await featuresAPI.merge(targetLid, mergePayload);
      const keptId = res.data?.feature_id;
      const mergedFeature = res.data?.feature;
      const mergedIds = new Set((mergePayload.feature_ids || []).map(String));

      // Instantly reflect merge in serverVectors state in real-time
      if (mergedFeature) {
        setServerVectors((prev) =>
          prev.map((v) => {
            if (String(v.id) === String(targetLid)) {
              const currentFeatures = Array.isArray(v.features)
                ? v.features
                : (Array.isArray(v.features?.features) ? v.features.features : []);
              const filtered = currentFeatures.filter(
                (f) => !mergedIds.has(String(f.id)) && !mergedIds.has(String(f.properties?._id))
              );
              return {
                ...v,
                features: {
                  type: 'FeatureCollection',
                  features: [...filtered, mergedFeature],
                },
                tile_version: (v.tile_version || 0) + 1,
                _v: Date.now(),
              };
            }
            return v;
          })
        );
      }

      setShowMergeModal(false);
      setMergeSelection([]);
      setMergeFeaturesMap({});
      setMergeSelectMode(false);
      setSelectedFeature(null);
      setAttributePopupFeature(null);
      setBboxReloadTrigger({ layerId: targetLid, timestamp: Date.now() });
      await reloadVectorLayerFeatures(targetLid);
      if (res.data?.warning) {
        alert(`⚠️ सूचना: ${res.data.warning}\n\nसफलतापूर्वक एकीकरण गरियो! फिचर #${keptId} सिर्जना भयो।`);
      } else {
        alert(`सफलतापूर्वक एकीकरण गरियो! छानिएका ${mergePayload.feature_ids?.length || 'सबै'} फिचरहरू #${keptId} मा जोडिए।`);
      }
    } catch (err) {
      console.error('Merge failed:', err);
      alert(err.response?.data?.detail || 'फिचर जोड्न सकिएन (Merge failed)');
    } finally {
      setSplitMerging(false);
    }
  }, [editLayerId, reloadVectorLayerFeatures]);

  // Clear split/merge modes when edit mode or the edit layer changes
  useEffect(() => {
    if (!editMode) {
      setSplitBladeMode(false);
      setMergeSelectMode(false);
      setMergeSelection([]);
      setEditSubMode(null);
    }
  }, [editMode, editLayerId]);

  // ---- Delete Project Handler (Admin) ----
  const handleDeleteProject = useCallback(async (projectId, projectName) => {
    if (!window.confirm(`के तपाईं निश्चित परियोजना '${projectName || projectId}' मेट्न चाहनुहुन्छ? (Are you sure you want to delete this project?)`)) {
      return;
    }
    try {
      await projectsAPI.delete(projectId);
      if (activeProject?.id === projectId) {
        setActiveProject(null);
      }
      const res = await projectsAPI.list();
      setProjects(res.data || []);
      loadAllLayers(null);
    } catch (err) {
      alert(formatApiError(err, 'परियोजना मेटाउन असफल भयो'));
    }
  }, [activeProject, loadAllLayers]);

  if (authLoading || !isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-screen bg-slate-100">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-4 border-gov-blue-800 border-t-transparent rounded-full animate-spin" />
          <p className="text-slate-700 text-xs font-semibold font-nepali">काठमाडौँ महानगरपालिका भू-सूचना प्रणाली...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col bg-slate-100 overflow-hidden font-sans pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]">
      {/* Official Nepal Government Masthead & Navigation with Module Switcher */}
      <Navbar
        activeProject={activeProject}
        onProjectSelect={handleProjectSelect}
        projects={projects}
        onDeleteProject={isAdmin ? handleDeleteProject : undefined}
        onOpenLayers={() => setShowLayerControl((prev) => !prev)}
        onOpenTasks={() => setShowTaskPanel(!showTaskPanel)}
        onOpenMyRecords={() => setShowMyRecords((prev) => !prev)}
        onOpenAdmin={() => setShowAdminPanel(!showAdminPanel)}
        isOnline={isOnline}
        activeModule={activeModule}
        onModuleChange={(mod) => setActiveModule(mod)}
      />

      {/* Module 1: GeoPortal & Dynamic GIS Dashboard */}
      {activeModule === 'geoportal' && (
        <div className="flex-1 relative overflow-hidden">
          <GeoPortalView user={user} isAdmin={isAdmin} />
        </div>
      )}

      {/* Module 2: Field Data Collection (Default Core Operational Workspace) */}
      {activeModule === 'field_data' && (
        <div className="flex-1 relative overflow-hidden">
          {/* OpenLayers Map Engine */}
          <KmcMap
          gpsPosition={gpsPosition}
          taskGrids={taskGrids}
          serverVectors={serverVectors}
          serverRasters={serverRasters}
          layerOrderingConfig={layerOrderingConfig}
          activeBasemap={activeBasemap}
          basemapOpacity={basemapOpacity}
          zoomTarget={zoomTarget}
          selectedTask={selectedTask}
          currentUser={user}
          isAdmin={isAdmin}
          onTaskClick={(task) => {
            setSelectedTask(task);
            setShowTaskPanel(true);
          }}
          onFeatureCreate={handleFeatureCreate}
          editingGeometry={editingGeometry}
          drawMode={drawMode}
          activeLayerId={activeLayerId}
          editMode={editMode}
          editLayerId={editLayerId}
          selectedFeature={selectedFeature}
          inspectedFeature={attributePopupFeature}
          selectedFeatureId={selectedFeature?.id}
          onFeatureSelect={handleFeatureSelect}
          onFeatureModifyEnd={handleFeatureModifyEnd}
          snappingEnabled={snappingEnabled}
          snapTolerance={snapTolerance}
          onSnappingToggle={() => setSnappingEnabled((prev) => !prev)}
          geometryUpdateTrigger={geometryUpdateTrigger}
          drawUndoTrigger={drawUndoTrigger}
          drawRedoTrigger={drawRedoTrigger}
          onDrawVertexChange={handleDrawVertexChange}
          onFeatureInspect={handleFeatureInspect}
          inspectedFeatureId={attributePopupFeature?.id}
          drawnBoundary={drawnTaskBoundary}
          isCollector={isCollector}
          onFeatureBlocked={handleFeatureBlocked}
          editSubMode={editSubMode}
          splitBladeMode={splitBladeMode}
          onSplitBladeDrawn={handleSplitBladeDrawn}
          mergeSelectMode={mergeSelectMode}
          mergeSelection={mergeSelection}
          onMergeToggleFeature={handleMergeToggleFeature}
          onBboxLoadFeatures={handleBboxLoadFeatures}
          bboxReloadTrigger={bboxReloadTrigger}
          outlinedTaskIds={outlinedTaskIds}
          outlineAllTasks={outlineAllTasks}
          showTaskGrids={showTaskGrids}
          showAoiBoundary={showAoiBoundary}
          isTaskPanelOpen={showTaskPanel}
          aoiBoundary={activeProject?.boundary_geojson || activeProject?.aoi_geojson || null}
          pickLinkedFeatureMode={pickFeatureMode}
          selectedLinkedFeatureId={selectedLinkedFeature?.featureId}
          selectedLinkedLayerId={selectedLinkedFeature?.layerId}
          onLinkedFeatureSelect={async (featInfo) => {
            if (selectedLinkedFeature?.featureId && featInfo?.featureId && String(selectedLinkedFeature.featureId) !== String(featInfo.featureId)) {
              try {
                await featuresAPI.link(selectedLinkedFeature.featureId, {
                  target_feature_id: featInfo.featureId,
                  source_layer_id: selectedLinkedFeature.layerId,
                  target_layer_id: featInfo.layerId,
                  source_link_attribute: activeLayerLinkingIdField || '_id',
                  target_link_attribute: refLayerLinkingIdField || '_id',
                  relationship_type: 'spatial_feature_link',
                });
                alert(`सफलतापूर्वक फिचर #${selectedLinkedFeature.featureId} लाई #${featInfo.featureId} सँग सम्बन्ध जोडियो!`);
                setHighlightedLinkedFeatures([selectedLinkedFeature, featInfo]);
                const targetLid = selectedLinkedFeature.layerId || activeLayerId;
                if (targetLid) reloadVectorLayerFeatures(targetLid);
              } catch (err) {
                console.error('Failed to link features on map click:', err);
                alert(err.response?.data?.detail || 'फिचर जोड्न सकिएन।');
              }
            }
            setSelectedLinkedFeature(featInfo);
            setPickFeatureMode(false);
          }}
          collectorLocations={collectorLocations}
          showCollectorLocations={showCollectorTracking}
          linkedHighlightFeatures={highlightedLinkedFeatures}
          showHouseNumbers={showHouseNumbers && isHouseNumberingOn}
          individualHouseNumberFeatureId={individualHouseNumberFeatureId}
        />

        {/* Spatial Grid Boundary Enforcement Floating Alert */}
        {gridAlert && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-50 animate-bounce-in max-w-md w-full px-4 pointer-events-none">
            <div className="bg-amber-950/95 backdrop-blur-md text-white border border-amber-500/70 shadow-2xl rounded-xl p-3 flex items-center gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0 animate-pulse" />
              <div className="text-xs font-nepali font-bold leading-relaxed text-amber-100">
                {gridAlert}
              </div>
            </div>
          </div>
        )}

        {/* Multi-Section Layer Control (Top Right) */}
        <LayerControl
          isOpen={showLayerControl}
          onToggle={setShowLayerControl}
          activeBasemap={activeBasemap}
          onBasemapChange={setActiveBasemap}
          basemapOpacity={basemapOpacity}
          onBasemapOpacityChange={setBasemapOpacity}
          rasterLayers={serverRasters}
          onRasterToggle={handleRasterToggle}
          onRasterOpacityChange={handleRasterOpacityChange}
          onZoomToRaster={handleZoomToRaster}
          vectorLayers={serverVectors}
          onVectorToggle={handleVectorToggle}
          onVectorOpacityChange={handleVectorOpacityChange}
          onZoomToVector={handleZoomToVector}
          activeEditLayerId={editMode ? editLayerId : null}
          onEditLayer={(layerId) => toggleEditMode(layerId)}
          onVectorOutlineToggle={handleVectorOutlineToggle}
          onOpenLinkLayers={handleOpenLinkModal}
          collectorLocations={collectorLocations}
          showCollectorLocations={showCollectorTracking}
          onToggleCollectorLocations={() => setShowCollectorTracking((prev) => !prev)}
          showHouseNumbers={showHouseNumbers && isHouseNumberingOn}
          onToggleHouseNumbers={() => setShowHouseNumbers((prev) => !prev)}
          showAoiBoundary={showAoiBoundary}
          onToggleAoiBoundary={() => setShowAoiBoundary((prev) => !prev)}
          showTaskGrids={showTaskGrids}
          onToggleTaskGrids={() => setShowTaskGrids((prev) => !prev)}
          projects={projects}
          onZoomToCollector={handleZoomToCollector}
          onToggleLayerSnapping={handleToggleLayerSnapping}
          onToggleViewEdits={handleToggleViewEdits}
          onToggleMyEdits={handleToggleMyEdits}
          onToggleCollectorInLayer={handleToggleCollectorInLayer}
          onSetLayerCollectors={handleSetLayerCollectors}
          onChangeEditCollector={handleChangeEditCollector}
          onOpenLayerEditsModal={(layer) => setLayerEditsModalTarget(layer)}
          currentUser={user}
          activeProjectId={activeProject?.id}
          onLayerCreated={(newLayer) => {
            setServerVectors((prev) => [newLayer, ...prev]);
            setActiveLayerId(newLayer.id);
            loadAllLayers(activeProject ? activeProject.id : null);
          }}
        />

        {/* Drawing & Quick Tools (Left Sidebar) */}
        <div className="absolute top-3 left-3 z-30 flex items-start gap-2 font-sans max-w-[calc(100vw-24px)] max-h-[calc(100dvh-75px)] pointer-events-none" id="left-tools-container">
          {toolsCollapsed ? (
            /* Collapsed to Single Button Mode (Edit Mode / Master Tools Button) */
            <button
              type="button"
              onClick={() => setToolsCollapsed(false)}
              className={`w-9 h-9 sm:w-10 sm:h-10 rounded-xl border shadow-md flex items-center justify-center transition-all pointer-events-auto animate-fade-in ${
                editMode
                  ? 'bg-amber-600 text-white font-bold shadow-md ring-2 ring-amber-400 border-amber-500'
                  : 'bg-white text-slate-700 hover:bg-slate-50 border-slate-300'
              }`}
              title="उपकरण पट्टी खोल्नुहोस् (Expand Tools)"
            >
              <Edit3 className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          ) : (
            /* Expanded Mode: Single Vertically Aligned Column of All Buttons */
            <div className="pointer-events-auto bg-white rounded-xl border border-slate-300 shadow-md p-1.5 flex flex-col items-center gap-1 shrink-0 animate-fade-in">
              {/* Collapse to Single Button Toggle */}
              <button
                type="button"
                onClick={() => setToolsCollapsed(true)}
                className="w-8 h-5 flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded transition-colors"
                title="खुम्च्याउनुहोस् (Collapse to single button)"
              >
                <ChevronUp className="w-3.5 h-3.5" />
              </button>

              {/* 1. Edit Mode Toggle Button */}
              {(isAdmin || isCollector || isValidator) && (
                <button
                  type="button"
                  onClick={() => toggleEditMode()}
                  className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                    editMode
                      ? 'bg-amber-600 text-white font-bold shadow-md ring-2 ring-amber-400'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                  title="सम्पादन मोड (Edit Mode: Select & Modify Features)"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
              )}

              {/* 2. Common Feature Creation Button for Point, Line, and Polygon (button[3]) */}
              {(isAdmin || isCollector || isValidator) && (
                <>
                  <div className="w-6 h-[1px] bg-slate-200 my-0.5" />
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => {
                        const activeLayerObj = serverVectors.find((l) => l.id === activeLayerId);
                        const targetLayer = activeLayerObj || (serverVectors.length > 0 ? serverVectors[0] : null);
                        if (targetLayer && !isLayerEditableForField(targetLayer.id)) {
                          handleFeatureBlocked({
                            reason: 'LAYER_LOCKED',
                            message: '🔒 यो तह प्रशासकले सम्पादनका लागि खोलेको छैन — दर्शक मोड मात्र उपलब्ध छ। (This layer is locked by the admin; viewer mode only.)',
                          });
                          return;
                        }
                        setEditMode(false);
                        setSelectedFeature(null);
                        setAttributePopupFeature(null);
                        setDrawToolsCollapsed(false);
                        if (!activeLayerId && targetLayer) {
                          setActiveLayerId(targetLayer.id);
                        }
                        if (drawMode) {
                          setShowDrawTypeSelector((prev) => !prev);
                        } else {
                          const defType = targetLayer?.geometry_type === 'Point' ? 'Point' : targetLayer?.geometry_type === 'LineString' ? 'LineString' : 'Polygon';
                          setDrawMode(defType);
                          setShowDrawTypeSelector(true);
                        }
                      }}
                      className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all cursor-pointer ${
                        drawMode
                          ? 'bg-gov-blue-800 text-white font-bold shadow-sm ring-2 ring-gov-blue-400'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                      title="नयाँ फिचर संकलन / सिर्जना (Create Feature: Point, Line, Polygon)"
                    >
                      {drawMode === 'Point' ? (
                        <Circle className="w-4 h-4 text-emerald-300" />
                      ) : drawMode === 'LineString' ? (
                        <Minus className="w-4 h-4 text-sky-300" />
                      ) : drawMode === 'Polygon' ? (
                        <Triangle className="w-4 h-4 text-amber-300" />
                      ) : (
                        <Shapes className="w-4 h-4" />
                      )}
                    </button>

                    {/* Quick Flyout Selector to choose Point, Line, or Polygon directly */}
                    {showDrawTypeSelector && (
                      <div
                        className="absolute left-full ml-2 top-0 bg-white border border-gov-blue-300 rounded-xl shadow-2xl p-2 z-50 flex flex-col gap-1 w-44 animate-slide-right font-sans"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="flex items-center justify-between pb-1 border-b border-slate-200">
                          <span className="text-[10px] font-bold text-gov-blue-950 font-nepali">
                            ज्यामिति प्रकार (Geometry):
                          </span>
                          <button
                            type="button"
                            onClick={() => setShowDrawTypeSelector(false)}
                            className="text-slate-400 hover:text-slate-700 p-0.5 rounded cursor-pointer"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>

                        {/* 1. Point Option */}
                        <button
                          type="button"
                          onClick={() => {
                            setDrawMode('Point');
                            setShowDrawTypeSelector(false);
                            setDrawToolsCollapsed(false);
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-bold font-nepali transition-all text-left cursor-pointer ${
                            drawMode === 'Point'
                              ? 'bg-gov-blue-800 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-gov-blue-50'
                          }`}
                        >
                          <Circle className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                          <span>बिन्दु (Point)</span>
                        </button>

                        {/* 2. LineString Option */}
                        <button
                          type="button"
                          onClick={() => {
                            setDrawMode('LineString');
                            setShowDrawTypeSelector(false);
                            setDrawToolsCollapsed(false);
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-bold font-nepali transition-all text-left cursor-pointer ${
                            drawMode === 'LineString'
                              ? 'bg-gov-blue-800 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-gov-blue-50'
                          }`}
                        >
                          <Minus className="w-3.5 h-3.5 text-sky-500 shrink-0" />
                          <span>रेखा (Line)</span>
                        </button>

                        {/* 3. Polygon Option */}
                        <button
                          type="button"
                          onClick={() => {
                            setDrawMode('Polygon');
                            setShowDrawTypeSelector(false);
                            setDrawToolsCollapsed(false);
                          }}
                          className={`flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[11px] font-bold font-nepali transition-all text-left cursor-pointer ${
                            drawMode === 'Polygon'
                              ? 'bg-gov-blue-800 text-white shadow-xs'
                              : 'text-slate-700 hover:bg-gov-blue-50'
                          }`}
                        >
                          <Triangle className="w-3.5 h-3.5 text-purple-500 shrink-0" />
                          <span>बहुभुज (Polygon)</span>
                        </button>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* 5. Task Grid Shortcut */}
              <div className="w-6 h-[1px] bg-slate-200 my-0.5" />
              <button
                type="button"
                onClick={() => setShowTaskPanel(!showTaskPanel)}
                className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                  showTaskPanel
                    ? 'bg-gov-blue-800 text-white font-bold shadow-sm'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
                title="कार्य ग्रिड व्यवस्थापन (Task Grid)"
              >
                <Grid3X3 className="w-4 h-4" />
              </button>

              {/* 6. Admin Panel Shortcut */}
              {isAdmin && (
                <>
                  {!activeProject && <div className="w-6 h-[1px] bg-slate-200 my-0.5" />}
                  <button
                    type="button"
                    onClick={() => setShowAdminPanel(!showAdminPanel)}
                    className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
                      showAdminPanel
                        ? 'bg-gov-blue-800 text-white font-bold shadow-sm'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                    title="प्रशासनिक प्यानल (Admin Control)"
                  >
                    <Settings className="w-4 h-4" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* New Feature Capture / Drawing Mode Controls Panel with Full Snapping */}
          {serverVectors.length > 0 && drawMode && (
            drawToolsCollapsed ? (
              /* Collapsed State: Sleek Toggle Button */
              <button
                type="button"
                onClick={() => setDrawToolsCollapsed(false)}
                className="pointer-events-auto bg-white hover:bg-gov-blue-50 text-slate-800 border border-gov-blue-300 rounded-lg p-2 sm:px-3 sm:py-2 flex items-center gap-2 shadow-md transition-all shrink-0 animate-fade-in text-left"
                title="अङ्कन नियन्त्रण प्यानल खोल्नुहोस् (Expand Drawing Tools)"
              >
                <div className="w-5 h-5 rounded bg-gov-blue-800 text-white flex items-center justify-center shrink-0">
                  {drawMode === 'Point' && <Circle className="w-3.5 h-3.5" />}
                  {drawMode === 'LineString' && <Minus className="w-3.5 h-3.5" />}
                  {drawMode === 'Polygon' && <Triangle className="w-3.5 h-3.5" />}
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-gov-blue-900 block leading-tight font-nepali">
                      {drawMode === 'Point' && 'बिन्दु संकलन (Point)'}
                      {drawMode === 'LineString' && 'रेखा संकलन (Line)'}
                      {drawMode === 'Polygon' && 'बहुभुज संकलन (Polygon)'}
                    </span>
                    <span className="flex h-1.5 w-1.5 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-gov-blue-600"></span>
                    </span>
                  </div>
                  <span className="text-[10px] text-gov-blue-700/90 block leading-tight truncate max-w-[150px]">
                    तह: {serverVectors.find((v) => v.id === activeLayerId)?.name || 'सक्रिय'}
                  </span>
                </div>
                <ChevronDown className="w-4 h-4 text-gov-blue-800 shrink-0 ml-1" />
              </button>
            ) : (
              /* Expanded State: Full Panel with Layer Selection, Snapping & Guidance */
              <div className="pointer-events-auto w-72 sm:w-80 max-w-[calc(100vw-64px)] max-h-[calc(100dvh-90px)] flex flex-col bg-white border border-gov-blue-300 rounded-xl shadow-2xl text-slate-800 animate-slide-right overflow-hidden shrink min-h-0">
                {/* Pinned Header Banner with Minimize and Close Controls */}
                <div
                  className="bg-gov-blue-800 text-white px-3 py-2 flex items-center justify-between text-xs font-bold font-nepali shrink-0 shadow-sm select-none cursor-pointer"
                  onClick={() => setDrawToolsCollapsed(true)}
                >
                  <div className="flex items-center gap-1.5 truncate">
                    {drawMode === 'Point' && <Circle className="w-3.5 h-3.5 text-gov-gold-400 shrink-0" />}
                    {drawMode === 'LineString' && <Minus className="w-3.5 h-3.5 text-gov-gold-400 shrink-0" />}
                    {drawMode === 'Polygon' && <Triangle className="w-3.5 h-3.5 text-gov-gold-400 shrink-0" />}
                    <span className="truncate">
                      {drawMode === 'Point' && 'बिन्दु संकलन (Capture Point)'}
                      {drawMode === 'LineString' && 'रेखा संकलन (Capture Line)'}
                      {drawMode === 'Polygon' && 'बहुभुज संकलन (Capture Polygon)'}
                    </span>
                    <span className="flex h-2 w-2 relative shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-gov-gold-400"></span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setDrawToolsCollapsed(true)}
                      className="text-white/80 hover:text-white hover:bg-gov-blue-700 p-0.5 rounded transition-colors"
                      title="प्यानल खुम्च्याउनुहोस् (Collapse to Button)"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setDrawMode(null)}
                      className="text-white/80 hover:text-white hover:bg-gov-blue-700 p-0.5 rounded transition-colors"
                      title="अङ्कन बन्द गर्नुहोस् (Cancel Drawing)"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Scrollable Content Body */}
                <div className="overflow-y-auto p-2.5 space-y-2 flex-1 overscroll-contain scrollbar-thin">
                  {/* Geometry Type 3-Way Selector (Allows creating Point, Line, or Polygon into ANY vector layer) */}
                  <div className="bg-slate-100 p-1.5 rounded-lg border border-slate-200">
                    <label className="text-[9px] font-bold text-gov-blue-950 block mb-1 font-nepali">
                      सिर्जना गर्ने ज्यामिति प्रकार (Geometry Type):
                    </label>
                    <div className="grid grid-cols-3 gap-1">
                      <button
                        type="button"
                        onClick={() => setDrawMode('Point')}
                        className={`py-1.5 px-1 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all cursor-pointer ${
                          drawMode === 'Point'
                            ? 'bg-gov-blue-800 text-white shadow-xs font-bold'
                            : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'
                        }`}
                      >
                        <Circle className={`w-3 h-3 ${drawMode === 'Point' ? 'text-white' : 'text-emerald-500'}`} />
                        <span>बिन्दु (Point)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDrawMode('LineString')}
                        className={`py-1.5 px-1 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all cursor-pointer ${
                          drawMode === 'LineString'
                            ? 'bg-gov-blue-800 text-white shadow-xs font-bold'
                            : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'
                        }`}
                      >
                        <Minus className={`w-3 h-3 ${drawMode === 'LineString' ? 'text-white' : 'text-sky-500'}`} />
                        <span>रेखा (Line)</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setDrawMode('Polygon')}
                        className={`py-1.5 px-1 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all cursor-pointer ${
                          drawMode === 'Polygon'
                            ? 'bg-gov-blue-800 text-white shadow-xs font-bold'
                            : 'bg-white text-slate-700 hover:bg-slate-50 border border-slate-200'
                        }`}
                      >
                        <Triangle className={`w-3 h-3 ${drawMode === 'Polygon' ? 'text-white' : 'text-purple-500'}`} />
                        <span>बहुभुज (Poly)</span>
                      </button>
                    </div>
                  </div>

                  {/* 1. Target Vector Layer Dropdown & Linking ID Field Selector */}
                  <div className="bg-gov-blue-50/60 p-2 rounded-lg border border-gov-blue-200 space-y-2">
                    <div>
                      <label className="text-[9px] font-bold text-gov-blue-950 block mb-1 font-nepali flex items-center gap-1">
                        <MapPin className="w-3 h-3 text-gov-red-700 shrink-0" />
                        <span>अङ्कन तह (Target Layer):</span>
                      </label>
                      <select
                        value={activeLayerId || ''}
                        onChange={(e) => {
                          setActiveLayerId(parseInt(e.target.value) || null);
                          setSelectedLinkedFeature(null);
                        }}
                        className="w-full bg-white border border-gov-blue-300 rounded-md text-[11px] text-slate-800
                                   px-2 py-1 outline-none focus:border-gov-blue-800 font-medium cursor-pointer"
                      >
                        {serverVectors.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name} ({l.is_global ? 'महानगर / Global' : `विशेष परियोजना: ${l.project_name || projects.find(p => p.id === l.project_id)?.name || l.project_id}`})
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  {/* 2. Feature Linking in Base Layer Option — OFF BY DEFAULT */}
                  <div className="bg-purple-50/60 p-2 rounded-lg border border-purple-200/80 space-y-1.5 transition-all">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <Link2 className={`w-3.5 h-3.5 ${enableLayerLinking ? 'text-purple-700' : 'text-slate-400'}`} />
                        <div>
                          <span className="text-[9.5px] font-bold text-purple-950 block font-nepali leading-tight">
                            आधार तहमा फिचर लिङ्किङ (Link to Base Layer Feature)
                          </span>
                          <span className="text-[8.5px] text-slate-500 font-nepali">
                            {enableLayerLinking ? 'सक्रिय (Linking ON)' : 'निष्क्रिय (Default OFF - No Linking)'}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          const next = !enableLayerLinking;
                          setEnableLayerLinking(next);
                          if (!next) {
                            setSelectedLinkedFeature(null);
                            setPickFeatureMode(false);
                          }
                        }}
                        className={`relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                          enableLayerLinking ? 'bg-purple-600' : 'bg-slate-300'
                        }`}
                        title={enableLayerLinking ? 'फिचर लिङ्किङ बन्द गर्नुहोस्' : 'फिचर लिङ्किङ खोल्नुहोस्'}
                      >
                        <span
                          className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                            enableLayerLinking ? 'translate-x-3.5' : 'translate-x-0'
                          }`}
                        />
                      </button>
                    </div>

                    {!enableLayerLinking && (
                      <p className="text-[8.5px] text-slate-500 font-nepali leading-tight pt-1 border-t border-purple-100">
                        नयाँ फिचर आधार तहमा स्वतन्त्र रूपमा सिर्जना हुनेछ (कुनै फिचरसँग स्वचालित सम्बन्ध जोडिने छैन)।
                      </p>
                    )}

                    {/* Expanded Base Layer Linking Options */}
                    {enableLayerLinking && (
                      <div className="space-y-2 pt-1.5 border-t border-purple-200/80 animate-fade-in">
                        {/* 1. Pair the source field and the reference feature's field */}
                        <div className="space-y-1.5">
                          <div>
                            <label className="text-[9px] font-bold text-purple-950 block mb-1 font-nepali flex items-center gap-1">
                              <Link2 className="w-3 h-3 text-purple-700 shrink-0" />
                              <span>यो फिचरको फिल्ड (This feature's field):</span>
                            </label>
                            <select
                              value={activeLayerLinkingIdField}
                              onChange={(e) => setActiveLayerLinkingIdField(e.target.value)}
                              className="w-full bg-white border border-purple-300 rounded-md text-[10px] text-purple-950
                                         px-2 py-1 outline-none focus:border-purple-700 font-medium cursor-pointer"
                            >
                              {activeLayerLinkFields.map((f) => (
                                <option key={f} value={f}>
                                  {f === '_id' ? '_id (प्राथमिक आइडी / Primary ID)' : f}
                                </option>
                              ))}
                            </select>
                          </div>
                          <div>
                            <label className="text-[9px] font-bold text-purple-950 block mb-1 font-nepali flex items-center gap-1">
                              <Link2 className="w-3 h-3 text-purple-700 shrink-0" />
                              <span>आधार फिचरको फिल्ड (Reference feature field):</span>
                            </label>
                            <select
                              value={refLayerLinkingIdField}
                              onChange={(e) => setRefLayerLinkingIdField(e.target.value)}
                              disabled={!selectedLinkedFeature}
                              className="w-full bg-white border border-purple-300 rounded-md text-[10px] text-purple-950
                                         px-2 py-1 outline-none focus:border-purple-700 font-medium cursor-pointer disabled:bg-slate-100 disabled:text-slate-400"
                            >
                              {targetLayerFields.map((f) => {
                                const val = selectedLinkedFeature?.properties?.[f] !== undefined
                                  ? selectedLinkedFeature.properties[f]
                                  : (f === '_id' || f === 'id' ? selectedLinkedFeature?.featureId : undefined);
                                const valStr = val !== undefined ? ` [मान: ${val}]` : '';
                                return (
                                  <option key={f} value={f}>
                                    {f === '_id' ? `_id (प्राथमिक आइडी / Primary ID)${valStr}` : `${f}${valStr}`}
                                  </option>
                                );
                              })}
                            </select>
                          </div>
                          <p className="text-[8px] text-purple-800/80 font-nepali leading-tight">
                            दुवै फिचरमा छानिएको फिल्डको मान उही हुनुपर्छ; फारममा आधार फिचरको मान स्वतः भरिन्छ।
                          </p>
                        </div>

                        {/* 2. Pick from Base Layer Feature on Map */}
                        <div className="space-y-1.5 pt-1 border-t border-purple-200/60">
                          <label className="flex items-center gap-1.5 cursor-pointer select-none">
                            <input
                              type="checkbox"
                              checked={pickFeatureMode}
                              onChange={(e) => setPickFeatureMode(e.target.checked)}
                              className="w-3.5 h-3.5 rounded border-slate-300 text-purple-700 focus:ring-purple-600 cursor-pointer"
                            />
                            <span className="text-[9.5px] font-bold text-slate-800 font-nepali flex items-center gap-1">
                              <Crosshair className={`w-3 h-3 ${pickFeatureMode ? 'text-purple-600 animate-spin' : 'text-slate-500'}`} />
                              <span>आधार तहको फिचर नक्सामा क्लिक गर्नुहोस् (Pick on Map)</span>
                            </span>
                          </label>

                          {pickFeatureMode && !selectedLinkedFeature && (
                            <div className="bg-purple-100/70 text-purple-900 border border-purple-300 rounded p-1.5 text-[8.5px] font-nepali leading-tight flex items-center gap-1.5 animate-pulse">
                              <Sparkles className="w-3 h-3 text-purple-700 shrink-0" />
                              <span>नक्सामा आधार तहको कुनै मौजुदा फिचरमा क्लिक गर्नुहोस्।</span>
                            </div>
                          )}

                          {selectedLinkedFeature && (
                            <div className="bg-purple-100/90 border border-purple-300 rounded-md p-1.5 text-[9px] flex items-center justify-between gap-1 animate-fade-in shadow-xs">
                              <div className="min-w-0">
                                <div className="font-bold text-purple-950 font-nepali truncate flex items-center gap-1">
                                  <Link2 className="w-3 h-3 text-purple-700 shrink-0" />
                                  <span>आधार तहको फिचर #{selectedLinkedFeature.featureId}</span>
                                </div>
                                <span className="text-[8.5px] text-purple-900 font-mono block truncate">
                                  विशेषता ({refLayerLinkingIdField}): <span className="font-bold">{String(
                                    refLayerLinkingIdField === '_id' || refLayerLinkingIdField === 'id'
                                      ? (selectedLinkedFeature.featureId || selectedLinkedFeature.properties?._id || '')
                                      : (selectedLinkedFeature.properties?.[refLayerLinkingIdField] ?? '')
                                  )}</span>
                                </span>
                              </div>
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedLinkedFeature(null);
                                  setPickFeatureMode(false);
                                }}
                                className="text-purple-700 hover:text-gov-red-700 p-1 rounded hover:bg-purple-200 transition-colors shrink-0 cursor-pointer"
                                title="चयन हटाउनुहोस् (Clear Selection)"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>

                  {/* 2. Undo & Redo Quick Action Buttons for Drawing Mode */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleDrawUndo}
                      disabled={drawUndoCount === 0}
                      className={`flex-1 py-1.5 px-2 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all border ${
                        drawUndoCount > 0
                          ? 'bg-white hover:bg-gov-blue-50 text-gov-blue-900 border-gov-blue-300 shadow-xs cursor-pointer active:scale-95'
                          : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed opacity-60'
                      }`}
                      title="पूर्ववत गर्नुहोस् (Undo / Backspace or Ctrl+Z)"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                      <span>पूर्ववत (Undo)</span>
                      {drawUndoCount > 0 && (
                        <span className="px-1 py-0.2 rounded-full text-[8px] bg-gov-blue-200 text-gov-blue-900 font-mono font-bold">
                          {drawUndoCount}
                        </span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handleDrawRedo}
                      disabled={drawRedoCount === 0}
                      className={`flex-1 py-1.5 px-2 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all border ${
                        drawRedoCount > 0
                          ? 'bg-white hover:bg-gov-blue-50 text-gov-blue-900 border-gov-blue-300 shadow-xs cursor-pointer active:scale-95'
                          : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed opacity-60'
                      }`}
                      title="पुनः गर्नुहोस् (Redo / Ctrl+Y or Ctrl+Shift+Z)"
                    >
                      <Redo2 className="w-3.5 h-3.5" />
                      <span>पुनः (Redo)</span>
                      {drawRedoCount > 0 && (
                        <span className="px-1 py-0.2 rounded-full text-[8px] bg-gov-blue-200 text-gov-blue-900 font-mono font-bold">
                          {drawRedoCount}
                        </span>
                      )}
                    </button>
                  </div>

                  {/* 3. Snapping ON/OFF Toggle Section */}
                  <div className="bg-slate-50 p-2 rounded-lg border border-slate-200 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-700 font-nepali">
                        <Magnet className={`w-3.5 h-3.5 ${isDrawLayerSnappingAllowed && snappingEnabled ? 'text-emerald-600 animate-pulse' : 'text-slate-400'}`} />
                        <span>बिन्दु स्न्यापिङ (Snapping)</span>
                      </div>
                      {!isDrawLayerSnappingAllowed ? (
                        <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[9px] font-bold font-nepali" title="प्रशासकद्वारा यस तहमा स्न्यापिङ अनुमति दिइएको छैन">
                          स्न्याप बन्द (Admin)
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSnappingEnabled(!snappingEnabled)}
                          className={`relative inline-flex h-4.5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            snappingEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                          }`}
                          title={snappingEnabled ? 'स्न्यापिङ बन्द गर्नुहोस्' : 'स्न्यापिङ चालू गर्नुहोस्'}
                        >
                          <span
                            className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              snappingEnabled ? 'translate-x-4.5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      )}
                    </div>

                    {!isDrawLayerSnappingAllowed ? (
                      <div className="text-[9px] text-rose-600 font-nepali pt-1 border-t border-rose-100 flex items-center gap-1">
                        <span>⚠️ प्रशासकद्वारा यस तहमा स्न्यापिङ निषेध गरिएको छ।</span>
                      </div>
                    ) : (
                      snappingEnabled && (
                        <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
                          <span className="text-[9px] text-slate-500 font-nepali">सहिष्णुता (Tolerance):</span>
                          <div className="flex items-center gap-1">
                            {[10, 15, 20, 30].map((tol) => (
                              <button
                                key={tol}
                                type="button"
                                onClick={() => setSnapTolerance(tol)}
                                className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold transition-all ${
                                  snapTolerance === tol
                                    ? 'bg-emerald-600 text-white shadow-xs'
                                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                                }`}
                              >
                                {tol}px
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    )}
                  </div>

                  {/* 4. Context Guidance Information */}
                  <div className="bg-gov-blue-50/80 rounded-lg p-2 border border-gov-blue-200/80 text-[9px] text-gov-blue-950 font-nepali leading-relaxed flex flex-col gap-1">
                    <div className="font-bold text-gov-blue-900 flex items-center gap-1">
                      <Sparkles className="w-3 h-3 text-gov-blue-700 shrink-0" />
                      <span>
                        {drawMode === 'Point' && 'बिन्दु संकलन निर्देशन:'}
                        {drawMode === 'LineString' && 'रेखा खिच्ने निर्देशन:'}
                        {drawMode === 'Polygon' && 'बहुभुज बनाउने निर्देशन:'}
                      </span>
                    </div>
                    <div className="text-slate-700 space-y-0.5 pl-1 border-l-2 border-gov-blue-400">
                      {drawMode === 'Point' && (
                        <p>&bull; नक्सामा जहाँ नयाँ बिन्दु राख्न चाहनुहुन्छ, त्यहाँ <strong>क्लिक</strong> गर्नुहोस्।</p>
                      )}
                      {drawMode === 'LineString' && (
                        <>
                          <p>&bull; <strong>क्लिक:</strong> नयाँ बिन्दु थप्दै रेखा विस्तार गर्नुहोस्।</p>
                          <p>&bull; <strong>पूर्ववत:</strong> Backspace वा पूर्ववत बटनले अघिल्लो बिन्दु हटाउँछ।</p>
                          <p>&bull; <strong>समाप्त:</strong> रेखा पूरा गर्न अन्तिम बिन्दुमा <strong>डबल क्लिक</strong> गर्नुहोस्।</p>
                        </>
                      )}
                      {drawMode === 'Polygon' && (
                        <>
                          <p>&bull; <strong>क्लिक:</strong> कुनाहरू जोड्दै बहुभुज कोर्नुहोस्।</p>
                          <p>&bull; <strong>पूर्ववत:</strong> Backspace वा पूर्ववत बटनले अघिल्लो कुना हटाउँछ।</p>
                          <p>&bull; <strong>समाप्त:</strong> सुरुको बिन्दु वा अन्तिम स्थानमा <strong>डबल क्लिक</strong> गर्नुहोस्।</p>
                        </>
                      )}
                      {snappingEnabled && (
                        <p className="text-emerald-700 font-semibold">&bull; <strong>स्न्यापिङ सक्रिय:</strong> मौजुदा बिन्दुहरू स्पष्ट देखिन्छन् र कर्सर स्वतः जोडिन्छ।</p>
                      )}
                    </div>
                  </div>

                </div>
              </div>
            )
          )}

          {/* Unified Editing Workbench Section (Single Cohesive Editing Panel for All Vector Editing) */}
          {serverVectors.length > 0 && editMode && (
            editToolsCollapsed ? (
              /* Collapsed State: Sleek Toggle Button (Just like LayerControl) */
              <button
                type="button"
                onClick={() => setEditToolsCollapsed(false)}
                className="pointer-events-auto bg-white hover:bg-amber-50 text-slate-800 border border-amber-300 rounded-lg p-2 sm:px-3 sm:py-2 flex items-center gap-2 shadow-md transition-all shrink-0 animate-fade-in text-left"
                title="सम्पादन प्यानल खोल्नुहोस् (Expand Edit Workbench)"
              >
                <div className="w-5 h-5 rounded bg-amber-600 text-white flex items-center justify-center shrink-0">
                  <Edit3 className="w-3.5 h-3.5" />
                </div>
                <div className="text-left">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-bold text-amber-900 block leading-tight font-nepali">
                      सम्पादन नियन्त्रण (Edit Workbench)
                    </span>
                    <span className="flex h-1.5 w-1.5 relative">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-amber-500"></span>
                    </span>
                  </div>
                  <span className="text-[10px] text-amber-700/90 block leading-tight truncate max-w-[150px]">
                    {selectedFeature ? `फिचर #${selectedFeature.id}` : `तह: ${serverVectors.find((v) => v.id === editLayerId)?.name || 'सक्रिय'}`}
                  </span>
                </div>
                <ChevronDown className="w-4 h-4 text-amber-600 shrink-0 ml-1" />
              </button>
            ) : selectedFeature ? (
              /* Expanded State WITH Selected Feature: Render FeatureEditPanel directly in this single section */
              <FeatureEditPanel
                docked={true}
                feature={selectedFeature}
                onSave={handleSaveFeature}
                onRevertGeometry={handleFeatureRevert}
                onDelete={handleDeleteFeature}
                onClose={() => {
                  if (selectedFeature?.originalGeom) {
                    setGeometryUpdateTrigger({
                      featureId: selectedFeature.id,
                      geometry: selectedFeature.originalGeom,
                      timestamp: Date.now(),
                    });
                  }
                  setSelectedFeature(null);
                  setEditSubMode(null);
                  setSplitBladeMode(false);
                  setMergeSelectMode(false);
                  setMergeSelection([]);
                  setMergeFeaturesMap({});
                }}
                saving={featureSaving}
                deleting={featureDeleting}
                schema={activeProject?.form_schema || null}
                snappingEnabled={snappingEnabled}
                onToggleSnapping={() => setSnappingEnabled((prev) => !prev)}
                snapTolerance={snapTolerance}
                onChangeSnapTolerance={setSnapTolerance}
                layerAllowsSnapping={isEditLayerSnappingAllowed}
                onUndo={handleUndo}
                onRedo={handleRedo}
                canUndo={undoStack.length > 0}
                canRedo={redoStack.length > 0}
                editSubMode={editSubMode}
                onChangeEditSubMode={setEditSubMode}
                onRemoveLastVertex={handleRemoveLastVertex}
                vectorLayers={serverVectors}
                user={user}
                isAdmin={isAdmin}
                isCollector={isCollector}
                onStartSplit={() => {
                  setMergeSelectMode(false);
                  setEditSubMode(null);
                  setSplitBladeMode(true);
                }}
                onStartMerge={() => {
                  setSplitBladeMode(false);
                  setEditSubMode(null);
                  setMergeSelectMode(true);
                  if (selectedFeature?.id) {
                    setMergeSelection([selectedFeature.id]);
                    setMergeFeaturesMap({ [String(selectedFeature.id)]: selectedFeature });
                  }
                }}
                onStartLink={() => {
                  handleOpenLinkModal(selectedFeature?.layerId || editLayerId);
                }}
                splitBladeMode={splitBladeMode}
                onCancelSplit={() => setSplitBladeMode(false)}
                mergeSelectMode={mergeSelectMode}
                mergeSelectionCount={mergeSelection.length}
                onConfirmMerge={handleMergeConfirm}
                onCancelMerge={() => {
                  setMergeSelectMode(false);
                  setMergeSelection([]);
                  setMergeFeaturesMap({});
                }}
                onFeatureLinksUpdated={({ sourceLayerId, targetLayerId }) => {
                  [sourceLayerId, targetLayerId].filter(Boolean).forEach((lid) => {
                    reloadVectorLayerFeatures(lid);
                    setBboxReloadTrigger({ layerId: lid, timestamp: Date.now() });
                  });
                }}
              />
            ) : (
              /* Expanded State WITHOUT Selected Feature: Render Edit Mode Setup (Layer selection, Snapping, Guidance) */
              <div className="pointer-events-auto w-76 sm:w-84 max-w-[calc(100vw-64px)] max-h-[calc(100dvh-90px)] flex flex-col bg-white border border-amber-300 rounded-xl shadow-2xl text-slate-800 animate-slide-right overflow-hidden shrink min-h-0">
                {/* Pinned Header Banner with Minimize and Close Controls */}
                <div
                  className="bg-amber-600 text-white px-3 py-2 flex items-center justify-between text-xs font-bold font-nepali shrink-0 shadow-sm select-none cursor-pointer"
                  onClick={() => setEditToolsCollapsed(true)}
                >
                  <div className="flex items-center gap-1.5 truncate">
                    <Edit3 className="w-3.5 h-3.5 text-amber-200 shrink-0" />
                    <span className="truncate">सम्पादन नियन्त्रण (Edit Workbench)</span>
                    <span className="flex h-2 w-2 relative shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-white opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-200"></span>
                    </span>
                  </div>
                  <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
                    <button
                      type="button"
                      onClick={() => setEditToolsCollapsed(true)}
                      className="text-white/80 hover:text-white hover:bg-amber-700 p-0.5 rounded transition-colors cursor-pointer"
                      title="प्यानल खुम्च्याउनुहोस् (Collapse to Button)"
                    >
                      <ChevronUp className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleEditMode()}
                      className="text-white/80 hover:text-white hover:bg-amber-700 p-0.5 rounded transition-colors cursor-pointer"
                      title="सम्पादन मोड बन्द गर्नुहोस् (Exit Edit Mode)"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                {/* Scrollable Content Body */}
                <div className="overflow-y-auto p-2.5 space-y-2 flex-1 overscroll-contain scrollbar-thin">
                  {/* Edit Layer Dropdown — ONLY VISIBLE / ON LAYERS */}
                  <div className="bg-amber-50/60 p-2 rounded-lg border border-amber-200">
                    <label className="text-[9px] font-bold text-amber-950 block mb-1 font-nepali">
                      सक्रिय सम्पादन तह (Edit Layer):
                    </label>
                    <select
                      value={editLayerId || ''}
                      onChange={(e) => {
                        const newId = parseInt(e.target.value) || null;
                        setEditLayerId(newId);
                        setSelectedFeature(null);
                        setUndoStack([]);
                        setRedoStack([]);
                        if (newId) {
                          setServerVectors((current) =>
                            current.map((v) => {
                              if (v.id === newId) {
                                if (!v.features) {
                                  featuresAPI.list(newId).then((res) => {
                                    let featureData = res.data;
                                    if (featureData && !featureData.type && Array.isArray(featureData)) {
                                      featureData = { type: 'FeatureCollection', features: featureData };
                                    }
                                    setServerVectors((cur) =>
                                      cur.map((item) => (item.id === newId ? { ...item, features: featureData } : item))
                                    );
                                  });
                                }
                                return { ...v, visible: true, lastActivatedAt: v.lastActivatedAt || Date.now() };
                              }
                              return v;
                            })
                          );
                        }
                      }}
                      className="w-full bg-white border border-amber-300 rounded-md text-[11px] text-slate-800 px-2 py-1 outline-none focus:border-amber-600 font-medium cursor-pointer"
                    >
                      {serverVectors.filter((v) => v.visible !== false).length === 0 ? (
                        <option value="" disabled>कुनै तह अन छैन (पहिले तह खोल्नुहोस्)</option>
                      ) : (
                        serverVectors
                          .filter((v) => v.visible !== false)
                          .map((l) => (
                            <option key={l.id} value={l.id}>
                              {l.name} ({l.is_global ? 'महानगर' : 'परियोजना'})
                            </option>
                          ))
                      )}
                    </select>
                  </div>

                  {/* Undo & Redo Quick Action Buttons */}
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={handleUndo}
                      disabled={!selectedFeature || undoStack.length === 0}
                      className={`flex-1 py-1.5 px-2 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all border ${
                        selectedFeature && undoStack.length > 0
                          ? 'bg-white hover:bg-amber-100 text-amber-900 border-amber-300 shadow-xs cursor-pointer active:scale-95'
                          : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed opacity-60'
                      }`}
                      title="पूर्ववत गर्नुहोस् (Undo / Backspace or Ctrl+Z)"
                    >
                      <Undo2 className="w-3.5 h-3.5" />
                      <span>पूर्ववत (Undo)</span>
                      {undoStack.length > 0 && (
                        <span className="px-1 py-0.2 rounded-full text-[8px] bg-amber-200 text-amber-900 font-mono font-bold">
                          {undoStack.length}
                        </span>
                      )}
                    </button>

                    <button
                      type="button"
                      onClick={handleRedo}
                      disabled={!selectedFeature || redoStack.length === 0}
                      className={`flex-1 py-1.5 px-2 rounded-md text-[10px] font-bold font-nepali flex items-center justify-center gap-1 transition-all border ${
                        selectedFeature && redoStack.length > 0
                          ? 'bg-white hover:bg-amber-100 text-amber-900 border-amber-300 shadow-xs cursor-pointer active:scale-95'
                          : 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed opacity-60'
                      }`}
                      title="पुनः गर्नुहोस् (Redo / Ctrl+Y or Ctrl+Shift+Z)"
                    >
                      <Redo2 className="w-3.5 h-3.5" />
                      <span>पुनः (Redo)</span>
                      {redoStack.length > 0 && (
                        <span className="px-1 py-0.2 rounded-full text-[8px] bg-amber-200 text-amber-900 font-mono font-bold">
                          {redoStack.length}
                        </span>
                      )}
                    </button>
                  </div>

                  {/* Snapping ON/OFF Toggle Section */}
                  <div className="bg-slate-50 p-2 rounded-lg border border-slate-200 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-[10px] font-bold text-slate-700 font-nepali">
                        <Magnet className={`w-3.5 h-3.5 ${isEditLayerSnappingAllowed && snappingEnabled ? 'text-emerald-600 animate-pulse' : 'text-slate-400'}`} />
                        <span>बिन्दु स्न्यापिङ (Snapping)</span>
                      </div>
                      {!isEditLayerSnappingAllowed ? (
                        <span className="px-1.5 py-0.5 rounded bg-rose-50 text-rose-700 border border-rose-200 text-[9px] font-bold font-nepali" title="प्रशासकद्वारा यस तहमा स्न्यापिङ अनुमति दिइएको छैन">
                          स्न्याप बन्द (Admin)
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setSnappingEnabled(!snappingEnabled)}
                          className={`relative inline-flex h-4.5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            snappingEnabled ? 'bg-emerald-600' : 'bg-slate-300'
                          }`}
                          title={snappingEnabled ? 'स्न्यापिङ बन्द गर्नुहोस्' : 'स्न्यापिङ चालू गर्नुहोस्'}
                        >
                          <span
                            className={`pointer-events-none inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              snappingEnabled ? 'translate-x-4.5' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      )}
                    </div>

                    {!isEditLayerSnappingAllowed ? (
                      <div className="text-[9px] text-rose-600 font-nepali pt-1 border-t border-rose-100 flex items-center gap-1">
                        <span>⚠️ प्रशासकद्वारा यस तहमा स्न्यापिङ निषेध गरिएको छ।</span>
                      </div>
                    ) : (
                      snappingEnabled && (
                        <div className="flex items-center justify-between pt-1 border-t border-slate-200/60">
                          <span className="text-[9px] text-slate-500 font-nepali">सहिष्णुता (Tolerance):</span>
                          <div className="flex items-center gap-1">
                            {[10, 15, 20, 30].map((tol) => (
                              <button
                                key={tol}
                                type="button"
                                onClick={() => setSnapTolerance(tol)}
                                className={`px-1.5 py-0.5 rounded text-[9px] font-mono font-bold transition-all cursor-pointer ${
                                  snapTolerance === tol
                                    ? 'bg-emerald-600 text-white shadow-xs'
                                    : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'
                                }`}
                              >
                                {tol}px
                              </button>
                            ))}
                          </div>
                        </div>
                      )
                    )}
                  </div>

                  {/* Context Guidance Information */}
                  <div className="bg-amber-50/80 rounded-lg p-2.5 border border-amber-200/80 text-[10px] text-amber-950 font-nepali leading-relaxed flex flex-col gap-1.5">
                    <div className="flex items-start gap-1.5 font-bold text-amber-900">
                      <MousePointerClick className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                      <span>फिचर छान्नुहोस् र सम्पादन गर्नुहोस्</span>
                    </div>
                    <p className="text-[9px] text-amber-800">
                      नक्सामा देखाइएको कुनै पनि फिचरमा क्लिक गर्नुहोस्। चयन गरिएको फिचरको ज्यामिति (Vertices) तथा विशेषताहरू (Attributes) यसै प्यानलमा सम्पादन गर्न सकिनेछ।
                    </p>
                  </div>
                </div>
              </div>
            )
          )}
        </div>

        {/* Task Grid Sidebar */}
        {showTaskPanel && (
          <TaskPanel
            tasks={taskGrids}
            selectedTask={selectedTask}
            onTaskSelect={(taskProps) => {
              setSelectedTask(taskProps);
            }}
            onTaskAction={handleTaskAction}
            onClose={() => setShowTaskPanel(false)}
            loading={actionLoading}
            activeProject={activeProject}
            projects={projects}
            onSelectProject={(proj) => {
              setActiveProject(proj);
            }}
            onRefreshTasks={async () => {
              if (activeProject) {
                try {
                  const res = await tasksAPI.list(activeProject.id);
                  setTaskGrids(res.data);
                  const pRes = await projectsAPI.get(activeProject.id);
                  setActiveProject(pRes.data);
                } catch (err) {
                  console.error('Failed to reload tasks:', err);
                }
              }
            }}
            onStartDrawBoundary={handleStartDrawBoundary}
            drawnBoundary={drawnTaskBoundary}
            isDrawingBoundary={drawingTaskBoundary}
            onClearDrawnBoundary={handleClearDrawnBoundary}
            outlinedTaskIds={outlinedTaskIds}
            outlineAllTasks={outlineAllTasks}
            onToggleTaskOutline={handleToggleTaskOutline}
            onToggleAllTasksOutline={handleToggleAllTasksOutline}
            showTaskGrids={showTaskGrids}
            onToggleTaskGrids={() => setShowTaskGrids((prev) => !prev)}
            showAoiBoundary={showAoiBoundary}
            onToggleAoiBoundary={() => setShowAoiBoundary((prev) => !prev)}
            aoiBoundary={activeProject?.boundary_geojson || activeProject?.aoi_geojson || null}
            aoiAreaSqm={activeProject?.aoi_area_sqm || null}
          />
        )}

        {/* Admin Panel Sidebar */}
        {showAdminPanel && (
          <AdminPanel
            onClose={() => {
              setShowAdminPanel(false);
              loadAllLayers(activeProject);
              projectsAPI.list().then((res) => setProjects(res.data)).catch(console.error);
            }}
            onProjectCreated={(p) => {
              setProjects((prev) => [p, ...prev]);
              setActiveProject(p);
              loadAllLayers(p);
            }}
            activeProject={activeProject}
            onOpenLinkLayers={handleOpenLinkModal}
            onZoomToCollector={handleZoomToCollector}
            onLayerUpdate={() => loadAllLayers(activeProject)}
          />
        )}

        {/* Unfinished Feature Creation Recovery Floating Banner */}
        {unfinishedDraft && !showForm && (
          <div className="fixed top-14 left-1/2 -translate-x-1/2 z-[60] w-[95%] max-w-xl bg-white/95 backdrop-blur-md border-2 border-amber-400 rounded-2xl shadow-2xl p-3 sm:p-4 flex items-center justify-between gap-3 animate-slide-down">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-800 flex items-center justify-center shrink-0 shadow-xs">
                <Save className="w-5 h-5 text-amber-700 animate-pulse" />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h4 className="text-xs font-bold text-slate-900 font-nepali">
                    अपूर्ण फिचर सिर्जना ड्राफ्ट फेला पर्यो
                  </h4>
                  <span className="text-[10px] px-1.5 py-0.2 bg-amber-100 text-amber-800 rounded font-semibold font-mono">
                    {unfinishedDraft.savedAt ? new Date(unfinishedDraft.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'ड्राफ्ट'}
                  </span>
                </div>
                <p className="text-[11px] text-slate-600 truncate font-nepali mt-0.5">
                  फारम: <span className="font-semibold text-gov-blue-800">{unfinishedDraft.questionnaireTitle || unfinishedDraft.layerName || 'प्रश्नावली'}</span> •
                  जियोमेट्री: <span className="font-mono text-slate-700">{unfinishedDraft.geometry?.type || 'GeoJSON'}</span>
                </p>
              </div>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleResumeUnfinishedDraft}
                className="px-3 py-1.5 bg-gov-blue-800 hover:bg-gov-blue-700 active:scale-95 text-white rounded-lg text-xs font-bold font-nepali shadow transition-all flex items-center gap-1.5 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>जारी राख्नुहोस् (Resume)</span>
              </button>
              <button
                type="button"
                onClick={handleDiscardUnfinishedDraft}
                className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors cursor-pointer"
                title="ड्राफ्ट खारेज गर्नुहोस् (Discard Draft)"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
        )}

        {/* Dynamic Attributes Form / Advanced Questionnaire for Feature Capture */}
        {showForm && (() => {
          const currentTargetLayer = serverVectors.find((l) => String(l.id) === String(formLayerId || (editMode && editLayerId ? editLayerId : activeLayerId)));
          const targetQId = currentTargetLayer?.questionnaire_id || resumedRecord?.questionnaire_id;
          const currentQ = (formQuestionnaire && String(formQuestionnaire.id) === String(targetQId))
            ? formQuestionnaire
            : ((activeQuestionnaire && String(activeQuestionnaire.id) === String(targetQId)) ? activeQuestionnaire : null);
          const isQuestionnaireMode = Boolean(targetQId);

          return (
            <div
              className={`fixed sm:absolute left-0 right-0 bottom-0 sm:left-auto sm:right-4 sm:top-16 sm:bottom-4 landscape:right-2 landscape:top-2 landscape:bottom-2 ${
                isQuestionnaireMode
                  ? 'w-full sm:w-[560px] sm:max-w-2xl max-h-[calc(100dvh-80px)] sm:max-h-[calc(100%-80px)]'
                  : formCollapsed
                  ? 'max-h-12 w-full sm:w-96 sm:max-w-md'
                  : 'max-h-[85dvh] sm:max-h-[calc(100%-80px)] w-full sm:w-96 sm:max-w-md'
              } flex flex-col min-h-0 bg-white rounded-t-2xl sm:rounded-xl shadow-2xl border-t sm:border border-slate-300 overflow-hidden animate-slide-up pb-[max(0.75rem,calc(env(safe-area-inset-bottom,0px)+0.5rem))] transition-all z-50`}
            >
              {isQuestionnaireMode ? (
                currentQ ? (
                  <QuestionnaireForm
                    projectId={
                      activeProject?.id ||
                      activeEditLayer?.project_id ||
                      serverVectors.find((l) => String(l.id) === String(formLayerId))?.project_id ||
                      currentQ?.project_id ||
                      serverVectors.find((l) => String(l.id) === String(editMode && editLayerId ? editLayerId : activeLayerId))?.project_id ||
                      null
                    }
                    layerId={formLayerId || (editMode && editLayerId) || activeLayerId || null}
                    questionnaire={currentQ}
                    linkTo={questionnaireLinkTo}
                    geometry={editingGeometry}
                    geometryType={editingGeometry?.type || serverVectors.find((l) => String(l.id) === String(formLayerId))?.geometry_type || serverVectors.find((l) => String(l.id) === String(editMode && editLayerId ? editLayerId : activeLayerId))?.geometry_type || activeProject?.geometry_config?.type || 'POINT'}
                    initialRecord={resumedRecord}
                    extraFields={questionnaireExtraFields}
                    currentGps={gpsPosition}
                    onSaved={(savedRec, isAutosave) => {
                      if (savedRec) {
                        setResumedRecord(savedRec);
                        const targetId = formLayerId || activeEditLayer?.id || (editMode && editLayerId ? editLayerId : activeLayerId);
                        if (targetId) {
                          setBboxReloadTrigger({ layerId: targetId, timestamp: Date.now() });
                        }
                      }
                    }}
                    onSubmitSuccess={(submittedRec) => {
                      if (typeof window !== 'undefined') {
                        localStorage.removeItem('kmc_unfinished_feature_creation_draft');
                      }
                      setUnfinishedDraft(null);
                      setShowForm(false);
                      setEditingGeometry(null);
                      setResumedRecord(null);
                      setFormLayerId(null);
                      setFormQuestionnaire(null);
                      setQuestionnaireExtraFields([]);
                      setDrawMode(null);
                      setSelectedLinkedFeature(null);
                      setPickFeatureMode(false);
                      setEnableLayerLinking(false);
                      const isDraftRec = submittedRec?.status === 'DRAFT' || submittedRec?._status === 'DRAFT';
                      loadAllLayers(activeProject);
                      const targetId = formLayerId || activeEditLayer?.id || (editMode && editLayerId ? editLayerId : activeLayerId);
                      if (targetId) {
                        setBboxReloadTrigger({ layerId: targetId, timestamp: Date.now() });
                      }
                      if (isDraftRec) {
                        alert('मस्यौदा फिचर सफलतापूर्वक सुरक्षित गरियो (Draft feature saved successfully)!');
                      } else {
                        alert('सर्वेक्षण सफलतापूर्वक बुझाइयो र GIS फिचर सुरक्षित गरियो (Survey submitted & GIS feature updated)!');
                      }
                    }}
                    onCancel={() => {
                      setShowForm(false);
                      setEditingGeometry(null);
                      setResumedRecord(null);
                      setFormLayerId(null);
                      setFormQuestionnaire(null);
                      setQuestionnaireExtraFields([]);
                      setDrawMode(null);
                      setSelectedLinkedFeature(null);
                      setPickFeatureMode(false);
                      setEnableLayerLinking(false);
                      try {
                        const raw = localStorage.getItem('kmc_unfinished_feature_creation_draft');
                        if (raw) setUnfinishedDraft(JSON.parse(raw));
                      } catch (e) {}
                    }}
                  />
                ) : (
                  <div className="p-8 flex flex-col items-center justify-center gap-3">
                    <Loader2 className="w-8 h-8 animate-spin text-gov-blue-800" />
                    <p className="text-sm font-nepali text-slate-700">तहसँग जोडिएको प्रश्नावली लोड गरिँदैछ... (Loading questionnaire...)</p>
                  </div>
                )
              ) : (
                <>
                  {/* Mobile Grab / Drag Handle Pill & Collapsible Header */}
                  <div
                    className="w-full flex flex-col items-center py-1 sm:hidden cursor-pointer bg-slate-50 border-b border-slate-200 shrink-0 select-none"
                    onClick={() => setFormCollapsed(!formCollapsed)}
                  >
                    <div className="w-10 h-1 bg-slate-300 rounded-full mb-1" />
                    <div className="flex items-center justify-between w-full px-3 text-[11px] font-bold text-gov-blue-900 font-nepali">
                      <span className="truncate">नयाँ फिचर फारम (Feature Form)</span>
                      {formCollapsed ? <ChevronUp className="w-3.5 h-3.5 text-slate-500" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500" />}
                    </div>
                  </div>
                  {!formCollapsed && (
                    <div className="overflow-y-auto flex-1 min-h-0 p-4 sm:p-5 overscroll-contain scrollbar-thin">
                      <DynamicFormRenderer
                        schema={activeLayerFormSchema || activeProject?.form_schema || null}
                        initialValues={initialFormAttributes}
                        onSubmit={handleFormSubmit}
                        onSaveDraft={(values) => handleFormSubmit(values, true)}
                        loading={formSaving}
                        onCancel={() => {
                          if (formSaving) return;
                          setShowForm(false);
                          setEditingGeometry(null);
                          setFormLayerId(null);
                          setFormQuestionnaire(null);
                          setDrawMode(null);
                          setInitialFormAttributes({});
                          setActiveLayerFormSchema(null);
                          try {
                            const raw = localStorage.getItem('kmc_unfinished_feature_creation_draft');
                            if (raw) setUnfinishedDraft(JSON.parse(raw));
                          } catch (e) {}
                        }}
                        title={`नयाँ फिचर प्रविष्टि: ${currentTargetLayer?.name || 'भेक्टर तह'} (New Feature)`}
                        hideCustomFields={true}
                      />
                    </div>
                  )}
                </>
              )}
            </div>
          );
        })()}

        {/* My Records Slide-Over Drawer */}
        {showMyRecords && (
          <div className="fixed sm:absolute left-0 right-0 bottom-0 sm:left-auto sm:right-4 sm:bottom-4 z-40 w-full sm:w-96 sm:max-w-md h-[85dvh] sm:h-[620px] bg-white rounded-t-2xl sm:rounded-xl shadow-2xl border border-slate-300 overflow-hidden animate-slide-up">
            <MyRecordsPanel
              projectId={activeProject?.id}
              projects={projects}
              onSelectProject={(proj) => {
                handleProjectSelect(proj.id);
              }}
              onResumeRecord={async (rec) => {
                setResumedRecord(rec);
                setFormLayerId(rec.layer_id || null);
                if (rec.questionnaire_id) {
                  try {
                    const qRes = await questionnairesAPI.get(rec.questionnaire_id);
                    setActiveQuestionnaire(qRes.data);
                  } catch (e) {
                    console.warn('Failed to load questionnaire for resumed record', e);
                  }
                }
                if (rec.geom_geojson) {
                  setEditingGeometry(rec.geom_geojson);
                  setZoomTarget({
                    type: 'geometry',
                    geometry: rec.geom_geojson,
                  });
                }
                setShowForm(true);
                setShowMyRecords(false);
              }}
              onClose={() => setShowMyRecords(false)}
            />
          </div>
        )}

        {/* Split Feature Modal (QGIS Scientific Geometric Split) */}
        <SplitFeatureModal
          isOpen={showSplitModal}
          onClose={() => {
            setShowSplitModal(false);
            setSplitModalData(null);
          }}
          splitData={splitModalData}
          onConfirmSplit={handleConfirmSplit}
          saving={splitMerging}
        />

        {/* Merge Features Modal (QGIS Scientific Geometric Merge) */}
        <MergeFeaturesModal
          isOpen={showMergeModal}
          onClose={() => {
            setShowMergeModal(false);
          }}
          features={mergeSelection.map((id) => {
            const fromMap = mergeFeaturesMap[String(id)];
            if (fromMap) return fromMap;
            if (selectedFeature && String(selectedFeature.id) === String(id)) return selectedFeature;
            const lyr = serverVectors.find((l) => l.id === editLayerId);
            const foundInLyr = lyr?.features?.features?.find((f) => String(f.id) === String(id));
            if (foundInLyr) return foundInLyr;
            return { id, properties: { _id: id } };
          })}
          layerId={editLayerId}
          onConfirmMerge={handleConfirmMerge}
          saving={splitMerging}
        />

        {/* Unified Feature Attribute Inspector Popup (Strictly in Browse / Inspect Mode) */}
        {attributePopupFeature && !editMode && !drawMode && (
          <ReadOnlyAttributePopup
            feature={attributePopupFeature}
            layer={serverVectors.find((l) => String(l.id) === String(attributePopupFeature.layerId || attributePopupFeature.layer_id || attributePopupFeature.properties?.layer_id || activeLayerId))}
            allLayers={serverVectors}
            currentUser={user}
            onDeleteFeature={handleDeleteFeature}
            deletingFeature={featureDeleting}
            onClose={() => {
              setAttributePopupFeature(null);
              setHighlightedLinkedFeatures([]);
            }}
            onLinkedFeaturesLoaded={(list) => setHighlightedLinkedFeatures(list || [])}
            onToggleIndividualHouseNumber={(fId) => {
              setIndividualHouseNumberFeatureId((prev) => (String(prev) === String(fId) ? null : fId));
            }}
            isIndividualHouseNumberShown={(fId) => String(individualHouseNumberFeatureId) === String(fId)}
            onZoomToFeature={(feat) => handleZoomToInspectedFeature(feat?.geometry, feat?.bbox || feat?.properties?.bbox)}
            onStartSurvey={(feat, lyr) => {
              const geom = feat?.geometry || feat?.originalGeom || feat?.currentGeom;
              if (geom) {
                handleFeatureCreate(geom, {
                  existingFeatureId: feat.id,
                  layerId: lyr?.id || feat.layerId || feat.properties?.layer_id,
                  feature: feat,
                  properties: feat.properties || {},
                });
                setAttributePopupFeature(null);
              }
            }}
            onEditFeature={(feat) => {
              const targetLayerId = feat?.layerId || feat?.layer_id || feat?.properties?.layer_id || activeLayerId;
              if (!isLayerEditableForField(targetLayerId)) {
                handleFeatureBlocked({
                  reason: 'LAYER_LOCKED',
                  message: '🔒 यो तह प्रशासकले सम्पादनका लागि खोलेको छैन — दर्शक मोड मात्र उपलब्ध छ। (This layer is locked by the admin; viewer mode only.)',
                });
                return;
              }
              setAttributePopupFeature(null);
              setHighlightedLinkedFeatures([]);
              if (targetLayerId) {
                setEditLayerId(targetLayerId);
              }
              setEditMode(true);
              setSelectedFeature(feat);
              setUndoStack([]);
              setRedoStack([]);
            }}
            onStartSplit={(feat, lyr) => {
              const geomType = feat?.geometry?.type || feat?.geometryType;
              const isMultipart =
                geomType === 'MultiPolygon' ||
                geomType === 'MultiLineString' ||
                (geomType && geomType.startsWith('Multi')) ||
                (Array.isArray(feat?.geometry?.coordinates) && feat.geometry.coordinates.length > 1);
              if (isMultipart) {
                handleStartMultipartSplit(feat, lyr);
              } else {
                const targetLayerId = lyr?.id || feat?.layerId || feat?.layer_id || feat?.properties?.layer_id || activeLayerId;
                if (!isLayerEditableForField(targetLayerId)) {
                  handleFeatureBlocked({
                    reason: 'LAYER_LOCKED',
                    message: '🔒 यो तह प्रशासकले सम्पादनका लागि खोलेको छैन — दर्शक मोड मात्र उपलब्ध छ। (This layer is locked by the admin; viewer mode only.)',
                  });
                  return;
                }
                setAttributePopupFeature(null);
                setHighlightedLinkedFeatures([]);
                if (targetLayerId) setEditLayerId(targetLayerId);
                setEditMode(true);
                setSelectedFeature(feat);
                setSplitBladeMode(true);
              }
            }}
            onStartMerge={(feat, lyr) => {
              const targetLayerId = lyr?.id || feat?.layerId || feat?.layer_id || feat?.properties?.layer_id || activeLayerId;
              if (!isLayerEditableForField(targetLayerId)) {
                handleFeatureBlocked({
                  reason: 'LAYER_LOCKED',
                  message: '🔒 यो तह प्रशासकले सम्पादनका लागि खोलेको छैन — दर्शक मोड मात्र उपलब्ध छ। (This layer is locked by the admin; viewer mode only.)',
                });
                return;
              }
              setAttributePopupFeature(null);
              setHighlightedLinkedFeatures([]);
              if (targetLayerId) setEditLayerId(targetLayerId);
              setEditMode(true);
              setSelectedFeature(feat);
              setMergeSelectMode(true);
              const fId = feat?.id || feat?.properties?._id || feat?.properties?.id;
              if (fId != null) {
                setMergeSelection([fId]);
                setMergeFeaturesMap({ [String(fId)]: feat });
              }
            }}
            onStartMapLinkPick={(feat, lyr, sourceAttr, targetAttr) => {
              setPickFeatureMode(true);
              setEnableLayerLinking(true);
              if (sourceAttr) setActiveLayerLinkingIdField(sourceAttr);
              if (targetAttr) setRefLayerLinkingIdField(targetAttr);
              const referenceFeatureId = feat?.id || feat?.properties?._id || feat?.properties?.id;
              if (referenceFeatureId && lyr?.id != null) {
                setSelectedLinkedFeature({
                  featureId: referenceFeatureId,
                  layerId: lyr.id,
                  properties: feat?.properties || {},
                });
              }
              setAttributePopupFeature(null);
              setHighlightedLinkedFeatures([]);
            }}
            onSelectLinkedFeature={(lf) => {
              setAttributePopupFeature(lf);
            }}
            onFeatureLinksUpdated={() => {
              const targetLid = attributePopupFeature?.layerId || attributePopupFeature?.layer_id || attributePopupFeature?.properties?.layer_id || editLayerId || activeLayerId;
              if (targetLid) {
                reloadVectorLayerFeatures(targetLid);
                setBboxReloadTrigger({ layerId: targetLid, timestamp: Date.now() });
              }
            }}
            canEdit={
              (isAdmin || isCollector || isValidator) &&
              isLayerEditableForField(
                attributePopupFeature?.layerId ||
                attributePopupFeature?.layer_id ||
                attributePopupFeature?.properties?.layer_id ||
                activeLayerId
              )
            }
          />
        )}

        {/* Vector Layer Feature-to-Feature Linking Modal */}
        <LinkLayersModal
          isOpen={showLinkModal}
          onClose={() => setShowLinkModal(false)}
          vectorLayers={serverVectors}
          initialSourceLayerId={linkModalSourceLayerId}
          onLinkedSuccess={handleLayerLinkedSuccess}
        />

        {/* Layer Edits Inspection Modal */}
        <LayerEditsModal
          isOpen={!!layerEditsModalTarget}
          onClose={() => setLayerEditsModalTarget(null)}
          layer={activeModalLayer}
          onZoomToFeature={handleZoomToLayerEditFeature}
          currentUser={user}
          isAdmin={isAdmin}
        />

        {/* Compulsory GPS Requirement Guard for Data Collectors */}
        <GpsGuardModal
          isCollector={isCollector}
          gpsPosition={gpsPosition}
          gpsError={gpsError}
          isTracking={gpsTracking}
          onRetry={restartGps}
        />

        {/* Non-blocking Save Success Floating Toast */}
        {saveSuccessToast && (
          <div className="fixed bottom-20 sm:bottom-6 left-1/2 -translate-x-1/2 z-50 bg-slate-900/95 text-white px-4 py-2.5 rounded-xl shadow-2xl border border-emerald-500/50 flex items-center gap-2.5 animate-slide-up pointer-events-none">
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
            <div className="text-xs font-nepali">
              <span className="font-bold text-white">फिचर #{saveSuccessToast.id}</span> सफलतापूर्वक सुरक्षित गरियो (Saved Successfully)
            </div>
          </div>
        )}
        </div>
      )}
    </div>
  );
}

export default function DashboardPage() {
  return (
    <ErrorBoundary>
      <DashboardContent />
    </ErrorBoundary>
  );
}
