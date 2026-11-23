'use client';

import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import {
  Users, Plus, FolderPlus, Upload, Layers, Image, Database,
  Trash2, Edit3, X, Loader2, UserPlus, MapPin, Grid3X3,
  ChevronDown, ChevronUp, RefreshCw, Link2, ShieldCheck, CheckCircle2,
  Globe, Folder, Unlink, ExternalLink, Check, Sparkles, Filter, Copy,
  UserCheck, UserX, Shield, FolderCheck, Download, FileDown, FileText,
  Radio, Navigation, Crosshair, Clock, Magnet, Sliders, Asterisk,
  ClipboardList, CheckSquare, ArrowUp, ArrowDown, Eye, EyeOff, Key, Hash, ListOrdered,
  Palette, Wand2, MousePointerClick, Save, RotateCcw, Recycle,
  HardDrive, Power, ShieldAlert, Home,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import api, {
  usersAPI, projectsAPI, layersAPI, tilesAPI, trackingAPI, triggerFileDownload,
  uploadFileResumable, systemAPI, questionnairesAPI, geoportalAPI,
} from '../lib/api';
import {
  GOLDEN_SWARM_SECRETS_CATALOG,
  generateSwarmRotationPlan,
} from '../lib/swarmSecretsUtils';
import QuestionnaireBuilder from './questionnaire/QuestionnaireBuilder';
import RecordsReviewTable from './questionnaire/RecordsReviewTable';
import PrimaryKeyConfigModal from './PrimaryKeyConfigModal';
import { formatApiError } from '../lib/apiError';

/**
 * AdminPanel Component — Official Nepal Government WebGIS Standard
 * Kathmandu Metropolitan City (काठमाडौँ महानगरपालिका)
 * GisAdmin Management Console
 * 
 * Supports:
 * - Direct Project-scoped or Global Vector & Raster Upload
 * - Project Layer & MBTiles Linking / Unlinking Management
 * - Data Collector Project Assignment & Access Control
 * - Real-Time Data Collector Location Fleet Tracking
 * - User & Project Administration
 */
export default function AdminPanel({
  onClose,
  onProjectCreated,
  activeProject,
  onOpenLinkLayers = null,
  onZoomToCollector = null,
  onLayerUpdate = null,
}) {
  const { user: currentUser, isAdmin, isSuperAdmin, isMasterAdmin, isDepartmentAdmin } = useAuth();
  const [activeTab, setActiveTab] = useState('projects');
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  // ---- Main datasets ----
  const [users, setUsers] = useState([]);
  const [projects, setProjects] = useState([]);
  const [allLayers, setAllLayers] = useState([]);
  const [allTiles, setAllTiles] = useState([]);
  const [collectorLocations, setCollectorLocations] = useState([]);
  const [projectAssignments, setProjectAssignments] = useState({}); // { [projectId]: { layer_ids: [], tile_ids: [] } }
  const [projectCollectors, setProjectCollectors] = useState({}); // { [projectId]: [ { user_id, username, full_name, email, assigned_tasks_count } ] }

  // ---- Active UI states ----
  const [expandedProjectId, setExpandedProjectId] = useState(activeProject?.id || null);
  const [projectFilter, setProjectFilter] = useState('ALL'); // 'ALL', 'GLOBAL', or projectId string
  const [searchTerm, setSearchTerm] = useState('');
  const [addingCollectorProjectId, setAddingCollectorProjectId] = useState(null);
  const [selectedCollectorIdToAssign, setSelectedCollectorIdToAssign] = useState('');

  // ---- Modal & Dialog States ----
  const [showUserForm, setShowUserForm] = useState(false);
  const [showProjectForm, setShowProjectForm] = useState(false);
  const [showLayerUpload, setShowLayerUpload] = useState(false);
  const [showTileUpload, setShowTileUpload] = useState(false);
  const [assignModal, setAssignModal] = useState(null); // { type: 'layer' | 'tile', item: layer | tile, targetProjectId: null }
  const [layerDownloadModal, setLayerDownloadModal] = useState(null); // { layer: layerObj }
  const [downloadingLayerId, setDownloadingLayerId] = useState(null);
  const [downloadingLayerFormat, setDownloadingLayerFormat] = useState(null);
  const [downloadingTileId, setDownloadingTileId] = useState(null);
  const [downloadingLogs, setDownloadingLogs] = useState(false);
  const [togglingSnappingLayerId, setTogglingSnappingLayerId] = useState(null);
  const [styleEditorLayerId, setStyleEditorLayerId] = useState(null); // layer card with style editor open
  const [styleForm, setStyleForm] = useState({ color: '#3b82f6', width: 3, clickTolerance: 14, hoverMinZoom: '' });
  const [savingStyleLayerId, setSavingStyleLayerId] = useState(null);
  // Recycle bin (soft-deleted layers & rasters)
  const [deletedLayers, setDeletedLayers] = useState([]);
  const [deletedTiles, setDeletedTiles] = useState([]);
  const [showRecycleBin, setShowRecycleBin] = useState(false);
  const [recycleBinLoading, setRecycleBinLoading] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [permanentDeletingId, setPermanentDeletingId] = useState(null);
  const [purgeBinLoading, setPurgeBinLoading] = useState(false);
  const [fieldConfigModal, setFieldConfigModal] = useState(null); // { layer, activeTab, fields: [], creation_geometry_types: [], geometry_fields_config: {}, loading: false, saving: false }
  const [selectedQuestionnaireProject, setSelectedQuestionnaireProject] = useState(activeProject || null);
  const [selectedLinkLayerId, setSelectedLinkLayerId] = useState('');
  const [linkQModalLayer, setLinkQModalLayer] = useState(null);
  const [linkQModalList, setLinkQModalList] = useState([]);
  const [linkQModalSelected, setLinkQModalSelected] = useState('');
  const [linkQLoading, setLinkQLoading] = useState(false);
  const [questionnaireStudioProject, setQuestionnaireStudioProject] = useState(null);
  const [selectedRecordsProjectId, setSelectedRecordsProjectId] = useState(activeProject?.id || null);
  const [swarmSecrets, setSwarmSecrets] = useState([]);
  const [swarmPosture, setSwarmPosture] = useState(null);
  const [swarmSecretsLoading, setSwarmSecretsLoading] = useState(false);
  const [swarmSecretsError, setSwarmSecretsError] = useState('');
  const [activeRotationPlan, setActiveRotationPlan] = useState(null);
  const [primaryKeyModal, setPrimaryKeyModal] = useState(null); // { layer, isPostUpload: boolean }

  // ---- Master control (MasterAdmin only) ----
  const [orderingConfig, setOrderingConfig] = useState({
    strategy: 'golden_rules',
    golden_rules: {
      rasters_at_bottom: true,
      vector_order: ['Polygon', 'MultiPolygon', 'LineString', 'MultiLineString', 'Point', 'MultiPoint'],
      recent_on_top_within_type: true,
    },
    custom_ranks: {},
  });
  const [orderingSaving, setOrderingSaving] = useState(false);

  useEffect(() => {
    if (activeTab === 'ordering') {
      api.get('/platform/layer-ordering')
        .then((res) => {
          if (res.data) setOrderingConfig(res.data);
        })
        .catch((err) => console.warn('Failed to load ordering config:', err));
    }
  }, [activeTab]);

  const handleSaveOrdering = async () => {
    setOrderingSaving(true);
    try {
      await api.put('/platform/layer-ordering', orderingConfig);
      setMessage({
        type: 'success',
        text: 'तह क्रमबद्धता तथा स्ट्याकिङ नियमहरू सफलतापूर्वक अद्यावधिक गरियो!',
      });
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('kmc_layer_ordering_updated', { detail: orderingConfig }));
      }
    } catch (err) {
      alert(`क्रमबद्धता सुरक्षित गर्न सकिएन: ${err.message}`);
    } finally {
      setOrderingSaving(false);
    }
  };

  const [masterLoading, setMasterLoading] = useState(false);
  const [geoportalState, setGeoportalState] = useState(null);
  const [storageUsage, setStorageUsage] = useState(null);
  const [storageFiles, setStorageFiles] = useState({ uploads: [], tiles: [] });
  const [storageFilesLoading, setStorageFilesLoading] = useState(false);
  const [storageFileDeleting, setStorageFileDeleting] = useState(null);
  const [storagePurgeLoading, setStoragePurgeLoading] = useState(false);
  const [masterDeletingId, setMasterDeletingId] = useState(null);
  const [geoportalSaving, setGeoportalSaving] = useState(false);
  const [landingPageSaving, setLandingPageSaving] = useState(false);

  // ---- Form states ----
  const [userForm, setUserForm] = useState({ username: '', email: '', password: '', full_name: '', role: 'DataCollector', assigned_ward: 0, department: '' });
  const [editUserModal, setEditUserModal] = useState(null); // target user object for editing
  const [editUserForm, setEditUserForm] = useState({ username: '', full_name: '', email: '', role: 'DataCollector', assigned_ward: 0, department: '', is_active: true, password: '' });
  const [userSaving, setUserSaving] = useState(false);
  const [passwordModal, setPasswordModal] = useState(null); // target user object
  const [passwordForm, setPasswordForm] = useState({ current_password: '', new_password: '', confirm_password: '' });
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [projectForm, setProjectForm] = useState({
    name: '',
    description: '',
    project_mode: 'STANDARD',
    geometry_config: { type: 'Point' },
    department_admin_ids: [],
    house_numbering_enabled: false,
  });
  const [editingHouseNumberConfig, setEditingHouseNumberConfig] = useState({});
  const [generatingHouseNumbersId, setGeneratingHouseNumbersId] = useState(null);
  const [houseNumberResult, setHouseNumberResult] = useState(null);
  const [houseNumberFields, setHouseNumberFields] = useState({}); // { [layerId]: field names }
  // Department admins only operate inside their linked projects, so their
  // uploads default to project scope (global layers stay a super-admin action).
  const defaultUploadScope = isDepartmentAdmin ? 'PROJECT' : 'GLOBAL';
  const [layerUploadForm, setLayerUploadForm] = useState({ name: '', scope: defaultUploadScope, projectId: '', editable_by_collectors: false, allow_snapping: true });
  const [tileUploadForm, setTileUploadForm] = useState({ name: '', description: '', scope: defaultUploadScope, projectId: '' });
  const [uploadProgress, setUploadProgress] = useState(null);
  const [uploadQueue, setUploadQueue] = useState([]);
  const [vectorDragActive, setVectorDragActive] = useState(false);
  const [tileDragActive, setTileDragActive] = useState(false);
  const [droppedVectorFiles, setDroppedVectorFiles] = useState([]);
  const [droppedTileFiles, setDroppedTileFiles] = useState([]);
  const [togglingPublicId, setTogglingPublicId] = useState(null);

  useEffect(() => {
    if (activeTab !== 'master' || !isMasterAdmin) return;
    let alive = true;
    setMasterLoading(true);
    loadData();
    Promise.allSettled([systemAPI.getGeoportalState(), systemAPI.getStorageUsage(), systemAPI.getStorageFiles()])
      .then(([geoRes, storeRes, filesRes]) => {
        if (!alive) return;
        if (geoRes.status === 'fulfilled') setGeoportalState(geoRes.value.data);
        if (storeRes.status === 'fulfilled') setStorageUsage(storeRes.value.data);
        if (filesRes.status === 'fulfilled') {
          setStorageFiles({
            uploads: filesRes.value.data?.uploads || [],
            tiles: filesRes.value.data?.tiles || [],
          });
        }
      })
      .finally(() => {
        if (alive) setMasterLoading(false);
      });
    return () => { alive = false; };
  }, [activeTab, isMasterAdmin]);

  // ---- Load all data ----
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [usersRes, projRes, layersRes, tilesRes, trackingRes] = await Promise.allSettled([
        usersAPI.list(),
        projectsAPI.list(),
        layersAPI.listAll(),
        tilesAPI.listAll(),
        trackingAPI.getCollectors(),
      ]);
      if (usersRes.status === 'fulfilled') setUsers(usersRes.value.data);
      if (projRes.status === 'fulfilled') setProjects(projRes.value.data);
      if (layersRes.status === 'fulfilled') setAllLayers(layersRes.value.data);
      if (tilesRes.status === 'fulfilled') setAllTiles(tilesRes.value.data);
      if (trackingRes.status === 'fulfilled') setCollectorLocations(trackingRes.value.data || []);

      // Load assignments and collectors for all projects
      if (projRes.status === 'fulfilled' && Array.isArray(projRes.value.data)) {
        const assignmentsMap = {};
        const collectorsMap = {};
        await Promise.allSettled(
          projRes.value.data.map(async (p) => {
            try {
              const res = await projectsAPI.getAssignments(p.id);
              assignmentsMap[p.id] = {
                layer_ids: res.data.assigned_layer_ids || [],
                tile_ids: res.data.assigned_mbtiles_ids || [],
              };
            } catch (e) {
              assignmentsMap[p.id] = { layer_ids: [], tile_ids: [] };
            }

            try {
              const cRes = await projectsAPI.getCollectors(p.id);
              collectorsMap[p.id] = cRes.data || [];
            } catch (e) {
              collectorsMap[p.id] = [];
            }
          })
        );
        setProjectAssignments(assignmentsMap);
        setProjectCollectors(collectorsMap);
      }
    } catch (err) {
      console.error('[AdminPanel] Error loading data:', err);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    loadData();
  }, [isAdmin, loadData]);

  // Live tracking: poll collector positions while the tracking tab is open.
  useEffect(() => {
    if (!isAdmin || activeTab !== 'tracking') return undefined;
    const refresh = async () => {
      try {
        const res = await trackingAPI.getCollectors();
        setCollectorLocations(res.data || []);
      } catch (e) {
        // transient network errors are ignored; the next tick retries
      }
    };
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [activeTab]);

  // Swarm secrets: always render the backend's observed posture, never a static claim.
  useEffect(() => {
    if (!isAdmin || activeTab !== 'secrets') return undefined;
    let cancelled = false;
    const catalogByName = new Map(
      GOLDEN_SWARM_SECRETS_CATALOG.map((entry) => [entry.secretName, entry])
    );
    setSwarmSecretsLoading(true);
    setSwarmSecretsError('');
    systemAPI.getSwarmSecrets()
      .then((res) => {
        if (cancelled) return;
        const posture = res.data || {};
        const observed = (posture.secrets || []).map((item) => {
          const base = catalogByName.get(item.secret_name) || {};
          return {
            id: item.secret_name,
            secretName: item.secret_name,
            envVarName: item.env_var,
            fileEnvVarName: item.file_env_var,
            targetPath: item.target_path,
            version: item.version || 'v1',
            uid: item.uid,
            gid: item.gid,
            mode: item.mode,
            source: item.source,
            mounted: item.mounted_in_tmpfs,
            services: item.services || [],
            descriptionNe: base.descriptionNe || item.secret_name,
            descriptionEn: base.descriptionEn || '',
            minLength: base.minLength || 24,
          };
        });
        setSwarmPosture(posture);
        setSwarmSecrets(observed);
      })
      .catch((err) => {
        if (cancelled) return;
        setSwarmPosture(null);
        setSwarmSecrets([]);
        setSwarmSecretsError(err?.response?.data?.detail || err.message || 'Unable to load secret posture');
      })
      .finally(() => {
        if (!cancelled) setSwarmSecretsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  // Sync active project if opened from outside
  useEffect(() => {
    if (activeProject && activeProject.id) {
      setExpandedProjectId(activeProject.id);
    }
  }, [activeProject]);

  // ---- User Actions ----
  const handleCreateUser = async (e) => {
    e.preventDefault();
    try {
      const deptVal = String(userForm.department || '').trim();
      const payload = {
        ...userForm,
        department: deptVal || null,
        ...(deptVal && /^\d+$/.test(deptVal) ? { department_id: parseInt(deptVal, 10) } : {}),
      };
      await usersAPI.create(payload);
      setMessage({ type: 'success', text: `नयाँ प्रयोगकर्ता '${userForm.username}' सफलतापूर्वक सिर्जना भयो` });
      setShowUserForm(false);
      setUserForm({ username: '', email: '', password: '', full_name: '', role: 'DataCollector', assigned_ward: 0, department: '' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'प्रयोगकर्ता सिर्जना गर्न सकिएन' });
    }
  };

  const handleOpenEditUser = (user) => {
    setEditUserModal(user);
    setEditUserForm({
      username: user.username || '',
      full_name: user.full_name || '',
      email: user.email || '',
      role: user.role || 'DataCollector',
      assigned_ward: user.assigned_ward ?? 0,
      department: user.department || (user.department_id != null ? String(user.department_id) : ''),
      is_active: user.is_active !== false,
      password: '',
    });
  };

  const handleUpdateUser = async (e) => {
    e.preventDefault();
    if (!editUserModal) return;
    setUserSaving(true);
    try {
      const deptVal = String(editUserForm.department || '').trim();
      const payload = {
        username: editUserForm.username.trim(),
        full_name: editUserForm.full_name.trim(),
        email: editUserForm.email.trim(),
        role: editUserForm.role,
        assigned_ward: Number(editUserForm.assigned_ward) || 0,
        department: deptVal || null,
        ...(deptVal && /^\d+$/.test(deptVal) ? { department_id: parseInt(deptVal, 10) } : { department_id: null }),
        is_active: editUserForm.is_active,
      };
      if (editUserForm.password && editUserForm.password.trim().length >= 8) {
        payload.password = editUserForm.password.trim();
      }
      await usersAPI.update(editUserModal.id, payload);
      setMessage({ type: 'success', text: `'${editUserForm.username}' को विवरण सफलतापूर्वक अद्यावधिक भयो (User updated)` });
      setEditUserModal(null);
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'प्रयोगकर्ता अद्यावधिक गर्न असफल भयो (Failed to update user)' });
    } finally {
      setUserSaving(false);
    }
  };

  const handleDeleteUser = async (user) => {
    if (!window.confirm(`के तपाईं निश्चित हुनुहुन्छ कि '${user.full_name || user.username}' प्रयोगकर्ता मेटाउन चाहनुहुन्छ? (Are you sure you want to delete this user?)`)) {
      return;
    }
    try {
      await usersAPI.delete(user.id);
      setMessage({ type: 'success', text: `प्रयोगकर्ता '${user.username}' सफलतापूर्वक हटाइयो (User deleted)` });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'प्रयोगकर्ता मेटाउन असफल भयो (Failed to delete user)' });
    }
  };

  const openPasswordModal = (user) => {
    setPasswordModal(user);
    setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!passwordModal) return;
    // MasterAdmin or SuperAdmin resets any account without the current password;
    // other users must prove their current password.
    const isMasterOrSuper = isMasterAdmin || (isSuperAdmin && passwordModal.role !== 'MasterAdmin');
    const currentPasswordRequired = !isMasterOrSuper && String(passwordModal.id) === String(currentUser?.id);

    if (currentPasswordRequired && !passwordForm.current_password) {
      setMessage({ type: 'error', text: 'हालको पासवर्ड आवश्यक छ। (Current password is required.)' });
      return;
    }
    if (passwordForm.new_password.length < 8) {
      setMessage({ type: 'error', text: 'नयाँ पासवर्ड कम्तीमा ८ अक्षरको हुनुपर्छ। (New password must be at least 8 characters.)' });
      return;
    }
    if (passwordForm.new_password !== passwordForm.confirm_password) {
      setMessage({ type: 'error', text: 'नयाँ पासवर्ड दुई पटक एउटै हुनुपर्छ। (Passwords do not match.)' });
      return;
    }
    setPasswordSaving(true);
    try {
      await usersAPI.changePassword(passwordModal.id, {
        new_password: passwordForm.new_password,
        ...(currentPasswordRequired ? { current_password: passwordForm.current_password } : {}),
      });
      setMessage({ type: 'success', text: `'${passwordModal.username}' को पासवर्ड सफलतापूर्वक परिवर्तन भयो (Password updated)` });
      setPasswordModal(null);
      setPasswordForm({ current_password: '', new_password: '', confirm_password: '' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'पासवर्ड परिवर्तन गर्न सकिएन (Could not change password)' });
    } finally {
      setPasswordSaving(false);
    }
  };

  // ---- Project Actions ----
  const handleDeleteProject = async (projectId, projectName) => {
    if (!window.confirm(`के तपाईं निश्चित हुनुहुन्छ कि '${projectName || projectId}' परियोजना मेटाउन चाहनुहुन्छ? यससँग सम्बन्धित सबै कार्य तथा ग्रिडहरू हटाइनेछन्।`)) {
      return;
    }
    try {
      await projectsAPI.delete(projectId);
      setMessage({ type: 'success', text: `परियोजना '${projectName}' सफलतापूर्वक हटाइयो।` });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'परियोजना मेटाउन असफल भयो।' });
    }
  };

  const handleCreateVectorLayerFromQuestionnaire = async (proj) => {
    try {
      setMessage(null);
      let activeQ = null;
      try {
        const qRes = await questionnairesAPI.getActive(proj.id);
        if (qRes?.data) activeQ = qRes.data;
      } catch (_) {}

      if (!activeQ) {
        try {
          const listRes = await questionnairesAPI.list(proj.id);
          if (listRes?.data && listRes.data.length > 0) {
            activeQ = listRes.data[0];
          }
        } catch (_) {}
      }

      if (!activeQ?.id) {
        setMessage({
          type: 'error',
          text: 'यो परियोजनामा प्रश्नावली भेटिएन। पहिले प्रश्नावली सिर्जना गर्नुहोस्। (Create a questionnaire for this project first.)',
        });
        return;
      }

      const geomType = proj.geometry_config?.type || 'Point';
      const layerName = `${proj.name} (सर्वेक्षण तह)`;
      const res = await layersAPI.create({
        name: layerName,
        description: `${proj.name} को प्रश्नावली आधारित भेक्टर तह`,
        type: 'vector',
        geometry_type: geomType,
        creation_geometry_types: geomType === 'Mix' ? ['Point', 'LineString', 'Polygon'] : [geomType],
        project_id: proj.id,
        questionnaire_id: activeQ.id,
        allow_snapping: true,
        editable_by_collectors: false,
      });

      setMessage({ type: 'success', text: `भेक्टर तह '${res.data.name}' सफलतापूर्वक सिर्जना गरियो र प्रश्नावलीसँग जोडाइयो!` });
      loadData();
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: err.response?.data?.detail || 'भेक्टर तह सिर्जना गर्न सकिएन।' });
    }
  };

  const handleLinkLayerToQuestionnaire = async (layerId, projId, qId) => {
    if (!layerId) return;
    try {
      let activeQ = null;
      if (qId) {
        try {
          const qRes = await questionnairesAPI.get(qId);
          activeQ = qRes?.data;
        } catch (_) {}
      }
      if (!activeQ && projId) {
        try {
          const qRes = await questionnairesAPI.getActive(projId);
          activeQ = qRes?.data;
        } catch (_) {}
      }
      if (!activeQ?.id) {
        setMessage({ type: 'error', text: 'प्रश्नावली भेटिएन। पहिले प्रश्नावली सिर्जना गर्नुहोस्। (Questionnaire not found.)' });
        return;
      }

      // The backend derives the layer attribute schema from the questionnaire,
      // keeping the survey fields and layer fields identical.
      await layersAPI.update(layerId, { questionnaire_id: activeQ.id });

      setMessage({ type: 'success', text: 'भेक्टर तह सफलतापूर्वक प्रश्नावलीसँग जोडाइयो!' });
      loadData();
    } catch (err) {
      console.error(err);
      setMessage({ type: 'error', text: err.response?.data?.detail || 'तह जोड्न सकिएन।' });
    }
  };

  const handleUnlinkLayerQuestionnaire = async (layerId) => {
    try {
      await layersAPI.update(layerId, { questionnaire_id: null });
      setMessage({ type: 'success', text: 'भेक्टर तहबाट प्रश्नावली अलग गरियो।' });
      loadData();
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: 'तह अलग गर्न सकिएन।' });
    }
  };

  useEffect(() => {
    if (linkQModalLayer) {
      const projId = linkQModalLayer.project_id || (projects && projects[0]?.id);
      if (projId) {
        setLinkQLoading(true);
        questionnairesAPI.list(projId)
          .then((res) => {
            const list = Array.isArray(res.data) ? res.data : [];
            setLinkQModalList(list);
            const active = list.find((q) => q.is_active) || list[0];
            setLinkQModalSelected(active ? String(active.id) : '');
          })
          .catch((e) => {
            console.warn('Could not load questionnaires for layer linking:', e);
            setLinkQModalList([]);
          })
          .finally(() => setLinkQLoading(false));
      }
    } else {
      setLinkQModalList([]);
      setLinkQModalSelected('');
    }
  }, [linkQModalLayer]);

  const handleConfirmLinkLayerQuestionnaire = async () => {
    if (!linkQModalLayer || !linkQModalSelected) return;
    await handleLinkLayerToQuestionnaire(linkQModalLayer.id, linkQModalLayer.project_id, linkQModalSelected);
    setLinkQModalLayer(null);
    if (onLayerUpdate) onLayerUpdate();
  };
  const handleCreateProject = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...projectForm };
      if (!isSuperAdmin) delete payload.department_admin_ids;
      const res = await projectsAPI.create(payload);
      setMessage({ type: 'success', text: `नयाँ परियोजना '${projectForm.name}' सफलतापूर्वक सिर्जना भयो` });
      setShowProjectForm(false);
      setProjectForm({
        name: '',
        description: '',
        project_mode: 'STANDARD',
        geometry_config: { type: 'Point' },
        department_admin_ids: [],
        house_numbering_enabled: false,
      });
      loadData();
      if (onProjectCreated) onProjectCreated(res.data);
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'परियोजना सिर्जना गर्न सकिएन' });
    }
  };

  // ---- Upload GeoJSON Layer (Global or Project-Scoped) ----
  const enqueueUploadItem = (item) => {
    setUploadQueue((prev) => [item, ...prev]);
  };

  const updateUploadQueueItem = (id, patch) => {
    setUploadQueue((prev) => prev.map((it) => (it.id === id ? { ...it, ...patch } : it)));
  };

  const dismissUploadQueueItem = (id) => {
    setUploadQueue((prev) => prev.filter((it) => it.id !== id));
  };

  const handleToggleLayerPublicView = async (layer) => {
    const nextVal = !(layer.published_in_geoportal !== false);
    const key = `vector_${layer.id}`;
    try {
      setTogglingPublicId(key);
      await geoportalAPI.updateLayerConfig(layer.id, { published_in_geoportal: nextVal });
      setAllLayers((prev) =>
        prev.map((l) => (l.id === layer.id ? { ...l, published_in_geoportal: nextVal } : l))
      );
      setMessage({
        type: 'success',
        text: `'${layer.name}' सार्वजनिक जियोपोर्टलमा ${nextVal ? 'देखाइयो (Public Visible)' : 'लुकाइयो (Hidden from Public)'}`,
      });
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'सार्वजनिक दृश्यता परिवर्तन गर्न सकिएन' });
    } finally {
      setTogglingPublicId(null);
    }
  };

  const handleToggleTilePublicView = async (tile) => {
    const nextVal = !(tile.published_in_geoportal !== false);
    const key = `raster_${tile.id}`;
    try {
      setTogglingPublicId(key);
      await geoportalAPI.updateMBTilesConfig(tile.id, { published_in_geoportal: nextVal });
      setAllTiles((prev) =>
        prev.map((t) => (t.id === tile.id ? { ...t, published_in_geoportal: nextVal } : t))
      );
      setMessage({
        type: 'success',
        text: `'${tile.name}' सार्वजनिक जियोपोर्टलमा ${nextVal ? 'देखाइयो (Public Visible)' : 'लुकाइयो (Hidden from Public)'}`,
      });
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'सार्वजनिक दृश्यता परिवर्तन गर्न सकिएन' });
    } finally {
      setTogglingPublicId(null);
    }
  };

  const handleLayerUpload = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fileInput = form.file;
    const inputFiles = Array.from(fileInput?.files || []);
    const files = droppedVectorFiles.length > 0 ? droppedVectorFiles : inputFiles;
    if (!files.length) {
      setMessage({ type: 'error', text: 'कृपया भेक्टर फाइल (.geojson, .json, .zip, .gpkg) छान्नुहोस्' });
      return;
    }

    const isGlobal = layerUploadForm.scope === 'GLOBAL';
    const targetProjId = !isGlobal && layerUploadForm.projectId ? parseInt(layerUploadForm.projectId, 10) : null;
    if (!isGlobal && !targetProjId) {
      setMessage({ type: 'error', text: 'कृपया लक्षित परियोजना छान्नुहोस्' });
      return;
    }

    const formSnapshot = { ...layerUploadForm };
    setShowLayerUpload(false);
    setDroppedVectorFiles([]);
    setLayerUploadForm({ name: '', scope: defaultUploadScope, projectId: '', editable_by_collectors: false, allow_snapping: true });

    const runSingleVectorUpload = async (file, idx) => {
      const queueId = `vec_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
      const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
      const layerName = files.length === 1 && formSnapshot.name
        ? formSnapshot.name
        : (formSnapshot.name ? `${formSnapshot.name} (${idx + 1})` : fileNameWithoutExt);

      enqueueUploadItem({
        id: queueId,
        kind: 'vector',
        fileName: file.name,
        layerName,
        percent: 0,
        phase: 'uploading',
        label: 'अपलोड सुरु हुँदैछ...',
        speedMBs: 0,
        status: 'uploading',
        error: null,
      });

      const onProgress = (p) => {
        const isComplete = p.phase === 'complete';
        const isFailed = p.phase === 'failed';
        const isServerWait = ['server_processing', 'verifying', 'reassembling', 'ingesting', 'spatial_indexing'].includes(p.phase);
        updateUploadQueueItem(queueId, {
          percent: p.percent,
          phase: p.phase,
          speedMBs: p.speedMBs || 0,
          label: p.label || `${p.percent}%`,
          status: isComplete ? 'complete' : isFailed ? 'error' : isServerWait ? 'importing' : 'uploading',
        });
      };

      try {
        const result = await uploadFileResumable(file, {
          kind: 'vector',
          name: layerName,
          is_global: isGlobal,
          project_id: targetProjId,
          editable_by_collectors: formSnapshot.editable_by_collectors,
          allow_snapping: formSnapshot.allow_snapping,
        }, onProgress);

        // Wait for background bulk import if signaled
        if (result && result.import_status === 'importing' && result.id) {
          const deadline = Date.now() + 60 * 60 * 1000;
          for (;;) {
            await new Promise((r) => setTimeout(r, 3000));
            let layer;
            try {
              layer = (await layersAPI.get(result.id)).data;
            } catch {
              break;
            }
            if (layer.import_status === 'complete') {
              break;
            }
            if (layer.import_status === 'failed') {
              throw new Error(layer.import_error || 'Import failed');
            }
            const total = layer.import_total || 0;
            const done = layer.import_count || 0;
            const percent = total > 0 ? Math.min(99, Math.round((done * 100) / total)) : 99;
            updateUploadQueueItem(queueId, {
              percent,
              phase: 'importing',
              status: 'importing',
              label: layer.import_phase || (total > 0 ? `${done.toLocaleString()} / ${total.toLocaleString()} फिचर` : 'फिचर आयात हुँदैछ...'),
            });
            if (Date.now() > deadline) break;
          }
        }

        updateUploadQueueItem(queueId, {
          percent: 100,
          phase: 'complete',
          status: 'complete',
          label: 'सफलतापूर्वक अपलोड तथा आयात सम्पन्न',
        });
        if (result && result.id) {
          setPrimaryKeyModal({
            layer: { ...result, fields_config: result.fields_config || [] },
            isPostUpload: true,
          });
        }
        return { ok: true, fileName: file.name };
      } catch (err) {
        const errMsg = formatApiError(err, 'तह अपलोड असफल भयो');
        updateUploadQueueItem(queueId, {
          phase: 'error',
          status: 'error',
          error: errMsg,
          label: errMsg,
        });
        return { ok: false, fileName: file.name, error: errMsg };
      }
    };

    const results = await Promise.all(files.map((file, idx) => runSingleVectorUpload(file, idx)));
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const scopeText = isGlobal ? 'सार्वजनिक तह (Global Layer)' : 'विशेष परियोजना तह (Project-Scoped Layer)';

    if (okCount > 0) {
      loadData();
      if (onLayerUpdate) onLayerUpdate();
    }
    if (failed.length === 0) {
      setMessage({
        type: 'success',
        text: files.length > 1
          ? `${okCount} वटा भेक्टर तहहरू (${scopeText}) सफलतापूर्वक अपलोड गरियो`
          : `भेक्टर तह (${scopeText}) सफलतापूर्वक अपलोड भयो`,
      });
    } else if (okCount > 0) {
      setMessage({
        type: 'error',
        text: `${okCount}/${files.length} फाइल सफल, ${failed.length} असफल: ${failed[0].error}`,
      });
    } else {
      setMessage({ type: 'error', text: failed[0]?.error || 'तह अपलोड असफल भयो' });
    }
  };

  // ---- Toggle Layer Snapping (Admin only) ----
  const handleToggleLayerSnapping = async (layer) => {
    const newStatus = layer.allow_snapping === false;
    try {
      setTogglingSnappingLayerId(layer.id);
      await layersAPI.update(layer.id, { allow_snapping: newStatus });
      setAllLayers((prev) =>
        prev.map((l) => (l.id === layer.id ? { ...l, allow_snapping: newStatus } : l))
      );
      setMessage({
        type: 'success',
        text: `'${layer.name}' तहमा स्न्यापिङ ${newStatus ? 'अनुमति दिइयो (Allowed)' : 'बन्द गरियो (Disabled)'}`,
      });
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err.response?.data?.detail || 'स्न्यापिङ अनुमति परिवर्तन गर्न सकिएन',
      });
    } finally {
      setTogglingSnappingLayerId(null);
    }
  };

  // ---- Per-layer write / validator-download permissions ----
  const handleToggleProjectLayerFlag = async (project, layer, field) => {
    const isEditable = field === 'editable_by_collectors';
    const projectKey = isEditable ? 'editable_layer_ids' : 'download_layer_ids';
    const currentList = Array.isArray(project?.[projectKey]) ? project[projectKey] : [];
    const isCurrentlyActive = isEditable
      ? (layer.editable_by_collectors === true || currentList.some((id) => String(id) === String(layer.id)))
      : (layer.validator_download_allowed === true || currentList.some((id) => String(id) === String(layer.id)));
    const nextValue = !isCurrentlyActive;
    const nextList = nextValue
      ? (currentList.some((id) => String(id) === String(layer.id)) ? currentList : [...currentList, layer.id])
      : currentList.filter((id) => String(id) !== String(layer.id));

    try {
      if (project?.id) {
        await projectsAPI.update(project.id, { [projectKey]: nextList });
        setProjects((prev) => prev.map((p) => (p.id === project.id ? { ...p, [projectKey]: nextList } : p)));
      }
      await layersAPI.update(layer.id, {
        [isEditable ? 'editable_by_collectors' : 'validator_download_allowed']: nextValue,
      });
      setAllLayers((prev) => prev.map((l) => (
        String(l.id) === String(layer.id)
          ? { ...l, [isEditable ? 'editable_by_collectors' : 'validator_download_allowed']: nextValue }
          : l
      )));
      setMessage({
        type: 'success',
        text: isEditable
          ? (nextValue ? `'${layer.name}' संकलक सम्पादनका लागि खोलियो` : `'${layer.name}' संकलक सम्पादन बन्द गरियो`)
          : (nextValue ? `'${layer.name}' प्रमाणक डाउनलोड अनुमति दिइयो` : `'${layer.name}' प्रमाणक डाउनलोड अनुमति हटाइयो`),
      });
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'तह अनुमति परिवर्तन गर्न सकिएन' });
    }
  };

  // ---- House Numbering System Handlers (Metric Address Generation) ----
  const handleSaveProjectHouseNumberingConfig = async (projectId) => {
    try {
      const proj = projects.find((p) => p.id === projectId);
      const cfg = editingHouseNumberConfig[projectId] || proj?.house_numbering_config || {};
      const enabled = editingHouseNumberConfig[projectId]?.house_numbering_enabled ?? proj?.house_numbering_enabled ?? false;
      await projectsAPI.update(projectId, {
        house_numbering_enabled: enabled,
        house_numbering_config: cfg,
      });
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, house_numbering_enabled: enabled, house_numbering_config: cfg } : p)));
      setMessage({ type: 'success', text: 'घर नम्बर प्रणाली सेटिङ सफलतापूर्वक सुरक्षित भयो।' });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'सेटिङ सुरक्षित गर्न सकिएन' });
    }
  };

  const handleGenerateHouseNumbers = async (projectId) => {
    const proj = projects.find((p) => p.id === projectId);
    const cfg = editingHouseNumberConfig[projectId] || proj?.house_numbering_config || {};
    const enabled = editingHouseNumberConfig[projectId]?.house_numbering_enabled ?? proj?.house_numbering_enabled ?? true;

    const bLayer = allLayers.find((l) => String(l.id) === String(cfg.building_layer_id));
    const gLayer = allLayers.find((l) => String(l.id) === String(cfg.gate_layer_id));
    const rLayer = allLayers.find((l) => String(l.id) === String(cfg.road_layer_id));

    if (!bLayer || !['Polygon', 'MultiPolygon'].includes(bLayer.geometry_type)) {
      setMessage({ type: 'error', text: 'घर नम्बरका लागि भवन तह (Building Layer) बहुभुज (Polygon) हुनुपर्दछ।' });
      return;
    }
    if (!gLayer || !['Point', 'MultiPoint'].includes(gLayer.geometry_type)) {
      setMessage({ type: 'error', text: 'घर नम्बरका लागि गेट तह (Gate Layer) बिन्दु (Point) हुनुपर्दछ।' });
      return;
    }
    if (!rLayer || !['LineString', 'MultiLineString', 'Line'].includes(rLayer.geometry_type)) {
      setMessage({ type: 'error', text: 'घर नम्बरका लागि सडक तह (Road Layer) रेखा (LineString) हुनुपर्दछ।' });
      return;
    }

    setGeneratingHouseNumbersId(projectId);
    try {
      const res = await projectsAPI.generateHouseNumbers(projectId, {
        house_numbering_enabled: enabled,
        house_numbering_config: cfg,
      });
      const data = res?.data || res;
      setHouseNumberResult({ projectId, ...data });
      setProjects((prev) => prev.map((p) => (p.id === projectId ? { ...p, house_numbering_enabled: enabled, house_numbering_config: cfg } : p)));
      setMessage({
        type: 'success',
        text: `घर नम्बर सफलतापूर्वक उत्पादन भयो: ${data.total_gates_processed ?? data.gates_processed ?? 0} गेट र ${data.total_buildings_numbered ?? data.buildings_updated ?? 0} भवन अद्यावधिक!`,
      });
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'घर नम्बर उत्पादन गर्न सकिएन' });
    } finally {
      setGeneratingHouseNumbersId(null);
    }
  };

  // Load real attribute names for the house numbering building/gate/road layers so the
  // shared link column and road-name column are chosen from the actual layer schema.
  useEffect(() => {
    if (!expandedProjectId) return;
    const proj = projects.find((p) => String(p.id) === String(expandedProjectId));
    const cfg = editingHouseNumberConfig[expandedProjectId] || proj?.house_numbering_config || {};
    const layerIds = [cfg.building_layer_id, cfg.gate_layer_id, cfg.road_layer_id]
      .filter((id) => id !== undefined && id !== null && id !== '')
      .map(String)
      .filter((id) => !(id in houseNumberFields));
    if (layerIds.length === 0) return;

    let cancelled = false;
    Promise.allSettled(
      layerIds.map(async (id) => {
        const res = await layersAPI.getFields(Number(id));
        const names = (res?.data?.fields || [])
          .map((f) => (typeof f === 'string' ? f : f?.name))
          .filter(Boolean);
        return { id, names: Array.from(new Set(['_id', ...names])) };
      })
    ).then((results) => {
      if (cancelled) return;
      setHouseNumberFields((prev) => {
        const next = { ...prev };
        results.forEach((r) => {
          if (r.status === 'fulfilled' && r.value) next[r.value.id] = r.value.names;
        });
        return next;
      });
    });
    return () => { cancelled = true; };
  }, [expandedProjectId, projects, editingHouseNumberConfig, houseNumberFields]);

  // ---- Recycle Bin (soft-deleted layers & rasters) ----
  const loadRecycleBin = async () => {
    try {
      setRecycleBinLoading(true);
      const [lr, tr] = await Promise.all([
        layersAPI.getDeleted().catch(() => ({ data: [] })),
        tilesAPI.getDeleted().catch(() => ({ data: [] })),
      ]);
      setDeletedLayers(lr.data || []);
      setDeletedTiles(tr.data || []);
    } finally {
      setRecycleBinLoading(false);
    }
  };

  const handleRestoreLayer = async (layer) => {
    try {
      setRestoringId(`layer-${layer.id}`);
      await layersAPI.restore(layer.id);
      setMessage({ type: 'success', text: `'${layer.name}' तह पुनर्स्थापना गरियो (Restored)` });
      loadData();
      loadRecycleBin();
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'पुनर्स्थापना गर्न सकिएन' });
    } finally {
      setRestoringId(null);
    }
  };

  const handlePermanentDeleteLayer = async (layer) => {
    if (!window.confirm(`'${layer.name}' लाई स्थायी रूपमा मेट्ने? सर्भर डिस्कबाट फाइल पनि हट्नेछ र फेरि देखा पर्दैन। (Permanently delete and remove files from disk?)`)) {
      return;
    }
    try {
      setPermanentDeletingId(`layer-${layer.id}`);
      const res = await layersAPI.permanentDelete(layer.id);
      const released = Number(res?.data?.removed_assets || 0);
      setMessage({
        type: 'success',
        text: `'${layer.name}' तह स्थायी रूपमा मेटाइयो${released ? ` (${(released / (1024 * 1024)).toFixed(2)} MB मुक्त)` : ''}`,
      });
      loadRecycleBin();
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'मेटाउन सकिएन' });
    } finally {
      setPermanentDeletingId(null);
    }
  };

  const handlePurgeRecycleBin = async () => {
    if (!window.confirm('रिसाइकल बिनका सबै तह तथा इमेज्री सर्भर डिस्कबाट स्थायी रूपमा हटाउने? यो कार्य फिर्ता गर्न सकिँदैन। (Purge all recycled files from disk? This cannot be undone.)')) {
      return;
    }
    try {
      setPurgeBinLoading(true);
      const res = await systemAPI.purgeRecycleBin();
      const released = Number(res?.data?.bytes_released || 0);
      setMessage({
        type: 'success',
        text: `रिसाइकल बिन खाली गरियो — ${res?.data?.layers_deleted || 0} तह, ${res?.data?.tiles_deleted || 0} इमेज्री, ${(released / (1024 * 1024)).toFixed(2)} MB डिस्क मुक्त`,
      });
      loadData();
      loadRecycleBin();
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'रिसाइकल बिन खाली गर्न सकिएन' });
    } finally {
      setPurgeBinLoading(false);
    }
  };

  const handleToggleGeoportal = async () => {
    const currentlyEnabled = geoportalState?.geoportal_enabled !== false;
    const nextEnabled = !currentlyEnabled;
    if (!nextEnabled && !window.confirm('सार्वजनिक जियोपोर्टल बन्द गर्ने? सबै नागरिक पहुँचमा मर्मत सन्देश देखिनेछ। (Disable the public GeoPortal for all visitors?)')) {
      return;
    }
    try {
      setGeoportalSaving(true);
      const res = await systemAPI.setGeoportalEnabled(nextEnabled);
      setGeoportalState(res.data);
      window.dispatchEvent(new CustomEvent('kmc:geoportal-state', { detail: { enabled: nextEnabled } }));
      setMessage({
        type: 'success',
        text: nextEnabled ? 'जियोपोर्टल पुनः सक्रिय गरियो (GeoPortal enabled)' : 'जियोपोर्टल बन्द गरियो (GeoPortal disabled)',
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'जियोपोर्टल स्थिति परिवर्तन गर्न सकिएन' });
    } finally {
      setGeoportalSaving(false);
    }
  };

  const handleToggleLandingPage = async () => {
    const currentlyEnabled = geoportalState?.landing_page_enabled !== false;
    const nextEnabled = !currentlyEnabled;
    if (!nextEnabled && !window.confirm('ल्यान्डिङ पृष्ठ बन्द गर्ने? बन्द गर्दा सीधा लगइन पृष्ठमा रिडाइरेक्ट हुनेछ। (Disable landing page and redirect root URL directly to login?)')) {
      return;
    }
    try {
      setLandingPageSaving(true);
      await systemAPI.setLandingPageEnabled(nextEnabled);
      setGeoportalState((prev) => ({ ...prev, landing_page_enabled: nextEnabled }));
      setMessage({
        type: 'success',
        text: nextEnabled ? 'ल्यान्डिङ पृष्ठ सक्रिय गरियो (Landing page enabled)' : 'ल्यान्डिङ पृष्ठ बन्द गरियो (Landing page disabled; redirects to login)',
      });
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'ल्यान्डिङ पृष्ठ स्थिति परिवर्तन गर्न सकिएन' });
    } finally {
      setLandingPageSaving(false);
    }
  };

  // Refresh both the disk totals and the per-file inventory.
  const refreshStorageSnapshot = useCallback(async () => {
    setStorageFilesLoading(true);
    try {
      const [usageRes, filesRes] = await Promise.allSettled([
        systemAPI.getStorageUsage(),
        systemAPI.getStorageFiles(),
      ]);
      if (usageRes.status === 'fulfilled') setStorageUsage(usageRes.value.data);
      if (filesRes.status === 'fulfilled') {
        setStorageFiles({
          uploads: filesRes.value.data?.uploads || [],
          tiles: filesRes.value.data?.tiles || [],
        });
      }
    } finally {
      setStorageFilesLoading(false);
    }
  }, []);

  if (!isAdmin) return null;

  const handlePurgeAllStorage = async () => {
    const typed = window.prompt(
      'यसले सबै अपलोड गरिएका तह, MBTiles, अस्थायी फाइल र मेटाडाटा सर्भरबाट स्थायी रूपमा मेट्छ। फिर्ता गर्न सकिँदैन।\n\nपुष्टि गर्न DELETE_ALL_UPLOADS टाइप गर्नुहोस्।\n(Type DELETE_ALL_UPLOADS to confirm.)'
    );
    if (typed === null) return;
    if (typed.trim() !== 'DELETE_ALL_UPLOADS') {
      setMessage({ type: 'error', text: 'पुष्टि मिलेन — केही पनि मेटिएको छैन (Confirmation did not match; nothing was deleted)' });
      return;
    }
    try {
      setStoragePurgeLoading(true);
      const res = await systemAPI.purgeAllStorage('DELETE_ALL_UPLOADS');
      const released = Number(res?.data?.bytes_released || 0);
      setMessage({
        type: 'success',
        text: `सर्भर भण्डारण खाली गरियो — ${res?.data?.files_deleted || 0} फाइल, ${(released / (1024 * 1024)).toFixed(2)} MB मुक्त, ${res?.data?.vector_layers_cleared || 0} तह, ${res?.data?.raster_layers_cleared || 0} इमेज्री मेटिए`,
      });
      await Promise.allSettled([loadData(), loadRecycleBin(), refreshStorageSnapshot()]);
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'सर्भर भण्डारण खाली गर्न सकिएन' });
    } finally {
      setStoragePurgeLoading(false);
    }
  };

  const handleDeleteStorageFile = async (root, file) => {
    const filename = file?.name || file?.path;
    if (!window.confirm(
      `'${filename}' फाइल सर्भर डिस्कबाट स्थायी रूपमा मेट्ने? यससँग सम्बन्धित तह/इमेज्री मेटाडाटा पनि हट्नेछ र डिस्क स्पेस तुरुन्तै खाली हुनेछ। यो कार्य फिर्ता गर्न सकिँदैन।\n\nPermanently delete this file from the server disk? This cannot be undone.`
    )) return;

    const key = `${root}:${file.path}`;
    setStorageFileDeleting(key);
    try {
      const res = await systemAPI.deleteStorageFile(root, file.path);
      const released = Number(res?.data?.bytes_released) || 0;
      const removed = [
        res?.data?.layers_removed ? `${res.data.layers_removed} तह` : '',
        res?.data?.rasters_removed ? `${res.data.rasters_removed} इमेज्री` : '',
      ].filter(Boolean).join(', ');
      setMessage({
        type: 'success',
        text: `'${filename}' फाइल मेटाइयो${released ? ` (${(released / (1024 * 1024)).toFixed(2)} MB मुक्त)` : ''}${removed ? ` · ${removed} मेटाडाटा हटाइयो` : ''}`,
      });
      await Promise.allSettled([loadData(), loadRecycleBin(), refreshStorageSnapshot()]);
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'फाइल मेट्न सकिएन' });
    } finally {
      setStorageFileDeleting(null);
    }
  };

  const handleMasterDeleteUpload = async (kind, item) => {
    const isLayer = kind === 'layer';
    const label = isLayer ? 'भेक्टर तह' : 'रास्टर इमेज्री';
    const message = isLayer
      ? `'${item.name}' तह सर्भरबाट स्थायी रूपमा मेट्ने? यसका सबै फिचर, मेटाडाटा र डिस्क फाइल फिर्ता गर्न सकिँदैन।\n\nPermanently delete this vector layer and all of its data? This cannot be undone.`
      : `'${item.name}' इमेज्री सर्भरबाट स्थायी रूपमा मेट्ने? यसको .mbtiles फाइल र मेटाडाटा फिर्ता गर्न सकिँदैन।\n\nPermanently delete this raster package and its file? This cannot be undone.`;
    if (!window.confirm(message)) return;

    setMasterDeletingId(`${kind}-${item.id}`);
    try {
      const res = isLayer
        ? await layersAPI.permanentDelete(item.id)
        : await tilesAPI.permanentDelete(item.id);
      const released = Number(isLayer ? res?.data?.removed_assets : res?.data?.bytes_released) || 0;
      setMessage({
        type: 'success',
        text: `'${item.name}' ${label} स्थायी रूपमा मेटाइयो${released ? ` (${(released / (1024 * 1024)).toFixed(2)} MB मुक्त)` : ''}`,
      });
      await Promise.allSettled([loadData(), loadRecycleBin(), refreshStorageSnapshot()]);
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || `${label} मेटाउन सकिएन` });
    } finally {
      setMasterDeletingId(null);
    }
  };

  const handleRestoreTile = async (tile) => {
    try {
      setRestoringId(`tile-${tile.id}`);
      await tilesAPI.restore(tile.id);
      setMessage({ type: 'success', text: `'${tile.name}' इमेज्री पुनर्स्थापना गरियो (Restored)` });
      loadData();
      loadRecycleBin();
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'पुनर्स्थापना गर्न सकिएन' });
    } finally {
      setRestoringId(null);
    }
  };

  const handlePermanentDeleteTile = async (tile) => {
    if (!window.confirm(`'${tile.name}' इमेज्री स्थायी रूपमा मेट्ने? सर्भर डिस्कबाट .mbtiles फाइल पनि हट्नेछ। (Permanently delete and remove the file from disk?)`)) {
      return;
    }
    try {
      setPermanentDeletingId(`tile-${tile.id}`);
      const res = await tilesAPI.permanentDelete(tile.id);
      const released = Number(res?.data?.bytes_released || 0);
      setMessage({
        type: 'success',
        text: `'${tile.name}' इमेज्री स्थायी रूपमा मेटाइयो${released ? ` (${(released / (1024 * 1024)).toFixed(2)} MB मुक्त)` : ''}`,
      });
      loadRecycleBin();
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'मेटाउन सकिएन' });
    } finally {
      setPermanentDeletingId(null);
    }
  };

  // ---- Layer Style Editor (GIS Admin: color / thickness / click proximity) ----
  const STYLE_AUTO_PALETTE = [
    '#10b981', '#3b82f6', '#8b5cf6', '#f59e0b', '#ec4899', '#06b6d4',
    '#f97316', '#14b8a6', '#84cc16', '#f43f5e', '#a855f7', '#0ea5e9',
  ];

  const handleOpenStyleEditor = (layer) => {
    const st = layer.style || {};
    const hz = st.hoverMinZoom;
    setStyleForm({
      color: st.strokeColor || '#3b82f6',
      width: Number.isFinite(Number(st.strokeWidth)) && Number(st.strokeWidth) > 0 ? Number(st.strokeWidth) : 3,
      clickTolerance: Number.isFinite(Number(st.clickTolerance)) && Number(st.clickTolerance) >= 2 ? Number(st.clickTolerance) : 14,
      hoverMinZoom: hz === null || hz === undefined || hz === '' ? '' : Number(hz),
    });
    setStyleEditorLayerId(styleEditorLayerId === layer.id ? null : layer.id);
  };

  // Pick a color not used by any other layer's style (unique on the map canvas)
  const handleAutoStyleColor = () => {
    const used = new Set(
      (allLayers || [])
        .filter((l) => l.id !== styleEditorLayerId)
        .map((l) => (l.style?.strokeColor || '').toLowerCase())
        .filter(Boolean)
    );
    let pick = STYLE_AUTO_PALETTE.find((c) => !used.has(c.toLowerCase()));
    if (!pick) {
      // All palette colors taken — generate a vivid random hue
      const hue = Math.floor(Math.random() * 360);
      pick = `hsl(${hue}, 75%, 45%)`;
    }
    setStyleForm((prev) => ({ ...prev, color: pick }));
  };

  const handleSaveLayerStyle = async (layer) => {
    try {
      setSavingStyleLayerId(layer.id);
      const newStyle = {
        ...(layer.style || {}),
        strokeColor: styleForm.color,
        strokeWidth: Number(styleForm.width),
        clickTolerance: Number(styleForm.clickTolerance),
        hoverMinZoom: styleForm.hoverMinZoom === '' || styleForm.hoverMinZoom === null
          ? null
          : Number(styleForm.hoverMinZoom),
      };
      await layersAPI.update(layer.id, { style: newStyle });
      setAllLayers((prev) =>
        prev.map((l) => (l.id === layer.id ? { ...l, style: newStyle } : l))
      );
      setMessage({
        type: 'success',
        text: `'${layer.name}' तहको रङ / मोटाइ / क्लिक दूरी सेभ भयो (Style saved)`,
      });
      setStyleEditorLayerId(null);
      if (onLayerUpdate) onLayerUpdate();
    } catch (err) {
      setMessage({
        type: 'error',
        text: err.response?.data?.detail || 'तहको स्टाइल सेभ गर्न सकिएन',
      });
    } finally {
      setSavingStyleLayerId(null);
    }
  };

  // ---- Open Layer Fields & Compulsory Configuration Modal ----
  const handleOpenFieldConfig = async (layer) => {
    const nativeGeom = layer.geometry_type || 'Point';
    const existingPerms = layer.field_permissions || {};
    const mapAccessLevel = (f) => {
      const allowed = existingPerms[f.name];
      let accessLevel = 'public';
      if (Array.isArray(allowed)) {
        if (!allowed.includes('Validator') && !allowed.includes('BasicViewer') && !allowed.includes('MunicipalUser') && !allowed.includes('DataCollector')) {
          accessLevel = 'admin';
        } else if (!allowed.includes('BasicViewer') && (allowed.includes('MunicipalUser') || allowed.includes('DataCollector'))) {
          accessLevel = 'hide_public';
        } else if (!allowed.includes('BasicViewer')) {
          accessLevel = 'validator';
        }
      }
      return f.access_level || accessLevel;
    };
    const initialFields = Array.isArray(layer.fields_config) && layer.fields_config.length > 0
      ? layer.fields_config.map((f) => ({
          ...f,
          access_level: mapAccessLevel(f),
          is_unique: Boolean(f.is_unique),
          id_mode: f.id_mode === 'auto' ? 'auto' : 'manual',
          id_prefix: f.id_prefix || '',
          id_sequence: f.id_sequence !== undefined ? f.id_sequence : 1,
          visible_in_popup: f.visible_in_popup !== false,
        }))
      : [];
    const creationGeomTypes = Array.isArray(layer.creation_geometry_types) && layer.creation_geometry_types.length > 0
      ? [...layer.creation_geometry_types]
      : [nativeGeom];
    const geomFieldsConfig = layer.geometry_fields_config && typeof layer.geometry_fields_config === 'object'
      ? JSON.parse(JSON.stringify(layer.geometry_fields_config))
      : {};

    setFieldConfigModal({
      layer,
      activeTab: 'DEFAULT',
      fields: initialFields,
      creation_geometry_types: creationGeomTypes,
      geometry_fields_config: geomFieldsConfig,
      loading: initialFields.length === 0,
      saving: false,
    });

    try {
      const res = await layersAPI.getFields(layer.id);
      const fetched = res.data?.fields || [];
      const fetchedGeomTypes = res.data?.creation_geometry_types || [nativeGeom];
      const fetchedGeomFields = res.data?.geometry_fields_config || {};
      setFieldConfigModal((prev) => (prev && prev.layer?.id === layer.id ? {
        ...prev,
        fields: fetched.length > 0 ? fetched.map((f) => ({
          ...f,
          access_level: mapAccessLevel(f),
          is_unique: Boolean(f.is_unique),
          id_mode: f.id_mode === 'auto' ? 'auto' : 'manual',
          id_prefix: f.id_prefix || '',
          id_sequence: f.id_sequence !== undefined ? f.id_sequence : 1,
          visible_in_popup: f.visible_in_popup !== false,
        })) : prev.fields,
        creation_geometry_types: Array.isArray(fetchedGeomTypes) && fetchedGeomTypes.length > 0 ? fetchedGeomTypes : prev.creation_geometry_types,
        geometry_fields_config: fetchedGeomFields && typeof fetchedGeomFields === 'object' ? fetchedGeomFields : prev.geometry_fields_config,
        loading: false,
      } : prev));
    } catch (e) {
      console.warn('Could not auto-fetch fields:', e);
      setFieldConfigModal((prev) => (prev ? { ...prev, loading: false } : null));
    }
  };

  // ---- Re-scan features to auto-detect fields from existing data ----
  const handleAutoDetectFields = async () => {
    if (!fieldConfigModal?.layer) return;
    setFieldConfigModal((prev) => ({ ...prev, loading: true }));
    try {
      const res = await layersAPI.getFields(fieldConfigModal.layer.id, { rescan: true });
      const fetched = res.data?.fields || [];
      setFieldConfigModal((prev) => {
        if (!prev) return null;
        const currentTab = prev.activeTab || 'DEFAULT';
        const isDefault = currentTab === 'DEFAULT';
        const currentList = isDefault ? prev.fields : (prev.geometry_fields_config?.[currentTab] || []);
        const currentMap = new Map((currentList || []).map((f) => [f.name, f]));
        const merged = fetched.map((f) => {
          const exist = currentMap.get(f.name);
          return exist ? { ...f, ...exist } : {
            ...f,
            is_unique: Boolean(f.is_unique),
            id_mode: f.id_mode === 'auto' ? 'auto' : 'manual',
            id_prefix: f.id_prefix || '',
            id_sequence: f.id_sequence !== undefined ? f.id_sequence : 1,
            visible_in_popup: f.visible_in_popup !== false,
          };
        });
        const fetchedNames = new Set(fetched.map((f) => f.name));
        (currentList || []).forEach((f) => {
          if (!fetchedNames.has(f.name)) {
            merged.push(f);
          }
        });
        if (isDefault) {
          return { ...prev, fields: merged, loading: false };
        } else {
          return {
            ...prev,
            geometry_fields_config: {
              ...(prev.geometry_fields_config || {}),
              [currentTab]: merged,
            },
            loading: false,
          };
        }
      });
    } catch (e) {
      setMessage({ type: 'error', text: 'फिल्ड पहिचान गर्न सकिएन: ' + (e.response?.data?.detail || e.message) });
      setFieldConfigModal((prev) => ({ ...prev, loading: false }));
    }
  };

  // ---- Save Layer Fields, Unique ID & Permitted Geometries Configuration ----
  const handleSaveFieldConfig = async () => {
    if (!fieldConfigModal?.layer) return;
    setFieldConfigModal((prev) => ({ ...prev, saving: true }));
    try {
      const cleanField = (f) => ({
        name: (f.name || '').trim().replace(/\s+/g, '_').toLowerCase(),
        label: (f.label || f.name || '').trim(),
        type: f.type || 'text',
        required: Boolean(f.required),
        access_level: f.access_level || 'public',
        is_unique: Boolean(f.is_unique),
        id_mode: f.id_mode === 'auto' ? 'auto' : 'manual',
        id_prefix: (f.id_prefix || '').trim(),
        id_sequence: parseInt(f.id_sequence, 10) || 1,
        visible_in_popup: f.visible_in_popup !== false,
        options: Array.isArray(f.options) ? f.options : [],
        ...(Array.isArray(f.editable_roles) && f.editable_roles.length > 0
          ? { editable_roles: f.editable_roles }
          : {}),
      });

      const cleanedDefaultFields = (fieldConfigModal.fields || [])
        .map(cleanField)
        .filter((f) => f.name.length > 0);

      // Build field_permissions map based on access_level
      const field_permissions = { ...(fieldConfigModal.layer.field_permissions || {}) };
      cleanedDefaultFields.forEach((f) => {
        if (f.access_level === 'admin') {
          field_permissions[f.name] = ['DepartmentAdmin', 'GisAdmin', 'SuperAdmin', 'MasterAdmin'];
        } else if (f.access_level === 'hide_public') {
          field_permissions[f.name] = ['MunicipalUser', 'DataCollector', 'Validator', 'DepartmentAdmin', 'GisAdmin', 'SuperAdmin', 'MasterAdmin'];
        } else if (f.access_level === 'validator') {
          field_permissions[f.name] = ['Validator', 'DepartmentAdmin', 'GisAdmin', 'SuperAdmin', 'MasterAdmin'];
        } else {
          field_permissions[f.name] = ['BasicViewer', 'MunicipalUser', 'DataCollector', 'Validator', 'DepartmentAdmin', 'GisAdmin', 'SuperAdmin', 'MasterAdmin'];
        }
      });

      const cleanedGeomFieldsConfig = {};
      if (fieldConfigModal.geometry_fields_config && typeof fieldConfigModal.geometry_fields_config === 'object') {
        Object.entries(fieldConfigModal.geometry_fields_config).forEach(([geomType, fList]) => {
          if (Array.isArray(fList)) {
            cleanedGeomFieldsConfig[geomType] = fList.map(cleanField).filter((f) => f.name.length > 0);
          }
        });
      }

      const creationGeomTypes = Array.isArray(fieldConfigModal.creation_geometry_types) && fieldConfigModal.creation_geometry_types.length > 0
        ? fieldConfigModal.creation_geometry_types
        : [fieldConfigModal.layer.geometry_type || 'Point'];

      const uniqueFieldObj = cleanedDefaultFields.find((f) => f.is_unique);
      const uniqueFieldName = uniqueFieldObj ? uniqueFieldObj.name : null;
      const uniqueFieldMode = uniqueFieldObj ? (uniqueFieldObj.id_mode === 'auto' ? 'autogenerate' : 'manual') : 'manual';
      const uniqueFieldPrefix = uniqueFieldObj ? (uniqueFieldObj.id_prefix || '') : '';

      await layersAPI.updateFields(fieldConfigModal.layer.id, {
        fields: cleanedDefaultFields,
        creation_geometry_types: creationGeomTypes,
        geometry_fields_config: cleanedGeomFieldsConfig,
        field_permissions,
        unique_field: uniqueFieldName,
        unique_mode: uniqueFieldMode,
        unique_prefix: uniqueFieldPrefix,
      });

      try {
        await layersAPI.update(fieldConfigModal.layer.id, {
          unique_field: uniqueFieldName,
          unique_mode: uniqueFieldMode,
          unique_prefix: uniqueFieldPrefix,
        });
      } catch (err) {
        console.warn('Syncing unique field to layer metadata notice:', err);
      }

      setAllLayers((prev) =>
        prev.map((l) => (l.id === fieldConfigModal.layer.id ? {
          ...l,
          fields_config: cleanedDefaultFields,
          creation_geometry_types: creationGeomTypes,
          geometry_fields_config: cleanedGeomFieldsConfig,
          field_permissions,
          unique_field: uniqueFieldName,
          unique_mode: uniqueFieldMode,
          unique_prefix: uniqueFieldPrefix,
        } : l))
      );

      setMessage({
        type: 'success',
        text: `'${fieldConfigModal.layer.name}' तहको फिल्ड, अद्वितीय ID तथा नयाँ फिचर सिर्जना नियमहरू सुरक्षित गरियो!`,
      });
      setFieldConfigModal(null);
      loadData();
      if (onLayerUpdate) onLayerUpdate();
    } catch (e) {
      setMessage({ type: 'error', text: 'फिल्ड कन्फिगरेसन सुरक्षित गर्न सकिएन: ' + (e.response?.data?.detail || e.message) });
      setFieldConfigModal((prev) => ({ ...prev, saving: false }));
    }
  };

  // ---- Upload MBTiles (Global or Project-Scoped) ----
  const handleTileUpload = async (e) => {
    e.preventDefault();
    const form = e.target;
    const fileInput = form.file;
    const inputFiles = Array.from(fileInput?.files || []);
    const files = droppedTileFiles.length > 0 ? droppedTileFiles : inputFiles;
    if (!files.length) {
      setMessage({ type: 'error', text: 'कृपया .mbtiles फाइल छान्नुहोस्' });
      return;
    }

    const isGlobal = tileUploadForm.scope === 'GLOBAL';
    const targetProjId = !isGlobal && tileUploadForm.projectId ? parseInt(tileUploadForm.projectId, 10) : null;
    if (!isGlobal && !targetProjId) {
      setMessage({ type: 'error', text: 'कृपया लक्षित परियोजना छान्नुहोस्' });
      return;
    }

    const formSnapshot = { ...tileUploadForm };
    setShowTileUpload(false);
    setDroppedTileFiles([]);
    setTileUploadForm({ name: '', description: '', scope: defaultUploadScope, projectId: '' });

    const runSingleTileUpload = async (file, idx) => {
      const queueId = `tile_${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`;
      const fileNameWithoutExt = file.name.replace(/\.[^/.]+$/, '').replace(/_/g, ' ');
      const layerName = files.length === 1 && formSnapshot.name
        ? formSnapshot.name
        : (formSnapshot.name ? `${formSnapshot.name} (${idx + 1})` : fileNameWithoutExt);

      enqueueUploadItem({
        id: queueId,
        kind: 'raster',
        fileName: file.name,
        layerName,
        percent: 0,
        phase: 'uploading',
        label: 'इमेज्री अपलोड सुरु हुँदैछ...',
        speedMBs: 0,
        status: 'uploading',
        error: null,
      });

      const onProgress = (p) => {
        const isComplete = p.phase === 'complete';
        const isFailed = p.phase === 'failed';
        const isServerWait = ['server_processing', 'verifying', 'reassembling', 'ingesting', 'spatial_indexing'].includes(p.phase);
        updateUploadQueueItem(queueId, {
          percent: p.percent,
          phase: p.phase,
          speedMBs: p.speedMBs || 0,
          label: p.label || `${p.percent}%`,
          status: isComplete ? 'complete' : isFailed ? 'error' : isServerWait ? 'importing' : 'uploading',
        });
      };

      try {
        await uploadFileResumable(file, {
          kind: 'raster',
          name: layerName,
          description: formSnapshot.description || null,
          is_global: isGlobal,
          project_id: targetProjId,
        }, onProgress);
        updateUploadQueueItem(queueId, {
          percent: 100,
          phase: 'complete',
          status: 'complete',
          label: 'टाइल सर्भरमा सक्रिय गरियो',
        });
        return { ok: true, fileName: file.name };
      } catch (err) {
        const errMsg = formatApiError(err, 'इमेज्री अपलोड असफल भयो');
        updateUploadQueueItem(queueId, {
          phase: 'error',
          status: 'error',
          error: errMsg,
          label: errMsg,
        });
        return { ok: false, fileName: file.name, error: errMsg };
      }
    };

    const results = await Promise.all(files.map((file, idx) => runSingleTileUpload(file, idx)));
    const okCount = results.filter((r) => r.ok).length;
    const failed = results.filter((r) => !r.ok);
    const scopeText = isGlobal ? 'सार्वजनिक इमेज्री (Global)' : 'विशेष परियोजना इमेज्री (Project-Scoped)';

    if (okCount > 0) {
      loadData();
      if (onLayerUpdate) onLayerUpdate();
    }
    if (failed.length === 0) {
      setMessage({
        type: 'success',
        text: files.length > 1
          ? `${okCount} वटा ड्रोन इमेज्री फाइलहरू (${scopeText}) सफलतापूर्वक अपलोड गरियो र टाइल सर्भरमा सक्रिय भयो`
          : `ड्रोन इमेज्री (${scopeText}) सफलतापूर्वक अपलोड भयो र टाइल सर्भरमा सक्रिय गरियो`,
      });
    } else if (okCount > 0) {
      setMessage({
        type: 'error',
        text: `${okCount}/${files.length} इमेज्री सफल, ${failed.length} असफल: ${failed[0].error}`,
      });
    } else {
      setMessage({ type: 'error', text: failed[0]?.error || 'इमेज्री अपलोड असफल भयो' });
    }
  };

  // ---- Download Vector Layer (GisAdmin only) ----
  const handleDownloadLayer = async (layer, format = 'geojson') => {
    if (!layer || !layer.id) return;
    try {
      setDownloadingLayerId(layer.id);
      setDownloadingLayerFormat(format);
      const res = await layersAPI.download(layer.id, format);
      const ext = format === 'shapefile' || format === 'shp' ? 'zip' : format;
      const defaultFilename = `${(layer.name || 'layer').replace(/[^a-zA-Z0-9_\-\.]/g, '_')}.${ext}`;
      triggerFileDownload(res, defaultFilename);
      setMessage({
        type: 'success',
        text: `'${layer.name}' (${format.toUpperCase()}) सफलतापूर्वक डाउनलोड भयो`,
      });
      setLayerDownloadModal(null);
    } catch (err) {
      console.error('[AdminPanel] Error downloading layer:', err);
      setMessage({
        type: 'error',
        text: err.response?.data?.detail || 'तह डाउनलोड गर्न सकिएन',
      });
    } finally {
      setDownloadingLayerId(null);
      setDownloadingLayerFormat(null);
    }
  };

  // ---- Download Collector Tracking Log (CSV: time + coordinates) ----
  const handleDownloadAdminLogs = async () => {
    try {
      setDownloadingLogs(true);
      const res = await trackingAPI.downloadAdminLogs();
      const filename = `kmc_collector_tracking_${new Date().toISOString().slice(0, 10)}.csv`;
      triggerFileDownload(res, filename);
      setMessage({
        type: 'success',
        text: 'संकलक मार्ग लग सफलतापूर्वक डाउनलोड भयो (CSV)',
      });
    } catch (err) {
      console.error('[AdminPanel] Error downloading admin logs:', err);
      setMessage({
        type: 'error',
        text: err.response?.data?.detail || 'लग डाउनलोड गर्न सकिएन',
      });
    } finally {
      setDownloadingLogs(false);
    }
  };

  // ---- Download MBTiles Raster Layer (GisAdmin only) ----
  const handleDownloadTile = async (tile) => {
    if (!tile || !tile.id) return;
    try {
      setDownloadingTileId(tile.id);
      const res = await tilesAPI.download(tile.id);
      const defaultFilename = tile.filename || `${(tile.name || 'tiles').replace(/[^a-zA-Z0-9_\-\.]/g, '_')}.mbtiles`;
      triggerFileDownload(res, defaultFilename);
      setMessage({
        type: 'success',
        text: `'${tile.name}' (.mbtiles) सफलतापूर्वक डाउनलोड भयो`,
      });
    } catch (err) {
      console.error('[AdminPanel] Error downloading MBTiles:', err);
      setMessage({
        type: 'error',
        text: err.response?.data?.detail || 'इमेज्री डाउनलोड गर्न सकिएन',
      });
    } finally {
      setDownloadingTileId(null);
    }
  };

  // ---- Assign Layer to a Project ----
  const handleAssignLayer = async (projectId, layerId) => {
    if (!projectId || !layerId) return;
    try {
      await projectsAPI.assignLayer(projectId, layerId);
      const projObj = projects.find((p) => p.id === projectId);
      setMessage({ type: 'success', text: `तह सफलतापूर्वक '${projObj?.name || 'परियोजना'}' मा समावेश गरियो` });
      setAssignModal(null);
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'परियोजनामा समावेश गर्न सकिएन' });
    }
  };

  // ---- Unassign Layer from a Project ----
  const handleUnassignLayer = async (projectId, layerId) => {
    if (!projectId || !layerId) return;
    try {
      await projectsAPI.unassignLayer(projectId, layerId);
      setMessage({ type: 'success', text: 'तह परियोजनाबाट हटाइयो' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'हटाउन सकिएन' });
    }
  };

  // ---- Assign Tiles to a Project ----
  const handleAssignTiles = async (projectId, tilesId) => {
    if (!projectId || !tilesId) return;
    try {
      await projectsAPI.assignTiles(projectId, tilesId);
      const projObj = projects.find((p) => p.id === projectId);
      setMessage({ type: 'success', text: `MBTiles सफलतापूर्वक '${projObj?.name || 'परियोजना'}' मा समावेश गरियो` });
      setAssignModal(null);
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'परियोजनामा समावेश गर्न सकिएन' });
    }
  };

  // ---- Unassign Tiles from a Project ----
  const handleUnassignTiles = async (projectId, tilesId) => {
    if (!projectId || !tilesId) return;
    try {
      await projectsAPI.unassignTiles(projectId, tilesId);
      setMessage({ type: 'success', text: 'MBTiles इमेज्री परियोजनाबाट हटाइयो' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'हटाउन सकिएन' });
    }
  };

  // ---- Assign Collector to a Project ----
  const handleAssignCollector = async (projectId, userId) => {
    if (!projectId || !userId) return;
    try {
      await projectsAPI.assignCollectors(projectId, [userId]);
      const projObj = projects.find((p) => p.id === projectId);
      const userObj = users.find((u) => u.id === userId);
      setMessage({
        type: 'success',
        text: `तथ्याङ्क संकलक '${userObj?.full_name || userObj?.username}' सफलतापूर्वक '${projObj?.name || 'परियोजना'}' मा तोकियो`,
      });
      setAddingCollectorProjectId(null);
      setSelectedCollectorIdToAssign('');
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'तथ्याङ्क संकलक तोक्न सकिएन' });
    }
  };

  // ---- Unassign Collector from a Project ----
  const handleUnassignCollector = async (projectId, userId) => {
    if (!projectId || !userId) return;
    try {
      await projectsAPI.unassignCollector(projectId, userId);
      setMessage({ type: 'success', text: 'तथ्याङ्क संकलक परियोजनाबाट सफलतापूर्वक हटाइयो' });
      loadData();
    } catch (err) {
      setMessage({ type: 'error', text: err.response?.data?.detail || 'हटाउन सकिएन' });
    }
  };

  // Helpers for filtering layers and tiles
  const filteredLayers = allLayers.filter((layer) => {
    if (projectFilter === 'GLOBAL' && !layer.is_global) return false;
    if (projectFilter !== 'ALL' && projectFilter !== 'GLOBAL') {
      const pId = parseInt(projectFilter, 10);
      const isDirectProject = layer.project_id === pId;
      const isAssigned = projectAssignments[pId]?.layer_ids?.includes(layer.id);
      if (!isDirectProject && !isAssigned) return false;
    }
    if (searchTerm.trim()) {
      return (
        layer.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        layer.geometry_type?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    return true;
  });

  const filteredTiles = allTiles.filter((tile) => {
    if (projectFilter === 'GLOBAL' && !tile.is_global) return false;
    if (projectFilter !== 'ALL' && projectFilter !== 'GLOBAL') {
      const pId = parseInt(projectFilter, 10);
      const isDirectProject = tile.project_id === pId;
      const isAssigned = projectAssignments[pId]?.tile_ids?.includes(tile.id);
      if (!isDirectProject && !isAssigned) return false;
    }
    if (searchTerm.trim()) {
      return (
        tile.name?.toLowerCase().includes(searchTerm.toLowerCase()) ||
        tile.filename?.toLowerCase().includes(searchTerm.toLowerCase())
      );
    }
    return true;
  });

  const tabs = [
    { id: 'projects', label: 'परियोजनाहरू', labelEn: 'Projects', icon: FolderPlus },
    { id: 'questionnaires', label: 'प्रश्नावली प्रणाली', labelEn: 'Questionnaires', icon: ClipboardList },
    { id: 'records', label: 'रेकर्ड समीक्षा (QA)', labelEn: 'Field Records', icon: CheckSquare },
    { id: 'tracking', label: 'लाइभ ट्र्याकिङ', labelEn: 'Live Tracking', icon: Radio },
    { id: 'layers', label: 'भेक्टर तहहरू', labelEn: 'Vector Layers', icon: Layers },
    { id: 'tiles', label: 'ड्रोन इमेज्री', labelEn: 'Drone MBTiles', icon: Image },
    { id: 'ordering', label: 'तह क्रमबद्धता (Ordering)', labelEn: 'Layer Stacking', icon: ListOrdered },
    { id: 'users', label: 'अधिकृतहरू', labelEn: 'Officers', icon: Users },
    ...(isDepartmentAdmin
      ? []
      : [{ id: 'services', label: 'GIS सेवा लिङ्कहरू', labelEn: 'GIS Service Links', icon: ExternalLink }]),
    // Master control is exclusive to the MasterAdmin account.
    ...(isMasterAdmin
      ? [{ id: 'master', label: 'मास्टर नियन्त्रण', labelEn: 'Master Control', icon: ShieldAlert }]
      : []),
    // Swarm secrets are visible only to the private master account.
    ...(isMasterAdmin
      ? [{ id: 'secrets', label: 'स्वारम गोप्यता (Swarm Secrets)', labelEn: 'Swarm Secrets', icon: Key }]
      : []),
  ];

  return (
    <div className="gov-sidebar font-sans" id="admin-panel">
      {/* Header */}
      <div className="gov-sidebar-header shrink-0">
        <div className="flex items-center gap-2">
          <ShieldCheck className="w-5 h-5 text-gov-gold-400 shrink-0" />
          <div>
            <h2 className="text-sm font-bold text-white font-nepali leading-tight">
              प्रशासनिक नियन्त्रण (Admin Console)
            </h2>
            <span className="text-[10px] text-gov-blue-200 block">
              काठमाडौँ महानगरपालिका WebGIS व्यवस्थापन
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            disabled={downloadingLogs}
            onClick={handleDownloadAdminLogs}
            className="px-2 py-1 text-gov-blue-100 hover:text-white hover:bg-gov-blue-800 rounded-lg transition-colors flex items-center gap-1 text-[11px] font-bold border border-white/20 shadow-xs"
            title="संकलक मार्ग लग डाउनलोड (CSV) (Download Collector Tracking Logs)"
          >
            {downloadingLogs ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <FileDown className="w-3.5 h-3.5 text-gov-gold-400" />
            )}
            <span className="font-nepali">लग (CSV)</span>
          </button>
          <button
            type="button"
            onClick={loadData}
            className="p-1.5 text-gov-blue-200 hover:text-white hover:bg-gov-blue-900 rounded-lg transition-colors"
            title="पुनः लोड (Refresh)"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-1 text-white/90 hover:text-white hover:bg-gov-red-700/90 rounded-lg transition-colors flex items-center gap-1 text-xs font-bold border border-white/20 hover:border-gov-red-500 shadow-xs"
            title="बन्द गर्नुहोस् (Close Admin Panel)"
          >
            <span className="text-[10px]">बन्द</span>
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Alert Message */}
      {message && (
        <div
          className={`mx-3 mt-2 px-3 py-2 rounded-md text-xs font-semibold animate-fade-in flex items-center justify-between border shrink-0 ${
            message.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
              : 'bg-gov-red-50 text-gov-red-800 border-gov-red-200'
          }`}
        >
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="text-slate-400 hover:text-slate-700 ml-2">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-slate-200 bg-white px-2 pt-1.5 overflow-x-auto scrollbar-none shrink-0">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                setActiveTab(tab.id);
                setSearchTerm('');
              }}
              className={`flex items-center gap-1.5 px-3 py-2 text-xs font-bold border-b-2 transition-colors whitespace-nowrap font-nepali ${
                isActive
                  ? 'text-gov-blue-800 border-gov-blue-800 bg-gov-blue-50/50'
                  : 'text-slate-500 border-transparent hover:text-slate-800'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Body Content */}
      {/* Independent Non-Blocking Upload Queue */}
      {uploadQueue.length > 0 && (
        <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 space-y-1.5 max-h-40 overflow-y-auto shrink-0">
          <div className="flex items-center justify-between text-[10px] font-bold text-slate-600 font-nepali">
            <span>अपलोड लाम (Active Upload Queue: {uploadQueue.length})</span>
            <button
              type="button"
              onClick={() => setUploadQueue((prev) => prev.filter((it) => it.status === 'uploading' || it.status === 'importing'))}
              className="text-gov-blue-700 hover:underline"
            >
              सम्पन्न हटाउनुहोस्
            </button>
          </div>
          {uploadQueue.map((item) => (
            <div key={item.id} className="bg-white border border-slate-200 rounded-md p-2 text-[10px] space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-slate-800 truncate" title={item.fileName}>
                  {item.kind === 'raster' ? '🛰️' : '🗺️'} {item.fileName}
                </span>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className={`font-mono font-bold ${
                    item.status === 'error'
                      ? 'text-red-600'
                      : item.status === 'complete'
                      ? 'text-emerald-700'
                      : item.status === 'importing'
                      ? 'text-amber-600'
                      : 'text-gov-blue-800'
                  }`}>
                    {item.status === 'error' ? 'Failed' : `${item.percent}%`}
                  </span>
                  {(item.status === 'complete' || item.status === 'error') && (
                    <button
                      type="button"
                      onClick={() => dismissUploadQueueItem(item.id)}
                      className="text-slate-400 hover:text-slate-600"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  )}
                </div>
              </div>
              <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    item.status === 'error'
                      ? 'bg-red-500'
                      : item.status === 'complete'
                      ? 'bg-emerald-600'
                      : item.status === 'importing' || ['server_processing', 'verifying', 'reassembling', 'ingesting', 'spatial_indexing'].includes(item.phase)
                      ? 'bg-gradient-to-r from-amber-500 to-amber-400 animate-pulse'
                      : 'bg-gov-blue-800'
                  }`}
                  style={{ width: `${Math.max(4, item.percent)}%` }}
                />
              </div>
              <div className="text-[9.5px] text-slate-500 truncate flex items-center justify-between">
                <span className="truncate">{item.label}</span>
                {(item.status === 'importing' || ['server_processing', 'verifying', 'reassembling', 'ingesting', 'spatial_indexing'].includes(item.phase)) && (
                  <span className="shrink-0 text-amber-700 font-medium font-nepali ml-1">सर्भर प्रशोधन</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="gov-sidebar-body space-y-3 flex-1 overflow-y-auto overscroll-contain p-3">
        {/* ======================================================== */}
        {/* ============ 1. PROJECTS TAB (with Layer Manager) ====== */}
        {/* ======================================================== */}
        {activeTab === 'projects' && (
          <div className="space-y-3 animate-fade-in">
            {(isSuperAdmin || isDepartmentAdmin) && (
              <button
                type="button"
                onClick={() => setShowProjectForm(!showProjectForm)}
                className="btn-gov-primary w-full text-xs font-bold py-2 flex items-center justify-center gap-1.5 shadow-sm"
              >
                <Plus className="w-4 h-4 text-gov-gold-400" />
                <span>नयाँ परियोजना थप्नुहोस् (New Project)</span>
              </button>
            )}

            {(isSuperAdmin || isDepartmentAdmin) && showProjectForm && (
              <form onSubmit={handleCreateProject} className="bg-white p-3.5 rounded-lg border border-gov-blue-300 shadow-md space-y-2.5 animate-slide-up">
                <div className="text-xs font-bold text-gov-blue-900 font-nepali border-b border-slate-100 pb-1 flex items-center justify-between">
                  <span>परियोजना विवरण (Project Setup)</span>
                  <span className="text-[10px] text-gov-red-600">* अनिवार्य</span>
                </div>
                <div>
                  <label className="gov-label">परियोजनाको नाम (Project Name)</label>
                  <input
                    value={projectForm.name}
                    onChange={(e) => setProjectForm((p) => ({ ...p, name: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="उदा. वडा नं. ४ तथ्याङ्क संकलन"
                    required
                  />
                </div>
                <div>
                  <label className="gov-label">विवरण (Description)</label>
                  <textarea
                    value={projectForm.description}
                    onChange={(e) => setProjectForm((p) => ({ ...p, description: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="परियोजनाको उद्देश्य र कार्यक्षेत्र..."
                    rows={2}
                  />
                </div>
                <div>
                  <label className="gov-label font-nepali">सर्वेक्षण ढाँचा (Collection Mode)</label>
                  <div className="grid grid-cols-2 gap-2 mt-1">
                    <button
                      type="button"
                      onClick={() => setProjectForm((p) => ({ ...p, project_mode: 'STANDARD' }))}
                      className={`p-2 rounded-lg border text-left text-xs font-nepali transition-all ${
                        projectForm.project_mode === 'STANDARD'
                          ? 'bg-gov-blue-50 border-gov-blue-600 font-bold text-gov-blue-900 shadow-xs'
                          : 'border-slate-200 text-slate-700 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-bold">मानक GIS संकलन</div>
                      <div className="text-[10px] text-slate-500">Standard GIS Collection</div>
                    </button>
                    <button
                      type="button"
                      onClick={() => setProjectForm((p) => ({ ...p, project_mode: 'ADVANCED_QUESTIONNAIRE' }))}
                      className={`p-2 rounded-lg border text-left text-xs font-nepali transition-all ${
                        projectForm.project_mode === 'ADVANCED_QUESTIONNAIRE'
                          ? 'bg-gov-blue-50 border-gov-blue-600 font-bold text-gov-blue-900 shadow-xs'
                          : 'border-slate-200 text-slate-700 bg-white hover:bg-slate-50'
                      }`}
                    >
                      <div className="font-bold">उन्नत प्रश्नावली संकलन</div>
                      <div className="text-[10px] text-slate-500">Advanced Questionnaire</div>
                    </button>
                  </div>
                </div>
                {projectForm.project_mode === 'ADVANCED_QUESTIONNAIRE' && (
                  <div>
                    <label className="gov-label font-nepali">ज्यामिति प्रकार (Geometry Configuration)</label>
                    <select
                      value={projectForm.geometry_config?.type || 'Point'}
                      onChange={(e) => setProjectForm((p) => ({ ...p, geometry_config: { type: e.target.value } }))}
                      className="gov-input text-xs"
                    >
                      <option value="Point">बिन्दु (Point - Buildings / Poles / Assets)</option>
                      <option value="LineString">रेखा (Line - Roads / Drainage / Pipelines)</option>
                      <option value="Polygon">बहुभुज (Polygon - Land Parcels / Areas)</option>
                      <option value="Mix">मिश्रित ज्यामिति (Mixed Geometry - Multi-target)</option>
                    </select>
                  </div>
                )}
                {isSuperAdmin && (
                  <div>
                    <label className="gov-label font-nepali">विभागीय प्रशासक लिङ्क (Link Departments Admins)</label>
                    <div className="max-h-28 overflow-y-auto border border-slate-200 rounded p-1.5 space-y-1 bg-white mt-1">
                      {users.filter((u) => ['DepartmentAdmin', 'GisAdmin'].includes(u.role) && u.is_active).length === 0 ? (
                        <p className="text-[10px] text-slate-500 font-nepali">कुनै विभागीय प्रशासक उपलब्ध छैन।</p>
                      ) : users.filter((u) => ['DepartmentAdmin', 'GisAdmin'].includes(u.role) && u.is_active).map((u) => {
                        const checked = (projectForm.department_admin_ids || []).some((id) => String(id) === String(u.id));
                        return (
                          <label key={u.id} className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => setProjectForm((p) => {
                                const ids = p.department_admin_ids || [];
                                return {
                                  ...p,
                                  department_admin_ids: checked
                                    ? ids.filter((id) => String(id) !== String(u.id))
                                    : [...ids, u.id],
                                };
                              })}
                            />
                            <span>{u.full_name || u.username} <span className="text-slate-400">(@{u.username})</span></span>
                          </label>
                        );
                      })}
                    </div>
                    <p className="text-[10px] text-slate-500 mt-1 font-nepali">
                      यी प्रशासकहरूले यस परियोजनाका लागि मात्र प्रश्नावली, प्रमाणीकरणकर्ता र संकलक व्यवस्थापन गर्न सक्नेछन्।
                    </p>
                  </div>
                )}
                {/* Optional House Numbering Setting for Project */}
                <div className="p-2.5 rounded bg-amber-50/60 border border-amber-200 text-xs">
                  <label className="flex items-center gap-2 cursor-pointer font-bold text-amber-950 font-nepali">
                    <input
                      type="checkbox"
                      checked={Boolean(projectForm.house_numbering_enabled)}
                      onChange={(e) => setProjectForm((p) => ({ ...p, house_numbering_enabled: e.target.checked }))}
                      className="rounded text-amber-600 focus:ring-amber-500 h-4 w-4"
                    />
                    <Home className="w-4 h-4 text-amber-700" />
                    <span>घर नम्बर प्रणाली सक्षम गर्नुहोस् (Enable House Numbering Mode)</span>
                  </label>
                  <p className="text-[10px] text-amber-800 mt-1 font-nepali pl-6">
                    परियोजना सिर्जना पश्चात् भवन, गेट र सडक तहहरू लिङ्क गरी दूरी र दिशा (बायाँ बिजोर, दायाँ जोर) अनुसार स्वचालित घर नम्बर उत्पादन गर्न सकिनेछ।
                  </p>
                </div>

                <div className="p-2.5 rounded bg-gov-blue-50/70 border border-gov-blue-200 text-[11px] text-gov-blue-900 flex items-start gap-2">
                  <Grid3X3 className="w-4 h-4 text-gov-blue-800 shrink-0 mt-0.5" />
                  <span>
                    <strong>सूचना:</strong> कार्यक्षेत्र विभाजन तथा ग्रिड व्यवस्थापन परियोजना सिर्जना पश्चात् <strong>कार्य विभाजन ग्रिड (Task Grid)</strong> बाट सिमाना अपलोड (Method A) वा ग्रिड उत्पादन (Method B) मार्फत गर्न सकिन्छ।
                  </span>
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" className="btn-gov-primary flex-1 text-xs py-1.5">
                    सिर्जना गर्नुहोस्
                  </button>
                  <button type="button" onClick={() => setShowProjectForm(false)} className="btn-gov-secondary text-xs py-1.5">
                    रद्द गर्नुहोस्
                  </button>
                </div>
              </form>
            )}

            {/* Projects List with Inline Asset & Collector Manager */}
            <div className="space-y-2.5">
              {projects.map((proj) => {
                const isExpanded = expandedProjectId === proj.id;
                const assignedLayerIds = projectAssignments[proj.id]?.layer_ids || [];
                const assignedTileIds = projectAssignments[proj.id]?.tile_ids || [];
                const assignedCollectors = projectCollectors[proj.id] || [];
                const availableCollectorsToAssign = users.filter(
                  (u) => ['DataCollector', 'Validator'].includes(u.role) && u.is_active && !assignedCollectors.some((ac) => ac.user_id === u.id)
                );

                // Directly scoped layers & assigned layers
                const linkedLayers = allLayers.filter(
                  (l) => l.project_id === proj.id || assignedLayerIds.includes(l.id)
                );
                // Directly scoped tiles & assigned tiles
                const linkedTiles = allTiles.filter(
                  (t) => t.project_id === proj.id || assignedTileIds.includes(t.id)
                );

                // House numbering schema-driven column options
                const houseCfg = editingHouseNumberConfig[proj.id] || proj.house_numbering_config || {};
                const buildingFields = houseNumberFields[String(houseCfg.building_layer_id ?? '')] || [];
                const gateFields = houseNumberFields[String(houseCfg.gate_layer_id ?? '')] || [];
                const sharedLinkFields = buildingFields.filter((f) => gateFields.includes(f));
                const linkFieldOptions = sharedLinkFields.length > 0
                  ? sharedLinkFields
                  : Array.from(new Set([...buildingFields, ...gateFields]));
                const roadFieldOptions = houseNumberFields[String(houseCfg.road_layer_id ?? '')] || [];
                const currentLinkField = houseCfg.link_field ?? 'building_id';
                const linkSelectOptions = linkFieldOptions.includes(currentLinkField)
                  ? linkFieldOptions
                  : [currentLinkField, ...linkFieldOptions];
                const currentRoadNameField = houseCfg.road_name_field ?? 'name';
                const roadSelectOptions = roadFieldOptions.includes(currentRoadNameField)
                  ? roadFieldOptions
                  : [currentRoadNameField, ...roadFieldOptions];

                return (
                  <div
                    key={proj.id}
                    className={`bg-white rounded-lg border transition-all shadow-xs ${
                      isExpanded ? 'border-gov-blue-800 ring-1 ring-gov-blue-800/30' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    {/* Project Header Bar */}
                    <div
                      className="p-3 flex items-center justify-between cursor-pointer select-none"
                      onClick={() => setExpandedProjectId(isExpanded ? null : proj.id)}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <div className="w-8 h-8 rounded-lg bg-gov-blue-50 border border-gov-blue-200 flex items-center justify-center text-gov-blue-800 shrink-0">
                          <Folder className="w-4 h-4" />
                        </div>
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-900 truncate font-nepali">
                            {proj.name}
                          </div>
                          <div className="text-[10px] text-slate-500 flex items-center gap-2 font-mono">
                            <span className="bg-slate-100 px-1.5 py-0.2 rounded font-semibold text-slate-700">
                              #{proj.id} &middot; {proj.status}
                            </span>
                            <span>{proj.task_count || 0} ग्रिड</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] bg-gov-blue-100/70 text-gov-blue-900 font-bold px-1.5 py-0.5 rounded font-nepali">
                          {linkedLayers.length + linkedTiles.length} तहहरू
                        </span>
                        <span className="text-[10px] bg-emerald-100 text-emerald-900 font-bold px-1.5 py-0.5 rounded font-nepali">
                          {assignedCollectors.length} संकलक
                        </span>
                        {isExpanded ? (
                          <ChevronUp className="w-4 h-4 text-slate-500" />
                        ) : (
                          <ChevronDown className="w-4 h-4 text-slate-500" />
                        )}
                      </div>
                    </div>

                    {/* Expanded Project Details & Asset Linkage Manager */}
                    {isExpanded && (
                      <div className="border-t border-slate-100 p-3 bg-slate-50/50 space-y-3 animate-fade-in text-xs">
                        {proj.description && (
                          <p className="text-[11px] text-slate-600 bg-white p-2 rounded border border-slate-200/70">
                            {proj.description}
                          </p>
                        )}

                        {/* Questionnaire Mode Action Banner */}
                        <div className="flex items-center justify-between p-2.5 bg-gov-blue-50/80 border border-gov-blue-200 rounded-lg">
                          <div>
                            <div className="text-xs font-bold text-gov-blue-900 font-nepali">
                              {proj.project_mode === 'ADVANCED_QUESTIONNAIRE'
                                ? 'उन्नत प्रश्नावली प्रणाली (Questionnaire Mode)'
                                : 'मानक GIS फिचर संकलन (Standard Mode)'}
                            </div>
                            <div className="text-[10px] text-slate-600">
                              {proj.project_mode === 'ADVANCED_QUESTIONNAIRE'
                                ? `ज्यामिति: ${proj.geometry_config?.type || 'Point'} • संरचनाबद्ध बहु-खण्ड सर्वेक्षण`
                                : 'तह विशेषता तालिका मार्फत प्रत्यक्ष संकलन'}
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setSelectedQuestionnaireProject(proj);
                              setQuestionnaireStudioProject(proj);
                            }}
                            className="flex items-center gap-1.5 px-3 py-1.5 bg-gov-blue-800 hover:bg-gov-blue-700 text-white rounded-lg text-xs font-bold font-nepali shadow-xs transition-colors"
                          >
                            <ClipboardList className="w-3.5 h-3.5 text-gov-gold-400" />
                            <span>प्रश्नावली स्टुडियो</span>
                          </button>
                        </div>

                        {/* 1. Linked Vector Layers */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-[11px] font-bold text-slate-800 font-nepali">
                            <span className="flex items-center gap-1 text-gov-blue-900">
                              <Layers className="w-3.5 h-3.5 text-gov-blue-700" />
                              <span>संलग्न भेक्टर तहहरू ({linkedLayers.length})</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => setAssignModal({ type: 'layer', targetProjectId: proj.id })}
                              className="text-[10px] text-gov-blue-800 hover:text-gov-blue-950 font-bold flex items-center gap-1 bg-gov-blue-100/60 hover:bg-gov-blue-200/70 px-1.5 py-0.5 rounded transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                              <span>तह लिङ्क गर्नुहोस्</span>
                            </button>
                          </div>

                          {linkedLayers.length === 0 ? (
                            <div className="text-[10px] text-slate-400 bg-white p-2 rounded border border-dashed border-slate-200 text-center font-nepali">
                              यस परियोजनामा कुनै भेक्टर तह लिङ्क गरिएको छैन
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {linkedLayers.map((l) => {
                                const isDirect = l.project_id === proj.id;
                                return (
                                  <div
                                    key={l.id}
                                    className="flex items-center justify-between bg-white px-2 py-1.5 rounded border border-slate-200 text-[11px]"
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="w-2 h-2 rounded-full bg-gov-blue-700 shrink-0" />
                                      <span className="font-semibold text-slate-800 truncate font-nepali">
                                        {l.name}
                                      </span>
                                      <span className="text-[9px] text-slate-500 font-mono">
                                        ({l.geometry_type})
                                      </span>
                                      {isDirect ? (
                                        <span className="text-[9px] bg-amber-100 text-amber-900 font-bold px-1 rounded font-nepali">
                                          विशेष (Direct)
                                        </span>
                                      ) : (
                                        <span className="text-[9px] bg-slate-100 text-slate-700 px-1 rounded font-nepali">
                                          सार्वजनिक (Global)
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-1">
                                      {(() => {
                                        const isCollectorEditable = l.editable_by_collectors === true || (Array.isArray(proj.editable_layer_ids) && proj.editable_layer_ids.some(id => String(id) === String(l.id)));
                                        return (
                                          <button
                                            type="button"
                                            onClick={() => handleToggleProjectLayerFlag(proj, l, 'editable_by_collectors')}
                                            className={`p-0.5 rounded transition-colors ${
                                              isCollectorEditable
                                                ? 'text-emerald-700 hover:text-emerald-900 hover:bg-emerald-50'
                                                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                                            }`}
                                            title={isCollectorEditable
                                              ? 'संकलक सम्पादन बन्द गर्नुहोस् (Stop collector editing)'
                                              : 'संकलक सम्पादन खोल्नुहोस् (Allow collector editing)'}
                                          >
                                            {isCollectorEditable ? <Edit3 className="w-3 h-3 text-emerald-700" /> : <EyeOff className="w-3 h-3" />}
                                          </button>
                                        );
                                      })()}
                                      {(() => {
                                        const isValidatorDownloadable = l.validator_download_allowed === true || (Array.isArray(proj.download_layer_ids) && proj.download_layer_ids.some(id => String(id) === String(l.id)));
                                        return (
                                          <button
                                            type="button"
                                            onClick={() => handleToggleProjectLayerFlag(proj, l, 'validator_download_allowed')}
                                            className={`p-0.5 rounded transition-colors ${
                                              isValidatorDownloadable
                                                ? 'text-amber-600 hover:text-amber-800 hover:bg-amber-50'
                                                : 'text-slate-400 hover:text-slate-600 hover:bg-slate-100'
                                            }`}
                                            title={isValidatorDownloadable
                                              ? 'प्रमाणकको डाउनलोड अनुमति फिर्ता लिनुहोस् (Revoke validator download)'
                                              : 'प्रमाणकलाई डाउनलोड अनुमति दिनुहोस् (Grant validator download)'}
                                          >
                                            <ShieldCheck className="w-3 h-3 text-amber-600" />
                                          </button>
                                        );
                                      })()}
                                      <button
                                        type="button"
                                        onClick={() => setLayerDownloadModal({ layer: l })}
                                        className="text-gov-blue-700 hover:text-gov-blue-900 p-0.5 rounded hover:bg-gov-blue-50 transition-colors"
                                        title="तह डाउनलोड गर्नुहोस् (Download Layer)"
                                      >
                                        <Download className="w-3 h-3" />
                                      </button>
                                      {!isDirect && (
                                        <button
                                          type="button"
                                          onClick={() => handleUnassignLayer(proj.id, l.id)}
                                          className="text-gov-red-600 hover:text-gov-red-800 p-0.5 rounded hover:bg-red-50 transition-colors"
                                          title="परियोजनाबाट हटाउनुहोस् (Unlink)"
                                        >
                                          <Unlink className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* House Numbering System Settings (वैकल्पिक घर नम्बर प्रणाली) */}
                        <div className="bg-gradient-to-r from-amber-50/70 via-orange-50/40 to-slate-50 border border-amber-200/90 rounded-lg p-3 space-y-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className="w-6 h-6 rounded-md bg-amber-100 text-amber-800 flex items-center justify-center">
                                <Home className="w-3.5 h-3.5" />
                              </div>
                              <div>
                                <div className="text-xs font-bold text-amber-950 font-nepali">
                                  घर नम्बर प्रणाली सेटिङ (House Numbering System)
                                </div>
                                <div className="text-[10px] text-amber-800 font-nepali">
                                  भवन, गेट र सडक तहका आधारमा दूरी र क्रस-प्रडक्ट दिशा (बायाँ बिजोर, दायाँ जोर) अनुसार घर नम्बर उत्पादन
                                </div>
                              </div>
                            </div>

                            <label className="flex items-center gap-1.5 cursor-pointer select-none">
                              <input
                                type="checkbox"
                                checked={Boolean(
                                  editingHouseNumberConfig[proj.id]?.house_numbering_enabled ?? proj.house_numbering_enabled
                                )}
                                onChange={(e) => {
                                  const enabled = e.target.checked;
                                  setEditingHouseNumberConfig((prev) => ({
                                    ...prev,
                                    [proj.id]: {
                                      ...(prev[proj.id] || proj.house_numbering_config || {}),
                                      house_numbering_enabled: enabled,
                                    },
                                  }));
                                }}
                                className="rounded text-amber-600 focus:ring-amber-500 h-4 w-4"
                              />
                              <span className="text-[11px] font-bold text-amber-900 font-nepali">सक्रिय (Enabled)</span>
                            </label>
                          </div>

                          {(editingHouseNumberConfig[proj.id]?.house_numbering_enabled ?? proj.house_numbering_enabled) && (
                            <div className="space-y-2.5 pt-2 border-t border-amber-200/70">
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                                {/* 1. Building Layer (Polygon) */}
                                <div>
                                  <label className="text-[10px] font-bold text-slate-800 block mb-0.5 font-nepali">
                                    १. भवन तह (Building Layer - Polygon):
                                  </label>
                                  <select
                                    value={
                                      editingHouseNumberConfig[proj.id]?.building_layer_id ??
                                      proj.house_numbering_config?.building_layer_id ??
                                      ''
                                    }
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setEditingHouseNumberConfig((prev) => ({
                                        ...prev,
                                        [proj.id]: {
                                          ...(prev[proj.id] || proj.house_numbering_config || {}),
                                          building_layer_id: val,
                                        },
                                      }));
                                    }}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs text-slate-800 focus:border-amber-600 outline-none"
                                  >
                                    <option value="">-- भवन तह (Polygon) छान्नुहोस् --</option>
                                    {(linkedLayers.length > 0 ? linkedLayers : allLayers)
                                      .filter((l) => ['Polygon', 'MultiPolygon'].includes(l.geometry_type))
                                      .map((l) => (
                                        <option key={l.id} value={l.id}>
                                          {l.name} ({l.geometry_type})
                                        </option>
                                      ))}
                                    {(linkedLayers.length > 0 ? linkedLayers : allLayers).filter((l) => ['Polygon', 'MultiPolygon'].includes(l.geometry_type)).length === 0 && (
                                      <option disabled value="">(कुनै बहुभुज/Polygon तह भेटिएन)</option>
                                    )}
                                  </select>
                                </div>

                                {/* 2. Gate Layer (Point) */}
                                <div>
                                  <label className="text-[10px] font-bold text-slate-800 block mb-0.5 font-nepali">
                                    २. गेट तह (Gate Layer - Point):
                                  </label>
                                  <select
                                    value={
                                      editingHouseNumberConfig[proj.id]?.gate_layer_id ??
                                      proj.house_numbering_config?.gate_layer_id ??
                                      ''
                                    }
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setEditingHouseNumberConfig((prev) => ({
                                        ...prev,
                                        [proj.id]: {
                                          ...(prev[proj.id] || proj.house_numbering_config || {}),
                                          gate_layer_id: val,
                                        },
                                      }));
                                    }}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs text-slate-800 focus:border-amber-600 outline-none"
                                  >
                                    <option value="">-- गेट तह (Point) छान्नुहोस् --</option>
                                    {(linkedLayers.length > 0 ? linkedLayers : allLayers)
                                      .filter((l) => ['Point', 'MultiPoint'].includes(l.geometry_type))
                                      .map((l) => (
                                        <option key={l.id} value={l.id}>
                                          {l.name} ({l.geometry_type})
                                        </option>
                                      ))}
                                    {(linkedLayers.length > 0 ? linkedLayers : allLayers).filter((l) => ['Point', 'MultiPoint'].includes(l.geometry_type)).length === 0 && (
                                      <option disabled value="">(कुनै बिन्दु/Point तह भेटिएन)</option>
                                    )}
                                  </select>
                                </div>

                                {/* 3. Road Layer (LineString) */}
                                <div>
                                  <label className="text-[10px] font-bold text-slate-800 block mb-0.5 font-nepali">
                                    ३. सडक तह (Road Layer - LineString):
                                  </label>
                                  <select
                                    value={
                                      editingHouseNumberConfig[proj.id]?.road_layer_id ??
                                      proj.house_numbering_config?.road_layer_id ??
                                      ''
                                    }
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setEditingHouseNumberConfig((prev) => ({
                                        ...prev,
                                        [proj.id]: {
                                          ...(prev[proj.id] || proj.house_numbering_config || {}),
                                          road_layer_id: val,
                                        },
                                      }));
                                    }}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs text-slate-800 focus:border-amber-600 outline-none"
                                  >
                                    <option value="">-- सडक तह (LineString) छान्नुहोस् --</option>
                                    {(linkedLayers.length > 0 ? linkedLayers : allLayers)
                                      .filter((l) => ['LineString', 'MultiLineString', 'Line'].includes(l.geometry_type))
                                      .map((l) => (
                                        <option key={l.id} value={l.id}>
                                          {l.name} ({l.geometry_type})
                                        </option>
                                      ))}
                                    {(linkedLayers.length > 0 ? linkedLayers : allLayers).filter((l) => ['LineString', 'MultiLineString', 'Line'].includes(l.geometry_type)).length === 0 && (
                                      <option disabled value="">(कुनै रेखा/LineString तह भेटिएन)</option>
                                    )}
                                  </select>
                                </div>
                              </div>

                              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 pt-1">
                                {/* Link Field */}
                                <div>
                                  <label className="text-[10px] font-bold text-slate-800 block mb-0.5 font-nepali">
                                    भवन र गेट जोड्ने साझा स्तम्भ (Identical Link Field):
                                  </label>
                                  <select
                                    value={currentLinkField}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setEditingHouseNumberConfig((prev) => ({
                                        ...prev,
                                        [proj.id]: {
                                          ...(prev[proj.id] || proj.house_numbering_config || {}),
                                          link_field: val,
                                        },
                                      }));
                                    }}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs text-slate-800 focus:border-amber-600 outline-none font-mono"
                                  >
                                    {linkSelectOptions.map((f) => (
                                      <option key={f} value={f}>
                                        {f}{sharedLinkFields.includes(f) ? ' ✓ (भवन + गेट)' : ''}
                                      </option>
                                    ))}
                                    {linkSelectOptions.length === 0 && (
                                      <option value={currentLinkField}>{currentLinkField}</option>
                                    )}
                                  </select>
                                  {linkFieldOptions.length === 0 && (
                                    <div className="text-[9px] text-amber-700 mt-0.5 font-nepali">
                                      भवन र गेट तह छान्नुहोस् — तहका वास्तविक फिल्डहरू स्वतः देखिनेछन्।
                                    </div>
                                  )}
                                  <div className="text-[9px] text-slate-500 mt-0.5 font-nepali">
                                    गेट र भवन दुवैमा भएको समान मान जसबाट भवनले गेटको घर नम्बर प्राप्त गर्दछ।
                                  </div>
                                </div>

                                {/* Road Name Field */}
                                <div>
                                  <label className="text-[10px] font-bold text-slate-800 block mb-0.5 font-nepali">
                                    सडकको नाम भएको स्तम्भ (Road Name Field):
                                  </label>
                                  <select
                                    value={currentRoadNameField}
                                    onChange={(e) => {
                                      const val = e.target.value;
                                      setEditingHouseNumberConfig((prev) => ({
                                        ...prev,
                                        [proj.id]: {
                                          ...(prev[proj.id] || proj.house_numbering_config || {}),
                                          road_name_field: val,
                                        },
                                      }));
                                    }}
                                    className="w-full bg-white border border-slate-300 rounded px-2 py-1 text-xs text-slate-800 focus:border-amber-600 outline-none font-mono"
                                  >
                                    {roadSelectOptions.map((f) => (
                                      <option key={f} value={f}>
                                        {f}
                                      </option>
                                    ))}
                                    {roadSelectOptions.length === 0 && (
                                      <option value={currentRoadNameField}>{currentRoadNameField}</option>
                                    )}
                                  </select>
                                  {roadFieldOptions.length === 0 && (
                                    <div className="text-[9px] text-amber-700 mt-0.5 font-nepali">
                                      सडक तह छान्नुहोस् — तहका वास्तविक फिल्डहरू स्वतः देखिनेछन्।
                                    </div>
                                  )}
                                  <div className="text-[9px] text-slate-500 mt-0.5 font-nepali">
                                    सडक नाम नभएमा वा खाली भएमा स्वतः RNR (उदा. RNR/55) राखिनेछ।
                                  </div>
                                </div>
                              </div>

                              {/* Action Buttons */}
                              <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-amber-200/50">
                                <div className="text-[10px] text-amber-900 font-nepali">
                                  * बायाँतर्फ बिजोर (Odd) र दायाँतर्फ जोर (Even) नम्बर क्रस-प्रडक्ट अनुसार तोकिनेछ।
                                </div>
                                <div className="flex items-center gap-2">
                                  <button
                                    type="button"
                                    onClick={() => handleSaveProjectHouseNumberingConfig(proj.id)}
                                    className="px-2.5 py-1 rounded bg-white hover:bg-slate-100 text-slate-700 border border-slate-300 text-xs font-bold font-nepali flex items-center gap-1 cursor-pointer transition-colors"
                                  >
                                    <Save className="w-3 h-3 text-slate-600" />
                                    <span>सेटिङ सुरक्षित गर्नुहोस्</span>
                                  </button>

                                  <button
                                    type="button"
                                    disabled={generatingHouseNumbersId === proj.id}
                                    onClick={() => handleGenerateHouseNumbers(proj.id)}
                                    className="px-3 py-1 rounded bg-gradient-to-r from-amber-600 to-amber-700 hover:from-amber-700 hover:to-amber-800 text-white text-xs font-bold font-nepali flex items-center gap-1.5 shadow-xs cursor-pointer disabled:opacity-50 transition-all"
                                  >
                                    {generatingHouseNumbersId === proj.id ? (
                                      <>
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                        <span>उत्पादन गरिँदैछ...</span>
                                      </>
                                    ) : (
                                      <>
                                        <Sparkles className="w-3 h-3 text-amber-200" />
                                        <span>घर नम्बर उत्पादन गर्नुहोस् (Generate)</span>
                                      </>
                                    )}
                                  </button>
                                </div>
                              </div>

                              {/* Result feedback */}
                              {houseNumberResult && houseNumberResult.projectId === proj.id && (
                                <div className="p-2.5 rounded-lg bg-white border border-amber-300 shadow-xs space-y-1.5 text-xs animate-slide-up">
                                  <div className="flex items-center gap-1.5 font-bold text-amber-950 font-nepali">
                                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                                    <span>घर नम्बर उत्पादन सम्पन्न भयो:</span>
                                  </div>
                                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 text-[11px] font-mono">
                                    <div className="p-1 rounded bg-slate-50 border border-slate-200">
                                      <span className="text-slate-500 block text-[9px] font-nepali">गेट प्रक्रिया:</span>
                                      <span className="font-bold text-slate-900">{houseNumberResult.total_gates_processed ?? houseNumberResult.gates_processed ?? 0}</span>
                                    </div>
                                    <div className="p-1 rounded bg-slate-50 border border-slate-200">
                                      <span className="text-slate-500 block text-[9px] font-nepali">भवन अद्यावधिक:</span>
                                      <span className="font-bold text-emerald-800">{houseNumberResult.total_buildings_numbered ?? houseNumberResult.buildings_updated ?? 0}</span>
                                    </div>
                                    <div className="p-1 rounded bg-slate-50 border border-slate-200">
                                      <span className="text-slate-500 block text-[9px] font-nepali">बायाँ (बिजोर):</span>
                                      <span className="font-bold text-amber-800">{houseNumberResult.left_side_count || 0}</span>
                                    </div>
                                    <div className="p-1 rounded bg-slate-50 border border-slate-200">
                                      <span className="text-slate-500 block text-[9px] font-nepali">दायाँ (जोर):</span>
                                      <span className="font-bold text-gov-blue-800">{houseNumberResult.right_side_count || 0}</span>
                                    </div>
                                  </div>
                                  {Array.isArray(houseNumberResult.sample_house_numbers) && houseNumberResult.sample_house_numbers.length > 0 && (
                                    <div className="text-[10px] text-slate-600 flex flex-wrap items-center gap-1 pt-1 border-t border-slate-100">
                                      <span className="font-bold text-slate-700 font-nepali">नमुना नम्बरहरू:</span>
                                      {houseNumberResult.sample_house_numbers.map((num, idx) => (
                                        <span key={idx} className="px-1.5 py-0.2 rounded bg-amber-100/80 font-mono text-amber-900 font-bold">
                                          {num}
                                        </span>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </div>

                        {/* 2. Linked MBTiles Imagery */}
                        <div className="space-y-1.5">
                          <div className="flex items-center justify-between text-[11px] font-bold text-slate-800 font-nepali">
                            <span className="flex items-center gap-1 text-gov-blue-900">
                              <Image className="w-3.5 h-3.5 text-gov-blue-700" />
                              <span>संलग्न ड्रोन इमेज्री ({linkedTiles.length})</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => setAssignModal({ type: 'tile', targetProjectId: proj.id })}
                              className="text-[10px] text-gov-blue-800 hover:text-gov-blue-950 font-bold flex items-center gap-1 bg-gov-blue-100/60 hover:bg-gov-blue-200/70 px-1.5 py-0.5 rounded transition-colors"
                            >
                              <Plus className="w-3 h-3" />
                              <span>इमेज्री लिङ्क गर्नुहोस्</span>
                            </button>
                          </div>

                          {linkedTiles.length === 0 ? (
                            <div className="text-[10px] text-slate-400 bg-white p-2 rounded border border-dashed border-slate-200 text-center font-nepali">
                              यस परियोजनामा कुनै ड्रोन इमेज्री लिङ्क गरिएको छैन
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {linkedTiles.map((t) => {
                                const isDirect = t.project_id === proj.id;
                                return (
                                  <div
                                    key={t.id}
                                    className="flex items-center justify-between bg-white px-2 py-1.5 rounded border border-slate-200 text-[11px]"
                                  >
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
                                      <span className="font-semibold text-slate-800 truncate font-nepali">
                                        {t.name}
                                      </span>
                                      {isDirect ? (
                                        <span className="text-[9px] bg-amber-100 text-amber-900 font-bold px-1 rounded font-nepali">
                                          विशेष (Direct)
                                        </span>
                                      ) : (
                                        <span className="text-[9px] bg-slate-100 text-slate-700 px-1 rounded font-nepali">
                                          सार्वजनिक (Global)
                                        </span>
                                      )}
                                    </div>

                                    <div className="flex items-center gap-1">
                                      <button
                                        type="button"
                                        disabled={downloadingTileId === t.id}
                                        onClick={() => handleDownloadTile(t)}
                                        className="text-emerald-700 hover:text-emerald-900 p-0.5 rounded hover:bg-emerald-50 transition-colors"
                                        title="MBTiles डाउनलोड गर्नुहोस् (Download .mbtiles)"
                                      >
                                        {downloadingTileId === t.id ? (
                                          <Loader2 className="w-3 h-3 animate-spin" />
                                        ) : (
                                          <Download className="w-3 h-3" />
                                        )}
                                      </button>
                                      {!isDirect && (
                                        <button
                                          type="button"
                                          onClick={() => handleUnassignTiles(proj.id, t.id)}
                                          className="text-gov-red-600 hover:text-gov-red-800 p-0.5 rounded hover:bg-red-50 transition-colors"
                                          title="परियोजनाबाट हटाउनुहोस् (Unlink)"
                                        >
                                          <Unlink className="w-3 h-3" />
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* 3. Assigned Data Collectors (तोकिएका तथ्याङ्क संकलकहरू) */}
                        <div className="space-y-1.5 pt-1 border-t border-slate-200/60">
                          <div className="flex items-center justify-between text-[11px] font-bold text-slate-800 font-nepali">
                            <span className="flex items-center gap-1 text-gov-blue-900">
                              <Users className="w-3.5 h-3.5 text-gov-blue-700" />
                              <span>तोकिएका तथ्याङ्क संकलकहरू ({assignedCollectors.length})</span>
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setAddingCollectorProjectId(addingCollectorProjectId === proj.id ? null : proj.id);
                                setSelectedCollectorIdToAssign('');
                              }}
                              className="text-[10px] text-gov-blue-800 hover:text-gov-blue-950 font-bold flex items-center gap-1 bg-gov-blue-100/60 hover:bg-gov-blue-200/70 px-1.5 py-0.5 rounded transition-colors"
                            >
                              <UserPlus className="w-3 h-3" />
                              <span>संकलक तोक्नुहोस्</span>
                            </button>
                          </div>

                          {/* Quick assign collector bar */}
                          {addingCollectorProjectId === proj.id && (
                            <div className="bg-gov-blue-50/80 p-2 rounded-lg border border-gov-blue-200 space-y-1.5 animate-slide-up">
                              <div className="text-[10px] font-bold text-gov-blue-900 font-nepali">
                                यस परियोजनामा तथ्याङ्क संकलक तोक्नुहोस् (Assign Data Collector):
                              </div>
                              {availableCollectorsToAssign.length === 0 ? (
                                <div className="text-[10px] text-slate-500 font-nepali">
                                  सबै तथ्याङ्क संकलकहरू यस परियोजनामा पहिल्यै तोकिएका छन् वा कुनै सक्रिय संकलक उपलब्ध छैन।
                                </div>
                              ) : (
                                <div className="flex items-center gap-1.5">
                                  <select
                                    value={selectedCollectorIdToAssign}
                                    onChange={(e) => setSelectedCollectorIdToAssign(e.target.value)}
                                    className="gov-input text-xs py-1 flex-1 bg-white"
                                  >
                                    <option value="">-- संकलक चयन गर्नुहोस् (Select Collector) --</option>
                                    {availableCollectorsToAssign.map((c) => (
                                      <option key={c.id} value={c.id}>
                                        {c.full_name || c.username} (@{c.username})
                                      </option>
                                    ))}
                                  </select>
                                  <button
                                    type="button"
                                    disabled={!selectedCollectorIdToAssign}
                                    onClick={() => handleAssignCollector(proj.id, parseInt(selectedCollectorIdToAssign, 10))}
                                    className="btn-gov-primary text-[10px] py-1 px-2.5 font-bold disabled:opacity-50"
                                  >
                                    तोक्नुहोस्
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setAddingCollectorProjectId(null)}
                                    className="btn-gov-secondary text-[10px] py-1 px-1.5"
                                  >
                                    <X className="w-3 h-3" />
                                  </button>
                                </div>
                              )}
                            </div>
                          )}

                          {assignedCollectors.length === 0 ? (
                            <div className="text-[10px] text-slate-400 bg-white p-2 rounded border border-dashed border-slate-200 text-center font-nepali">
                              यस परियोजनामा कुनै तथ्याङ्क संकलक तोकिएको छैन (Data Collectors cannot access until assigned)
                            </div>
                          ) : (
                            <div className="space-y-1">
                              {assignedCollectors.map((c) => (
                                <div
                                  key={c.user_id}
                                  className="flex items-center justify-between bg-white px-2 py-1.5 rounded border border-slate-200 text-[11px]"
                                >
                                  <div className="flex items-center gap-1.5 min-w-0">
                                    <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
                                    <span className="font-semibold text-slate-800 truncate font-nepali">
                                      {c.full_name || c.username}
                                    </span>
                                    <span className="text-[9px] text-slate-500 font-mono">
                                      (@{c.username})
                                    </span>
                                    <span className="text-[9px] bg-gov-blue-50 text-gov-blue-800 font-semibold px-1 rounded font-nepali">
                                      {c.assigned_tasks_count} ग्रिड तोकिएको
                                    </span>
                                  </div>

                                  <button
                                    type="button"
                                    onClick={() => handleUnassignCollector(proj.id, c.user_id)}
                                    className="text-gov-red-600 hover:text-gov-red-800 p-0.5 rounded hover:bg-red-50 transition-colors"
                                    title="परियोजनाबाट संकलक हटाउनुहोस् (Unassign)"
                                  >
                                    <UserX className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>

                        {/* Danger Zone: Delete Project */}
                        <div className="pt-2 border-t border-slate-200/80 flex items-center justify-between">
                          <span className="text-[10px] text-slate-400 font-nepali">परियोजना आईडी: #{proj.id}</span>
                          {isSuperAdmin && (
                            <button
                              type="button"
                              onClick={() => handleDeleteProject(proj.id, proj.name)}
                              className="btn-gov-danger text-[11px] py-1 px-2.5 flex items-center gap-1.5"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                              <span>परियोजना मेटाउनुहोस् (Delete Project)</span>
                            </button>
                          )}
                        </div>

                        {/* Quick Direct Upload Buttons for this specific project */}
                        <div className="pt-2 border-t border-slate-200/80 flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setLayerUploadForm({ name: '', scope: 'PROJECT', projectId: String(proj.id), editable_by_collectors: false, allow_snapping: true });
                              setShowLayerUpload(true);
                              setActiveTab('layers');
                            }}
                            className="flex-1 py-1 px-2 rounded bg-white hover:bg-slate-100 text-gov-blue-800 border border-slate-300 text-[10px] font-bold font-nepali flex items-center justify-center gap-1"
                          >
                            <Upload className="w-3 h-3" />
                            <span>यस परियोजनामा भेक्टर अपलोड</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setTileUploadForm({ name: '', description: '', scope: 'PROJECT', projectId: String(proj.id) });
                              setShowTileUpload(true);
                              setActiveTab('tiles');
                            }}
                            className="flex-1 py-1 px-2 rounded bg-white hover:bg-slate-100 text-gov-blue-800 border border-slate-300 text-[10px] font-bold font-nepali flex items-center justify-center gap-1"
                          >
                            <Upload className="w-3 h-3" />
                            <span>यस परियोजनामा इमेज्री अपलोड</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ LIVE TRACKING TAB (Collector Fleet) ======== */}
        {/* ======================================================== */}
        {activeTab === 'tracking' && (
          <div className="space-y-3 animate-fade-in">
            {/* Header Metrics */}
            <div className="grid grid-cols-2 gap-2">
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-2.5 flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center text-emerald-700 shrink-0">
                  <Radio className="w-4 h-4 animate-pulse" />
                </div>
                <div>
                  <div className="text-[10px] text-emerald-800 font-bold font-nepali">सक्रिय संकलकहरू</div>
                  <div className="text-base font-black text-emerald-950">
                    {collectorLocations.filter((c) => c.is_online).length} <span className="text-[10px] font-normal text-slate-500">/ {collectorLocations.length} जना</span>
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 border border-slate-200 rounded-lg p-2.5 flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-slate-200 flex items-center justify-center text-slate-700 shrink-0">
                  <MapPin className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-[10px] text-slate-600 font-bold font-nepali">स्थान ट्र्याक स्थिति</div>
                  <div className="text-xs font-bold text-slate-800 font-nepali">
                    {collectorLocations.filter((c) => c.latitude && c.longitude).length} जनाको स्थान उपलब्ध
                  </div>
                </div>
              </div>
            </div>

            {/* Admin Audit & Tracking Route Logs Download Banner */}
            <div className="bg-gov-blue-50/80 border border-gov-blue-200 rounded-lg p-2.5 flex items-center justify-between gap-2 shadow-xs">
              <div className="min-w-0">
                <div className="text-xs font-bold text-gov-blue-950 font-nepali truncate">
                  संकलक मार्ग तथा स्थान लग (CSV)
                </div>
                <div className="text-[10px] text-slate-600 font-nepali leading-tight">
                  संकलकहरूको सम्पूर्ण GPS ट्र्याक टाइमलाइन र प्रणाली अडिट लग सुरक्षित डाउनलोड गर्नुहोस्
                </div>
              </div>
              <button
                type="button"
                disabled={downloadingLogs}
                onClick={handleDownloadAdminLogs}
                className="btn-gov-primary text-xs py-1.5 px-3 flex items-center gap-1.5 font-nepali shrink-0 shadow-xs"
                title="सम्पूर्ण संकलक मार्ग लग CSV ढाँचामा डाउनलोड गर्नुहोस्"
              >
                {downloadingLogs ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <FileDown className="w-3.5 h-3.5" />
                )}
                <span>{downloadingLogs ? 'डाउनलोड हुँदै...' : 'लग डाउनलोड (CSV)'}</span>
              </button>
            </div>

            {/* Search Input */}
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="संकलक खोज्नुहोस् (Search collector)..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="gov-input text-xs py-1.5 flex-1"
              />
              <button
                type="button"
                onClick={loadData}
                className="btn-gov-secondary text-xs py-1.5 px-2.5 flex items-center gap-1 font-nepali shrink-0"
                title="ताजा गर्नुहोस् (Refresh Locations)"
              >
                <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
                <span>रिफ्रेस</span>
              </button>
            </div>

            {/* Collector Cards List */}
            <div className="space-y-2">
              {collectorLocations
                .filter((col) => {
                  if (!searchTerm.trim()) return true;
                  const term = searchTerm.toLowerCase();
                  return (
                    col.full_name?.toLowerCase().includes(term) ||
                    col.username?.toLowerCase().includes(term) ||
                    col.email?.toLowerCase().includes(term)
                  );
                })
                .map((col) => {
                  const hasLocation = col.latitude !== null && col.longitude !== null;
                  return (
                    <div
                      key={col.user_id}
                      className={`bg-white rounded-xl border p-3 shadow-xs space-y-2 transition-all ${
                        col.is_online ? 'border-emerald-300 ring-1 ring-emerald-100' : 'border-slate-200'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="relative shrink-0">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-xs ${
                              col.is_online ? 'bg-emerald-100 text-emerald-800 ring-2 ring-emerald-400' : 'bg-slate-100 text-slate-700'
                            }`}>
                              {col.full_name ? col.full_name.charAt(0).toUpperCase() : 'U'}
                            </div>
                            {col.is_online && (
                              <span className="absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse ring-2 ring-white" />
                            )}
                          </div>

                          <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-900 font-nepali truncate">
                              {col.full_name || col.username}
                            </div>
                            <div className="text-[10px] text-slate-500 font-mono">
                              @{col.username} &middot; {col.email}
                            </div>
                          </div>
                        </div>

                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold shrink-0 flex items-center gap-1 ${
                          col.is_online
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-slate-100 text-slate-600'
                        }`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${col.is_online ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} />
                          <span>{col.is_online ? 'सक्रिय (Active)' : (col.app_state === 'background' || col.app_state === 'inactive' ? 'निष्क्रिय (Inactive)' : (col.minutes_ago !== null && col.minutes_ago !== undefined ? `${col.minutes_ago} मिनेट अघि` : 'निष्क्रिय (Inactive)'))}</span>
                        </span>
                      </div>

                      {/* Location & Metadata Details */}
                      <div className="bg-slate-50 rounded-lg p-2 text-[11px] space-y-1 border border-slate-100">
                        {hasLocation ? (
                          <>
                            <div className="flex items-center justify-between">
                              <span className="text-slate-500 font-nepali">स्थान (GPS Coords):</span>
                              <span className="font-mono text-slate-800 font-semibold">
                                {col.latitude.toFixed(6)}°N, {col.longitude.toFixed(6)}°E
                              </span>
                            </div>
                            {col.accuracy && (
                              <div className="flex items-center justify-between text-[10px]">
                                <span className="text-slate-500 font-nepali">शुद्धता (Accuracy):</span>
                                <span className="font-mono text-slate-600">±{col.accuracy.toFixed(1)} मिटर</span>
                              </div>
                            )}
                          </>
                        ) : (
                          <div className="text-slate-400 italic text-[10px] text-center font-nepali">
                            कुनै GPS स्थान प्राप्त भएको छैन (No GPS signal received yet)
                          </div>
                        )}

                        {col.assigned_projects?.length > 0 && (
                          <div className="flex items-center gap-1 pt-1 border-t border-slate-200/60 text-[10px]">
                            <span className="text-slate-500 font-nepali shrink-0">परियोजना:</span>
                            <div className="flex flex-wrap gap-1 truncate">
                              {col.assigned_projects.map((p) => (
                                <span key={p.id} className="px-1 rounded bg-gov-blue-100 text-gov-blue-800 font-semibold font-nepali">
                                  {p.name}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {col.active_task && (
                          <div className="text-[10px] text-amber-800 font-nepali font-semibold bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 flex items-center justify-between">
                            <span>हाल म्यापिङ गर्दै: ग्रिड #{col.active_task.grid_index}</span>
                            <span className="text-[9px] bg-amber-200 text-amber-900 px-1 rounded">Locked</span>
                          </div>
                        )}
                      </div>

                      {/* Action buttons */}
                      {hasLocation && onZoomToCollector && (
                        <div className="flex justify-end pt-1">
                          <button
                            type="button"
                            onClick={() => {
                              onZoomToCollector(col);
                              if (onClose) onClose();
                            }}
                            className="btn-gov-primary text-[10px] py-1 px-2.5 flex items-center gap-1 font-nepali"
                          >
                            <Crosshair className="w-3 h-3 text-gov-gold-400" />
                            <span>नक्सामा हेर्नुहोस् (Locate on Map)</span>
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}

              {collectorLocations.length === 0 && (
                <div className="text-center py-6 text-slate-400 font-nepali text-xs">
                  कुनै पनि तथ्याङ्क संकलक फेला परेन
                </div>
              )}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ 2. VECTOR LAYERS TAB (Global & Project) === */}
        {/* ======================================================== */}
        {activeTab === 'layers' && (
          <div className="space-y-3 animate-fade-in">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setShowLayerUpload(!showLayerUpload)}
                className="btn-gov-primary text-xs font-bold py-2 flex items-center justify-center gap-1.5 shadow-sm"
              >
                <Upload className="w-4 h-4 text-gov-gold-400" />
                <span>GeoJSON तह अपलोड</span>
              </button>

              {onOpenLinkLayers && (
                <button
                  type="button"
                  onClick={() => onOpenLinkLayers(null)}
                  className="bg-gov-blue-50 hover:bg-gov-blue-100 text-gov-blue-900 border border-gov-blue-300 rounded-lg text-xs font-bold py-2 flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                >
                  <Link2 className="w-4 h-4 text-gov-blue-800" />
                  <span>फिचर सम्बन्ध व्यवस्थापन</span>
                </button>
              )}
            </div>

            {/* Upload Modal / Form */}
            {showLayerUpload && (
              <form onSubmit={handleLayerUpload} className="bg-white p-3.5 rounded-lg border border-gov-blue-300 shadow-md space-y-2.5 animate-slide-up">
                <div className="text-xs font-bold text-gov-blue-900 font-nepali border-b border-slate-100 pb-1 flex items-center justify-between">
                  <span>भेक्टर तह अपलोड (Upload Vector Layer)</span>
                  <span className="text-[10px] text-gov-red-600">* अनिवार्य</span>
                </div>
                <div>
                  <label className="gov-label">तहको नाम (Layer Name)</label>
                  <input
                    name="name"
                    value={layerUploadForm.name}
                    onChange={(e) => setLayerUploadForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="उदा. काठमाडौँ वडा सिमाना"
                    required
                  />
                </div>

                {/* Scope selector: Global vs Project-Specific */}
                <div className="space-y-1">
                  <label className="gov-label">तहको कार्यक्षेत्र (Layer Scope)</label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {!isDepartmentAdmin && (
                      <label
                        className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                          layerUploadForm.scope === 'GLOBAL'
                            ? 'border-gov-blue-800 bg-gov-blue-50/70 text-gov-blue-900 font-bold'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="layer_scope"
                          checked={layerUploadForm.scope === 'GLOBAL'}
                          onChange={() => setLayerUploadForm((prev) => ({ ...prev, scope: 'GLOBAL', projectId: '' }))}
                          className="accent-gov-blue-800"
                        />
                        <Globe className="w-3.5 h-3.5 text-gov-blue-700" />
                        <span className="font-nepali text-[11px]">सार्वजनिक (Global)</span>
                      </label>
                    )}

                    <label
                      className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                        layerUploadForm.scope === 'PROJECT'
                          ? 'border-gov-blue-800 bg-gov-blue-50/70 text-gov-blue-900 font-bold'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="layer_scope"
                        checked={layerUploadForm.scope === 'PROJECT'}
                        onChange={() => setLayerUploadForm((prev) => ({ ...prev, scope: 'PROJECT' }))}
                        className="accent-gov-blue-800"
                      />
                      <Folder className="w-3.5 h-3.5 text-gov-blue-700" />
                      <span className="font-nepali text-[11px]">विशेष परियोजना</span>
                    </label>
                  </div>
                </div>

                {/* Project Selection Dropdown if Project-scoped */}
                {layerUploadForm.scope === 'PROJECT' && (
                  <div className="animate-fade-in">
                    <label className="gov-label text-gov-blue-900 font-bold">
                      लक्षित परियोजना छान्नुहोस् (Select Target Project) *
                    </label>
                    <select
                      value={layerUploadForm.projectId}
                      onChange={(e) => setLayerUploadForm((prev) => ({ ...prev, projectId: e.target.value }))}
                      className="gov-input text-xs"
                      required
                    >
                      <option value="">-- परियोजना चयन गर्नुहोस् --</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (#{p.id})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="gov-label">भेक्टर फाइल (.geojson, .json, .zip, .gpkg) — तान्नुहोस् वा चयन गर्नुहोस्</label>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setVectorDragActive(true); }}
                    onDragLeave={() => setVectorDragActive(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setVectorDragActive(false);
                      const dropped = Array.from(e.dataTransfer?.files || []).filter((f) =>
                        /\.(geojson|json|zip|gpkg)$/i.test(f.name)
                      );
                      if (dropped.length > 0) setDroppedVectorFiles(dropped);
                    }}
                    className={`border-2 border-dashed rounded-lg p-3 text-center transition-colors ${
                      vectorDragActive ? 'border-gov-blue-700 bg-gov-blue-50' : 'border-slate-300 bg-slate-50/70'
                    }`}
                  >
                    <Upload className="w-4 h-4 mx-auto text-gov-blue-700 mb-1" />
                    <div className="text-[11px] font-nepali text-slate-600 mb-1.5">
                      फाइलहरू यहाँ ड्र्याग एण्ड ड्रप गर्नुहोस् वा तलबाट छान्नुहोस्
                    </div>
                    <input
                      name="file"
                      type="file"
                      accept=".geojson,.json,.zip,.gpkg"
                      multiple
                      onChange={(e) => setDroppedVectorFiles(Array.from(e.target.files || []))}
                      className="gov-input text-xs"
                      required={droppedVectorFiles.length === 0}
                    />
                    {droppedVectorFiles.length > 0 && (
                      <div className="mt-1.5 text-[10px] text-emerald-700 font-semibold font-mono">
                        {droppedVectorFiles.length} file(s) queued: {droppedVectorFiles.map((f) => f.name).join(', ')}
                      </div>
                    )}
                  </div>
                </div>

                {/* Snapping Permission Toggle */}
                <div className="bg-slate-50 p-2.5 rounded-lg border border-slate-200 flex items-center justify-between">
                  <div>
                    <label className="text-xs font-bold text-slate-800 font-nepali flex items-center gap-1.5 cursor-pointer">
                      <Magnet className="w-3.5 h-3.5 text-gov-blue-800" />
                      <span>स्न्यापिङ अनुमति दिनुहोस् (Allow Snapping)</span>
                    </label>
                    <p className="text-[10px] text-slate-500 font-nepali mt-0.5">
                      फिचरहरू कोर्दा वा सम्पादन गर्दा बिन्दु स्न्यापिङ (Snapping) गर्न सकिने बनाउनुहोस्
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setLayerUploadForm((prev) => ({ ...prev, allow_snapping: !prev.allow_snapping }))}
                    className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      layerUploadForm.allow_snapping ? 'bg-emerald-600' : 'bg-slate-300'
                    }`}
                    title={layerUploadForm.allow_snapping ? 'स्न्यापिङ सक्षम छ' : 'स्न्यापिङ असक्षम छ'}
                  >
                    <span
                      className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                        layerUploadForm.allow_snapping ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {uploadProgress && (
                  <div className="space-y-2 py-2 px-3 bg-slate-50 rounded-lg border border-slate-200 shadow-inner">
                    {uploadProgress.totalFiles > 1 && (
                      <div className="space-y-1 pb-1.5 border-b border-slate-200">
                        <div className="flex justify-between text-[11px] text-slate-700 font-semibold font-nepali">
                          <span>समग्र प्रगति (Overall): {uploadProgress.currentFileIndex} / {uploadProgress.totalFiles} फाइल</span>
                          <span className="font-mono text-gov-blue-800 font-bold">{uploadProgress.overallPercent}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-600 transition-all duration-300"
                            style={{ width: `${uploadProgress.overallPercent}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="flex justify-between items-center text-xs text-slate-700 font-semibold font-nepali mb-1">
                        <span className="truncate max-w-[240px]" title={uploadProgress.currentFileName}>
                          {uploadProgress.currentFileName ? uploadProgress.currentFileName : 'फाइल अपलोड'}
                        </span>
                        <span className="font-mono text-gov-blue-800 font-bold">
                          {uploadProgress.phase === 'verifying'
                            ? '१००% प्रमाणीकरण'
                            : uploadProgress.phase === 'importing'
                            ? 'फिचर आयात'
                            : `${uploadProgress.percent}%`}
                        </span>
                      </div>

                      <div className="h-2.5 w-full bg-slate-200 rounded-full overflow-hidden relative">
                        <div
                          className={`h-full transition-all duration-200 ${
                            uploadProgress.phase === 'verifying'
                              ? 'bg-amber-500 animate-pulse'
                              : uploadProgress.phase === 'importing'
                              ? 'bg-purple-600 animate-pulse'
                              : 'bg-gov-blue-800'
                          }`}
                          style={{ width: `${uploadProgress.percent}%` }}
                        />
                      </div>

                      <div className="flex justify-between items-center text-[10px] text-slate-500 font-nepali mt-1">
                        <span className="truncate max-w-[280px]">
                          {uploadProgress.phase === 'verifying'
                            ? 'प्रमाणीकरण तथा इन्डेक्सिङ हुँदैछ...'
                            : uploadProgress.phase === 'importing'
                            ? uploadProgress.label || 'फिचर आयात हुँदैछ...'
                            : uploadProgress.label || `${uploadProgress.percent}% सम्पन्न`}
                        </span>
                        {uploadProgress.speedMBs > 0 && uploadProgress.phase === 'uploading' && (
                          <span className="font-mono font-medium text-slate-600 shrink-0 ml-1">
                            {uploadProgress.speedMBs.toFixed(1)} MB/s
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={loading} className="btn-gov-primary flex-1 text-xs py-1.5 flex items-center justify-center gap-1">
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'अपलोड गर्नुहोस्'}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setShowLayerUpload(false)}
                    className="btn-gov-secondary text-xs py-1.5"
                  >
                    रद्द
                  </button>
                </div>
              </form>
            )}

            {/* Filter & Search Bar */}
            <div className="flex gap-2 text-xs">
              <div className="flex-1">
                <select
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  className="gov-input text-xs py-1"
                >
                  <option value="ALL">सबै तहहरू (All Layers)</option>
                  <option value="GLOBAL">🌐 सार्वजनिक मात्र (Global Only)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      📁 {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                placeholder="तह खोज्नुहोस्..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="gov-input text-xs py-1 w-36"
              />
            </div>

            {/* Layers List */}
            <div className="space-y-2">
              {filteredLayers.map((layer) => {
                const assignedProjNames = projects
                  .filter((p) => projectAssignments[p.id]?.layer_ids?.includes(layer.id))
                  .map((p) => p.name);

                const parentProj = layer.project_id ? projects.find((p) => p.id === layer.project_id) : null;

                return (
                  <div key={layer.id} className="bg-white rounded-lg border border-slate-200 p-3 shadow-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-800 font-nepali truncate">
                          {layer.name}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5 flex items-center gap-2">
                          <span>{layer.geometry_type}</span>
                          <span>&middot;</span>
                          <span>{layer.feature_count} वस्तुहरू</span>
                          {layer.import_status === 'importing' && (
                            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800 font-nepali font-semibold">
                              <Loader2 className="w-2.5 h-2.5 animate-spin" /> आयात हुँदैछ
                            </span>
                          )}
                          {layer.import_status === 'failed' && (
                            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full bg-red-100 text-red-800 font-nepali font-semibold" title={layer.import_error || ''}>
                              आयात असफल
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        {/* Collector Editing Quick Toggle */}
                        <button
                          type="button"
                          onClick={() => {
                            const parentProj = projects.find((p) => String(p.id) === String(layer.project_id));
                            handleToggleProjectLayerFlag(parentProj, layer, 'editable_by_collectors');
                          }}
                          className={`p-1.5 rounded transition-colors ${
                            layer.editable_by_collectors === true
                              ? 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                              : 'text-slate-400 hover:text-emerald-700 hover:bg-slate-100'
                          }`}
                          title={
                            layer.editable_by_collectors === true
                              ? 'संकलक सम्पादन खुला छ (Click to Disable Collector Edit)'
                              : 'संकलक सम्पादन बन्द छ (Click to Allow Collector Edit)'
                          }
                        >
                          {layer.editable_by_collectors === true ? (
                            <Edit3 className="w-3.5 h-3.5 text-emerald-700" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </button>
                        {/* Admin Snapping Quick Toggle */}
                        <button
                          type="button"
                          disabled={togglingSnappingLayerId === layer.id}
                          onClick={() => handleToggleLayerSnapping(layer)}
                          className={`p-1.5 rounded transition-colors ${
                            layer.allow_snapping !== false
                              ? 'text-emerald-700 hover:bg-emerald-50'
                              : 'text-slate-400 hover:text-emerald-700 hover:bg-slate-100'
                          }`}
                          title={
                            layer.allow_snapping !== false
                              ? 'यस तहमा स्न्यापिङ बन्द गर्नुहोस् (Click to Disable Snapping)'
                              : 'यस तहमा स्न्यापिङ अनुमति दिनुहोस् (Click to Enable Snapping)'
                          }
                        >
                          {togglingSnappingLayerId === layer.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-700" />
                          ) : (
                            <Magnet className={`w-3.5 h-3.5 ${layer.allow_snapping !== false ? 'text-emerald-700' : 'text-slate-400'}`} />
                          )}
                        </button>
                        {/* Public View Visibility Toggle (GeoPortal) */}
                        <button
                          type="button"
                          disabled={togglingPublicId === `vector_${layer.id}`}
                          onClick={() => handleToggleLayerPublicView(layer)}
                          className={`p-1.5 rounded transition-colors ${
                            layer.published_in_geoportal !== false
                              ? 'text-sky-700 hover:bg-sky-50'
                              : 'text-slate-400 hover:bg-slate-100'
                          }`}
                          title={
                            layer.published_in_geoportal !== false
                              ? 'सार्वजनिक जियोपोर्टलमा देखिने (Public View: ON — Click to Hide)'
                              : 'सार्वजनिक जियोपोर्टलबाट लुकाइएको (Public View: OFF — Click to Publish)'
                          }
                        >
                          {togglingPublicId === `vector_${layer.id}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-700" />
                          ) : layer.published_in_geoportal !== false ? (
                            <Eye className="w-3.5 h-3.5 text-sky-700" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </button>
                        {/* Admin Style Editor: color / thickness / click proximity */}
                        <button
                          type="button"
                          onClick={() => handleOpenStyleEditor(layer)}
                          className={`p-1.5 rounded transition-colors ${
                            styleEditorLayerId === layer.id
                              ? 'text-gov-blue-800 bg-gov-blue-100'
                              : 'text-gov-blue-800 hover:bg-gov-blue-50'
                          }`}
                          title="तहको रङ, मोटाइ र क्लिक दूरी मिलाउनुहोस् (Layer Style: Color / Thickness / Click Proximity)"
                        >
                          <span
                            className="block w-3.5 h-3.5 rounded-full border border-slate-400"
                            style={{ backgroundColor: layer.style?.strokeColor || '#94a3b8' }}
                          />
                        </button>
                        {onOpenLinkLayers && (
                          <button
                            type="button"
                            onClick={() => onOpenLinkLayers(layer)}
                            className="p-1.5 text-gov-blue-800 hover:bg-gov-blue-50 rounded transition-colors"
                            title="फिचर सम्बन्ध कायम गर्नुहोस् (Link Features)"
                          >
                            <Link2 className="w-3.5 h-3.5 text-gov-blue-800" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => handleOpenFieldConfig(layer)}
                          className="p-1.5 text-gov-blue-800 hover:bg-gov-blue-50 rounded transition-colors"
                          title="तहका फिल्ड तथा अनिवार्य नियमहरू कन्फिगर गर्नुहोस् (Configure Fields & Compulsory Rules)"
                        >
                          <Sliders className="w-3.5 h-3.5 text-gov-blue-800" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setLayerDownloadModal({ layer })}
                          className="p-1.5 text-gov-blue-800 hover:bg-gov-blue-50 rounded transition-colors"
                          title="तह डाउनलोड गर्नुहोस् (Download Layer Data)"
                        >
                          {downloadingLayerId === layer.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-gov-blue-800" />
                          ) : (
                            <Download className="w-3.5 h-3.5 text-gov-blue-800" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAssignModal({ type: 'layer', item: layer })}
                          className="p-1.5 text-slate-600 hover:text-gov-blue-800 hover:bg-slate-100 rounded transition-colors"
                          title="परियोजनामा समावेश / लिङ्क गर्नुहोस्"
                        >
                          <FolderPlus className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await layersAPI.delete(layer.id);
                            setMessage({ type: 'success', text: `'${layer.name}' तह रिसाइकल बिनमा सारियो (Moved to Recycle Bin)` });
                            loadData();
                            loadRecycleBin();
                            if (onLayerUpdate) onLayerUpdate();
                          }}
                          className="p-1.5 text-gov-red-700 hover:bg-gov-red-50 rounded transition-colors"
                          title="रिसाइकल बिनमा सार्नुहोस् (Soft delete — पुनर्स्थापना गर्न सकिने)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Badges: Scope, Linked Projects & Snapping Permission & Field Config */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
                      {/* Fields & Compulsory Rules Quick Badge */}
                      <button
                        type="button"
                        onClick={() => handleOpenFieldConfig(layer)}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold font-nepali bg-blue-50 text-blue-900 border-blue-200 hover:bg-blue-100 transition-colors cursor-pointer"
                        title="तहका फिल्ड तथा अनिवार्य नियमहरू हेर्नुहोस् र मिलाउनुहोस्"
                      >
                        <Sliders className="w-2.5 h-2.5 text-blue-700" />
                        <span>फिल्ड: {layer.fields_config?.length || 0}</span>
                        {layer.fields_config?.some((f) => f.required) && (
                          <span className="text-red-700 font-extrabold ml-0.5">
                            ({layer.fields_config.filter((f) => f.required).length} अनिवार्य)
                          </span>
                        )}
                      </button>

                      {/* Primary Key / Unique ID Badge & Quick Manager */}
                      <button
                        type="button"
                        onClick={() => setPrimaryKeyModal({ layer, isPostUpload: false })}
                        className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold font-nepali bg-amber-50 text-amber-950 border-amber-300 hover:bg-amber-100 transition-colors cursor-pointer"
                        title="प्राथमिक कुञ्जी (Primary Key / Unique ID) व्यवस्थापन तथा अडिट गर्नुहोस्"
                      >
                        <Key className="w-2.5 h-2.5 text-amber-700" />
                        <span>PK: {layer.unique_field || layer.primary_key_field || 'सेट गर्नुहोस्'}</span>
                      </button>

                      {/* Snapping Permission Badge */}
                      <button
                        type="button"
                        onClick={() => handleToggleLayerSnapping(layer)}
                        disabled={togglingSnappingLayerId === layer.id}
                        className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold font-nepali transition-all ${
                          layer.allow_snapping !== false
                            ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100'
                            : 'bg-rose-50 text-rose-800 border-rose-300 hover:bg-rose-100'
                        }`}
                        title={
                          layer.allow_snapping !== false
                            ? 'स्न्यापिङ सक्रिय छ — बन्द गर्न क्लिक गर्नुहोस्'
                            : 'स्न्यापिङ बन्द छ — खोल्न क्लिक गर्नुहोस्'
                        }
                      >
                        {togglingSnappingLayerId === layer.id ? (
                          <Loader2 className="w-2.5 h-2.5 animate-spin" />
                        ) : (
                          <Magnet className={`w-2.5 h-2.5 ${layer.allow_snapping !== false ? 'text-emerald-700' : 'text-rose-600'}`} />
                        )}
                        <span>{layer.allow_snapping !== false ? 'स्न्यापिङ: सक्षम' : 'स्न्यापिङ: बन्द'}</span>
                      </button>

                      {/* Questionnaire Link Badge */}
                      {layer.questionnaire_id ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold font-nepali bg-purple-50 text-purple-900 border-purple-300">
                          <FileText className="w-2.5 h-2.5 text-purple-700" />
                          <span>प्रश्नावली #{layer.questionnaire_id}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleUnlinkLayerQuestionnaire(layer.id);
                            }}
                            className="ml-1 text-purple-600 hover:text-red-700 p-0.5 rounded hover:bg-purple-100 transition-colors"
                            title="प्रश्नावली हटाउनुहोस् (Unlink Questionnaire)"
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setLinkQModalLayer(layer);
                          }}
                          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold font-nepali bg-slate-50 text-slate-700 border-slate-300 hover:bg-purple-50 hover:text-purple-900 hover:border-purple-300 transition-colors"
                          title="यस तहमा प्रश्नावली जोड्नुहोस् (Link Questionnaire)"
                        >
                          <Link2 className="w-2.5 h-2.5 text-slate-600" />
                          <span>प्रश्नावली जोड्नुहोस्</span>
                        </button>
                      )}

                      {layer.is_global ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold font-nepali">
                          <Globe className="w-2.5 h-2.5" />
                          <span>सार्वजनिक (Global)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-amber-50 text-amber-900 border border-amber-200 font-bold font-nepali">
                          <Folder className="w-2.5 h-2.5" />
                          <span>विशेष: {parentProj?.name || layer.project_name || `#${layer.project_id}`}</span>
                        </span>
                      )}

                      {assignedProjNames.length > 0 && (
                        <span className="text-slate-500 font-nepali">
                          संलग्न परियोजनाहरू: {assignedProjNames.join(', ')}
                        </span>
                      )}
                    </div>

                    {/* Style Editor: color / thickness / click proximity (GIS Admin) */}
                    {styleEditorLayerId === layer.id && (
                      <div className="mt-2 rounded-lg border border-gov-blue-200 bg-gov-blue-50/60 p-3 space-y-2.5 animate-slide-up">
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-bold text-gov-blue-900 font-nepali flex items-center gap-1.5">
                            <Palette className="w-3.5 h-3.5" />
                            तह स्टाइल (Layer Style)
                          </span>
                          <button
                            type="button"
                            onClick={() => setStyleEditorLayerId(null)}
                            className="p-1 text-slate-400 hover:text-slate-600 rounded"
                            title="बन्द गर्नुहोस्"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>

                        {/* Color */}
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] font-bold text-slate-700 font-nepali w-24 shrink-0">
                            रङ (Color)
                          </label>
                          <input
                            type="color"
                            value={/^#[0-9a-fA-F]{6}$/.test(styleForm.color) ? styleForm.color : '#3b82f6'}
                            onChange={(e) => setStyleForm((p) => ({ ...p, color: e.target.value }))}
                            className="w-9 h-8 rounded border border-slate-300 cursor-pointer bg-white p-0.5"
                          />
                          <input
                            type="text"
                            value={styleForm.color}
                            onChange={(e) => setStyleForm((p) => ({ ...p, color: e.target.value }))}
                            className="gov-input text-xs py-1 w-24 font-mono"
                            placeholder="#3b82f6"
                          />
                          <button
                            type="button"
                            onClick={handleAutoStyleColor}
                            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-white border border-gov-blue-300 text-gov-blue-800 text-[10px] font-bold font-nepali hover:bg-gov-blue-100 transition-colors"
                            title="नक्सामा प्रयोग नभएको अद्वितीय रङ स्वतः छान्नुहोस्"
                          >
                            <Wand2 className="w-3 h-3" />
                            स्वतः अद्वितीय रङ
                          </button>
                        </div>

                        {/* Thickness */}
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] font-bold text-slate-700 font-nepali w-24 shrink-0">
                            मोटाइ (Thickness)
                          </label>
                          <input
                            type="range"
                            min="1"
                            max="10"
                            step="0.5"
                            value={styleForm.width}
                            onChange={(e) => setStyleForm((p) => ({ ...p, width: Number(e.target.value) }))}
                            className="flex-1 accent-gov-blue-700"
                          />
                          <span className="text-[11px] font-mono text-slate-600 w-8 text-right">
                            {styleForm.width}px
                          </span>
                        </div>

                        {/* Click proximity */}
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] font-bold text-slate-700 font-nepali w-24 shrink-0 flex items-center gap-1">
                            <MousePointerClick className="w-3 h-3" />
                            क्लिक दूरी
                          </label>
                          <input
                            type="number"
                            min="2"
                            max="60"
                            value={styleForm.clickTolerance}
                            onChange={(e) => setStyleForm((p) => ({ ...p, clickTolerance: Number(e.target.value) }))}
                            className="gov-input text-xs py-1 w-20"
                          />
                          <span className="text-[10px] text-slate-500 font-nepali">
                            पिक्सेल — जति ठूलो, त्यति सजिलो क्लिक (2–60)
                          </span>
                        </div>

                        {/* Hover highlight min zoom (empty = hover highlight OFF) */}
                        <div className="flex items-center gap-2">
                          <label className="text-[11px] font-bold text-slate-700 font-nepali w-24 shrink-0">
                            हभर जुम
                          </label>
                          <input
                            type="number"
                            min="0"
                            max="22"
                            step="1"
                            value={styleForm.hoverMinZoom}
                            onChange={(e) => setStyleForm((p) => ({ ...p, hoverMinZoom: e.target.value === '' ? '' : Number(e.target.value) }))}
                            className="gov-input text-xs py-1 w-20"
                            placeholder="बन्द"
                          />
                          <span className="text-[10px] text-slate-500 font-nepali">
                            यो जुम वा माथि मात्र हभर हाइलाइट — खाली छोडे बन्द (OFF)
                          </span>
                        </div>

                        <div className="flex justify-end pt-1">
                          <button
                            type="button"
                            disabled={savingStyleLayerId === layer.id}
                            onClick={() => handleSaveLayerStyle(layer)}
                            className="btn-gov-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                          >
                            {savingStyleLayerId === layer.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <Save className="w-3.5 h-3.5" />
                            )}
                            <span className="font-nepali">सेभ गर्नुहोस्</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Recycle Bin — soft-deleted vector layers */}
            <div className="mt-3 border border-slate-200 rounded-lg overflow-hidden bg-white shadow-xs">
              <button
                type="button"
                onClick={() => {
                  const next = !showRecycleBin;
                  setShowRecycleBin(next);
                  if (next) loadRecycleBin();
                }}
                className="w-full px-3 py-2 bg-slate-100/90 hover:bg-slate-200/80 flex items-center justify-between text-left transition-colors"
              >
                <span className="flex items-center gap-2 text-xs font-bold text-slate-800 font-nepali">
                  <Recycle className="w-3.5 h-3.5 text-slate-500" />
                  रिसाइकल बिन (Recycle Bin)
                </span>
                <span className="flex items-center gap-2">
                  {deletedLayers.length > 0 && (
                    <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-100 text-amber-800">
                      {deletedLayers.length}
                    </span>
                  )}
                  {showRecycleBin ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                </span>
              </button>
              {showRecycleBin && (
                <div className="p-2 space-y-1.5 max-h-64 overflow-y-auto">
                  {isMasterAdmin && (deletedLayers.length > 0 || deletedTiles.length > 0) && (
                    <div className="flex items-center justify-between gap-2 bg-rose-50 border border-rose-200 rounded-lg px-2.5 py-1.5">
                      <span className="text-[10px] text-rose-800 font-bold font-nepali leading-tight">
                        मास्टर: रिसाइकल बिनका सबै फाइल सर्भर डिस्कबाट स्थायी रूपमा हटाउनुहोस्
                      </span>
                      <button
                        type="button"
                        disabled={purgeBinLoading}
                        onClick={handlePurgeRecycleBin}
                        className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-700 hover:bg-rose-800 text-white text-[10px] font-bold disabled:opacity-50"
                      >
                        {purgeBinLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                        डिस्कबाट खाली गर्नुहोस्
                      </button>
                    </div>
                  )}
                  {recycleBinLoading ? (
                    <div className="p-4 text-center text-xs text-slate-500 font-nepali flex items-center justify-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> लोड हुँदैछ…
                    </div>
                  ) : deletedLayers.length === 0 ? (
                    <div className="p-4 text-center text-xs text-slate-400 font-nepali">
                      रिसाइकल बिन खाली छ (No deleted layers)
                    </div>
                  ) : (
                    deletedLayers.map((layer) => (
                      <div key={layer.id} className="flex items-center justify-between gap-2 bg-amber-50/60 border border-amber-200/60 rounded-lg px-2.5 py-2">
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-800 font-nepali truncate">{layer.name}</div>
                          <div className="text-[10px] text-slate-500">
                            {layer.geometry_type} · {layer.feature_count ?? 0} फिचर · मेटिएको:{' '}
                            {layer.deleted_at ? new Date(layer.deleted_at).toLocaleString() : '—'}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            disabled={restoringId === `layer-${layer.id}`}
                            onClick={() => handleRestoreLayer(layer)}
                            className="p-1.5 text-emerald-700 hover:bg-emerald-100 rounded transition-colors"
                            title="पुनर्स्थापना गर्नुहोस् (Restore)"
                          >
                            {restoringId === `layer-${layer.id}` ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin" />
                            ) : (
                              <RotateCcw className="w-3.5 h-3.5" />
                            )}
                          </button>
                          {isMasterAdmin && (
                            <button
                              type="button"
                              disabled={permanentDeletingId === `layer-${layer.id}`}
                              onClick={() => handlePermanentDeleteLayer(layer)}
                              className="p-1.5 text-gov-red-700 hover:bg-gov-red-100 rounded transition-colors"
                              title="सधैंका लागि मेटाउनुहोस् (Delete forever — cannot be undone)"
                            >
                              {permanentDeletingId === `layer-${layer.id}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="w-3.5 h-3.5" />
                              )}
                            </button>
                          )}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ 3. DRONE MBTILES TAB (Global & Project) === */}
        {/* ======================================================== */}
        {activeTab === 'tiles' && (
          <div className="space-y-3 animate-fade-in">
            <button
              type="button"
              onClick={() => setShowTileUpload(!showTileUpload)}
              className="btn-gov-primary w-full text-xs font-bold py-2 flex items-center justify-center gap-1.5 shadow-sm"
            >
              <Upload className="w-4 h-4 text-gov-gold-400" />
              <span>MBTiles (ड्रोन इमेज्री) अपलोड गर्नुहोस्</span>
            </button>

            {/* Upload Modal / Form */}
            {showTileUpload && (
              <form onSubmit={handleTileUpload} className="bg-white p-3.5 rounded-lg border border-gov-blue-300 shadow-md space-y-2.5 animate-slide-up">
                <div className="text-xs font-bold text-gov-blue-900 font-nepali border-b border-slate-100 pb-1 flex items-center justify-between">
                  <span>ड्रोन तथा स्याटेलाइट MBTiles अपलोड</span>
                  <span className="text-[10px] text-gov-red-600">* अनिवार्य</span>
                </div>
                <div>
                  <label className="gov-label">इमेज्री तहको नाम</label>
                  <input
                    name="name"
                    value={tileUploadForm.name}
                    onChange={(e) => setTileUploadForm((prev) => ({ ...prev, name: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="उदा. काठमाडौँ वडा ४ ड्रोन सर्भे २०२६"
                    required
                  />
                </div>
                <div>
                  <label className="gov-label">विवरण (Optional)</label>
                  <input
                    name="description"
                    value={tileUploadForm.description}
                    onChange={(e) => setTileUploadForm((prev) => ({ ...prev, description: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="विवरण..."
                  />
                </div>

                {/* Scope selector */}
                <div className="space-y-1">
                  <label className="gov-label">इमेज्रीको कार्यक्षेत्र (Imagery Scope)</label>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {!isDepartmentAdmin && (
                      <label
                        className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                          tileUploadForm.scope === 'GLOBAL'
                            ? 'border-gov-blue-800 bg-gov-blue-50/70 text-gov-blue-900 font-bold'
                            : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                        }`}
                      >
                        <input
                          type="radio"
                          name="tile_scope"
                          checked={tileUploadForm.scope === 'GLOBAL'}
                          onChange={() => setTileUploadForm((prev) => ({ ...prev, scope: 'GLOBAL', projectId: '' }))}
                          className="accent-gov-blue-800"
                        />
                        <Globe className="w-3.5 h-3.5 text-gov-blue-700" />
                        <span className="font-nepali text-[11px]">सार्वजनिक (Global)</span>
                      </label>
                    )}

                    <label
                      className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                        tileUploadForm.scope === 'PROJECT'
                          ? 'border-gov-blue-800 bg-gov-blue-50/70 text-gov-blue-900 font-bold'
                          : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="tile_scope"
                        checked={tileUploadForm.scope === 'PROJECT'}
                        onChange={() => setTileUploadForm((prev) => ({ ...prev, scope: 'PROJECT' }))}
                        className="accent-gov-blue-800"
                      />
                      <Folder className="w-3.5 h-3.5 text-gov-blue-700" />
                      <span className="font-nepali text-[11px]">विशेष परियोजना</span>
                    </label>
                  </div>
                </div>

                {/* Project Selection Dropdown if Project-scoped */}
                {tileUploadForm.scope === 'PROJECT' && (
                  <div className="animate-fade-in">
                    <label className="gov-label text-gov-blue-900 font-bold">
                      लक्षित परियोजना छान्नुहोस् (Select Target Project) *
                    </label>
                    <select
                      value={tileUploadForm.projectId}
                      onChange={(e) => setTileUploadForm((prev) => ({ ...prev, projectId: e.target.value }))}
                      className="gov-input text-xs"
                      required
                    >
                      <option value="">-- परियोजना चयन गर्नुहोस् --</option>
                      {projects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} (#{p.id})
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div>
                  <label className="gov-label">MBTiles / GeoTIFF / इमेज फाइल — तान्नुहोस् वा छान्नुहोस् (Multi-file)</label>
                  <div
                    onDragOver={(e) => { e.preventDefault(); setTileDragActive(true); }}
                    onDragLeave={() => setTileDragActive(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setTileDragActive(false);
                      const dropped = Array.from(e.dataTransfer?.files || []);
                      if (dropped.length > 0) setDroppedTileFiles(dropped);
                    }}
                    className={`border-2 border-dashed rounded-lg p-3 text-center transition-colors ${
                      tileDragActive ? 'border-gov-blue-700 bg-gov-blue-50' : 'border-slate-300 bg-slate-50/70'
                    }`}
                  >
                    <Upload className="w-4 h-4 mx-auto text-gov-blue-700 mb-1" />
                    <div className="text-[11px] font-nepali text-slate-600 mb-1.5">
                      .mbtiles वा इमेज्री फाइलहरू यहाँ ड्र्याग एण्ड ड्रप गर्नुहोस्
                    </div>
                    <input
                      name="file"
                      type="file"
                      accept=".mbtiles,.pmtiles,.tif,.tiff,.png,.jpg,.jpeg,.webp,image/*"
                      multiple
                      onChange={(e) => setDroppedTileFiles(Array.from(e.target.files || []))}
                      className="gov-input text-xs"
                      required={droppedTileFiles.length === 0}
                    />
                    {droppedTileFiles.length > 0 && (
                      <div className="mt-1.5 text-[10px] text-emerald-700 font-semibold font-mono">
                        {droppedTileFiles.length} file(s) queued: {droppedTileFiles.map((f) => f.name).join(', ')}
                      </div>
                    )}
                  </div>
                </div>

                {uploadProgress && (
                  <div className="space-y-2 py-2 px-3 bg-slate-50 rounded-lg border border-slate-200 shadow-inner">
                    {uploadProgress.totalFiles > 1 && (
                      <div className="space-y-1 pb-1.5 border-b border-slate-200">
                        <div className="flex justify-between text-[11px] text-slate-700 font-semibold font-nepali">
                          <span>समग्र इमेज्री प्रगति (Overall): {uploadProgress.currentFileIndex} / {uploadProgress.totalFiles} फाइल</span>
                          <span className="font-mono text-gov-blue-800 font-bold">{uploadProgress.overallPercent}%</span>
                        </div>
                        <div className="h-1.5 w-full bg-slate-200 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-emerald-600 transition-all duration-300"
                            style={{ width: `${uploadProgress.overallPercent}%` }}
                          />
                        </div>
                      </div>
                    )}

                    <div>
                      <div className="flex justify-between items-center text-xs text-slate-700 font-semibold font-nepali mb-1">
                        <span className="truncate max-w-[240px]" title={uploadProgress.currentFileName}>
                          {uploadProgress.currentFileName ? uploadProgress.currentFileName : 'इमेज्री फाइल अपलोड'}
                        </span>
                        <span className="font-mono text-gov-blue-800 font-bold">
                          {uploadProgress.phase === 'verifying'
                            ? '१००% प्रमाणीकरण'
                            : `${uploadProgress.percent}%`}
                        </span>
                      </div>

                      <div className="h-2.5 w-full bg-slate-200 rounded-full overflow-hidden relative">
                        <div
                          className={`h-full transition-all duration-200 ${
                            uploadProgress.phase === 'verifying'
                              ? 'bg-amber-500 animate-pulse'
                              : 'bg-gov-blue-800'
                          }`}
                          style={{ width: `${uploadProgress.percent}%` }}
                        />
                      </div>

                      <div className="flex justify-between items-center text-[10px] text-slate-500 font-nepali mt-1">
                        <span className="truncate max-w-[280px]">
                          {uploadProgress.phase === 'verifying'
                            ? '१००% सम्पन्न — टाइल मेटाडाटा र बक्स इन्डेक्सिङ गरिँदैछ...'
                            : uploadProgress.label || `${uploadProgress.percent}% सम्पन्न`}
                        </span>
                        {uploadProgress.speedMBs > 0 && uploadProgress.phase === 'uploading' && (
                          <span className="font-mono font-medium text-slate-600 shrink-0 ml-1">
                            {uploadProgress.speedMBs.toFixed(1)} MB/s
                          </span>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 pt-1">
                  <button type="submit" disabled={loading} className="btn-gov-primary flex-1 text-xs py-1.5 flex items-center justify-center gap-1">
                    {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'अपलोड गर्नुहोस्'}
                  </button>
                  <button
                    type="button"
                    disabled={loading}
                    onClick={() => setShowTileUpload(false)}
                    className="btn-gov-secondary text-xs py-1.5"
                  >
                    रद्द
                  </button>
                </div>
              </form>
            )}

            {/* Filter & Search Bar */}
            <div className="flex gap-2 text-xs">
              <div className="flex-1">
                <select
                  value={projectFilter}
                  onChange={(e) => setProjectFilter(e.target.value)}
                  className="gov-input text-xs py-1"
                >
                  <option value="ALL">सबै इमेज्रीहरू (All Tiles)</option>
                  <option value="GLOBAL">🌐 सार्वजनिक मात्र (Global Only)</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      📁 {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <input
                type="text"
                placeholder="इमेज्री खोज्नुहोस्..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="gov-input text-xs py-1 w-36"
              />
            </div>

            {/* Tiles List */}
            <div className="space-y-2">
              {filteredTiles.map((tile) => {
                const assignedProjNames = projects
                  .filter((p) => projectAssignments[p.id]?.tile_ids?.includes(tile.id))
                  .map((p) => p.name);

                const parentProj = tile.project_id ? projects.find((p) => p.id === tile.project_id) : null;

                return (
                  <div key={tile.id} className="bg-white rounded-lg border border-slate-200 p-3 shadow-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="min-w-0">
                        <div className="text-xs font-bold text-slate-800 font-nepali truncate">
                          {tile.name}
                        </div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          {tile.filename} &middot; {tile.file_size ? `${(tile.file_size / 1024 / 1024).toFixed(1)} MB` : ''}
                        </div>
                      </div>

                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          disabled={togglingPublicId === `raster_${tile.id}`}
                          onClick={() => handleToggleTilePublicView(tile)}
                          className={`p-1.5 rounded transition-colors ${
                            tile.published_in_geoportal !== false
                              ? 'text-sky-700 hover:bg-sky-50'
                              : 'text-slate-400 hover:bg-slate-100'
                          }`}
                          title={
                            tile.published_in_geoportal !== false
                              ? 'सार्वजनिक जियोपोर्टलमा देखिने (Public View: ON — Click to Hide)'
                              : 'सार्वजनिक जियोपोर्टलबाट लुकाइएको (Public View: OFF — Click to Publish)'
                          }
                        >
                          {togglingPublicId === `raster_${tile.id}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-sky-700" />
                          ) : tile.published_in_geoportal !== false ? (
                            <Eye className="w-3.5 h-3.5 text-sky-700" />
                          ) : (
                            <EyeOff className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </button>
                        <button
                          type="button"
                          disabled={downloadingTileId === tile.id}
                          onClick={() => handleDownloadTile(tile)}
                          className="p-1.5 text-emerald-800 hover:bg-emerald-50 rounded transition-colors"
                          title="MBTiles डाउनलोड गर्नुहोस् (Download .mbtiles)"
                        >
                          {downloadingTileId === tile.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin text-emerald-800" />
                          ) : (
                            <Download className="w-3.5 h-3.5 text-emerald-800" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => setAssignModal({ type: 'tile', item: tile })}
                          className="p-1.5 text-gov-blue-800 hover:bg-gov-blue-50 rounded transition-colors"
                          title="परियोजनामा समावेश / लिङ्क गर्नुहोस्"
                        >
                          <Link2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await tilesAPI.delete(tile.id);
                            setMessage({ type: 'success', text: `'${tile.name}' इमेज्री रिसाइकल बिनमा सारियो (Moved to Recycle Bin)` });
                            loadData();
                            loadRecycleBin();
                            if (onLayerUpdate) onLayerUpdate();
                          }}
                          className="p-1.5 text-gov-red-700 hover:bg-gov-red-50 rounded transition-colors"
                          title="रिसाइकल बिनमा सार्नुहोस् (Soft delete — पुनर्स्थापना गर्न सकिने)"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>

                    {/* Badges: Scope & Linked Projects */}
                    <div className="flex flex-wrap items-center gap-1.5 text-[9px]">
                      {tile.is_global ? (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-emerald-50 text-emerald-800 border border-emerald-200 font-bold font-nepali">
                          <Globe className="w-2.5 h-2.5" />
                          <span>सार्वजनिक (Global)</span>
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.2 rounded bg-amber-50 text-amber-900 border border-amber-200 font-bold font-nepali">
                          <Folder className="w-2.5 h-2.5" />
                          <span>विशेष: {parentProj?.name || tile.project_name || `#${tile.project_id}`}</span>
                        </span>
                      )}

                      {assignedProjNames.length > 0 && (
                        <span className="text-slate-500 font-nepali">
                          संलग्न परियोजनाहरू: {assignedProjNames.join(', ')}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ LAYER ORDERING & STACKING TAB ============= */}
        {/* ======================================================== */}
        {activeTab === 'ordering' && (
          <div className="space-y-4 animate-fade-in font-sans">
            <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-xs space-y-3">
              <div>
                <h3 className="text-xs font-bold text-gov-blue-900 font-nepali flex items-center gap-1.5">
                  <Sliders className="w-4 h-4 text-gov-blue-800" />
                  <span>नक्सा तह क्रमबद्धता रणनीति (Map Layer Stacking Strategy):</span>
                </h3>
                <p className="text-[11px] text-slate-500 font-nepali mt-0.5">
                  नक्सामा तहहरू एकमाथि अर्को कसरी देखिने भन्ने सार्वभौम GIS नियम वा म्यानुअल प्राथमिकता छान्नुहोस्।
                </p>
              </div>

              <div className="grid grid-cols-1 gap-2 pt-1">
                {[
                  {
                    id: 'golden_rules',
                    title: 'स्वर्ण नियम (Golden Rules): र्यास्टर तल, बहुभुज, रेखा र बिन्दु माथि',
                    desc: 'इमेज्री/र्यास्टर सधैं पिँधमा (Z: 10-49), त्यसपछि बहुभुज (Z: 50-69), सडक/रेखा (Z: 70-89), र बिन्दुहरू सधैं शीर्षमा (Z: 90-110)।',
                  },
                  {
                    id: 'recent_on_top',
                    title: 'हालसालै थपिएका तह माथि (Recent on Top)',
                    desc: 'हालसालै अपलोड भएका वा सक्रिय गरिएका तहहरू सोही प्रकार भित्र सधैं माथि देखिन्छन्।',
                  },
                  {
                    id: 'manual_ranking',
                    title: 'म्यानुअल प्राथमिकीकरण (Manual Ranking: व्यक्तिगत तह अंक)',
                    desc: 'प्रत्येक तहको छुट्टाछुट्टै प्राथमिकता अंक (Z-Index) अनुसार तहहरू देखाइन्छ।',
                  },
                ].map((opt) => (
                  <label
                    key={opt.id}
                    className={`p-2.5 rounded-lg border flex items-start gap-2.5 cursor-pointer transition-all ${
                      orderingConfig.strategy === opt.id
                        ? 'bg-gov-blue-50/70 border-gov-blue-600 ring-1 ring-gov-blue-600 shadow-xs'
                        : 'bg-white border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    <input
                      type="radio"
                      name="layer_strategy"
                      value={opt.id}
                      checked={orderingConfig.strategy === opt.id}
                      onChange={() => setOrderingConfig((prev) => ({ ...prev, strategy: opt.id }))}
                      className="mt-0.5 text-gov-blue-800 focus:ring-gov-blue-800"
                    />
                    <div>
                      <div className="text-xs font-bold text-slate-800 font-nepali">{opt.title}</div>
                      <div className="text-[11px] text-slate-500 font-nepali mt-0.5">{opt.desc}</div>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            {/* Individual Layer Custom Priority List */}
            <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-xs space-y-3">
              <div className="flex items-center justify-between border-b border-slate-100 pb-2">
                <div>
                  <h4 className="text-xs font-bold text-gov-blue-900 font-nepali flex items-center gap-1.5">
                    <ListOrdered className="w-4 h-4 text-gov-blue-800" />
                    <span>तहगत प्राथमिकता सूची (Layer Priority & Stacking Order):</span>
                  </h4>
                  <p className="text-[10px] text-slate-500 font-nepali">
                    उच्च प्राथमिकता अंक भएका तहहरू नक्सामा माथिल्लो सतहमा देखिन्छन्।
                  </p>
                </div>
                <button
                  type="button"
                  disabled={orderingSaving}
                  onClick={handleSaveOrdering}
                  className="btn-gov-primary py-1.5 px-3 text-xs flex items-center gap-1 font-nepali shadow-xs"
                >
                  {orderingSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5 text-gov-gold-400" />}
                  <span>नियम सुरक्षित गर्नुहोस्</span>
                </button>
              </div>

              <div className="space-y-1.5 max-h-[50dvh] overflow-y-auto scrollbar-thin pr-1">
                {[...(allLayers || []), ...(allTiles || [])]
                  .map((layer) => {
                    const isRaster = Boolean(layer.filename && !layer.geometry_type);
                    const lid = String(layer.id);
                    const currentRank = orderingConfig.custom_ranks?.[lid] ?? layer.display_order ?? (isRaster ? 10 : 50);
                    return { ...layer, isRaster, lid, rank: Number(currentRank) };
                  })
                  .sort((a, b) => b.rank - a.rank)
                  .map((item, idx) => (
                    <div
                      key={item.lid}
                      className="p-2 bg-slate-50 hover:bg-white rounded-lg border border-slate-200 flex items-center justify-between gap-2 transition-all shadow-2xs"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="text-[10px] font-mono font-bold text-slate-400 w-4 text-center">{idx + 1}</span>
                        {item.isRaster ? (
                          <span className="p-1 rounded bg-amber-100 text-amber-800 border border-amber-300 shrink-0">
                            <Image className="w-3.5 h-3.5" />
                          </span>
                        ) : (
                          <span className="p-1 rounded bg-blue-100 text-blue-800 border border-blue-300 shrink-0">
                            <Layers className="w-3.5 h-3.5" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="text-xs font-bold text-slate-800 font-nepali truncate">{item.name}</div>
                          <div className="text-[10px] text-slate-400 font-mono flex items-center gap-1.5">
                            <span>ID: {item.lid}</span>
                            <span>•</span>
                            <span>{item.isRaster ? 'Raster MBTiles' : (item.geometry_type || 'Vector')}</span>
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <span className="text-[10px] text-slate-500 font-nepali">प्राथमिकता:</span>
                        <input
                          type="number"
                          value={item.rank}
                          onChange={(e) => {
                            const val = parseInt(e.target.value, 10) || 0;
                            setOrderingConfig((prev) => ({
                              ...prev,
                              custom_ranks: {
                                ...(prev.custom_ranks || {}),
                                [item.lid]: val,
                              },
                            }));
                          }}
                          className="w-14 px-1.5 py-1 text-xs font-mono font-bold text-center border border-slate-300 rounded bg-white focus:ring-1 focus:ring-gov-blue-800"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setOrderingConfig((prev) => ({
                              ...prev,
                              custom_ranks: {
                                ...(prev.custom_ranks || {}),
                                [item.lid]: item.rank + 5,
                              },
                            }));
                          }}
                          className="p-1 rounded hover:bg-slate-200 text-slate-600 transition-colors"
                          title="माथि सार्नुहोस् (Increase Priority)"
                        >
                          <ArrowUp className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setOrderingConfig((prev) => ({
                              ...prev,
                              custom_ranks: {
                                ...(prev.custom_ranks || {}),
                                [item.lid]: Math.max(0, item.rank - 5),
                              },
                            }));
                          }}
                          className="p-1 rounded hover:bg-slate-200 text-slate-600 transition-colors"
                          title="तल सार्नुहोस् (Decrease Priority)"
                        >
                          <ArrowDown className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ 4. USERS MANAGEMENT TAB =================== */}
        {/* ======================================================== */}
        {activeTab === 'users' && (
          <div className="space-y-3 animate-fade-in">
            <button
              type="button"
              onClick={() => setShowUserForm(!showUserForm)}
              className="btn-gov-primary w-full text-xs font-bold py-2 flex items-center justify-center gap-1.5 shadow-sm"
            >
              <UserPlus className="w-4 h-4 text-gov-gold-400" />
              <span>नयाँ अधिकृत थप्नुहोस् (New User)</span>
            </button>

            {showUserForm && (
              <form onSubmit={handleCreateUser} className="bg-white p-3.5 rounded-lg border border-gov-blue-300 shadow-md space-y-2.5 animate-slide-up">
                <div className="text-xs font-bold text-gov-blue-900 font-nepali border-b border-slate-100 pb-1 flex items-center justify-between">
                  <span>अधिकृत विवरण (Officer Setup)</span>
                  <span className="text-[10px] text-gov-red-600">* अनिवार्य</span>
                </div>
                <div>
                  <label className="gov-label">प्रयोगकर्ता नाम (Username)</label>
                  <input
                    value={userForm.username}
                    onChange={(e) => setUserForm((u) => ({ ...u, username: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="username"
                    required
                  />
                </div>
                <div>
                  <label className="gov-label">इमेल (Email)</label>
                  <input
                    type="email"
                    value={userForm.email}
                    onChange={(e) => setUserForm((u) => ({ ...u, email: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="officer@kathmandu.gov.np"
                    required
                  />
                </div>
                <div>
                  <label className="gov-label">पूरा नाम (Full Name)</label>
                  <input
                    value={userForm.full_name}
                    onChange={(e) => setUserForm((u) => ({ ...u, full_name: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="राम बहादुर श्रेष्ठ"
                    required
                  />
                </div>
                <div>
                  <label className="gov-label">पासवर्ड (Password)</label>
                  <input
                    type="password"
                    value={userForm.password}
                    onChange={(e) => setUserForm((u) => ({ ...u, password: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="न्यूनतम ८ अक्षर"
                    required
                    minLength={8}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="gov-label">पद / भूमिका (Role)</label>
                    <select
                      value={userForm.role}
                      onChange={(e) => setUserForm((u) => ({ ...u, role: e.target.value }))}
                      className="gov-input text-xs"
                    >
                      <option value="DataCollector">तथ्याङ्क संकलक (DataCollector)</option>
                      <option value="Validator">प्रमाणीकरणकर्ता (Validator)</option>
                      <option value="DepartmentAdmin">विभागीय प्रशासक (DepartmentAdmin)</option>
                      <option value="MunicipalUser">नगरपालिका कर्मचारी (MunicipalUser)</option>
                      <option value="BasicViewer">अवलोकनकर्ता (BasicViewer)</option>
                      {isMasterAdmin && (
                        <>
                          <option value="SuperAdmin">सुपर प्रशासक (SuperAdmin)</option>
                          <option value="MasterAdmin">मास्टर प्रशासक (MasterAdmin)</option>
                        </>
                      )}
                    </select>
                  </div>
                  <div>
                    <label className="gov-label">तोकिएको वडा (Ward)</label>
                    <select
                      value={userForm.assigned_ward || 0}
                      onChange={(e) => setUserForm((u) => ({ ...u, assigned_ward: Number(e.target.value) }))}
                      className="gov-input text-xs"
                    >
                      <option value={0}>सबै वडा (All Wards / 0)</option>
                      {Array.from({ length: 32 }, (_, i) => i + 1).map((w) => (
                        <option key={w} value={w}>वडा नं. {w}</option>
                      ))}
                    </select>
                  </div>
                </div>
                <div>
                  <label className="gov-label">विभाग / शाखा (Department / ID)</label>
                  <input
                    value={userForm.department}
                    onChange={(e) => setUserForm((u) => ({ ...u, department: e.target.value }))}
                    className="gov-input text-xs"
                    placeholder="उदा. Urban Planning / GIS Division वा Department ID"
                  />
                </div>
                <div className="flex gap-2 pt-1">
                  <button type="submit" className="btn-gov-primary flex-1 text-xs py-1.5">
                    सिर्जना गर्नुहोस्
                  </button>
                  <button type="button" onClick={() => setShowUserForm(false)} className="btn-gov-secondary text-xs py-1.5">
                    रद्द गर्नुहोस्
                  </button>
                </div>
              </form>
            )}

            <div className="space-y-2">
              {users.map((u) => {
                // Find all projects where this user is assigned
                const userProjects = projects.filter((p) =>
                  (projectCollectors[p.id] || []).some((c) => c.user_id === u.id)
                );

                return (
                  <div key={u.id} className="bg-white rounded-lg border border-slate-200 p-3 shadow-xs space-y-2">
                    <div className="flex items-center justify-between">
                      <div>
                        <div className="text-xs font-bold text-slate-800">{u.full_name || u.username}</div>
                        <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                          @{u.username} &middot; <strong className="text-gov-blue-800">{u.role}</strong>
                          {(u.role === 'SuperAdmin' || u.role === 'MasterAdmin') && (
                            <span className={`ml-1 px-1 rounded font-bold font-nepali ${
                              u.role === 'MasterAdmin'
                                ? 'bg-rose-100 text-rose-800'
                                : 'bg-purple-100 text-purple-800'
                            }`}>
                              {u.role === 'MasterAdmin' ? 'मास्टर' : 'सुपर'}
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {/* Edit User Details */}
                        {(isMasterAdmin || isSuperAdmin || (isDepartmentAdmin && !['MasterAdmin', 'SuperAdmin'].includes(u.role))) && (
                          <button
                            type="button"
                            onClick={() => handleOpenEditUser(u)}
                            className="p-1 rounded border border-slate-300 text-slate-700 hover:bg-slate-100 transition-colors"
                            title="प्रयोगकर्ता विवरण सम्पादन गर्नुहोस् (Edit user details)"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Password Reset */}
                        {(isMasterAdmin || isSuperAdmin || String(u.id) === String(currentUser?.id)) && (
                          <button
                            type="button"
                            onClick={() => openPasswordModal(u)}
                            className="p-1 rounded border border-gov-blue-200 text-gov-blue-700 hover:bg-gov-blue-50 transition-colors"
                            title="पासवर्ड परिवर्तन / रिसेट गर्नुहोस् (Change / reset password)"
                          >
                            <Key className="w-3.5 h-3.5" />
                          </button>
                        )}

                        {/* Delete User */}
                        {(isMasterAdmin || (isSuperAdmin && u.role !== 'MasterAdmin')) && String(u.id) !== String(currentUser?.id) && (
                          <button
                            type="button"
                            onClick={() => handleDeleteUser(u)}
                            className="p-1 rounded border border-red-200 text-gov-red-600 hover:bg-red-50 transition-colors"
                            title="प्रयोगकर्ता मेटाउनुहोस् (Delete user)"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}

                        <span
                          className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold border font-nepali ${
                            u.is_active
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200'
                              : 'bg-red-50 text-gov-red-700 border-red-200'
                          }`}
                        >
                          {u.is_active ? 'सक्रिय' : 'निष्क्रिय'}
                        </span>
                      </div>
                    </div>

                    {/* Show Project Assignments for Data Collectors */}
                    {u.role === 'DataCollector' ? (
                      <div className="bg-slate-50 p-2 rounded border border-slate-100 space-y-1">
                        <div className="text-[10px] font-bold text-slate-600 font-nepali flex items-center justify-between">
                          <span>तोकिएका परियोजनाहरू ({userProjects.length}):</span>
                        </div>
                        {userProjects.length === 0 ? (
                          <div className="text-[10px] text-amber-700 font-nepali italic">
                            कुनै परियोजना तोकिएको छैन (पहुँच प्रतिबन्धित)
                          </div>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {userProjects.map((p) => {
                              const collectorInfo = (projectCollectors[p.id] || []).find((c) => c.user_id === u.id);
                              return (
                                <span
                                  key={p.id}
                                  className="inline-flex items-center gap-1 bg-gov-blue-50 text-gov-blue-900 border border-gov-blue-200 text-[10px] font-bold px-1.5 py-0.5 rounded font-nepali"
                                >
                                  <span>{p.name}</span>
                                  {collectorInfo?.assigned_tasks_count > 0 && (
                                    <span className="bg-gov-blue-200/70 text-gov-blue-950 text-[9px] px-1 rounded-full">
                                      {collectorInfo.assigned_tasks_count} ग्रिड
                                    </span>
                                  )}
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="text-[10px] text-slate-500 font-nepali bg-slate-50 px-2 py-1 rounded border border-slate-100 flex items-center justify-between gap-2">
                        <span>
                          {({
                            MasterAdmin: 'मास्टर प्रशासक पहुँच (Master Admin Access)',
                            SuperAdmin: 'सुपर प्रशासक पहुँच (Super Admin Access)',
                            GisAdmin: 'GIS प्रशासक पहुँच (GIS Admin Access)',
                            DepartmentAdmin: 'विभागीय प्रशासक पहुँच (Department Admin Access)',
                            Validator: 'प्रमाणीकरणकर्ता पहुँच (Validator Access)',
                            MunicipalUser: 'नगरपालिका कर्मचारी पहुँच (Municipal Staff Access)',
                            BasicViewer: 'नागरिक/अवलोकनकर्ता पहुँच (Public Viewer Access)',
                          }[u.role] || `${u.role} Access`)}
                        </span>
                        {(u.department || u.department_id) && (
                          <span className="font-mono text-[9px] text-gov-blue-700 bg-gov-blue-50 px-1.5 py-0.5 rounded border border-gov-blue-200">
                            Dept: {u.department || u.department_id}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ 5. GIS SERVICE LINKS TAB ================== */}
        {/* ======================================================== */}
        {activeTab === 'services' && (() => {
          // Single-origin golden rule: every service is addressed relative to
          // the nginx ingress that served this page (never a hardcoded host).
          const serverOrigin = typeof window !== 'undefined' ? window.location.origin : '';
          const ogcUrl = `${serverOrigin}/ogc/`;
          const wfsUrl = `${serverOrigin}/geoserver/wfs`;
          const wmsUrl = `${serverOrigin}/geoserver/wms`;
          const martinUrl = `${serverOrigin}/martin/catalog`;
          const copy = async (text, label) => {
            try {
              if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(text);
              } else {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
              }
              setMessage({ type: 'success', text: `${label} कपि भयो!` });
              setTimeout(() => setMessage(null), 2000);
            } catch {
              try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                setMessage({ type: 'success', text: `${label} कपि भयो!` });
                setTimeout(() => setMessage(null), 2000);
              } catch {
                setMessage({ type: 'error', text: `${label} कपि गर्न सकिएन — कृपया म्यानुअल रूपमा कपि गर्नुहोस्।` });
              }
            }
          };
          const UrlRow = ({ label, url }) => (
            <div className="flex items-center gap-1">
              <span className="text-[9px] text-slate-400 w-9 shrink-0">{label}</span>
              <code className="bg-white px-2 py-0.5 rounded border text-[10px] font-mono flex-1 truncate select-all font-semibold text-slate-800">
                {url}
              </code>
              <button
                type="button"
                onClick={() => copy(url, label)}
                className="text-gov-blue-600 hover:text-gov-blue-800 p-0.5 shrink-0"
                title="Copy"
              >
                <Copy className="w-3.5 h-3.5" />
              </button>
            </div>
          );
          return (
          <div className="space-y-4 animate-fade-in">
            {/* Connection Info — real endpoints exposed by nginx */}
            <div className="bg-gov-blue-50 border border-gov-blue-200 rounded-lg p-3 text-xs space-y-2">
              <div className="font-bold text-gov-blue-800 flex items-center gap-1.5 font-nepali">
                <ExternalLink className="w-4 h-4 text-gov-blue-600" />
                QGIS / OGC कनेक्शन गाइड (Connection Guide)
              </div>
              <div className="text-gov-blue-700 space-y-2">
                <p className="font-semibold">OGC API – Features (भेक्टर तह — QGIS मा Toggle Editing सहित):</p>
                <UrlRow label="OGC" url={ogcUrl} />
                <p className="text-[10px] text-gov-blue-800 leading-relaxed">
                  QGIS → Layer → Add Layer → Add WFS / OGC API - Features → New Connection → URL माथिको
                  लिङ्क (अन्त्यमा / सहित) → Version = “OGC API - Features” → Authentication = “Basic
                  authentication” र आफ्नो KMC प्रयोगकर्ता नाम/पासवर्ड → Connect → प्रत्येक भेक्टर तह
                  छुट्टाछुट्टै देखिन्छ, छान्नुहोस् र Add गर्नुहोस्। साझा गर्नुअघि Connection मा
                  Edit गरी Version/Authentication जाँच गर्नुहोस्। सम्पादनका लागि Toggle Editing
                  (पेन्सिल) थिच्नुहोस्; Save गर्दा परिवर्तन सिधै सर्भरमा लेखिन्छ र नक्सा, फारम तथा
                  GeoPortal सबैतिर देखिन्छ। GeoJSON/OGR (Add Vector Layer) कनेक्शन प्रयोग नगर्नुहोस् —
                  त्यसले पासवर्ड पठाउँदैन; पासवर्ड HTTPS मा मात्र पठाउनुहोस्। तल प्रत्येक तहको “OGC”
                  लिङ्क सिधै items API हो — QGIS कनेक्शनमा भने माथिको /ogc/ मात्र राख्नुहोस्।
                </p>
                <p className="font-semibold">र्यास्टर XYZ टाइल (QGIS → XYZ Tiles):</p>
                <UrlRow label="XYZ" url={`${serverOrigin}/api/tiles/data/{slug}/{z}/{x}/{y}.png`} />
                <p className="text-[10px] text-slate-500">
                  तल प्रत्येक र्यास्टरको सटीक XYZ लिङ्क कपि गरी QGIS XYZ Tiles मा राख्नुहोस्।
                </p>
                <p className="font-semibold">GeoServer (छुट्टै बाह्य OGC सर्भर — यो एपको फिचर स्टोर होइन):</p>
                <UrlRow label="WFS" url={wfsUrl} />
                <UrlRow label="WMS" url={wmsUrl} />
                <p className="font-semibold">Martin MVT catalog:</p>
                <UrlRow label="MVT" url={martinUrl} />
              </div>
            </div>

            {/* Vector Layers Section */}
            <div>
              <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-2 font-nepali">
                <Layers className="w-4 h-4 text-gov-blue-600" />
                भेक्टर तहहरू (Vector Layers) — {allLayers.length}
              </h3>
              <div className="space-y-1.5">
                {allLayers.length === 0 && (
                  <div className="text-xs text-slate-400 italic text-center py-3 font-nepali">
                    कुनै भेक्टर तह छैन (No vector layers)
                  </div>
                )}
                {allLayers.map((layer) => {
                  const restUrl = `${serverOrigin}/api/layers/${layer.id}`;
                  const geojsonUrl = `${serverOrigin}/api/layers/${layer.id}/download?format=geojson`;
                  const ogcItemsUrl = `${serverOrigin}/ogc/collections/${layer.id}/items`;
                  const layerWmsUrl = `${wmsUrl}?service=WMS&request=GetCapabilities&layers=kmc:layer_${layer.id}`;
                  const layerWfsUrl = `${wfsUrl}?service=WFS&request=GetFeature&typeName=kmc:layer_${layer.id}`;
                  const layerMvtUrl = `${serverOrigin}/martin/layer_${layer.id}/{z}/{x}/{y}`;
                  return (
                    <div key={layer.id} className="bg-white border border-slate-200 rounded-lg p-2.5 hover:border-gov-blue-300 transition-colors">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-slate-800 truncate">{layer.name}</span>
                        <span className="text-[10px] bg-emerald-100 text-emerald-700 px-1.5 py-0.5 rounded font-mono">
                          {layer.geometry_type}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 mb-1.5">
                        {layer.feature_count ?? 0} features • {layer.is_global ? 'Global' : `Project #${layer.project_id}`}
                      </div>
                      <div className="space-y-1">
                        <UrlRow label="OGC" url={ogcItemsUrl} />
                        <UrlRow label="WMS" url={layerWmsUrl} />
                        <UrlRow label="WFS" url={layerWfsUrl} />
                        <UrlRow label="MVT" url={layerMvtUrl} />
                        <UrlRow label="REST" url={restUrl} />
                        <UrlRow label="GeoJSON" url={geojsonUrl} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Raster/Tile Layers Section */}
            <div>
              <h3 className="text-xs font-bold text-slate-800 flex items-center gap-1.5 mb-2 font-nepali">
                <Image className="w-4 h-4 text-amber-600" />
                र्यास्टर/टाइल तहहरू (Raster/Tile Layers) — {allTiles.length}
              </h3>
              <div className="space-y-1.5">
                {allTiles.length === 0 && (
                  <div className="text-xs text-slate-400 italic text-center py-3 font-nepali">
                    कुनै MBTiles छैन (No MBTiles)
                  </div>
                )}
                {allTiles.map((tile) => {
                  const slug = String(tile.filename || '').replace(/\.mbtiles$/i, '');
                  // The API normalises tile_url to /api/tiles/data/<slug>/...;
                  // fall back to the same canonical form when it is absent.
                  const resolvedTileUrl = tile.tile_url
                    ? (tile.tile_url.startsWith('/') ? `${serverOrigin}${tile.tile_url}` : tile.tile_url)
                    : `${serverOrigin}/api/tiles/data/${slug}/{z}/{x}/{y}.png`;
                  const downloadUrl = `${serverOrigin}/api/tiles/${tile.id}/download`;
                  return (
                    <div key={tile.id} className="bg-white border border-slate-200 rounded-lg p-2.5 hover:border-amber-300 transition-colors">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs font-bold text-slate-800 truncate">{tile.name}</span>
                        <span className="text-[10px] bg-amber-100 text-amber-700 px-1.5 py-0.5 rounded font-mono">
                          z{tile.min_zoom ?? 0}-{tile.max_zoom ?? 22}
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-500 mb-1.5">
                        {tile.file_size ? `${(tile.file_size / 1024 / 1024).toFixed(1)} MB` : 'N/A'} • {tile.is_global ? 'Global' : `Project #${tile.project_id}`}
                      </div>
                      <div className="space-y-1">
                        <UrlRow label="XYZ" url={resolvedTileUrl} />
                        <UrlRow label="MVT" url={`${serverOrigin}/martin/${slug}/{z}/{x}/{y}`} />
                        <UrlRow label="WMS" url={`${wmsUrl}?service=WMS&request=GetCapabilities`} />
                        <UrlRow label="MBTiles" url={downloadUrl} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Recycle Bin — soft-deleted raster packages */}
              <div className="mt-2 border border-slate-200 rounded-lg overflow-hidden bg-white shadow-xs">
                <button
                  type="button"
                  onClick={() => {
                    const next = !showRecycleBin;
                    setShowRecycleBin(next);
                    if (next) loadRecycleBin();
                  }}
                  className="w-full px-3 py-2 bg-slate-100/90 hover:bg-slate-200/80 flex items-center justify-between text-left transition-colors"
                >
                  <span className="flex items-center gap-2 text-xs font-bold text-slate-800 font-nepali">
                    <Recycle className="w-3.5 h-3.5 text-slate-500" />
                    रिसाइकल बिन (Recycle Bin)
                  </span>
                  <span className="flex items-center gap-2">
                    {deletedTiles.length > 0 && (
                      <span className="px-1.5 py-0.5 rounded-full text-[9px] font-bold bg-amber-100 text-amber-800">
                        {deletedTiles.length}
                      </span>
                    )}
                    {showRecycleBin ? <ChevronUp className="w-3.5 h-3.5 text-slate-400" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-400" />}
                  </span>
                </button>
                {showRecycleBin && (
                  <div className="p-2 space-y-1.5 max-h-64 overflow-y-auto">
                    {recycleBinLoading ? (
                      <div className="p-4 text-center text-xs text-slate-500 font-nepali flex items-center justify-center gap-2">
                        <Loader2 className="w-4 h-4 animate-spin" /> लोड हुँदैछ…
                      </div>
                    ) : deletedTiles.length === 0 ? (
                      <div className="p-4 text-center text-xs text-slate-400 font-nepali">
                        रिसाइकल बिन खाली छ (No deleted rasters)
                      </div>
                    ) : (
                      deletedTiles.map((tile) => (
                        <div key={tile.id} className="flex items-center justify-between gap-2 bg-amber-50/60 border border-amber-200/60 rounded-lg px-2.5 py-2">
                          <div className="min-w-0">
                            <div className="text-xs font-bold text-slate-800 font-nepali truncate">{tile.name}</div>
                            <div className="text-[10px] text-slate-500">
                              {tile.filename} · मेटिएको:{' '}
                              {tile.deleted_at ? new Date(tile.deleted_at).toLocaleString() : '—'}
                            </div>
                          </div>
                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={restoringId === `tile-${tile.id}`}
                              onClick={() => handleRestoreTile(tile)}
                              className="p-1.5 text-emerald-700 hover:bg-emerald-100 rounded transition-colors"
                              title="पुनर्स्थापना गर्नुहोस् (Restore)"
                            >
                              {restoringId === `tile-${tile.id}` ? (
                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                              ) : (
                                <RotateCcw className="w-3.5 h-3.5" />
                              )}
                            </button>
                            {isMasterAdmin && (
                              <button
                                type="button"
                                disabled={permanentDeletingId === `tile-${tile.id}`}
                                onClick={() => handlePermanentDeleteTile(tile)}
                                className="p-1.5 text-gov-red-700 hover:bg-gov-red-100 rounded transition-colors"
                                title="सधैंका लागि मेटाउनुहोस् (Delete forever — cannot be undone)"
                              >
                                {permanentDeletingId === `tile-${tile.id}` ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                  <Trash2 className="w-3.5 h-3.5" />
                                )}
                              </button>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
          );
        })()}

        {/* ======================================================== */}
        {/* ============ QUESTIONNAIRES STUDIO TAB ================= */}
        {/* ======================================================== */}
        {activeTab === 'questionnaires' && (
          <div className="space-y-3 animate-fade-in text-xs">
            <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-xs space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-800 font-nepali">परियोजना छनोट गर्नुहोस् (Select Project)</span>
                <span className="text-[10px] text-slate-500 font-mono">{projects.length} Projects</span>
              </div>
              <select
                value={selectedQuestionnaireProject?.id || ''}
                onChange={(e) => {
                  if (e.target.value === 'global') {
                    setSelectedQuestionnaireProject({
                      id: 'global',
                      name: 'सार्वभौमिक प्रश्नावली (Global Questionnaire)',
                      project_mode: 'GLOBAL',
                      geometry_config: { type: 'Mix' },
                    });
                    return;
                  }
                  const p = projects.find((pr) => pr.id === Number(e.target.value));
                  setSelectedQuestionnaireProject(p || null);
                }}
                className="gov-input text-xs"
              >
                <option value="">-- परियोजना छान्नुहोस् --</option>
                {isSuperAdmin && (
                  <option value="global">🌐 सबै परियोजनामा प्रयोग हुने सार्वभौमिक प्रश्नावली (Global)</option>
                )}
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} [{p.project_mode || 'STANDARD'}]
                  </option>
                ))}
              </select>
              {selectedQuestionnaireProject?.id === 'global' && (
                <p className="text-[10px] text-gov-blue-800 bg-gov-blue-50 border border-gov-blue-200 rounded p-2 font-nepali">
                  सार्वभौमिक प्रश्नावली कुनै पनि परियोजनाको भेक्टर तहमा लिङ्क गर्न सकिन्छ। नयाँ फिचर सिर्जना गर्दा यही प्रश्नावली खुल्नेछ र उत्तरहरू तहका विशेषता (attributes) बन्नेछन्।
                </p>
              )}
            </div>

            {selectedQuestionnaireProject ? (
              <div className="p-4 bg-white rounded-xl border border-gov-blue-300 shadow-sm space-y-3">
                <div className="flex items-center justify-between border-b pb-2">
                  <div>
                    <h4 className="font-bold text-sm text-gov-blue-900 font-nepali">
                      {selectedQuestionnaireProject.name}
                    </h4>
                    <span className="text-[11px] text-slate-500">
                      ढाँचा: {selectedQuestionnaireProject.project_mode} &middot; ज्यामिति: {selectedQuestionnaireProject.geometry_config?.type || 'Point'}
                    </span>
                  </div>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    selectedQuestionnaireProject.active_questionnaire_id
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}>
                    {selectedQuestionnaireProject.active_questionnaire_id ? 'प्रश्नावली सक्रिय' : 'मस्यौदा'}
                  </span>
                </div>

                <p className="text-[11px] text-slate-600 font-nepali">
                  यस परियोजनाका लागि खण्डहरू, बहु-प्रकृतिका प्रश्नहरू, सर्त लजिक, दोहोरिने समूह (Repeat Groups), र नेपाली युनिकोड कन्फिगर गर्न बिल्डर खोल्नुहोस्।
                </p>

                <button
                  type="button"
                  onClick={() => setQuestionnaireStudioProject(selectedQuestionnaireProject)}
                  className="w-full btn-gov-primary py-2.5 flex items-center justify-center gap-2 text-xs font-bold font-nepali shadow-md"
                >
                  <ClipboardList className="w-4 h-4 text-gov-gold-400" />
                  <span>प्रश्नावली बिल्डर खोल्नुहोस् (Open Questionnaire Builder)</span>
                </button>
              </div>
            ) : (
              <div className="p-8 text-center text-slate-400 bg-white rounded-lg border border-dashed border-slate-200 font-nepali">
                माथिबाट कुनै परियोजना छनोट गरी प्रश्नावली बनाउनुहोस् वा सम्पादन गर्नुहोस्।
              </div>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ FIELD RECORDS QA REVIEW TAB =============== */}
        {/* ======================================================== */}
        {activeTab === 'records' && (
          <div className="space-y-3 animate-fade-in text-xs">
            <div className="p-3 bg-white rounded-lg border border-slate-200 shadow-xs space-y-2">
              <span className="font-bold text-slate-800 font-nepali">परियोजना छनोट (Select Project for QA)</span>
              <select
                value={selectedRecordsProjectId || ''}
                onChange={(e) => setSelectedRecordsProjectId(e.target.value ? Number(e.target.value) : null)}
                className="gov-input text-xs"
              >
                <option value="">-- परियोजना छान्नुहोस् --</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>

            {selectedRecordsProjectId ? (
              <RecordsReviewTable
                projectId={selectedRecordsProjectId}
                onZoomToRecord={(rec) => {}}
              />
            ) : (
              <div className="p-8 text-center text-slate-400 bg-white rounded-lg border border-dashed border-slate-200 font-nepali">
                समीक्षा गर्नका लागि परियोजना छान्नुहोस्।
              </div>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ MASTER CONTROL (MasterAdmin only) ========= */}
        {/* ======================================================== */}
        {activeTab === 'master' && isMasterAdmin && (
          <div className="space-y-3 animate-fade-in text-xs" data-testid="master-control-panel">
            <div className="bg-rose-950 text-white rounded-xl p-3.5 border border-rose-700 shadow-sm space-y-1.5">
              <div className="flex items-center gap-2 font-bold font-nepali text-sm">
                <ShieldAlert className="w-4 h-4 text-rose-300" />
                मास्टर नियन्त्रण (Master Control)
              </div>
              <p className="text-[11px] text-rose-100 font-nepali leading-relaxed">
                यो खण्ड केवल MasterAdmin खाताका लागि हो। यहाँबाट सार्वजनिक जियोपोर्टल बन्द/खुलाउन,
                सर्भर भण्डारण स्थायी रूपमा खाली गर्न र रिसाइकल बिन डिस्कबाट मेट्न सकिन्छ। यी कार्य फिर्ता गर्न सकिँदैन।
              </p>
            </div>

            {masterLoading ? (
              <div className="p-6 text-center text-slate-500 font-nepali flex items-center justify-center gap-2 bg-white rounded-lg border border-slate-200">
                <Loader2 className="w-4 h-4 animate-spin" /> मास्टर नियन्त्रण लोड हुँदैछ…
              </div>
            ) : (
              <>
                {/* Public GeoPortal kill-switch */}
                <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-xs space-y-2.5">
                  <div className="flex items-center gap-2 font-bold text-slate-800 font-nepali">
                    <Globe className="w-4 h-4 text-gov-blue-700" />
                    सार्वजनिक जियोपोर्टल (Public GeoPortal)
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border font-nepali ${
                        geoportalState?.geoportal_enabled === false
                          ? 'bg-rose-50 text-rose-800 border-rose-200'
                          : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${geoportalState?.geoportal_enabled === false ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                      {geoportalState?.geoportal_enabled === false ? 'बन्द (Disabled)' : 'सक्रिय (Enabled)'}
                    </span>
                    <button
                      type="button"
                      disabled={geoportalSaving}
                      onClick={handleToggleGeoportal}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-bold text-white disabled:opacity-50 ${
                        geoportalState?.geoportal_enabled === false
                          ? 'bg-emerald-700 hover:bg-emerald-800'
                          : 'bg-rose-700 hover:bg-rose-800'
                      }`}
                    >
                      {geoportalSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                      {geoportalState?.geoportal_enabled === false ? 'सक्रिय गर्नुहोस् (Enable)' : 'बन्द गर्नुहोस् (Disable)'}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 font-nepali leading-snug">
                    बन्द गर्दा नागरिक पोर्टलमा मर्मत सन्देश देखिन्छ, नेभिगेसन लिङ्क लुक्छ र जियोपोर्टल API बन्द हुन्छ।
                    {geoportalState?.reason ? ` कारण: ${geoportalState.reason}` : ''}
                    {geoportalState?.updated_by ? ` (${geoportalState.updated_by})` : ''}
                  </p>
                </div>

                {/* Landing Page Toggle */}
                <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-xs space-y-2.5">
                  <div className="flex items-center gap-2 font-bold text-slate-800 font-nepali">
                    <Globe className="w-4 h-4 text-sky-700" />
                    ल्यान्डिङ पृष्ठ (Unified Landing Page)
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold border font-nepali ${
                        geoportalState?.landing_page_enabled === false
                          ? 'bg-rose-50 text-rose-800 border-rose-200'
                          : 'bg-emerald-50 text-emerald-800 border-emerald-200'
                      }`}
                    >
                      <span className={`w-1.5 h-1.5 rounded-full ${geoportalState?.landing_page_enabled === false ? 'bg-rose-500' : 'bg-emerald-500'}`} />
                      {geoportalState?.landing_page_enabled === false ? 'बन्द (Disabled)' : 'सक्रिय (Enabled)'}
                    </span>
                    <button
                      type="button"
                      disabled={landingPageSaving}
                      onClick={handleToggleLandingPage}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-[11px] font-bold text-white disabled:opacity-50 ${
                        geoportalState?.landing_page_enabled === false
                          ? 'bg-emerald-700 hover:bg-emerald-800'
                          : 'bg-rose-700 hover:bg-rose-800'
                      }`}
                    >
                      {landingPageSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
                      {geoportalState?.landing_page_enabled === false ? 'सक्रिय गर्नुहोस् (Enable)' : 'बन्द गर्नुहोस् (Disable)'}
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-500 font-nepali leading-snug">
                    बन्द गर्दा मुख्य वेब ठेगाना (Root URL) मा जाने जोसुकै पनि सीधा कर्मचारी लगइन पृष्ठमा रिडाइरेक्ट हुन्छ।
                  </p>
                </div>

                {/* Individual upload deletion */}
                <div className="bg-white border border-rose-200 rounded-lg p-3 shadow-xs space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-bold text-rose-900 font-nepali">
                      <Database className="w-4 h-4 text-rose-700" />
                      व्यक्तिगत अपलोड मेट्नुहोस् (Delete Individual Uploads)
                    </div>
                    <span className="shrink-0 text-[9.5px] px-1.5 py-0.5 rounded bg-rose-50 text-rose-800 border border-rose-200 font-bold">
                      {(allLayers?.length || 0) + (allTiles?.length || 0)} आइटम
                    </span>
                  </div>
                  <p className="text-[10px] text-slate-500 font-nepali leading-snug">
                    कुनै एक तह वा रास्टर इमेज्री छानी सर्भर डिस्कबाट स्थायी रूपमा मेट्नुहोस्। यो कार्य फिर्ता गर्न सकिँदैन।
                  </p>

                  <div className="space-y-1.5 max-h-72 overflow-y-auto scrollbar-thin pr-0.5">
                    <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-wide">
                      भेक्टर तह ({allLayers?.length || 0})
                    </div>
                    {(allLayers || []).length === 0 ? (
                      <div className="text-[10px] text-slate-400 font-nepali italic px-1">कुनै सक्रिय भेक्टर तह छैन</div>
                    ) : (
                      allLayers.map((layer) => (
                        <div
                          key={`master-layer-${layer.id}`}
                          className="flex items-center justify-between gap-2 p-2 rounded border border-slate-200 bg-slate-50"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Layers className="w-3.5 h-3.5 text-gov-blue-800 shrink-0" />
                              <span className="font-bold text-slate-800 font-nepali truncate">{layer.name}</span>
                            </div>
                            <div className="text-[9.5px] text-slate-500 font-mono truncate">
                              {layer.geometry_type || 'Vector'} · {layer.feature_count ?? 0} फिचर ·{' '}
                              {layer.is_global ? 'Global' : `Project #${layer.project_id}`}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={masterDeletingId !== null}
                            onClick={() => handleMasterDeleteUpload('layer', layer)}
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-700 hover:bg-rose-800 text-white text-[10px] font-bold disabled:opacity-50"
                            title="स्थायी रूपमा मेट्नुहोस् (Permanently delete)"
                          >
                            {masterDeletingId === `layer-${layer.id}` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Trash2 className="w-3 h-3" />
                            )}
                            मेट्नुहोस्
                          </button>
                        </div>
                      ))
                    )}

                    <div className="text-[9.5px] font-bold text-slate-500 uppercase tracking-wide pt-1">
                      रास्टर इमेज्री ({allTiles?.length || 0})
                    </div>
                    {(allTiles || []).length === 0 ? (
                      <div className="text-[10px] text-slate-400 font-nepali italic px-1">कुनै सक्रिय रास्टर इमेज्री छैन</div>
                    ) : (
                      allTiles.map((tile) => (
                        <div
                          key={`master-tile-${tile.id}`}
                          className="flex items-center justify-between gap-2 p-2 rounded border border-slate-200 bg-slate-50"
                        >
                          <div className="min-w-0">
                            <div className="flex items-center gap-1.5 min-w-0">
                              <Image className="w-3.5 h-3.5 text-purple-700 shrink-0" />
                              <span className="font-bold text-slate-800 font-nepali truncate">{tile.name}</span>
                            </div>
                            <div className="text-[9.5px] text-slate-500 font-mono truncate">
                              {tile.filename || 'MBTiles'} ·{' '}
                              {tile.file_size ? `${(tile.file_size / (1024 * 1024)).toFixed(1)} MB` : 'आकार अज्ञात'} ·{' '}
                              {tile.is_global ? 'Global' : `Project #${tile.project_id}`}
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled={masterDeletingId !== null}
                            onClick={() => handleMasterDeleteUpload('tile', tile)}
                            className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-700 hover:bg-rose-800 text-white text-[10px] font-bold disabled:opacity-50"
                            title="स्थायी रूपमा मेट्नुहोस् (Permanently delete)"
                          >
                            {masterDeletingId === `tile-${tile.id}` ? (
                              <Loader2 className="w-3 h-3 animate-spin" />
                            ) : (
                              <Trash2 className="w-3 h-3" />
                            )}
                            मेट्नुहोस्
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Permanent storage wipe */}
                <div className="bg-white border border-rose-200 rounded-lg p-3 shadow-xs space-y-2.5">
                  <div className="flex items-center gap-2 font-bold text-rose-900 font-nepali">
                    <HardDrive className="w-4 h-4 text-rose-700" />
                    सर्भर भण्डारण स्थायी रूपमा मेट्नुहोस् (Permanent Storage Wipe)
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-[10px]">
                    <div className="bg-slate-50 border border-slate-200 rounded p-2">
                      <div className="text-slate-500 font-nepali">अपलोड भण्डारण</div>
                      <div className="font-mono font-bold text-slate-800">
                        {storageUsage ? `${storageUsage.uploads?.files || 0} फाइल · ${((storageUsage.uploads?.bytes || 0) / (1024 * 1024)).toFixed(2)} MB` : '—'}
                      </div>
                    </div>
                    <div className="bg-slate-50 border border-slate-200 rounded p-2">
                      <div className="text-slate-500 font-nepali">टाइल भण्डारण</div>
                      <div className="font-mono font-bold text-slate-800">
                        {storageUsage ? `${storageUsage.tileserver?.files || 0} फाइल · ${((storageUsage.tileserver?.bytes || 0) / (1024 * 1024)).toFixed(2)} MB` : '—'}
                      </div>
                    </div>
                    <div className="bg-slate-50 border border-slate-200 rounded p-2">
                      <div className="text-slate-500 font-nepali">भेक्टर तह</div>
                      <div className="font-mono font-bold text-slate-800">
                        {storageUsage?.vector_layers_active ?? '—'}
                        {storageUsage?.vector_layers_recycled ? (
                          <span className="ml-1 text-[9px] font-nepali font-normal text-slate-500">
                            (+{storageUsage.vector_layers_recycled} रिसाइकल)
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <div className="bg-slate-50 border border-slate-200 rounded p-2">
                      <div className="text-slate-500 font-nepali">रास्टर इमेज्री</div>
                      <div className="font-mono font-bold text-slate-800">
                        {storageUsage?.raster_layers_active ?? '—'}
                        {storageUsage?.raster_layers_recycled ? (
                          <span className="ml-1 text-[9px] font-nepali font-normal text-slate-500">
                            (+{storageUsage.raster_layers_recycled} रिसाइकल)
                          </span>
                        ) : null}
                      </div>
                    </div>
                  </div>
                  <p className="text-[10px] text-rose-800 bg-rose-50 border border-rose-200 rounded p-2 font-nepali leading-snug">
                    यसले अपलोड गरिएका GeoJSON, MBTiles, अस्थायी अपलोड खण्ड, अफलाइन बन्डल र सम्बन्धित
                    तह/इमेज्री मेटाडाटा सर्भरबाट स्थायी रूपमा मेट्छ। परियोजना र फिल्ड रेकर्ड रहन्छन्।
                  </p>
                  <button
                    type="button"
                    disabled={storagePurgeLoading}
                    onClick={handlePurgeAllStorage}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-rose-700 hover:bg-rose-800 text-white text-[11px] font-bold disabled:opacity-50"
                  >
                    {storagePurgeLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    सबै अपलोड स्थायी रूपमा मेट्नुहोस् (Wipe All Uploads)
                  </button>

                  {/* Individual file deletion */}
                  <div className="border-t border-rose-100 pt-2.5 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-1.5 font-bold text-slate-700 text-[10.5px] font-nepali">
                        <FileText className="w-3.5 h-3.5 text-slate-500" />
                        सर्भरमा रहेका फाइलहरू (Individual Files)
                      </div>
                      <button
                        type="button"
                        onClick={refreshStorageSnapshot}
                        disabled={storageFilesLoading || storageFileDeleting !== null}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded border border-slate-300 text-slate-700 text-[9.5px] font-bold disabled:opacity-50"
                      >
                        <RefreshCw className={`w-3 h-3 ${storageFilesLoading ? 'animate-spin' : ''}`} />
                        रिफ्रेस
                      </button>
                    </div>
                    <p className="text-[9.5px] text-slate-500 leading-snug font-nepali">
                      प्रत्येक फाइल छुट्टै मेट्न सकिन्छ — फाइल सर्भर डिस्कबाट हट्छ र भण्डारण तुरुन्तै खाली हुन्छ।
                      सुपर प्रशासकले मेटाएका तहका बाँकी फाइलहरू पनि यहाँ देखिन्छन्। एप्लिकेसन स्टेट र
                      tileserver config फाइलहरू सुरक्षित रहन्छन्।
                    </p>
                    <div className="space-y-1.5 max-h-96 overflow-y-auto scrollbar-thin pr-0.5">
                      {[
                        { key: 'uploads', label: 'अपलोड फाइलहरू (uploads)', items: storageFiles.uploads || [] },
                        { key: 'tiles', label: 'टाइल फाइलहरू (tileserver)', items: storageFiles.tiles || [] },
                      ].map((group) => (
                        <div key={group.key} className="space-y-1">
                          <div className="text-[9px] font-bold text-slate-500 uppercase tracking-wide pt-1">
                            {group.label} ({group.items.length})
                          </div>
                          {group.items.length === 0 ? (
                            <div className="text-[10px] text-slate-400 font-nepali italic px-1">कुनै फाइल छैन</div>
                          ) : (
                            group.items.map((file) => {
                              const rowKey = `${group.key}:${file.path}`;
                              return (
                                <div
                                  key={rowKey}
                                  className="flex items-center justify-between gap-2 p-2 rounded border border-slate-200 bg-slate-50"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                      <FileText className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                                      <span className="font-bold text-slate-800 font-mono text-[10.5px] truncate">
                                        {file.name}
                                      </span>
                                    </div>
                                    <div className="text-[9.5px] text-slate-500 font-mono truncate">
                                      {file.path} · {(Number(file.size || 0) / (1024 * 1024)).toFixed(2)} MB
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    disabled={storageFileDeleting !== null || storagePurgeLoading}
                                    onClick={() => handleDeleteStorageFile(group.key, file)}
                                    className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded bg-rose-700 hover:bg-rose-800 text-white text-[10px] font-bold disabled:opacity-50"
                                    title="यो फाइल स्थायी रूपमा मेट्नुहोस् (Permanently delete this file)"
                                  >
                                    {storageFileDeleting === rowKey ? (
                                      <Loader2 className="w-3 h-3 animate-spin" />
                                    ) : (
                                      <Trash2 className="w-3 h-3" />
                                    )}
                                    मेट्नुहोस्
                                  </button>
                                </div>
                              );
                            })
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Recycle bin purge */}
                <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-xs space-y-2">
                  <div className="flex items-center gap-2 font-bold text-slate-800 font-nepali">
                    <Recycle className="w-4 h-4 text-slate-600" />
                    रिसाइकल बिन (Recycle Bin)
                  </div>
                  <p className="text-[10px] text-slate-500 font-nepali leading-snug">
                    मेटाइएका तह र इमेज्रीका बाँकी फाइल डिस्कबाट खाली गर्नुहोस्।
                  </p>
                  <button
                    type="button"
                    disabled={purgeBinLoading}
                    onClick={handlePurgeRecycleBin}
                    className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded bg-slate-800 hover:bg-slate-900 text-white text-[11px] font-bold disabled:opacity-50"
                  >
                    {purgeBinLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Recycle className="w-4 h-4" />}
                    रिसाइकल बिन डिस्कबाट खाली गर्नुहोस् (Purge Recycle Bin)
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* ============ DOCKER SWARM SECRETS GOLDEN PRACTICE ====== */}
        {/* ======================================================== */}
        {activeTab === 'secrets' && (
          <div className="space-y-3 animate-fade-in text-xs" data-testid="swarm-secrets-panel">
            {/* Observed Posture Banner — values come from /api/system/swarm-secrets */}
            <div className={`rounded-xl p-3.5 border shadow-sm space-y-2 ${
              swarmPosture?.golden_practice_compliant
                ? 'bg-emerald-950 text-white border-emerald-700'
                : 'bg-amber-950 text-white border-amber-600'
            }`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {swarmPosture?.golden_practice_compliant
                    ? <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
                    : <ShieldAlert className="w-5 h-5 text-amber-400 shrink-0" />}
                  <div>
                    <h3 className="font-bold text-xs font-nepali text-white">
                      Docker Swarm Secrets — Golden Practice सुरक्षा स्थिति
                    </h3>
                    <p className={`text-[10px] font-mono ${swarmPosture?.golden_practice_compliant ? 'text-emerald-200' : 'text-amber-200'}`}>
                      {swarmSecretsLoading
                        ? 'Observing mounted secret files…'
                        : `${swarmSecrets.length} secret file(s) observed in this container`}
                    </p>
                  </div>
                </div>
                <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold border shrink-0 ${
                  swarmPosture?.golden_practice_compliant
                    ? 'bg-emerald-500/20 text-emerald-300 border-emerald-400/40'
                    : 'bg-amber-500/20 text-amber-200 border-amber-400/40'
                }`}>
                  {swarmPosture?.golden_practice_compliant
                    ? 'VERIFIED'
                    : (swarmPosture ? 'ATTENTION' : 'UNVERIFIED')}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-1 text-[10px]">
                <div className="bg-black/20 border border-white/10 rounded-lg p-2">
                  <div className={swarmPosture?.golden_practice_compliant ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>
                    Plaintext Env Fallback
                  </div>
                  <div className="text-white/80 font-mono mt-0.5">
                    {swarmPosture?.enforce_swarm_secrets ? 'rejected by ENFORCE_SWARM_SECRETS' : 'not enforced'}
                  </div>
                </div>
                <div className="bg-black/20 border border-white/10 rounded-lg p-2">
                  <div className={swarmPosture?.golden_practice_compliant ? 'text-emerald-300 font-bold' : 'text-amber-300 font-bold'}>
                    Observed Grants
                  </div>
                  <div className="text-white/80 font-mono mt-0.5">
                    {swarmSecrets.length
                      ? `${swarmSecrets[0].uid}:${swarmSecrets[0].gid} • mode ${swarmSecrets[0].mode}`
                      : 'no secret files visible'}
                  </div>
                </div>
              </div>

              {swarmSecretsError && (
                <p className="text-[10px] text-amber-200 font-mono">{swarmSecretsError}</p>
              )}
              {swarmPosture?.missing_secrets?.length > 0 && (
                <p className="text-[10px] text-amber-200 font-mono">
                  Missing: {swarmPosture.missing_secrets.join(', ')}
                </p>
              )}
            </div>

            {/* Zero-Downtime Rotation Plan Output (Immediately visible when triggered) */}
            {activeRotationPlan && (
              <div
                className="bg-slate-900 text-slate-100 rounded-xl p-3 border border-gov-blue-500 shadow-md space-y-2"
                data-testid="swarm-rotation-plan"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] font-bold text-amber-300 font-mono">
                    Rotation Plan ({activeRotationPlan.externalSecretNamePrev} → {activeRotationPlan.externalSecretNameNext})
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      try {
                        const txt = activeRotationPlan.commands.join('\n');
                        if (navigator.clipboard && window.isSecureContext) {
                          navigator.clipboard.writeText(txt).catch(() => {});
                        } else {
                          const ta = document.createElement('textarea');
                          ta.value = txt;
                          document.body.appendChild(ta);
                          ta.select();
                          document.execCommand('copy');
                          document.body.removeChild(ta);
                        }
                      } catch {}
                      setMessage({ type: 'success', text: 'Swarm रोटेसन कमाण्डहरू कपि गरियो!' });
                    }}
                    className="px-2 py-0.5 rounded bg-slate-800 hover:bg-slate-700 text-[10px] text-emerald-300 border border-slate-700 flex items-center gap-1"
                  >
                    <Copy className="w-3 h-3" />
                    <span>Copy CLI</span>
                  </button>
                </div>
                <p className={`text-[10px] font-nepali leading-snug ${activeRotationPlan.stateful ? 'text-amber-300 font-semibold' : 'text-slate-400'}`}>
                  {activeRotationPlan.stateful
                    ? 'यो प्रमाणीकरण datastore भित्र पहिले परिवर्तन गर्नुपर्ने हुनाले स्वचालित सेवा रोटेसन रोकिएको छ — तलका कमाण्डहरू म्यानुअल रूपमा चलाउनुहोस्।'
                    : 'तलका कमाण्डहरू कपि गरी Swarm manager मा चलाउनुहोस्; यो प्यानलले कुनै पनि secret आफैं रोटेट गर्दैन।'}
                </p>
                <pre className="text-[10px] font-mono text-emerald-300 bg-slate-950 p-2.5 rounded-lg overflow-x-auto leading-relaxed">
                  {activeRotationPlan.commands.join('\n')}
                </pre>
              </div>
            )}

            {/* Active Swarm Secrets Mount Table */}
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <span className="font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                  <Key className="w-3.5 h-3.5 text-gov-blue-800" />
                  <span>सक्रिय स्वारम गोप्य कुञ्जीहरू ({swarmSecrets.length} Secrets Mounted)</span>
                </span>
                <span className="text-[10px] text-slate-500 font-mono">
                  {swarmPosture?.secrets_mount_dir || '/run/secrets'} • Read-Only
                </span>
              </div>

              {swarmSecretsLoading && (
                <div className="bg-white rounded-lg border border-slate-200 p-3 text-[11px] text-slate-500 font-mono flex items-center gap-2">
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                  <span>Observing container secret mounts…</span>
                </div>
              )}
              {!swarmSecretsLoading && swarmSecretsError && (
                <div className="bg-gov-red-50 rounded-lg border border-gov-red-200 p-3 text-[11px] text-gov-red-800 font-nepali">
                  {swarmSecretsError}
                </div>
              )}
              {!swarmSecretsLoading && !swarmSecretsError && swarmSecrets.length === 0 && (
                <div className="bg-white rounded-lg border border-slate-200 p-3 text-[11px] text-slate-500 font-nepali">
                  यो कन्टेनरमा कुनै secret फाइल देखिएन। /run/secrets माउन्ट जाँच्नुहोस्।
                </div>
              )}

              {swarmSecrets.map((spec) => (
                <div
                  key={spec.id}
                  className="bg-white rounded-lg border border-slate-200 p-3 shadow-xs space-y-2 hover:border-gov-blue-300 transition-colors"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="font-bold text-slate-900 font-mono text-xs flex items-center gap-1.5">
                        <span>{spec.secretName}_{spec.version}</span>
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                          spec.mounted
                            ? 'bg-emerald-100 text-emerald-800'
                            : 'bg-gov-red-100 text-gov-red-800'
                        }`}>
                          {spec.mounted ? `mode ${spec.mode}` : 'not mounted'}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-600 font-nepali mt-0.5">
                        {spec.descriptionNe}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const plan = generateSwarmRotationPlan(spec);
                        setActiveRotationPlan(plan);
                        setMessage({
                          type: plan.stateful ? 'error' : 'success',
                          text: plan.stateful
                            ? `'${spec.secretName}' stateful credential हो — स्वचालित रोटेसन रोकिएको छ, योजनाका म्यानुअल चरणहरू पालना गर्नुहोस्।`
                            : `'${spec.secretName}' का लागि रोटेसन योजना (${plan.previousVersion} → ${plan.nextVersion}) तयार भयो — कमाण्डहरू म्यानुअल रूपमा चलाउनुहोस्।`,
                        });
                      }}
                      className="px-2.5 py-1 rounded-md bg-gov-blue-50 hover:bg-gov-blue-800 text-gov-blue-900 hover:text-white border border-gov-blue-300 text-[10px] font-bold transition-colors flex items-center gap-1 shrink-0"
                      title={`Show the manual rotation plan for ${spec.secretName}`}
                    >
                      <RefreshCw className="w-3 h-3" />
                      <span>Plan ({spec.version} → v{parseInt(String(spec.version).replace(/^v/i, ''), 10) + 1})</span>
                    </button>
                  </div>

                  <div className="bg-slate-50 rounded border border-slate-200/80 p-2 space-y-1 font-mono text-[10px]">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Runtime Mount:</span>
                      <code className="text-gov-blue-900 font-bold">{spec.targetPath}</code>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Env Indirection:</span>
                      <code className="text-emerald-800 font-bold">{spec.fileEnvVarName}</code>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Observed UID:GID / Mode:</span>
                      <span className={`font-semibold ${spec.mounted ? 'text-slate-700' : 'text-gov-red-700'}`}>
                        {spec.uid}:{spec.gid} ({spec.mode})
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-slate-500">Source:</span>
                      <span className="text-slate-700 truncate" title={spec.source}>{spec.source}</span>
                    </div>
                  </div>

                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <div className="flex flex-wrap items-center gap-1">
                      <span className="text-[10px] text-slate-500 font-nepali">अधिकृत सेवाहरू:</span>
                      {spec.services.map((svc) => (
                        <span
                          key={svc}
                          className="px-1.5 py-0.2 rounded bg-gov-blue-50 text-gov-blue-900 border border-gov-blue-200 font-mono text-[9px] font-bold"
                        >
                          {svc}
                        </span>
                      ))}
                    </div>
                    <span
                      className="text-[9px] text-slate-400 font-mono"
                      title="Swarm secret values are never readable through the app (zero-plaintext doctrine). Rotation is applied with the shell script."
                    >
                      Value: ******** (Hidden)
                    </span>
                  </div>
                  <div className="text-[9px] text-slate-400 font-nepali leading-snug">
                    मूल्य कहिल्यै देखाइँदैन (शून्य-सादा-पाठ सिद्धान्त) — परिवर्तन गर्न म्यानुअल रोटेसन योजना प्रयोग गर्नुहोस्। मास्टरले पनि सिधै पढ्न सक्दैन।
                  </div>
                </div>
              ))}

              {swarmPosture?.external_service_secrets?.length > 0 && (
                <div className="bg-slate-50 rounded-lg border border-slate-200 p-2.5 text-[10px] text-slate-600 font-nepali space-y-1">
                  <p className="font-bold text-slate-700">
                    अन्य सेवाका गोप्य कुञ्जीहरू (यो backend कन्टेनरबाट देखिँदैनन्):
                  </p>
                  {swarmPosture.external_service_secrets.map((ext) => (
                    <p key={ext.secret_name} className="font-mono">
                      {ext.secret_name} → {ext.services.join(', ')} • {ext.source}
                    </p>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ======================================================== */}
      {/* ============ PASSWORD CHANGE / RESET MODAL ============= */}
      {/* ======================================================== */}
      {passwordModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[99999] animate-fade-in font-sans">
          <div className="bg-white rounded-xl shadow-2xl border border-gov-blue-400 w-full max-w-sm max-h-[90dvh] overflow-hidden flex flex-col">
            <div className="bg-gov-blue-800 text-white px-3.5 py-2.5 flex items-center justify-between text-xs font-bold font-nepali shrink-0">
              <div className="flex items-center gap-1.5">
                <Key className="w-4 h-4 text-gov-gold-400" />
                <span>पासवर्ड परिवर्तन / रिसेट (Change / Reset Password)</span>
              </div>
              <button type="button" onClick={() => setPasswordModal(null)} className="text-white/80 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleChangePassword} className="p-3.5 space-y-2.5 text-xs flex-1 overflow-y-auto">
              <div className="bg-slate-50 rounded border border-slate-200 px-2.5 py-2">
                <div className="font-bold text-slate-800">{passwordModal.full_name || passwordModal.username}</div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  @{passwordModal.username} &middot; <strong className="text-gov-blue-800">{passwordModal.role}</strong>
                </div>
              </div>

              {isMasterAdmin || (isSuperAdmin && passwordModal.role !== 'MasterAdmin') ? (
                <p className="text-[10px] text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5 font-nepali">
                  {isMasterAdmin ? 'मास्टर' : 'सुपर'} प्रशासकले हालको पासवर्ड नचाहिकन सोझै नयाँ पासवर्ड सेट गर्न सक्छ।
                  ({isMasterAdmin ? 'MasterAdmin' : 'SuperAdmin'} can reset this password directly without the current one.)
                </p>
              ) : (
                <div>
                  <label className="gov-label">हालको पासवर्ड (Current Password)</label>
                  <input
                    type="password"
                    value={passwordForm.current_password}
                    onChange={(e) => setPasswordForm((f) => ({ ...f, current_password: e.target.value }))}
                    className="gov-input text-xs font-mono"
                    autoComplete="current-password"
                    required
                  />
                </div>
              )}

              <div>
                <label className="gov-label">नयाँ पासवर्ड (New Password)</label>
                <input
                  type="password"
                  value={passwordForm.new_password}
                  onChange={(e) => setPasswordForm((f) => ({ ...f, new_password: e.target.value }))}
                  className="gov-input text-xs font-mono"
                  placeholder="न्यूनतम ८ अक्षर"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>

              <div>
                <label className="gov-label">नयाँ पासवर्ड दोहोर्याउनुहोस् (Confirm New Password)</label>
                <input
                  type="password"
                  value={passwordForm.confirm_password}
                  onChange={(e) => setPasswordForm((f) => ({ ...f, confirm_password: e.target.value }))}
                  className="gov-input text-xs font-mono"
                  autoComplete="new-password"
                  minLength={8}
                  required
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button type="submit" disabled={passwordSaving} className="btn-gov-primary flex-1 text-xs py-1.5 flex items-center justify-center gap-1.5 disabled:opacity-60">
                  {passwordSaving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ShieldCheck className="w-3.5 h-3.5" />}
                  <span>पासवर्ड सुरक्षित गर्नुहोस्</span>
                </button>
                <button type="button" onClick={() => setPasswordModal(null)} className="btn-gov-secondary text-xs py-1.5">
                  रद्द गर्नुहोस्
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* ============ EDIT USER DETAILS MODAL =================== */}
      {/* ======================================================== */}
      {editUserModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[99999] animate-fade-in font-sans">
          <div className="bg-white rounded-xl shadow-2xl border border-gov-blue-400 w-full max-w-md max-h-[90dvh] overflow-hidden flex flex-col">
            <div className="bg-gov-blue-800 text-white px-3.5 py-2.5 flex items-center justify-between text-xs font-bold font-nepali shrink-0">
              <div className="flex items-center gap-1.5">
                <Edit3 className="w-4 h-4 text-gov-gold-400" />
                <span>प्रयोगकर्ता विवरण सम्पादन (Edit User Details)</span>
              </div>
              <button type="button" onClick={() => setEditUserModal(null)} className="text-white/80 hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleUpdateUser} className="p-3.5 space-y-2.5 text-xs flex-1 overflow-y-auto">
              <div className="bg-slate-50 rounded border border-slate-200 px-3 py-2 flex items-center justify-between">
                <div>
                  <div className="font-bold text-slate-800">{editUserModal.full_name || editUserModal.username}</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                    ID: {editUserModal.id} &middot; @{editUserModal.username}
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-gov-blue-50 text-gov-blue-800 border border-gov-blue-200 font-nepali">
                  {editUserModal.role}
                </span>
              </div>

              <div>
                <label className="gov-label">प्रयोगकर्ता नाम (Username)</label>
                <input
                  type="text"
                  value={editUserForm.username}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, username: e.target.value }))}
                  className="gov-input text-xs font-mono"
                  required
                />
              </div>

              <div>
                <label className="gov-label">पूरा नाम (Full Name)</label>
                <input
                  type="text"
                  value={editUserForm.full_name}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, full_name: e.target.value }))}
                  className="gov-input text-xs"
                  required
                />
              </div>

              <div>
                <label className="gov-label">इमेल ठेगाना (Email)</label>
                <input
                  type="email"
                  value={editUserForm.email}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, email: e.target.value }))}
                  className="gov-input text-xs"
                  placeholder="officer@kathmandu.gov.np"
                />
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="gov-label">पद / भूमिका (Role)</label>
                  <select
                    value={editUserForm.role}
                    onChange={(e) => setEditUserForm((f) => ({ ...f, role: e.target.value }))}
                    className="gov-input text-xs"
                    disabled={editUserModal.role === 'MasterAdmin' && !isMasterAdmin}
                  >
                    <option value="DataCollector">तथ्याङ्क संकलक (DataCollector)</option>
                    <option value="Validator">प्रमाणीकरणकर्ता (Validator)</option>
                    <option value="DepartmentAdmin">विभागीय प्रशासक (DepartmentAdmin)</option>
                    <option value="MunicipalUser">नगरपालिका कर्मचारी (MunicipalUser)</option>
                    <option value="BasicViewer">अवलोकनकर्ता (BasicViewer)</option>
                    {isMasterAdmin && (
                      <>
                        <option value="SuperAdmin">सुपर प्रशासक (SuperAdmin)</option>
                        <option value="MasterAdmin">मास्टर प्रशासक (MasterAdmin)</option>
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label className="gov-label">तोकिएको वडा (Assigned Ward)</label>
                  <select
                    value={editUserForm.assigned_ward}
                    onChange={(e) => setEditUserForm((f) => ({ ...f, assigned_ward: Number(e.target.value) }))}
                    className="gov-input text-xs"
                  >
                    <option value={0}>सबै वडा (All Wards / 0)</option>
                    {Array.from({ length: 32 }, (_, i) => i + 1).map((w) => (
                      <option key={w} value={w}>वडा नं. {w}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div>
                <label className="gov-label">विभाग / शाखा (Department / ID)</label>
                <input
                  type="text"
                  value={editUserForm.department}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, department: e.target.value }))}
                  className="gov-input text-xs"
                  placeholder="उदा. Urban Planning / GIS Division वा Department ID"
                />
              </div>

              <div>
                <label className="gov-label">खाता स्थिति (Account Status)</label>
                <select
                  value={editUserForm.is_active ? 'true' : 'false'}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, is_active: e.target.value === 'true' }))}
                  className="gov-input text-xs"
                >
                  <option value="true">सक्रिय (Active)</option>
                  <option value="false">निष्क्रिय (Disabled)</option>
                </select>
              </div>

              <div>
                <label className="gov-label">
                  नयाँ पासवर्ड (New Password) <span className="text-slate-400 font-normal">(परिवर्तन नगर्ने भए खाली छोड्नुहोस्)</span>
                </label>
                <input
                  type="password"
                  value={editUserForm.password}
                  onChange={(e) => setEditUserForm((f) => ({ ...f, password: e.target.value }))}
                  className="gov-input text-xs font-mono"
                  placeholder="नयाँ पासवर्ड (कम्तीमा ८ अक्षर) वा खाली छोड्नुहोस्"
                  minLength={8}
                />
              </div>

              <div className="flex gap-2 pt-2 border-t border-slate-100">
                <button
                  type="submit"
                  disabled={userSaving}
                  className="btn-gov-primary flex-1 text-xs py-2 flex items-center justify-center gap-1.5"
                >
                  {userSaving ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>अद्यावधिक गर्दैछ...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>अद्यावधिक गर्नुहोस् (Save Changes)</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => setEditUserModal(null)}
                  className="btn-gov-secondary text-xs py-2"
                >
                  रद्द गर्नुहोस्
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* ============ ASSET LINKAGE POPUP MODAL ================= */}
      {/* ======================================================== */}
      {assignModal && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[99999] animate-fade-in font-sans">
          <div className="bg-white rounded-xl shadow-2xl border border-gov-blue-400 w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh]">
            <div className="bg-gov-blue-800 text-white px-3.5 py-2.5 flex items-center justify-between text-xs font-bold font-nepali">
              <div className="flex items-center gap-1.5">
                <Link2 className="w-4 h-4 text-gov-gold-400" />
                <span>
                  {assignModal.type === 'layer' ? 'भेक्टर तह लिङ्क गर्नुहोस्' : 'MBTiles इमेज्री लिङ्क गर्नुहोस्'}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAssignModal(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 space-y-3 flex-1 overflow-y-auto text-xs">
              {/* Scenario A: Linking a specific Project to an Asset from Layers/Tiles Tab */}
              {assignModal.item && !assignModal.targetProjectId && (
                <div className="space-y-2">
                  <div className="bg-gov-blue-50 p-2 rounded border border-gov-blue-200 text-[11px] text-gov-blue-950 font-bold font-nepali">
                    तह: {assignModal.item.name}
                  </div>
                  <label className="gov-label font-nepali font-bold">
                    कुन परियोजनामा लिङ्क गर्ने? (Select Target Project)
                  </label>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {projects.map((p) => {
                      const isAlreadyAssigned =
                        assignModal.type === 'layer'
                          ? projectAssignments[p.id]?.layer_ids?.includes(assignModal.item.id)
                          : projectAssignments[p.id]?.tile_ids?.includes(assignModal.item.id);

                      return (
                        <div
                          key={p.id}
                          className="flex items-center justify-between p-2 rounded border border-slate-200 hover:bg-slate-50 text-[11px]"
                        >
                          <span className="font-semibold text-slate-800 font-nepali truncate">
                            {p.name}
                          </span>
                          {isAlreadyAssigned ? (
                            <span className="text-[10px] text-emerald-700 font-bold font-nepali flex items-center gap-1">
                              <Check className="w-3 h-3" /> पहिले नै लिङ्क
                            </span>
                          ) : (
                            <button
                              type="button"
                              onClick={() => {
                                if (assignModal.type === 'layer') {
                                  handleAssignLayer(p.id, assignModal.item.id);
                                } else {
                                  handleAssignTiles(p.id, assignModal.item.id);
                                }
                              }}
                              className="btn-gov-primary text-[10px] py-1 px-2 font-nepali"
                            >
                              लिङ्क गर्नुहोस्
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Scenario B: Linking an available Asset to a Project from Projects Tab */}
              {assignModal.targetProjectId && (
                <div className="space-y-2">
                  <div className="bg-gov-blue-50 p-2 rounded border border-gov-blue-200 text-[11px] text-gov-blue-950 font-bold font-nepali">
                    परियोजना: {projects.find((p) => p.id === assignModal.targetProjectId)?.name}
                  </div>
                  <label className="gov-label font-nepali font-bold">
                    उपलब्ध {assignModal.type === 'layer' ? 'सार्वजनिक तहहरू' : 'ड्रोन इमेज्रीहरू'}
                  </label>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto">
                    {(assignModal.type === 'layer' ? allLayers : allTiles)
                      .filter((item) => item.is_global)
                      .map((item) => {
                        const isAlreadyAssigned =
                          assignModal.type === 'layer'
                            ? projectAssignments[assignModal.targetProjectId]?.layer_ids?.includes(item.id)
                            : projectAssignments[assignModal.targetProjectId]?.tile_ids?.includes(item.id);

                        return (
                          <div
                            key={item.id}
                            className="flex items-center justify-between p-2 rounded border border-slate-200 hover:bg-slate-50 text-[11px]"
                          >
                            <span className="font-semibold text-slate-800 font-nepali truncate">
                              {item.name}
                            </span>
                            {isAlreadyAssigned ? (
                              <span className="text-[10px] text-emerald-700 font-bold font-nepali flex items-center gap-1">
                                <Check className="w-3 h-3" /> लिङ्क गरिएको
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={() => {
                                  if (assignModal.type === 'layer') {
                                    handleAssignLayer(assignModal.targetProjectId, item.id);
                                  } else {
                                    handleAssignTiles(assignModal.targetProjectId, item.id);
                                  }
                                }}
                                className="btn-gov-primary text-[10px] py-1 px-2 font-nepali"
                              >
                                लिङ्क गर्नुहोस्
                              </button>
                            )}
                          </div>
                        );
                      })}
                  </div>
                </div>
              )}
            </div>

            <div className="bg-slate-50 px-3.5 py-2 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setAssignModal(null)}
                className="btn-gov-secondary text-xs py-1 px-3"
              >
                बन्द गर्नुहोस्
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* ============ VECTOR LAYER DOWNLOAD MODAL =============== */}
      {/* ======================================================== */}
      {layerDownloadModal && layerDownloadModal.layer && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 z-[99999] animate-fade-in font-sans">
          <div className="bg-white rounded-xl shadow-2xl border border-gov-blue-400 w-full max-w-sm overflow-hidden flex flex-col max-h-[85vh] animate-slide-up">
            <div className="bg-gov-blue-800 text-white px-3.5 py-2.5 flex items-center justify-between text-xs font-bold font-nepali">
              <div className="flex items-center gap-1.5">
                <Download className="w-4 h-4 text-gov-gold-400" />
                <span>तह डाउनलोड गर्नुहोस् (Download Layer)</span>
              </div>
              <button
                type="button"
                onClick={() => setLayerDownloadModal(null)}
                className="text-white/80 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-3.5 space-y-3 flex-1 overflow-y-auto text-xs">
              <div className="bg-gov-blue-50 p-2.5 rounded-lg border border-gov-blue-200">
                <div className="text-xs font-bold text-gov-blue-950 font-nepali">
                  {layerDownloadModal.layer.name}
                </div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  प्रकार: {layerDownloadModal.layer.geometry_type} &middot; वस्तु संख्या: {layerDownloadModal.layer.feature_count ?? '-'}
                </div>
              </div>

              <div className="space-y-1">
                <label className="gov-label font-nepali font-bold">
                  डाउनलोड ढाँचा चयन गर्नुहोस् (Choose Export Format):
                </label>

                <div className="space-y-2 pt-1">
                  {/* GeoJSON */}
                  <button
                    type="button"
                    disabled={downloadingLayerId !== null}
                    onClick={() => handleDownloadLayer(layerDownloadModal.layer, 'geojson')}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg border border-slate-200 hover:border-gov-blue-800 hover:bg-gov-blue-50/50 transition-all text-left group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 flex items-center justify-center font-bold text-[10px] shrink-0">
                        JSON
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 font-nepali text-xs group-hover:text-gov-blue-900">
                          GeoJSON (.geojson)
                        </div>
                        <div className="text-[10px] text-slate-500">
                          मानक GIS तथा वेब नक्साङ्कन ढाँचा (RFC 7946)
                        </div>
                      </div>
                    </div>
                    {downloadingLayerId === layerDownloadModal.layer.id && downloadingLayerFormat === 'geojson' ? (
                      <Loader2 className="w-4 h-4 text-gov-blue-800 animate-spin shrink-0" />
                    ) : (
                      <Download className="w-4 h-4 text-slate-400 group-hover:text-gov-blue-800 shrink-0" />
                    )}
                  </button>

                  {/* ESRI Shapefile */}
                  <button
                    type="button"
                    disabled={downloadingLayerId !== null}
                    onClick={() => handleDownloadLayer(layerDownloadModal.layer, 'shapefile')}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg border border-slate-200 hover:border-gov-blue-800 hover:bg-gov-blue-50/50 transition-all text-left group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-amber-50 border border-amber-200 text-amber-900 flex items-center justify-center font-bold text-[10px] shrink-0">
                        SHP
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 font-nepali text-xs group-hover:text-gov-blue-900">
                          ESRI Shapefile (.zip)
                        </div>
                        <div className="text-[10px] text-slate-500">
                          ArcGIS, QGIS, तथा डेस्कटप GIS बन्डल (.shp, .dbf, .prj)
                        </div>
                      </div>
                    </div>
                    {downloadingLayerId === layerDownloadModal.layer.id && downloadingLayerFormat === 'shapefile' ? (
                      <Loader2 className="w-4 h-4 text-gov-blue-800 animate-spin shrink-0" />
                    ) : (
                      <Download className="w-4 h-4 text-slate-400 group-hover:text-gov-blue-800 shrink-0" />
                    )}
                  </button>

                  {/* KML */}
                  <button
                    type="button"
                    disabled={downloadingLayerId !== null}
                    onClick={() => handleDownloadLayer(layerDownloadModal.layer, 'kml')}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg border border-slate-200 hover:border-gov-blue-800 hover:bg-gov-blue-50/50 transition-all text-left group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-blue-50 border border-blue-200 text-blue-800 flex items-center justify-center font-bold text-[10px] shrink-0">
                        KML
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 font-nepali text-xs group-hover:text-gov-blue-900">
                          KML (.kml)
                        </div>
                        <div className="text-[10px] text-slate-500">
                          Google Earth तथा थ्री-डी नक्सा ढाँचा
                        </div>
                      </div>
                    </div>
                    {downloadingLayerId === layerDownloadModal.layer.id && downloadingLayerFormat === 'kml' ? (
                      <Loader2 className="w-4 h-4 text-gov-blue-800 animate-spin shrink-0" />
                    ) : (
                      <Download className="w-4 h-4 text-slate-400 group-hover:text-gov-blue-800 shrink-0" />
                    )}
                  </button>

                  {/* CSV */}
                  <button
                    type="button"
                    disabled={downloadingLayerId !== null}
                    onClick={() => handleDownloadLayer(layerDownloadModal.layer, 'csv')}
                    className="w-full flex items-center justify-between p-2.5 rounded-lg border border-slate-200 hover:border-gov-blue-800 hover:bg-gov-blue-50/50 transition-all text-left group"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-lg bg-purple-50 border border-purple-200 text-purple-800 flex items-center justify-center font-bold text-[10px] shrink-0">
                        CSV
                      </div>
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 font-nepali text-xs group-hover:text-gov-blue-900">
                          CSV स्प्रेडसिट (.csv)
                        </div>
                        <div className="text-[10px] text-slate-500">
                          Microsoft Excel तथा WKT ज्यामिति सहित
                        </div>
                      </div>
                    </div>
                    {downloadingLayerId === layerDownloadModal.layer.id && downloadingLayerFormat === 'csv' ? (
                      <Loader2 className="w-4 h-4 text-gov-blue-800 animate-spin shrink-0" />
                    ) : (
                      <Download className="w-4 h-4 text-slate-400 group-hover:text-gov-blue-800 shrink-0" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="bg-slate-50 px-3.5 py-2 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setLayerDownloadModal(null)}
                className="btn-gov-secondary text-xs py-1 px-3"
              >
                रद्द
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Field Configuration, Unique ID & Permitted Creation Geometries Modal */}
      {fieldConfigModal && (() => {
        const currentTab = fieldConfigModal.activeTab || 'DEFAULT';
        const isDefault = currentTab === 'DEFAULT';
        const activeFields = isDefault
          ? (fieldConfigModal.fields || [])
          : (fieldConfigModal.geometry_fields_config?.[currentTab] || []);

        const updateFieldsList = (updater) => {
          setFieldConfigModal((prev) => {
            const tab = prev.activeTab || 'DEFAULT';
            const def = tab === 'DEFAULT';
            const list = def ? (prev.fields || []) : (prev.geometry_fields_config?.[tab] || []);
            const updated = typeof updater === 'function' ? updater(list) : updater;
            if (def) {
              return { ...prev, fields: updated };
            } else {
              return {
                ...prev,
                geometry_fields_config: {
                  ...(prev.geometry_fields_config || {}),
                  [tab]: updated,
                },
              };
            }
          });
        };

        const moveField = (idx, dir) => {
          updateFieldsList((list) => {
            const target = idx + dir;
            if (target < 0 || target >= list.length) return list;
            const next = [...list];
            const temp = next[idx];
            next[idx] = next[target];
            next[target] = temp;
            return next;
          });
        };

        const setUniqueField = (idx) => {
          updateFieldsList((list) => {
            return list.map((f, i) => {
              if (i === idx) {
                const willBeUnique = !f.is_unique;
                return {
                  ...f,
                  is_unique: willBeUnique,
                  id_mode: willBeUnique ? (f.id_mode || 'auto') : 'manual',
                  id_prefix: f.id_prefix || 'ID-',
                  id_sequence: f.id_sequence !== undefined ? f.id_sequence : 1,
                };
              } else {
                return { ...f, is_unique: false };
              }
            });
          });
        };

        const uniqueField = activeFields.find((f) => f.is_unique);
        const requiredCount = activeFields.filter((f) => f.required).length;

        return (
          <div className="fixed inset-0 z-[99999] bg-black/60 flex items-center justify-center p-2 sm:p-4 animate-fade-in font-sans">
            <div className="bg-white rounded-xl shadow-2xl border border-slate-300 w-full max-w-4xl max-h-[94dvh] flex flex-col overflow-hidden animate-scale-up">
              {/* Modal Header */}
              <div className="bg-gov-blue-900 text-white px-4 py-3 flex items-center justify-between shrink-0 shadow-sm">
                <div className="flex items-center gap-2">
                  <Sliders className="w-4 h-4 text-gov-blue-200" />
                  <div>
                    <h3 className="text-sm font-bold font-nepali">
                      तहका विशेषता, अद्वितीय ID तथा नयाँ फिचर सिर्जना नियमहरू (GIS Admin Rules)
                    </h3>
                    <p className="text-[11px] text-gov-blue-200 font-nepali">
                      लक्षित तह: <span className="text-white font-bold">{fieldConfigModal.layer.name}</span> ({fieldConfigModal.layer.geometry_type})
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setFieldConfigModal(null)}
                  className="text-white/80 hover:text-white p-1 rounded hover:bg-gov-blue-800 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              {/* Instructions and Controls */}
              <div className="p-3 bg-slate-50 border-b border-slate-200 space-y-2 shrink-0">
                {/* Permitted Creation Geometry Types */}
                <div className="bg-white p-2.5 rounded-lg border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2 shadow-xs">
                  <div>
                    <div className="text-xs font-bold text-slate-800 font-nepali flex items-center gap-1.5">
                      <Sparkles className="w-3.5 h-3.5 text-gov-blue-800" />
                      <span>नयाँ फिचर सिर्जनाका लागि स्वीकृत ज्यामितिहरू (Permitted Geometries):</span>
                    </div>
                    <div className="text-[10px] text-slate-500 font-nepali">
                      तहको पूर्वनिर्धारित ज्यामिति: <strong>{fieldConfigModal.layer.geometry_type}</strong>
                    </div>
                  </div>
                  <div className="flex items-center gap-3 text-xs font-nepali">
                    {['Point', 'LineString', 'Polygon'].map((geom) => {
                      const isPermitted = (fieldConfigModal.creation_geometry_types || []).includes(geom);
                      return (
                        <label key={geom} className="flex items-center gap-1.5 cursor-pointer font-semibold text-slate-700 hover:text-gov-blue-800">
                          <input
                            type="checkbox"
                            checked={isPermitted}
                            onChange={(e) => {
                              const curr = [...(fieldConfigModal.creation_geometry_types || [])];
                              let next;
                              if (e.target.checked) {
                                next = [...new Set([...curr, geom])];
                              } else {
                                next = curr.filter((g) => g !== geom);
                                if (next.length === 0) next = [fieldConfigModal.layer.geometry_type || 'Point'];
                              }
                              setFieldConfigModal((prev) => ({
                                ...prev,
                                creation_geometry_types: next,
                              }));
                            }}
                            className="rounded border-slate-300 text-gov-blue-800 focus:ring-gov-blue-800"
                          />
                          <span>{geom === 'Point' ? 'बिन्दु (Point)' : geom === 'LineString' ? 'रेखा (Line)' : 'बहुभुज (Polygon)'}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>

                {/* Schema Switcher Tabs */}
                <div className="flex items-center gap-1 border-b border-slate-200 overflow-x-auto pt-1">
                  <button
                    type="button"
                    onClick={() => setFieldConfigModal((prev) => ({ ...prev, activeTab: 'DEFAULT' }))}
                    className={`px-3 py-1.5 text-xs font-bold font-nepali rounded-t-lg border-b-2 transition-all shrink-0 ${
                      isDefault
                        ? 'border-gov-blue-800 text-gov-blue-900 bg-white shadow-xs'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    मूल तह फिल्डहरू (Default Schema) ({fieldConfigModal.fields.length})
                  </button>

                  {(fieldConfigModal.creation_geometry_types || []).map((geom) => {
                    const isTabActive = currentTab === geom;
                    const geomFields = fieldConfigModal.geometry_fields_config?.[geom];
                    return (
                      <button
                        key={geom}
                        type="button"
                        onClick={() => {
                          setFieldConfigModal((prev) => {
                            const cfg = prev.geometry_fields_config || {};
                            if (!cfg[geom] || cfg[geom].length === 0) {
                              cfg[geom] = (prev.fields || []).map((f) => ({ ...f }));
                            }
                            return {
                              ...prev,
                              activeTab: geom,
                              geometry_fields_config: { ...cfg },
                            };
                          });
                        }}
                        className={`px-3 py-1.5 text-xs font-bold font-nepali rounded-t-lg border-b-2 transition-all shrink-0 ${
                          isTabActive
                            ? 'border-gov-blue-800 text-gov-blue-900 bg-white shadow-xs'
                            : 'border-transparent text-slate-500 hover:text-slate-800'
                        }`}
                      >
                        {geom} सिर्जना फिल्डहरू
                        {geomFields && geomFields.length > 0 ? ` (${geomFields.length})` : ' (मूलबाट)'}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Modal Body & Fields Table */}
              <div className="p-3 sm:p-4 flex-1 overflow-y-auto space-y-3 scrollbar-thin">
                {/* Secondary toolbar */}
                <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-slate-200">
                  <div className="text-xs font-bold text-slate-700 font-nepali flex items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-gov-blue-800" />
                    <span>
                      {isDefault ? 'मुख्य तहका फिल्डहरू' : `${currentTab} ज्यामितिका फिल्डहरू`} ({activeFields.length}):
                    </span>
                    {requiredCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-rose-100 text-rose-800 font-bold border border-rose-300">
                        {requiredCount} अनिवार्य
                      </span>
                    )}
                    {uniqueField && (
                      <span className="text-[10px] px-1.5 py-0.2 rounded bg-amber-100 text-amber-900 font-bold border border-amber-300 flex items-center gap-1 font-mono">
                        <Key className="w-2.5 h-2.5 text-amber-700" />
                        <span>ID: {uniqueField.name} ({uniqueField.id_mode === 'auto' ? 'Auto' : 'Manual'})</span>
                      </span>
                    )}
                  </div>

                  <div className="flex items-center gap-2">
                    {!isDefault && (
                      <button
                        type="button"
                        onClick={() => {
                          updateFieldsList(() => (fieldConfigModal.fields || []).map((f) => ({ ...f })));
                        }}
                        className="btn-gov-secondary py-1 px-2.5 text-xs flex items-center gap-1 font-nepali"
                        title="मूल तहका फिल्डहरू प्रतिलिपि गर्नुहोस्"
                      >
                        <Copy className="w-3 h-3 text-slate-600" />
                        <span>मूलबाट प्रतिलिपि</span>
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => {
                        updateFieldsList((list) => list.map((f) => ({ ...f, visible_in_popup: true })));
                      }}
                      className="btn-gov-secondary py-1 px-2 text-xs flex items-center gap-1 font-nepali"
                      title="सबै फिल्डहरू पपअपमा देखाउनुहोस्"
                    >
                      <Eye className="w-3 h-3 text-emerald-600" />
                      <span>सबै देखाउने</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        updateFieldsList((list) => list.map((f) => ({ ...f, visible_in_popup: false })));
                      }}
                      className="btn-gov-secondary py-1 px-2 text-xs flex items-center gap-1 font-nepali"
                      title="सबै फिल्डहरू पपअपमा लुकाउनुहोस्"
                    >
                      <EyeOff className="w-3 h-3 text-slate-500" />
                      <span>सबै लुकाउने</span>
                    </button>
                    <button
                      type="button"
                      disabled={fieldConfigModal.loading}
                      onClick={handleAutoDetectFields}
                      className="btn-gov-secondary py-1 px-2.5 text-xs flex items-center gap-1 font-nepali"
                      title="तहमा रहेका मौजुदा फिचरहरूबाट फिल्ड नामहरू पहिचान गर्नुहोस्"
                    >
                      {fieldConfigModal.loading ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5 text-gov-blue-800" />
                      )}
                      <span>स्वतः पहिचान (Auto-Detect)</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        updateFieldsList((prevList) => [
                          ...prevList,
                          {
                            name: `field_${prevList.length + 1}`,
                            label: `नयाँ फिल्ड ${prevList.length + 1}`,
                            type: 'text',
                            required: false,
                            is_unique: false,
                            id_mode: 'manual',
                            id_prefix: '',
                            id_sequence: 1,
                            visible_in_popup: true,
                          },
                        ]);
                      }}
                      className="btn-gov-primary py-1 px-2.5 text-xs flex items-center gap-1 font-nepali shadow-xs"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>नयाँ फिल्ड थप्नुहोस्</span>
                    </button>
                  </div>
                </div>

                {/* Loading State */}
                {fieldConfigModal.loading && (
                  <div className="p-8 text-center text-slate-500 flex flex-col items-center justify-center gap-2 font-nepali">
                    <Loader2 className="w-6 h-6 animate-spin text-gov-blue-800" />
                    <span>तहका विशेषताहरू लोड हुँदैछन्...</span>
                  </div>
                )}

                {/* Empty Fields State */}
                {!fieldConfigModal.loading && activeFields.length === 0 && (
                  <div className="p-8 text-center bg-slate-50 rounded-xl border border-dashed border-slate-300 space-y-2">
                    <Database className="w-8 h-8 text-slate-400 mx-auto" />
                    <p className="text-xs font-bold text-slate-700 font-nepali">
                      यस स्किमामा हालसम्म कुनै विशेषता फिल्डहरू छैनन्।
                    </p>
                    <p className="text-[11px] text-slate-500 font-nepali">
                      'नयाँ फिल्ड थप्नुहोस्' वा 'स्वतः पहिचान' प्रयोग गरी फिल्डहरू सिर्जना गर्नुहोस्।
                    </p>
                  </div>
                )}

                {/* DepartmentAdmin Access Guard Banner */}
                {(() => {
                  const userDept = currentUser?.department || currentUser?.department_name;
                  const layerDept = fieldConfigModal?.layer?.department || fieldConfigModal?.layer?.department_name;
                  const isAssociated = isMasterAdmin || isSuperAdmin || (
                    userDept && layerDept && String(userDept).trim().toLowerCase() === String(layerDept).trim().toLowerCase()
                  ) || (
                    fieldConfigModal?.layer?.project_id && (currentUser?.projects || []).includes(fieldConfigModal?.layer?.project_id)
                  );
                  if (isDepartmentAdmin && !isAssociated) {
                    return (
                      <div className="mb-3 p-3 bg-rose-50 border border-rose-300 rounded-lg text-rose-900 text-xs font-nepali flex items-center gap-2">
                        <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                        <span>⚠️ यो तह तपाईंको विभागसँग सम्बन्धित छैन। विभागीय प्रशासकले आफ्नो विभागसँग सम्बन्धित तह मात्र सम्पादन गर्न सक्नुहुन्छ। (Only layers associated with your department can be edited.)</span>
                      </div>
                    );
                  }
                  return null;
                })()}

                {/* Unique Field & ID Generation Controls Banner */}
                {uniqueField && (
                  <div className="mb-3 p-3 bg-amber-50/90 border border-amber-300 rounded-lg flex flex-wrap items-center justify-between gap-3 font-nepali shadow-xs">
                    <div className="flex items-center gap-2">
                      <Key className="w-4 h-4 text-amber-700 shrink-0" />
                      <div>
                        <span className="text-xs font-bold text-amber-950">
                          अद्वितीय पहिचानकर्ता फिल्ड (Unique Key):{' '}
                          <span className="font-mono text-gov-blue-900 bg-amber-100 px-1.5 py-0.5 rounded border border-amber-300 font-bold">{uniqueField.name}</span>
                        </span>
                        <p className="text-[10px] text-amber-800">
                          नयाँ फिचर सिर्जना गर्दा यो फिल्डको मान दोहोरिन दिइने छैन (Enforces unique constraint).
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <div className="flex items-center gap-2 bg-white px-2.5 py-1 rounded-md border border-amber-200">
                        <span className="font-semibold text-slate-700">उत्पादन मोड:</span>
                        <label className="inline-flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            name="unique_id_mode"
                            checked={uniqueField.id_mode === 'auto'}
                            onChange={() => {
                              updateFieldsList((list) => list.map((f) => f.is_unique ? { ...f, id_mode: 'auto' } : f));
                            }}
                          />
                          <span className="text-emerald-800 font-bold">स्वतः कोड (Auto)</span>
                        </label>
                        <label className="inline-flex items-center gap-1 cursor-pointer">
                          <input
                            type="radio"
                            name="unique_id_mode"
                            checked={uniqueField.id_mode === 'manual'}
                            onChange={() => {
                              updateFieldsList((list) => list.map((f) => f.is_unique ? { ...f, id_mode: 'manual' } : f));
                            }}
                          />
                          <span className="text-slate-800 font-bold">म्यानुअल (Manual)</span>
                        </label>
                      </div>
                      {uniqueField.id_mode === 'auto' && (
                        <div className="flex items-center gap-1.5 bg-white px-2 py-1 rounded-md border border-amber-200">
                          <span className="font-semibold text-slate-700">प्रिफिक्स (Prefix):</span>
                          <input
                            type="text"
                            value={uniqueField.id_prefix || ''}
                            onChange={(e) => {
                              const val = e.target.value;
                              updateFieldsList((list) => list.map((f) => f.is_unique ? { ...f, id_prefix: val } : f));
                            }}
                            placeholder="e.g. KMC-RD-"
                            className="w-28 px-2 py-0.5 text-xs font-mono font-bold border border-amber-300 rounded bg-amber-50/50 focus:bg-white focus:ring-1 focus:ring-amber-500"
                          />
                        </div>
                      )}
                    </div>
                  </div>
                )}

                {/* Fields Table */}
                {!fieldConfigModal.loading && activeFields.length > 0 && (
                  <div className="border border-slate-200 rounded-lg overflow-x-auto shadow-xs">
                    <div className="min-w-[760px]">
                      <div className="bg-slate-100 px-3 py-2 grid grid-cols-12 gap-2 text-[11px] font-bold text-slate-700 font-nepali border-b border-slate-200 items-center">
                        <div className="col-span-1 text-center">क्रम (Order)</div>
                        <div className="col-span-2">फिल्ड नाम (Key)</div>
                        <div className="col-span-2">नेपाली लेबल (Display)</div>
                        <div className="col-span-1">प्रकार (Type)</div>
                        <div className="col-span-1 text-center">अनिवार्य</div>
                        <div className="col-span-2 text-center">दर्शक पहुँच (Access)</div>
                        <div className="col-span-1 text-center">अद्वितीय ID</div>
                        <div className="col-span-2 text-center">पपअप / मेटाउने</div>
                      </div>

                      <div className="divide-y divide-slate-200 max-h-[52vh] overflow-y-auto">
                        {activeFields.map((f, idx) => (
                          <div key={idx} className={`px-3 py-2.5 grid grid-cols-12 gap-2 items-center transition-colors text-xs ${
                            f.is_unique ? 'bg-amber-50/50 hover:bg-amber-50' : 'hover:bg-slate-50'
                          }`}>
                            {/* 1. Order Controls */}
                            <div className="col-span-1 flex items-center justify-center gap-1">
                              <span className="font-mono text-[10px] text-slate-400 font-bold w-4 text-center">
                                #{idx + 1}
                              </span>
                              <div className="flex flex-col gap-0.5">
                                <button
                                  type="button"
                                  disabled={idx === 0}
                                  onClick={() => moveField(idx, -1)}
                                  className="p-0.5 rounded hover:bg-slate-200 text-slate-600 disabled:opacity-20 disabled:hover:bg-transparent"
                                  title="माथि सार्नुहोस् (Move Up)"
                                >
                                  <ArrowUp className="w-3 h-3" />
                                </button>
                                <button
                                  type="button"
                                  disabled={idx === activeFields.length - 1}
                                  onClick={() => moveField(idx, 1)}
                                  className="p-0.5 rounded hover:bg-slate-200 text-slate-600 disabled:opacity-20 disabled:hover:bg-transparent"
                                  title="तल सार्नुहोस् (Move Down)"
                                >
                                  <ArrowDown className="w-3 h-3" />
                                </button>
                              </div>
                            </div>

                            {/* 2. Field Key */}
                            <div className="col-span-2">
                              <input
                                type="text"
                                value={f.name}
                                onChange={(e) => {
                                  const newName = e.target.value.replace(/\s+/g, '_').toLowerCase();
                                  updateFieldsList((list) => {
                                    const next = [...list];
                                    next[idx] = { ...next[idx], name: newName };
                                    return next;
                                  });
                                }}
                                placeholder="ward_no"
                                className="gov-input py-1 px-2 text-xs font-mono"
                              />
                            </div>

                            {/* 3. Display Label */}
                            <div className="col-span-2">
                              <input
                                type="text"
                                value={f.label || ''}
                                onChange={(e) => {
                                  const newLabel = e.target.value;
                                  updateFieldsList((list) => {
                                    const next = [...list];
                                    next[idx] = { ...next[idx], label: newLabel };
                                    return next;
                                  });
                                }}
                                placeholder="वडा नं."
                                className="gov-input py-1 px-2 text-xs font-nepali"
                              />
                            </div>

                            {/* 4. Field Type */}
                            <div className="col-span-1">
                              <select
                                value={f.type || 'text'}
                                onChange={(e) => {
                                  const newType = e.target.value;
                                  updateFieldsList((list) => {
                                    const next = [...list];
                                    next[idx] = { ...next[idx], type: newType };
                                    return next;
                                  });
                                }}
                                className="gov-input py-1 px-1 text-[10px] cursor-pointer"
                              >
                                <option value="text">Text</option>
                                <option value="number">Number</option>
                                <option value="date">Date</option>
                                <option value="select">Select</option>
                                <option value="textarea">Textarea</option>
                                <option value="checkbox">Checkbox</option>
                                <option value="file">Photo</option>
                              </select>
                            </div>

                            {/* 5. Required Toggle */}
                            <div className="col-span-1 flex justify-center">
                              <button
                                type="button"
                                onClick={() => {
                                  updateFieldsList((list) => {
                                    const next = [...list];
                                    next[idx] = { ...next[idx], required: !next[idx].required };
                                    return next;
                                  });
                                }}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-nepali border transition-all ${
                                  f.required
                                    ? 'bg-rose-100 text-rose-900 border-rose-300 shadow-xs'
                                    : 'bg-slate-100 text-slate-400 border-slate-200 hover:bg-slate-200/70'
                                }`}
                                title={f.required ? 'अनिवार्य फिल्ड (Click to make optional)' : 'ऐच्छिक फिल्ड (Click to make required)'}
                              >
                                {f.required ? 'अनिवार्य' : 'ऐच्छिक'}
                              </button>
                            </div>

                            {/* 6. Viewer Access Control (Admin / Validator / Public) */}
                            <div className="col-span-2">
                              <select
                                value={f.access_level || 'public'}
                                onChange={(e) => {
                                  const newLvl = e.target.value;
                                  updateFieldsList((list) => {
                                    const next = [...list];
                                    next[idx] = { ...next[idx], access_level: newLvl };
                                    return next;
                                  });
                                }}
                                className={`gov-input py-1 px-1 text-[10px] font-nepali font-bold cursor-pointer rounded border transition-all ${
                                  f.access_level === 'admin'
                                    ? 'bg-rose-50 text-rose-900 border-rose-300'
                                    : f.access_level === 'hide_public'
                                    ? 'bg-sky-50 text-sky-900 border-sky-300'
                                    : f.access_level === 'validator'
                                    ? 'bg-amber-50 text-amber-900 border-amber-300'
                                    : 'bg-emerald-50 text-emerald-900 border-emerald-300'
                                }`}
                                title="दर्शक पहुँच: सार्वजनिक, सार्वजनिकबाट मात्र लुकाउने (कर्मचारी+), प्रमाणक+, वा प्रशासक मात्र"
                              >
                                <option value="public">सबै (Public)</option>
                                <option value="hide_public">सार्वजनिकबाट मात्र लुकाउनुहोस् (Hide Public Only)</option>
                                <option value="validator">प्रमाणक+ (Validator)</option>
                                <option value="admin">प्रशासक मात्र (Admin)</option>
                              </select>
                            </div>

                            {/* 7. Unique Field & ID Generation Controls */}
                            <div className="col-span-1 flex flex-col items-center gap-0.5">
                              <button
                                type="button"
                                onClick={() => setUniqueField(idx)}
                                className={`px-1.5 py-0.5 rounded text-[10px] font-bold font-nepali flex items-center gap-0.5 border transition-all ${
                                  f.is_unique
                                    ? 'bg-amber-100 text-amber-900 border-amber-400 shadow-xs ring-1 ring-amber-300'
                                    : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100'
                                }`}
                                title="अद्वितीय ID (Unique Identifier)"
                              >
                                <Key className="w-2.5 h-2.5" />
                                <span>{f.is_unique ? 'ID' : 'साधारण'}</span>
                              </button>

                              {f.is_unique && (
                                <span className="text-[8.5px] font-mono text-amber-800">
                                  {f.id_mode === 'auto' ? 'Auto' : 'Manual'}
                                </span>
                              )}
                            </div>

                            {/* 8. Read-only Popup Visibility & Delete */}
                            <div className="col-span-2 flex items-center justify-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => {
                                  updateFieldsList((list) => {
                                    const next = [...list];
                                    next[idx] = {
                                      ...next[idx],
                                      visible_in_popup: next[idx].visible_in_popup === false ? true : false,
                                    };
                                    return next;
                                  });
                                }}
                                className={`px-2 py-0.5 rounded text-[10px] font-bold font-nepali flex items-center gap-1 border transition-all ${
                                  f.visible_in_popup !== false
                                    ? 'bg-emerald-50 text-emerald-800 border-emerald-300 hover:bg-emerald-100 shadow-2xs'
                                    : 'bg-slate-100 text-slate-400 border-slate-200 hover:bg-slate-200'
                                }`}
                                title={f.visible_in_popup !== false ? 'फिचर क्लिक गर्दा यो फिल्ड पपअपमा देखिन्छ' : 'फिचर क्लिक गर्दा यो फिल्ड पपअपमा लुकाइनेछ'}
                              >
                                {f.visible_in_popup !== false ? (
                                  <>
                                    <Eye className="w-3 h-3 text-emerald-600" />
                                    <span>देखिने</span>
                                  </>
                                ) : (
                                  <>
                                    <EyeOff className="w-3 h-3 text-slate-400" />
                                    <span>लुकेको</span>
                                  </>
                                )}
                              </button>

                              <button
                                type="button"
                                onClick={() => {
                                  updateFieldsList((list) => list.filter((_, i) => i !== idx));
                                }}
                                className="p-1 text-slate-400 hover:text-gov-red-700 hover:bg-red-50 rounded transition-colors"
                                title="फिल्ड हटाउनुहोस्"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Modal Footer */}
              <div className="bg-slate-50 px-4 py-3 border-t border-slate-200 flex items-center justify-between shrink-0">
                <div className="text-[11px] text-slate-600 font-nepali flex items-center gap-2">
                  <span>
                    कुल <strong>{activeFields.length}</strong> फिल्डहरूमध्ये{' '}
                    <span className="font-bold text-rose-700">{requiredCount} अनिवार्य</span>
                  </span>
                  {uniqueField && (
                    <span className="text-amber-800 font-medium">
                      &middot; अद्वितीय ID: <strong className="font-mono">{uniqueField.name}</strong>
                    </span>
                  )}
                </div>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => setFieldConfigModal(null)}
                    className="btn-gov-secondary text-xs py-1.5 px-3.5 font-nepali"
                  >
                    रद्द (Cancel)
                  </button>
                  {(() => {
                    const userDept = currentUser?.department || currentUser?.department_name;
                    const layerDept = fieldConfigModal?.layer?.department || fieldConfigModal?.layer?.department_name;
                    const isAssociated = isMasterAdmin || isSuperAdmin || (
                      userDept && layerDept && String(userDept).trim().toLowerCase() === String(layerDept).trim().toLowerCase()
                    ) || (
                      fieldConfigModal?.layer?.project_id && (currentUser?.projects || []).includes(fieldConfigModal?.layer?.project_id)
                    );
                    const canSave = !isDepartmentAdmin || isAssociated;
                    return (
                      <button
                        type="button"
                        disabled={fieldConfigModal.saving || fieldConfigModal.loading || !canSave}
                        onClick={handleSaveFieldConfig}
                        className={`btn-gov-primary text-xs py-1.5 px-4 font-nepali flex items-center gap-1.5 shadow-sm ${
                          !canSave ? 'opacity-50 cursor-not-allowed' : ''
                        }`}
                      >
                        {fieldConfigModal.saving ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <Check className="w-3.5 h-3.5" />
                        )}
                        <span>{fieldConfigModal.saving ? 'सुरक्षित गरिँदैछ...' : 'कन्फिगरेसन सुरक्षित गर्नुहोस् (Save)'}</span>
                      </button>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ======================================================== */}
      {/* ============ LINK QUESTIONNAIRE TO LAYER MODAL ========= */}
      {/* ======================================================== */}
      {linkQModalLayer && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 z-[99999] bg-black/60 flex items-center justify-center p-4 animate-fade-in font-sans">
          <div className="bg-white rounded-xl shadow-2xl border border-slate-300 w-full max-w-md max-h-[90vh] overflow-hidden animate-scale-up flex flex-col">
            <div className="bg-gov-blue-900 text-white px-4 py-3 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-gov-gold-400" />
                <h3 className="text-sm font-bold font-nepali">तहमा प्रश्नावली जोड्नुहोस् (Link Questionnaire)</h3>
              </div>
              <button
                type="button"
                onClick={() => setLinkQModalLayer(null)}
                className="text-white/80 hover:text-white p-1 rounded hover:bg-gov-blue-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="p-4 space-y-3 font-nepali text-xs overflow-y-auto flex-1">
              <p className="text-slate-700">
                लक्षित भेक्टर तह: <strong className="text-gov-blue-900 font-bold">{linkQModalLayer.name}</strong>
              </p>
              <p className="text-[11px] text-slate-500 leading-relaxed">
                प्रश्नावली जोडेपछि फिल्ड संकलकहरूले नक्सामा नयाँ फिचर सिर्जना गर्दा प्रश्नावलीका प्रश्नहरू स्वचालित रूपमा फिल्ड (attributes) को रूपमा भरिनेछन्।
              </p>

              {linkQLoading ? (
                <div className="py-6 text-center text-slate-500 flex items-center justify-center gap-2 font-nepali">
                  <Loader2 className="w-4 h-4 animate-spin text-gov-blue-800" />
                  <span>प्रश्नावलीहरू खोजिँदै...</span>
                </div>
              ) : linkQModalList.length === 0 ? (
                <div className="p-3 bg-amber-50 rounded-lg border border-amber-200 text-amber-900 text-center space-y-1">
                  <p className="font-bold">यस परियोजनामा कुनै प्रश्नावली भेटिएन।</p>
                  <p className="text-[11px] text-amber-700">
                    कृपया पहिले 'प्रश्नावली प्रणाली' ट्याबबाट नयाँ प्रश्नावली सिर्जना गर्नुहोस्।
                  </p>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <label className="gov-label text-xs">प्रश्नावली छान्नुहोस्:</label>
                  <select
                    value={linkQModalSelected}
                    onChange={(e) => setLinkQModalSelected(e.target.value)}
                    className="gov-input text-xs font-nepali"
                  >
                    {linkQModalList.map((q) => (
                      <option key={q.id} value={q.id}>
                        #{q.id} - {q.title || 'शीर्षकविहीन प्रश्नावली'} {q.is_active ? ' (सक्रिय / Active)' : ' (मस्यौदा)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setLinkQModalLayer(null)}
                  className="btn-gov-secondary text-xs py-1.5 px-3"
                >
                  रद्द (Cancel)
                </button>
                <button
                  type="button"
                  disabled={linkQLoading || !linkQModalSelected || linkQModalList.length === 0}
                  onClick={handleConfirmLinkLayerQuestionnaire}
                  className="btn-gov-primary text-xs py-1.5 px-3 flex items-center gap-1.5"
                >
                  <Link2 className="w-3.5 h-3.5" />
                  <span>लागू गर्नुहोस् (Link)</span>
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body
      )}

      {/* ======================================================== */}
      {/* ============ QUESTIONNAIRE STUDIO MODAL ================ */}
      {/* ======================================================== */}
      {questionnaireStudioProject && typeof document !== 'undefined' && createPortal(
        <div className="fixed inset-0 bg-slate-950/80 backdrop-blur-md z-[99999] flex flex-col animate-fade-in font-sans">
          <QuestionnaireBuilder
            projectId={questionnaireStudioProject.id}
            project={questionnaireStudioProject}
            onPublished={(pub) => {
              loadData();
            }}
            onClose={() => setQuestionnaireStudioProject(null)}
          />
        </div>,
        document.body
      )}

      {/* ======================================================== */}
      {/* ========= PRIMARY KEY / UNIQUE ID CONFIG MODAL ========= */}
      {/* ======================================================== */}
      {primaryKeyModal && (
        <PrimaryKeyConfigModal
          isOpen={Boolean(primaryKeyModal)}
          onClose={() => setPrimaryKeyModal(null)}
          layer={primaryKeyModal.layer}
          isPostUpload={Boolean(primaryKeyModal.isPostUpload)}
          onSuccess={() => {
            loadData();
            if (onLayerUpdate) onLayerUpdate();
          }}
        />
      )}
    </div>
  );
}
