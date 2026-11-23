'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  Plus, Trash2, ArrowUp, ArrowDown, Save, CheckCircle2, AlertTriangle,
  Eye, EyeOff, Layers, Settings, FileText, Globe, Copy, Sparkles, Check,
  X, ChevronRight, ChevronDown, ChevronUp, ListFilter, HelpCircle, Code, ShieldCheck,
  Smartphone, Monitor, RefreshCw, Upload, Download, SplitSquareVertical, Pencil, RotateCcw,
  Link2, CheckSquare, Star, ExternalLink
} from 'lucide-react';
import { questionnairesAPI, layersAPI } from '../../lib/api';
import {
  filterNepaliOnly,
  filterEnglishOnly,
  filterKeyIdentifier,
  CHOICE_QUESTION_TYPES,
  createBlankOptionTemplate,
  createBlankSectionTemplate,
  createBlankQuestionTemplate,
  createBlankQuestionnaireTemplate,
  validateQuestionnaireTemplate,
  SKIP_OPERATORS,
  evaluateQuestionVisibility,
} from '../../lib/questionnaireUtils';

// Universal Question Types as specified in System Objective
export const QUESTION_TYPES = [
  // Input
  { id: 'text', label: 'पाठ (Short Text)', category: 'Input', icon: 'Type' },
  { id: 'textarea', label: 'लामो पाठ (Long Text / Paragraph)', category: 'Input', icon: 'AlignLeft' },
  { id: 'nepali_text', label: 'नेपाली युनिकोड (Nepali Unicode)', category: 'Input', icon: 'Globe' },
  { id: 'number', label: 'संख्या (Number)', category: 'Input', icon: 'Hash' },
  { id: 'decimal', label: 'दशमलव (Decimal)', category: 'Input', icon: 'Percent' },
  { id: 'currency', label: 'रकम (Currency - NPR रू)', category: 'Input', icon: 'DollarSign' },
  { id: 'phone', label: 'फोन नम्बर (Phone)', category: 'Input', icon: 'Phone' },
  { id: 'email', label: 'इमेल (Email)', category: 'Input', icon: 'Mail' },
  // Selection
  { id: 'single_choice', label: 'एकल छनोट (Radio / Single Choice)', category: 'Selection', icon: 'CheckCircle' },
  { id: 'multiple_choice', label: 'बहु-छनोट (Checkbox / Multiple)', category: 'Selection', icon: 'CheckSquare' },
  { id: 'dropdown', label: 'ड्रपडाउन (Dropdown)', category: 'Selection', icon: 'ChevronDown' },
  { id: 'yes_no', label: 'हो / होइन (Yes / No)', category: 'Selection', icon: 'ToggleLeft' },
  { id: 'rating', label: 'रेटिङ (Rating 1-5)', category: 'Selection', icon: 'Star' },
  { id: 'likert', label: 'लाइकर्त स्केल (Likert Scale)', category: 'Selection', icon: 'BarChart' },
  // Date/Time
  { id: 'date', label: 'मिति (Date)', category: 'Date/Time', icon: 'Calendar' },
  { id: 'time', label: 'समय (Time)', category: 'Date/Time', icon: 'Clock' },
  { id: 'datetime', label: 'मिति र समय (Date & Time)', category: 'Date/Time', icon: 'CalendarClock' },
  // Spatial
  { id: 'gps_coordinate', label: 'GPS निर्देशांक (GPS Coordinate)', category: 'Spatial', icon: 'MapPin' },
  { id: 'feature_picker', label: 'अवस्थित फिचर छनोट (Feature Picker)', category: 'Spatial', icon: 'Crosshair' },
  // Media
  { id: 'photo', label: 'फोटो / क्यामेरा (Photo Capture)', category: 'Media', icon: 'Camera' },
  { id: 'signature', label: 'डिजिटल हस्ताक्षर (Signature)', category: 'Media', icon: 'PenTool' },
  { id: 'document', label: 'फाइल / कागजात (Document/File)', category: 'Media', icon: 'FileUp' },
  // Structural / Dynamic
  { id: 'repeat_group', label: 'दोहोरिने समूह (Repeat Group / Roster)', category: 'Structural', icon: 'Repeat' },
  { id: 'calculated', label: 'गणना गरिएको मान (Calculated Field)', category: 'Dynamic', icon: 'Calculator' },
];

export default function QuestionnaireBuilder({
  projectId,
  project,
  onPublished,
  onClose,
}) {
  const [questionnaires, setQuestionnaires] = useState([]);
  const [activeQId, setActiveQId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState(null);

  // Active definition working state (all empty by default — template to be filled)
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [version, setVersion] = useState('v1.0');
  const [status, setStatus] = useState('DRAFT');
  const [sections, setSections] = useState([]);
  const [questions, setQuestions] = useState([]);
  const [settings, setSettings] = useState({
    autosave_seconds: 30,
    require_gps: true,
    gps_accuracy_threshold_m: 15,
    allow_offline: true,
  });

  // Selected item in editor
  const [selectedSectionId, setSelectedSectionId] = useState(null);
  const [selectedQuestionId, setSelectedQuestionId] = useState(null);
  const [editingSection, setEditingSection] = useState(null); // { id, title, title_ne, description }

  // Link / Implement Questionnaire on Vector Layers Modal state
  const [showLinkLayerModal, setShowLinkLayerModal] = useState(false);
  const [projectLayersList, setProjectLayersList] = useState([]);
  const [linkingLoading, setLinkingLoading] = useState(false);

  // Custom Dropdowns state
  const [showAddQuestionMenu, setShowAddQuestionMenu] = useState(false);
  const [showTypeDropdown, setShowTypeDropdown] = useState(false);

  // Preview & Validation mode
  const [viewMode, setViewMode] = useState('editor'); // 'editor' | 'preview' | 'validation'
  const [previewLanguage, setPreviewLanguage] = useState('ne'); // 'ne' | 'en'
  const [previewAnswers, setPreviewAnswers] = useState({});
  const [validationReport, setValidationReport] = useState(null);
  const [validating, setValidating] = useState(false);

  // Per-Question & Per-Section Live Validation State in Builder
  const [questionValidationResults, setQuestionValidationResults] = useState({});
  const [sectionValidationResults, setSectionValidationResults] = useState({});

  // Initialize a clean, blank questionnaire template with NO pre-populated values
  const initDefaultTemplate = useCallback(() => {
    const blank = createBlankQuestionnaireTemplate();
    setActiveQId(null);
    setTitle(blank.title);
    setDescription(blank.description);
    setVersion(blank.version);
    setStatus(blank.status);
    setSections(blank.sections);
    setQuestions(blank.questions);
    setSettings(blank.settings);
    setSelectedSectionId(blank.sections[0]?.id || null);
    setSelectedQuestionId(blank.questions[0]?.id || null);
    setPreviewAnswers({});
    setValidationReport(null);
    setQuestionValidationResults({});
    setSectionValidationResults({});
  }, []);

  const loadDefinition = useCallback((qDef) => {
    setActiveQId(qDef.id);
    setTitle(qDef.title ?? '');
    setDescription(qDef.description ?? '');
    setVersion(qDef.version || 'v1.0');
    setStatus(qDef.status || 'DRAFT');

    const schema = qDef.schema_definition || {};
    const secs = Array.isArray(schema.sections) && schema.sections.length > 0
      ? schema.sections
      : [createBlankSectionTemplate(1, 'sec_1')];
    const qs = Array.isArray(schema.questions) ? schema.questions : [];

    setSections(secs);
    setQuestions(qs);
    setSettings(schema.settings || { autosave_seconds: 30, require_gps: true });

    const firstSecId = secs[0]?.id || null;
    setSelectedSectionId(firstSecId);
    const firstSecQ = qs.find((q) => q.section_id === firstSecId) || qs[0];
    setSelectedQuestionId(firstSecQ?.id || null);
    setQuestionValidationResults({});
    setSectionValidationResults({});
  }, []);

  const isGlobalStudio = projectId === 'global';

  const fetchBuilderQuestionnaires = useCallback(async () => {
    if (isGlobalStudio) {
      const res = await questionnairesAPI.listGlobal();
      const list = Array.isArray(res.data) ? res.data : [];
      return list.filter((q) => q.is_global === true || q.project_id == null || q.project_id === '');
    }
    const res = await questionnairesAPI.listByProject(projectId);
    const list = Array.isArray(res.data) ? res.data : [];
    // The project studio only edits questionnaires owned by this project; reusable
    // global questionnaires are linked from the layer/questionnaire link modal instead.
    return list.filter((q) => String(q.project_id) === String(projectId));
  }, [projectId, isGlobalStudio]);

  // Load questionnaires for project
  const loadQuestionnaires = useCallback(async () => {
    if (!projectId) {
      initDefaultTemplate();
      setLoading(false);
      return;
    }
    try {
      setLoading(true);
      const list = await fetchBuilderQuestionnaires();
      setQuestionnaires(list);

      if (list.length > 0) {
        const active = list.find((q) => q.is_active) || list[0];
        loadDefinition(active);
      } else {
        initDefaultTemplate();
      }
    } catch (err) {
      console.error('Failed to load questionnaires', err);
      initDefaultTemplate();
    } finally {
      setLoading(false);
    }
  }, [projectId, fetchBuilderQuestionnaires, initDefaultTemplate, loadDefinition]);

  useEffect(() => {
    loadQuestionnaires();
  }, [loadQuestionnaires]);

  // Reset to a fresh blank template ready to be filled
  const handleResetBlankTemplate = () => {
    initDefaultTemplate();
    setViewMode('editor');
    setMessage({
      type: 'success',
      text: 'खाली प्रश्नावली टेम्प्लेट तयार गरियो। कृपया शीर्षक, खण्ड र प्रश्नहरूको विवरण भर्नुहोस्।',
    });
  };

  // Section Handlers — always create blank template slots with empty strings
  const handleAddSection = () => {
    const nextOrder = sections.length + 1;
    const newId = `sec_${Date.now()}`;
    const newSec = createBlankSectionTemplate(nextOrder, newId);
    setSections((prev) => [...prev, newSec]);
    setSelectedSectionId(newId);
    setEditingSection({ ...newSec });
  };

  const handleUpdateSection = (secId, updates) => {
    setSections((prev) => prev.map((s) => (s.id === secId ? { ...s, ...updates } : s)));
  };

  const handleDeleteSection = (secId) => {
    if (sections.length <= 1) {
      setMessage({ type: 'error', text: 'कम्तीमा एक खण्ड (Section) अनिवार्य छ।' });
      return;
    }
    const remainingSecs = sections.filter((s) => s.id !== secId);
    const remainingQs = questions.filter((q) => q.section_id !== secId);
    setSections(remainingSecs);
    setQuestions(remainingQs);
    const nextSecId = remainingSecs[0]?.id || null;
    setSelectedSectionId(nextSecId);
    const nextQ = remainingQs.find((q) => q.section_id === nextSecId) || remainingQs[0];
    setSelectedQuestionId(nextQ?.id || null);
    setMessage({ type: 'success', text: 'खण्ड र यसका प्रश्नहरू हटाइयो।' });
  };

  // Question Handlers — always create blank template slots with empty strings
  const handleAddQuestion = (type = 'text') => {
    const newId = `q_${Date.now()}`;
    const targetSecId = selectedSectionId || sections[0]?.id || 'sec_1';
    const newQ = createBlankQuestionTemplate(type, targetSecId, newId);

    setQuestions((prev) => [...prev, newQ]);
    setSelectedQuestionId(newId);
  };

  const handleUpdateQuestion = (qId, updates) => {
    setQuestions((prev) =>
      prev.map((q) => {
        if (q.id !== qId) return q;
        const next = { ...q, ...updates };

        // If user switched question type to a choice type and options are not initialized, provide 2 blank option templates
        if (
          updates.type &&
          CHOICE_QUESTION_TYPES.includes(updates.type) &&
          (!Array.isArray(next.options) || next.options.length === 0)
        ) {
          next.options = [createBlankOptionTemplate(), createBlankOptionTemplate()];
        }

        // If user switched question type to calculated and calculation is not initialized, provide blank formula template
        if (updates.type === 'calculated' && !next.calculation) {
          next.calculation = { formula: '' };
        }

        return next;
      })
    );
  };

  const handleDeleteQuestion = (qId) => {
    const remaining = questions.filter((q) => q.id !== qId);
    setQuestions(remaining);
    if (selectedQuestionId === qId) {
      const sameSec = remaining.find((q) => q.section_id === selectedSectionId);
      setSelectedQuestionId(sameSec?.id || remaining[0]?.id || null);
    }
  };

  const handleMoveQuestion = (qId, direction) => {
    const currentList = [...questions];
    const index = currentList.findIndex((q) => q.id === qId);
    if (index === -1) return;
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= currentList.length) return;

    const temp = currentList[index];
    currentList[index] = currentList[targetIndex];
    currentList[targetIndex] = temp;
    setQuestions(currentList);
  };

  // Save Draft to Backend (allows saving partially filled templates)
  const handleSaveDraft = async () => {
    try {
      setSaving(true);
      setMessage(null);

      const payload = {
        title,
        description,
        schema_definition: {
          sections,
          questions,
          settings,
        },
      };

      let saved;
      if (activeQId) {
        const res = await questionnairesAPI.updateDraft(activeQId, payload);
        saved = res.data;
        setMessage({ type: 'success', text: 'प्रश्नावली मस्यौदा सफलतापूर्वक सुरक्षित भयो (Draft saved).' });
      } else {
        const res = isGlobalStudio
          ? await questionnairesAPI.createGlobal(payload)
          : await questionnairesAPI.createDraft(projectId, payload);
        saved = res.data;
        if (saved?.id) {
          setActiveQId(saved.id);
        }
        setMessage({ type: 'success', text: 'नयाँ प्रश्नावली मस्यौदा तयार भयो (New draft created).' });
      }

      const list = await fetchBuilderQuestionnaires();
      setQuestionnaires(list);
      return saved;
    } catch (err) {
      console.error('Failed to save draft', err);
      setMessage({ type: 'error', text: err.response?.data?.detail || 'मस्यौदा सुरक्षित गर्न सकिएन।' });
      return null;
    } finally {
      setSaving(false);
    }
  };

  const handleNavigateToIssue = useCallback((issue) => {
    setViewMode('editor');
    if (issue?.sectionId) {
      setSelectedSectionId(issue.sectionId);
    }
    if (issue?.questionId) {
      setSelectedQuestionId(issue.questionId);
    }
    setTimeout(() => {
      let targetEl = null;
      if (issue?.questionId) {
        targetEl = document.getElementById(`question-card-${issue.questionId}`) ||
                   document.querySelector(`[data-question-id="${issue.questionId}"]`);
      } else if (issue?.sectionId) {
        targetEl = document.getElementById(`section-tab-${issue.sectionId}`) ||
                   document.querySelector(`[data-section-id="${issue.sectionId}"]`);
      } else {
        targetEl = document.getElementById('questionnaire-title-input');
      }
      if (targetEl) {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        const focusable = targetEl.querySelector('input, textarea, select, [tabindex="0"]') || targetEl;
        if (typeof focusable?.focus === 'function') focusable.focus();
      }
    }, 150);
  }, []);

  // Run Pre-Publish Validation against the current template state
  const handleRunValidation = async () => {
    setValidating(true);
    try {
      const localReport = validateQuestionnaireTemplate({
        title,
        sections,
        questions,
      });

      if (activeQId) {
        try {
          await questionnairesAPI.updateDraft(activeQId, {
            title,
            description,
            schema_definition: { sections, questions, settings },
          });
          const res = await questionnairesAPI.validateSchema(activeQId);
          if (res.data) {
            const serverData = res.data;
            const mergedIssues = [
              ...(Array.isArray(localReport.issues) ? localReport.issues : []),
              ...(Array.isArray(serverData.issues) ? serverData.issues : []),
            ];
            const seenKeys = new Set();
            const dedupedIssues = mergedIssues.filter((iss) => {
              const key = `${iss?.message || ''}::${iss?.questionId || ''}::${iss?.sectionId || ''}`;
              if (seenKeys.has(key)) return false;
              seenKeys.add(key);
              return true;
            });
            const mergedErrors = Array.from(new Set([
              ...(Array.isArray(serverData.errors) ? serverData.errors : []),
              ...(Array.isArray(localReport.errors) ? localReport.errors : []),
            ]));
            const mergedWarnings = Array.from(new Set([
              ...(Array.isArray(serverData.warnings) ? serverData.warnings : []),
              ...(Array.isArray(localReport.warnings) ? localReport.warnings : []),
            ]));
            setValidationReport({
              ...serverData,
              valid: Boolean(serverData.valid) && Boolean(localReport.valid) && mergedErrors.length === 0,
              errors: mergedErrors,
              warnings: mergedWarnings,
              issues: dedupedIssues,
            });
          } else {
            setValidationReport(localReport);
          }
        } catch {
          setValidationReport(localReport);
        }
      } else {
        setValidationReport(localReport);
      }
      setViewMode('validation');
    } catch (err) {
      console.error('Validation check failed', err);
      setMessage({ type: 'error', text: 'प्रमाणीकरण परीक्षण असफल भयो।' });
    } finally {
      setValidating(false);
    }
  };

  // Open Modal to link this questionnaire to any chosen project vector layer
  const handleOpenLinkLayerModal = async () => {
    try {
      setLinkingLoading(true);
      setShowLinkLayerModal(true);
      const res = (projectId && projectId !== 'global')
        ? await layersAPI.listProject(projectId)
        : await layersAPI.listAll();
      setProjectLayersList(Array.isArray(res.data) ? res.data : []);
    } catch (err) {
      console.warn('Failed to fetch project layers', err);
      setProjectLayersList([]);
    } finally {
      setLinkingLoading(false);
    }
  };

  // Implement / Apply this questionnaire to a chosen project vector layer
  const handleApplyQuestionnaireToLayer = async (targetLayerId) => {
    let qIdToLink = activeQId;
    if (!qIdToLink) {
      const saved = await handleSaveDraft();
      if (!saved?.id) {
        alert('कृपया पहिले प्रश्नावली मस्यौदा सुरक्षित गर्नुहोस् (Please save draft first).');
        return;
      }
      qIdToLink = saved.id;
    }

    try {
      setLinkingLoading(true);
      // The backend derives the layer schema from this questionnaire's questions,
      // so the survey attributes and the linked layer attributes can never drift.
      await layersAPI.update(targetLayerId, {
        questionnaire_id: qIdToLink,
      });

      setProjectLayersList((prev) =>
        prev.map((l) => (l.id === targetLayerId ? { ...l, questionnaire_id: qIdToLink } : l))
      );

      const targetLyr = projectLayersList.find((l) => l.id === targetLayerId);
      setMessage({
        type: 'success',
        text: `'${targetLyr?.name || 'भेक्टर तह'}' मा यो प्रश्नावली सफलतापूर्वक लागू गरियो! (Questionnaire implemented on layer)`,
      });
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.detail || 'तहमा प्रश्नावली लागू गर्न सकिएन।');
    } finally {
      setLinkingLoading(false);
    }
  };

  // Unlink questionnaire from a chosen vector layer
  const handleUnlinkQuestionnaireFromLayer = async (targetLayerId) => {
    try {
      setLinkingLoading(true);
      await layersAPI.update(targetLayerId, { questionnaire_id: null });
      setProjectLayersList((prev) =>
        prev.map((l) => (l.id === targetLayerId ? { ...l, questionnaire_id: null } : l))
      );
      setMessage({
        type: 'success',
        text: 'तहबाट प्रश्नावली हटाइयो (Questionnaire unlinked from layer).',
      });
    } catch (err) {
      console.error(err);
      alert('तहबाट प्रश्नावली हटाउन सकिएन।');
    } finally {
      setLinkingLoading(false);
    }
  };

  // Create a brand new vector layer and link this questionnaire to it
  const handleCreateAndLinkNewLayer = async () => {
    let qIdToLink = activeQId;
    if (!qIdToLink) {
      const saved = await handleSaveDraft();
      if (!saved?.id) {
        alert('कृपया पहिले प्रश्नावली सुरक्षित गर्नुहोस् (Please save draft first).');
        return;
      }
      qIdToLink = saved.id;
    }

    try {
      setLinkingLoading(true);
      const geomType = project?.geometry_config?.type || 'Point';
      const creationGeoms = geomType === 'Mix' ? ['Point', 'LineString', 'Polygon'] : [geomType];
      const layerName = `${title || project?.name || 'प्रश्नावली'} (तह)`;

      const res = await layersAPI.create({
        name: layerName,
        description: description || `Survey layer for ${title}`,
        type: 'vector',
        geometry_type: geomType,
        creation_geometry_types: creationGeoms,
        project_id: isGlobalStudio ? null : (projectId || null),
        is_global: isGlobalStudio,
        questionnaire_id: qIdToLink,
        allow_snapping: true,
        editable_by_collectors: false,
      });

      setProjectLayersList((prev) => [res.data, ...prev]);
      setMessage({
        type: 'success',
        text: `नयाँ भेक्टर तह '${res.data.name}' सिर्जना भयो र यो प्रश्नावली लागू गरियो!`,
      });
    } catch (err) {
      console.error(err);
      alert(err.response?.data?.detail || 'भेक्टर तह सिर्जना गर्न सकिएन।');
    } finally {
      setLinkingLoading(false);
    }
  };

  // Sync or create associated vector layer with questionnaire fields
  const handleSyncVectorLayer = async () => {
    handleOpenLinkLayerModal();
  };

  // Publish Questionnaire (requires template fields to be filled)
  const handlePublish = async () => {
    const localReport = validateQuestionnaireTemplate({
      title,
      sections,
      questions,
    });

    if (!localReport.valid) {
      setValidationReport(localReport);
      setViewMode('validation');
      setMessage({
        type: 'error',
        text: localReport.errors[0] || 'प्रकाशित गर्नुअघि कृपया टेम्प्लेटका खाली फिल्डहरू भर्नुहोस्।',
      });
      return;
    }

    try {
      setSaving(true);
      let targetQId = activeQId;
      if (!targetQId) {
        const created = await questionnairesAPI.createDraft(projectId, {
          title,
          description,
          schema_definition: { sections, questions, settings },
        });
        targetQId = created?.data?.id;
        setActiveQId(targetQId);
      } else {
        await questionnairesAPI.updateDraft(targetQId, {
          title,
          description,
          schema_definition: { sections, questions, settings },
        });
      }

      const res = await questionnairesAPI.publish(targetQId, { increment_version: true });
      setMessage({ type: 'success', text: `प्रश्नावली ${res.data.version} सफलतापूर्वक प्रकाशित भयो!` });
      setStatus('PUBLISHED');
      setVersion(res.data.version || version);
      await loadQuestionnaires();
      if (onPublished) onPublished(res.data);
    } catch (err) {
      console.error('Failed to publish', err);
      setMessage({ type: 'error', text: err.response?.data?.detail || 'प्रश्नावली प्रकाशित गर्न सकिएन।' });
    } finally {
      setSaving(false);
    }
  };

  // Duplicate Version
  const handleDuplicate = async () => {
    if (!activeQId) return;
    try {
      setSaving(true);
      const res = await questionnairesAPI.duplicate(activeQId);
      setMessage({ type: 'success', text: `नयाँ संस्करण ${res.data.version} मस्यौदा तयार भयो!` });
      loadDefinition(res.data);
      const listRes = await questionnairesAPI.listByProject(projectId);
      setQuestionnaires(Array.isArray(listRes.data) ? listRes.data : []);
    } catch (err) {
      console.error('Failed to duplicate', err);
    } finally {
      setSaving(false);
    }
  };

  const selectedQuestion = useMemo(
    () => questions.find((q) => q.id === selectedQuestionId),
    [questions, selectedQuestionId]
  );

  const selectedSection = useMemo(
    () => sections.find((s) => s.id === selectedSectionId),
    [sections, selectedSectionId]
  );

  const activeSectionQuestions = useMemo(
    () => questions.filter((q) => q.section_id === selectedSectionId),
    [questions, selectedSectionId]
  );

  // ---- Question & Section Live Validation Engine in Builder ----
  const validateSingleQuestionInBuilder = useCallback((q, allQuestions = questions) => {
    if (!q) return { valid: true, errors: [], warnings: [] };
    const errors = [];
    const warnings = [];

    // Check 1: Label
    const hasLabel = Boolean(String(q.label_ne || '').trim() || String(q.label || '').trim());
    if (!hasLabel) {
      errors.push('प्रश्नको शीर्षक (Question Label) खाली छ। कृपया नेपाली वा अंग्रेजीमा शीर्षक भर्नुहोस्।');
    }

    // Check 2: Internal Key
    const keyName = String(q.name || '').trim();
    if (!keyName) {
      errors.push('आन्तरिक कुञ्जी (Internal Key / PostGIS Column) खाली छ। यो डाटाबेसका लागि अनिवार्य छ।');
    } else {
      const isDup = (allQuestions || []).some(
        (other) => other.id !== q.id && String(other.name || '').trim().toLowerCase() === keyName.toLowerCase()
      );
      if (isDup) {
        errors.push(`यो कुञ्जी '${keyName}' अर्को प्रश्नमा पहिले नै प्रयोग भइसकेको छ (Duplicate Key)। कृपया फरक नाम दिनुहोस्।`);
      }
    }

    // Check 3: Choice Question Options
    if (CHOICE_QUESTION_TYPES.includes(q.type)) {
      const opts = Array.isArray(q.options) ? q.options : [];
      if (opts.length === 0) {
        errors.push('छनोट प्रश्नका लागि कम्तीमा एक विकल्प (Option) आवश्यक छ।');
      } else {
        opts.forEach((opt, idx) => {
          const hasOptVal = Boolean(String(opt?.value || '').trim());
          const hasOptLabel = Boolean(String(opt?.label_ne || '').trim() || String(opt?.label || '').trim());
          if (!hasOptVal) {
            errors.push(`विकल्प #${idx + 1} को Option Value (कोड) खाली छ।`);
          }
          if (!hasOptLabel) {
            errors.push(`विकल्प #${idx + 1} को Option Label (नाम) खाली छ।`);
          }
        });
      }
    }

    // Check 4: Calculated field
    if (q.type === 'calculated') {
      const formula = String(q.calculation?.formula || '').trim();
      if (!formula) {
        errors.push('गणना प्रश्नका लागि सूत्र (Calculation Formula) अनिवार्य छ।');
      }
    }

    // Check 5: Skip logic conditions
    if (Array.isArray(q.conditions) && q.conditions.length > 0) {
      q.conditions.forEach((cond, cIdx) => {
        if (!String(cond?.depends_on || '').trim()) {
          warnings.push(`सर्त #${cIdx + 1} मा आधार प्रश्न (Depends On) चयन गरिएको छैन।`);
        }
      });
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }, [questions]);

  const handleValidateCurrentQuestion = useCallback((targetQ = null) => {
    const qToValidate = targetQ || selectedQuestion;
    if (!qToValidate) return;
    const res = validateSingleQuestionInBuilder(qToValidate, questions);
    setQuestionValidationResults((prev) => ({
      ...prev,
      [qToValidate.id]: res,
    }));
    return res;
  }, [selectedQuestion, questions, validateSingleQuestionInBuilder]);

  const handleValidateCurrentSection = useCallback((targetSec = null) => {
    const secToValidate = targetSec || selectedSection;
    if (!secToValidate) return;
    const errors = [];
    const warnings = [];

    const hasSecTitle = Boolean(String(secToValidate.title_ne || '').trim() || String(secToValidate.title || '').trim());
    if (!hasSecTitle) {
      errors.push('खण्डको शीर्षक (Section Title) खाली छ।');
    }

    const secQuestions = questions.filter((q) => q.section_id === secToValidate.id);
    if (secQuestions.length === 0) {
      warnings.push('यस खण्डमा कुनै प्रश्न थपिएको छैन।');
    }

    let invalidCount = 0;
    const newQResults = {};
    secQuestions.forEach((q) => {
      const qRes = validateSingleQuestionInBuilder(q, questions);
      newQResults[q.id] = qRes;
      if (!qRes.valid) {
        invalidCount++;
        const qTitle = q.label_ne || q.label || q.name || 'प्रश्न';
        qRes.errors.forEach((e) => {
          errors.push(`[${qTitle}]: ${e}`);
        });
      }
    });

    setQuestionValidationResults((prev) => ({ ...prev, ...newQResults }));
    const secResult = {
      valid: errors.length === 0,
      errors,
      warnings,
      invalidCount,
    };
    setSectionValidationResults((prev) => ({
      ...prev,
      [secToValidate.id]: secResult,
    }));
    return secResult;
  }, [selectedSection, questions, validateSingleQuestionInBuilder]);

  return (
    <div className="flex flex-col h-full bg-slate-100 text-slate-800 font-sans select-none overflow-hidden">
      {/* Top Action Bar */}
      <div className="flex items-center justify-between px-4 py-2.5 bg-gov-blue-900 text-white shadow-md z-10 shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="p-1.5 bg-gov-blue-800 rounded-lg text-gov-gold-400 shrink-0">
            <Layers className="w-5 h-5" />
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm font-nepali tracking-wide truncate">
                {title.trim() ? title : 'नयाँ प्रश्नावली टेम्प्लेट (Blank Questionnaire Template)'}
              </span>
              <span className={`px-2 py-0.5 text-[10px] font-bold rounded-full uppercase tracking-wider shrink-0 ${
                status === 'PUBLISHED' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' : 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
              }`}>
                {version} • {status}
              </span>
            </div>
            <span className="text-[11px] text-gov-blue-200 block truncate">
              {project?.name ? `${project.name} • ` : ''}प्रश्नावली ढाँचा निर्माणकर्ता (Template to be Filled)
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 shrink-0">
          {/* Mode Switcher */}
          <div className="flex bg-gov-blue-800 rounded-lg p-0.5 border border-gov-blue-700">
            <button
              type="button"
              onClick={() => setViewMode('editor')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                viewMode === 'editor' ? 'bg-gov-blue-600 text-white' : 'text-gov-blue-200 hover:text-white'
              }`}
            >
              <Settings className="w-3.5 h-3.5" />
              <span>बिल्डर (Builder)</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('preview')}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                viewMode === 'preview' ? 'bg-gov-blue-600 text-white' : 'text-gov-blue-200 hover:text-white'
              }`}
            >
              <Eye className="w-3.5 h-3.5" />
              <span>पूर्वावलोकन (Preview)</span>
            </button>
            <button
              type="button"
              onClick={handleRunValidation}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-semibold rounded-md transition-colors ${
                viewMode === 'validation' ? 'bg-gov-blue-600 text-white' : 'text-gov-blue-200 hover:text-white'
              }`}
            >
              <ShieldCheck className="w-3.5 h-3.5" />
              <span>जाँच (Validate)</span>
            </button>
          </div>

          {/* Reset Blank Template Button */}
          <button
            type="button"
            onClick={handleResetBlankTemplate}
            title="खाली टेम्प्लेटमा रिसेट गर्नुहोस् (Reset to Blank Template)"
            className="flex items-center gap-1.5 px-2.5 py-1.5 bg-gov-blue-800 hover:bg-gov-blue-700 text-gov-blue-100 hover:text-white text-xs font-semibold rounded-lg transition-colors border border-gov-blue-700 font-nepali"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span className="hidden md:inline">खाली टेम्प्लेट (Blank)</span>
          </button>

          {/* Version / Duplicate Button */}
          {activeQId && (
            <button
              type="button"
              onClick={handleDuplicate}
              title="नयाँ संस्करण मस्यौदा प्रतिलिपि गर्नुहोस्"
              className="p-1.5 bg-gov-blue-800 hover:bg-gov-blue-700 text-gov-blue-200 hover:text-white rounded-lg transition-colors border border-gov-blue-700"
            >
              <Copy className="w-4 h-4" />
            </button>
          )}

          {/* Link / Implement Questionnaire on Vector Layers */}
          <button
            type="button"
            onClick={handleOpenLinkLayerModal}
            disabled={saving || linkingLoading}
            title="यस प्रोजेक्टका कुनै पनि भेक्टर तहमा यो प्रश्नावली लागू / लिङ्क गर्नुहोस्"
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gov-blue-700 hover:bg-gov-blue-600 text-white text-xs font-bold rounded-lg transition-colors shadow-sm disabled:opacity-50 font-nepali"
          >
            <Link2 className="w-3.5 h-3.5 text-gov-gold-400" />
            <span className="hidden sm:inline">भेक्टर तहमा लागू गर्नुहोस् (Link Layer)</span>
          </button>

          {/* Save Draft */}
          <button
            type="button"
            onClick={handleSaveDraft}
            disabled={saving}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded-lg transition-colors shadow-sm disabled:opacity-50"
          >
            <Save className={`w-3.5 h-3.5 ${saving ? 'animate-spin' : ''}`} />
            <span>सुरक्षित (Save Draft)</span>
          </button>

          {/* Publish Button */}
          <button
            type="button"
            onClick={handlePublish}
            disabled={saving}
            className="flex items-center gap-1.5 px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg transition-colors shadow-sm disabled:opacity-50 font-nepali"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>प्रकाशित गर्नुहोस् (Publish)</span>
          </button>

          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-gov-blue-200 hover:text-white hover:bg-gov-blue-800 rounded-lg ml-1"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Notification Toast */}
      {message && (
        <div
          className={`flex items-center justify-between px-4 py-2 text-xs font-semibold ${
            message.type === 'success' ? 'bg-emerald-100 text-emerald-900 border-b border-emerald-200' : 'bg-rose-100 text-rose-900 border-b border-rose-200'
          }`}
        >
          <span>{message.text}</span>
          <button type="button" onClick={() => setMessage(null)} className="text-slate-500 hover:text-slate-800">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Workspace Body */}
      {viewMode === 'editor' && (
        <div className="flex flex-1 min-h-0 divide-x divide-slate-200 bg-white">
          {/* Column 1: Questionnaire Template Metadata & Sections */}
          <div className="w-72 flex flex-col bg-slate-50 shrink-0">
            {/* Questionnaire Template Metadata (Top of Left Column so user fills Title & Description first) */}
            <div className="p-3 border-b border-slate-200 bg-white space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold text-gov-blue-900 uppercase tracking-wider font-nepali">
                  १. प्रश्नावली विवरण (Template Info)
                </span>
                <span className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-800 border border-amber-200 rounded font-semibold">
                  टेम्प्लेट
                </span>
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1 font-nepali">
                  प्रश्नावली शीर्षक (Questionnaire Title) *
                </label>
                <input
                  id="questionnaire-title-input"
                  type="text"
                  placeholder="प्रश्नावलीको शीर्षक यहाँ लेख्नुहोस्..."
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500 font-nepali bg-white"
                />
              </div>
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1 font-nepali">
                  विवरण / उद्देश्य (Description)
                </label>
                <textarea
                  rows={2}
                  placeholder="सर्वेक्षणको उद्देश्य वा निर्देशन लेख्नुहोस्..."
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500 resize-none font-nepali bg-white"
                />
              </div>
            </div>

            {/* Sections Header */}
            <div className="p-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-xs font-bold text-slate-700 uppercase tracking-wider font-nepali">
                २. खण्डहरू (Sections)
              </span>
              <button
                type="button"
                onClick={handleAddSection}
                className="flex items-center gap-1 px-2 py-1 bg-gov-blue-800 hover:bg-gov-blue-700 text-white text-[11px] font-bold rounded shadow-sm font-nepali"
              >
                <Plus className="w-3 h-3" />
                <span>नयाँ खण्ड</span>
              </button>
            </div>

            {/* Sections List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1.5 scrollbar-thin">
              {sections.map((sec, idx) => {
                const isSelected = sec.id === selectedSectionId;
                const count = questions.filter((q) => q.section_id === sec.id).length;
                const hasSecTitle = Boolean((sec.title_ne && sec.title_ne.trim()) || (sec.title && sec.title.trim()));
                const secVal = sectionValidationResults[sec.id];
                const secQuestions = questions.filter((q) => q.section_id === sec.id);
                const hasQuestionErrors = secQuestions.some((q) => questionValidationResults[q.id] && !questionValidationResults[q.id].valid);
                const secHasIssues = (secVal && !secVal.valid) || hasQuestionErrors;
                const secIsClean = secVal && secVal.valid && !hasQuestionErrors;

                return (
                  <div
                    key={sec.id}
                    id={`section-tab-${sec.id}`}
                    data-section-id={sec.id}
                    onClick={() => {
                      setSelectedSectionId(sec.id);
                      const firstQInSec = questions.find((q) => q.section_id === sec.id);
                      setSelectedQuestionId(firstQInSec?.id || null);
                    }}
                    className={`group flex items-center justify-between px-3 py-2 rounded-lg cursor-pointer transition-all border ${
                      secHasIssues
                        ? 'bg-rose-50/70 border-rose-400 text-rose-950 shadow-xs ring-1 ring-rose-300'
                        : isSelected
                        ? 'bg-gov-blue-50 border-gov-blue-300 text-gov-blue-900 shadow-sm'
                        : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded shrink-0 ${
                        secHasIssues ? 'bg-rose-600 text-white' : 'bg-slate-200 text-slate-600'
                      }`}>
                        {idx + 1}
                      </span>
                      <div className="truncate">
                        <div className="flex items-center gap-1.5">
                          {hasSecTitle ? (
                            <div className="text-xs font-bold truncate font-nepali">
                              {sec.title_ne || sec.title}
                            </div>
                          ) : (
                            <div className="text-xs italic text-slate-400 truncate font-nepali">
                              खण्ड #{idx + 1} — शीर्षक भर्नुहोस्
                            </div>
                          )}
                          {secHasIssues && (
                            <span className="text-[9px] px-1 py-0.2 bg-rose-600 text-white rounded font-bold font-nepali shrink-0">
                              त्रुटि !
                            </span>
                          )}
                          {secIsClean && (
                            <span className="text-[9px] px-1 py-0.2 bg-emerald-600 text-white rounded font-bold font-nepali shrink-0">
                              ✓ सहि
                            </span>
                          )}
                        </div>
                        {sec.title && sec.title_ne && (
                          <div className="text-[10px] text-slate-400 truncate">{sec.title}</div>
                        )}
                        <div className="text-[10px] text-slate-400">{count} प्रश्नहरू</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setEditingSection({ ...sec });
                        }}
                        className="p-1 text-slate-400 hover:text-gov-blue-800 hover:bg-gov-blue-100 rounded transition-colors"
                        title="खण्ड सम्पादन गर्नुहोस् (Edit Section)"
                      >
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      {sections.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteSection(sec.id);
                          }}
                          className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded transition-colors"
                          title="खण्ड मेटाउनुहोस्"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Column 2: Selected Section Template Inputs & Question List */}
          <div className="flex-1 flex flex-col min-w-0 bg-white">
            {/* Section Header & Add Question Dropdown */}
            <div className="p-3 border-b border-slate-200 flex items-center justify-between bg-slate-50 shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-bold text-sm text-slate-800 font-nepali truncate">
                  {selectedSection?.title_ne || selectedSection?.title || 'चयन गरिएको खण्ड (Selected Section Template)'}
                </span>
                {selectedSection?.title && selectedSection?.title_ne && (
                  <span className="text-xs text-slate-500 hidden sm:inline truncate">
                    ({selectedSection.title})
                  </span>
                )}
                {selectedSection && (
                  <button
                    type="button"
                    onClick={() => setEditingSection({ ...selectedSection })}
                    className="flex items-center gap-1 px-2 py-0.5 text-[11px] font-bold text-gov-blue-700 hover:text-gov-blue-900 bg-gov-blue-50 hover:bg-gov-blue-100 rounded border border-gov-blue-200 font-nepali transition-colors shrink-0"
                    title="खण्ड पपअपमा सम्पादन गर्नुहोस् (Edit Section Modal)"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>पपअप सम्पादन</span>
                  </button>
                )}
                <span className="text-xs text-slate-500 shrink-0">
                  ({activeSectionQuestions.length} प्रश्नहरू)
                </span>
              </div>

              {/* Add Question Menu & Validate Section */}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleValidateCurrentSection()}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 active:scale-95 text-white text-xs font-bold rounded-lg shadow-sm font-nepali transition-all shrink-0 cursor-pointer"
                  title="यो खण्ड र यसका सबै प्रश्नहरू जाँच गर्नुहोस्"
                >
                  <ShieldCheck className="w-3.5 h-3.5 text-gov-gold-300" />
                  <span>खण्ड जाँच (Validate Section)</span>
                </button>

                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setShowAddQuestionMenu((prev) => !prev)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-gov-blue-800 hover:bg-gov-blue-700 text-white text-xs font-bold rounded-lg shadow-sm font-nepali transition-all"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>नयाँ प्रश्न थप्नुहोस् (Add Question)</span>
                    {showAddQuestionMenu ? (
                      <ChevronUp className="w-3.5 h-3.5 ml-1" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5 ml-1" />
                    )}
                  </button>

                  {showAddQuestionMenu && (
                    <>
                      <div
                        className="fixed inset-0 z-20"
                        onClick={() => setShowAddQuestionMenu(false)}
                      />
                      <div className="absolute right-0 top-full mt-1.5 w-72 bg-white border border-slate-200 rounded-xl shadow-2xl z-30 p-2 max-h-96 overflow-y-auto scrollbar-thin animate-fade-in">
                        <div className="text-[10px] font-bold text-slate-400 uppercase tracking-wider px-2 py-1">
                          प्रश्नका प्रकारहरू (Question Types)
                        </div>
                        {QUESTION_TYPES.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            onClick={() => {
                              handleAddQuestion(t.id);
                              setShowAddQuestionMenu(false);
                            }}
                            className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-gov-blue-50 hover:text-gov-blue-900 rounded-md font-nepali flex items-center justify-between transition-colors"
                          >
                            <span>{t.label}</span>
                            <span className="text-[10px] px-1 bg-slate-100 text-slate-500 rounded">{t.category}</span>
                          </button>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Section Validation Alert Banner */}
            {selectedSection && sectionValidationResults[selectedSection.id] && (
              <div className={`mx-4 mt-3 p-3 rounded-xl border text-xs font-nepali flex items-start justify-between gap-2 animate-fade-in ${
                sectionValidationResults[selectedSection.id].valid
                  ? 'bg-emerald-50 border-emerald-300 text-emerald-950 shadow-xs'
                  : 'bg-rose-50 border-rose-400 text-rose-950 shadow-sm ring-1 ring-rose-300'
              }`}>
                <div className="flex items-start gap-2 min-w-0">
                  {sectionValidationResults[selectedSection.id].valid ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0 mt-0.5" />
                  ) : (
                    <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <div className="font-bold">
                      {sectionValidationResults[selectedSection.id].valid
                        ? '✓ यो खण्ड र यसका सबै प्रश्नहरू सही र प्रमाणित छन् (Section Valid & Ready)!'
                        : `⚠️ यो खण्ड वा प्रश्नहरूमा ${sectionValidationResults[selectedSection.id].errors.length} वटा समस्या फेला पर्यो (Issues Detected)`}
                    </div>
                    {!sectionValidationResults[selectedSection.id].valid && sectionValidationResults[selectedSection.id].errors.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5 pl-4 list-disc text-[11px] text-rose-800">
                        {sectionValidationResults[selectedSection.id].errors.map((err, eIdx) => (
                          <li key={eIdx}>{err}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSectionValidationResults((prev) => ({ ...prev, [selectedSection.id]: null }))}
                  className="text-slate-400 hover:text-slate-700 p-0.5 shrink-0 cursor-pointer"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            )}

            {/* Inline Selected Section Template Form (Directly Editable Blank Template Fields) */}
            {selectedSection && (
              <div className="p-3 bg-slate-50/70 border-b border-slate-200 grid grid-cols-1 md:grid-cols-3 gap-2.5 shrink-0">
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-bold text-slate-700 font-nepali">
                      खण्डको नाम नेपाली (Nepali Title) *
                    </label>
                    <span className="text-[9px] text-gov-blue-700 bg-gov-blue-50 px-1 rounded font-semibold font-nepali">
                      नेपाली मात्र
                    </span>
                  </div>
                  <input
                    type="text"
                    placeholder="उदाहरण: सामान्य विवरण..."
                    value={selectedSection.title_ne || ''}
                    onChange={(e) =>
                      handleUpdateSection(selectedSection.id, {
                        title_ne: filterNepaliOnly(e.target.value),
                      })
                    }
                    className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-gov-blue-500 font-nepali"
                  />
                </div>
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-[11px] font-bold text-slate-700">
                      Section Title (English)
                    </label>
                    <span className="text-[9px] text-slate-500 bg-slate-100 px-1 rounded font-semibold">
                      English only
                    </span>
                  </div>
                  <input
                    type="text"
                    placeholder="e.g. General Information..."
                    value={selectedSection.title || ''}
                    onChange={(e) =>
                      handleUpdateSection(selectedSection.id, {
                        title: filterEnglishOnly(e.target.value),
                      })
                    }
                    className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-gov-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold text-slate-700 mb-1 font-nepali">
                    खण्डको संक्षिप्त विवरण (Section Description)
                  </label>
                  <input
                    type="text"
                    placeholder="यस खण्डको उद्देश्य वा निर्देशन..."
                    value={selectedSection.description || ''}
                    onChange={(e) =>
                      handleUpdateSection(selectedSection.id, {
                        description: e.target.value,
                      })
                    }
                    className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 bg-white focus:outline-none focus:ring-1 focus:ring-gov-blue-500 font-nepali"
                  />
                </div>
              </div>
            )}

            {/* Questions Reorderable Template List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2 scrollbar-thin">
              {activeSectionQuestions.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                  <FileText className="w-12 h-12 stroke-[1.2] mb-2" />
                  <p className="text-xs font-nepali">यो खण्डमा कुनै प्रश्न थपिएको छैन।</p>
                  <p className="text-[11px]">माथिको &ldquo;नयाँ प्रश्न थप्नुहोस्&rdquo; बटनबाट खाली प्रश्न टेम्प्लेट थप्नुहोस्।</p>
                </div>
              ) : (
                activeSectionQuestions.map((q, idx) => {
                  const isSelected = q.id === selectedQuestionId;
                  const typeMeta = QUESTION_TYPES.find((t) => t.id === q.type);
                  const hasLabel = Boolean((q.label_ne && q.label_ne.trim()) || (q.label && q.label.trim()));
                  const hasKey = Boolean(q.name && q.name.trim());
                  const qVal = questionValidationResults[q.id];
                  const hasIssues = qVal && !qVal.valid;
                  const isClean = qVal && qVal.valid;

                  return (
                    <div
                      key={q.id}
                      id={`question-card-${q.id}`}
                      data-question-id={q.id}
                      onClick={() => setSelectedQuestionId(q.id)}
                      className={`flex items-start justify-between p-3 rounded-xl border transition-all cursor-pointer ${
                        hasIssues
                          ? 'bg-rose-50/70 border-rose-400 shadow-sm ring-1 ring-rose-400'
                          : isSelected
                          ? 'bg-gov-blue-50/70 border-gov-blue-400 shadow-md ring-1 ring-gov-blue-400'
                          : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'
                      }`}
                    >
                      <div className="flex items-start gap-3 min-w-0 flex-1">
                        <div className="flex flex-col items-center gap-1 pt-0.5">
                          <span className="text-[11px] font-bold text-slate-400">#{idx + 1}</span>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveQuestion(q.id, 'up');
                            }}
                            className="p-0.5 text-slate-400 hover:text-slate-700"
                            title="माथि सार्नुहोस्"
                          >
                            <ArrowUp className="w-3 h-3" />
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleMoveQuestion(q.id, 'down');
                            }}
                            className="p-0.5 text-slate-400 hover:text-slate-700"
                            title="तल सार्नुहोस्"
                          >
                            <ArrowDown className="w-3 h-3" />
                          </button>
                        </div>

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 mb-1 flex-wrap">
                            {hasLabel ? (
                              <span className="text-xs font-bold text-slate-900 font-nepali">
                                {q.label_ne || q.label}
                              </span>
                            ) : (
                              <span className="text-xs italic text-slate-400 font-nepali">
                                प्रश्न #{idx + 1} — दायाँ प्यानलमा प्रश्नको विवरण भर्नुहोस् (Click to fill question template)
                              </span>
                            )}
                            {q.required && (
                              <span className="text-[10px] px-1.5 py-0.2 bg-rose-100 text-rose-700 rounded font-bold">
                                अनिवार्य (Required)
                              </span>
                            )}
                            {hasIssues && (
                              <span className="text-[10px] px-1.5 py-0.2 bg-rose-600 text-white rounded font-bold font-nepali flex items-center gap-1 shadow-xs">
                                <AlertTriangle className="w-3 h-3 text-rose-100" />
                                <span>त्रुटि ({qVal.errors.length})</span>
                              </span>
                            )}
                            {isClean && (
                              <span className="text-[10px] px-1.5 py-0.2 bg-emerald-100 text-emerald-800 rounded font-bold font-nepali border border-emerald-300 flex items-center gap-1">
                                <Check className="w-3 h-3 text-emerald-600" />
                                <span>प्रमाणित</span>
                              </span>
                            )}
                          </div>

                          <div className="flex items-center gap-2 text-[11px] text-slate-500 flex-wrap">
                            {hasKey ? (
                              <span className="px-1.5 py-0.5 bg-slate-100 rounded text-slate-600 font-mono text-[10px]">
                                {q.name}
                              </span>
                            ) : (
                              <span className="px-1.5 py-0.5 bg-amber-50 border border-amber-200 rounded text-amber-700 font-nepali text-[10px]">
                                Key खाली छ
                              </span>
                            )}
                            <span>•</span>
                            <span className="text-gov-blue-700 font-medium font-nepali">
                              {typeMeta?.label || q.type}
                            </span>
                            {q.gis_binding && (
                              <>
                                <span>•</span>
                                <span className="text-slate-400 text-[10px] font-mono">GIS: {q.gis_binding}</span>
                              </>
                            )}
                            {q.conditions && q.conditions.length > 0 && (
                              <span className="px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-bold">
                                {q.conditions.length} सर्त (Logic)
                              </span>
                            )}
                          </div>

                          {/* Primary Error Tip */}
                          {hasIssues && qVal.errors.length > 0 && (
                            <div className="text-[11px] text-rose-700 font-bold font-nepali mt-1 flex items-center gap-1">
                              <AlertTriangle className="w-3 h-3 text-rose-600 shrink-0" />
                              <span className="truncate">{qVal.errors[0]}</span>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0 ml-2">
                        {/* Per-Question Check Button */}
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleValidateCurrentQuestion(q);
                            setSelectedQuestionId(q.id);
                          }}
                          className={`px-2 py-1 rounded-md text-[10px] font-bold font-nepali flex items-center gap-1 border transition-all cursor-pointer ${
                            hasIssues
                              ? 'bg-rose-600 text-white border-rose-600 shadow-xs'
                              : isClean
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-300'
                              : 'bg-slate-100 hover:bg-slate-200 text-slate-700 border-slate-300'
                          }`}
                          title="यो प्रश्नको त्रुटि जाँच गर्नुहोस्"
                        >
                          <CheckCircle2 className="w-3 h-3" />
                          <span>{hasIssues ? 'त्रुटि (Check)' : isClean ? 'मान्य ✓' : 'जाँच'}</span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteQuestion(q.id);
                          }}
                          className="p-1.5 text-slate-400 hover:text-rose-600 rounded hover:bg-slate-100 transition-colors"
                          title="प्रश्न मेटाउनुहोस्"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>
          </div>

          {/* Column 3: Question Settings & Inspector Panel (Blank Template Inputs) */}
          <div className="w-80 sm:w-96 flex flex-col bg-slate-50 shrink-0 border-l border-slate-200 min-w-0 max-w-full">
            <div className="p-3 border-b border-slate-200 flex items-center justify-between bg-white shrink-0">
              <span className="text-xs font-bold text-slate-800 uppercase tracking-wider font-nepali">
                ३. प्रश्न विशेषता (Question Template)
              </span>
              {selectedQuestion && (
                <span className="text-[10px] font-mono text-slate-500">
                  {selectedQuestion.name || 'key_not_set'}
                </span>
              )}
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-thin">
              {selectedQuestion ? (
                <>
                  {/* Question Validator Bar */}
                  {(() => {
                    const qVal = questionValidationResults[selectedQuestion.id];
                    return (
                      <div className="space-y-2">
                        <div className="p-2.5 bg-white rounded-xl border border-slate-200 shadow-xs flex items-center justify-between gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <ShieldCheck className="w-4 h-4 text-gov-blue-800 shrink-0" />
                            <div className="min-w-0">
                              <span className="text-xs font-bold text-slate-800 font-nepali block truncate">
                                प्रश्न प्रमाणीकरण (Validator)
                              </span>
                              <span className="text-[10px] text-slate-500 font-nepali">
                                {qVal ? (qVal.valid ? '✓ कुनै समस्या छैन' : `⚠️ ${qVal.errors.length} समस्याहरू`) : 'जाँच गर्न बाँकी'}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleValidateCurrentQuestion()}
                            className="flex items-center gap-1 px-3 py-1.5 bg-gov-blue-800 hover:bg-gov-blue-700 active:scale-95 text-white text-xs font-bold rounded-lg shadow-sm font-nepali transition-all shrink-0 cursor-pointer"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5 text-gov-gold-300" />
                            <span>जाँच गर्नुहोस् (Check)</span>
                          </button>
                        </div>

                        {/* Validation Result Box */}
                        {qVal && (
                          <div className={`p-3 rounded-xl border text-xs font-nepali animate-fade-in ${
                            qVal.valid
                              ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                              : 'bg-rose-50 border-rose-300 text-rose-900 shadow-xs'
                          }`}>
                            <div className="flex items-center gap-2 font-bold">
                              {qVal.valid ? (
                                <>
                                  <Check className="w-4 h-4 text-emerald-600 shrink-0" />
                                  <span>यो प्रश्न पूर्ण रूपमा सही छ (Valid Question)!</span>
                                </>
                              ) : (
                                <>
                                  <AlertTriangle className="w-4 h-4 text-rose-600 shrink-0" />
                                  <span>यो प्रश्नमा निम्न समस्याहरू फेला परे (Issues Found):</span>
                                </>
                              )}
                            </div>
                            {!qVal.valid && qVal.errors.length > 0 && (
                              <ul className="mt-1.5 space-y-1 pl-4 list-disc text-[11px] text-rose-800 font-medium">
                                {qVal.errors.map((err, eIdx) => (
                                  <li key={eIdx}>{err}</li>
                                ))}
                              </ul>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                  {/* Basic Details */}
                  <div className="space-y-3 bg-white p-3 rounded-xl border border-slate-200 shadow-sm min-w-0">
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-bold text-slate-700 font-nepali">
                          प्रश्न शीर्षक नेपाली (Nepali Label) *
                        </label>
                        <span className="text-[10px] text-gov-blue-700 bg-gov-blue-50 px-1.5 py-0.2 rounded font-semibold font-nepali">
                          नेपाली मात्र
                        </span>
                      </div>
                      <input
                        type="text"
                        placeholder="प्रश्नको नाम नेपालीमा लेख्नुहोस्..."
                        value={selectedQuestion.label_ne || ''}
                        onChange={(e) =>
                          handleUpdateQuestion(selectedQuestion.id, {
                            label_ne: filterNepaliOnly(e.target.value),
                          })
                        }
                        className={`w-full text-xs px-2.5 py-1.5 rounded-lg border font-nepali ${
                          questionValidationResults[selectedQuestion.id] && !questionValidationResults[selectedQuestion.id].valid && !String(selectedQuestion.label_ne || selectedQuestion.label || '').trim()
                            ? 'border-rose-500 bg-rose-50/30 ring-1 ring-rose-400 focus:ring-rose-500'
                            : 'border-slate-300 focus:ring-gov-blue-500'
                        } focus:outline-none focus:ring-1`}
                      />
                    </div>

                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <label className="text-xs font-bold text-slate-700">
                          Display Label (English)
                        </label>
                        <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded font-semibold">
                          English only
                        </span>
                      </div>
                      <input
                        type="text"
                        placeholder="Question label in English..."
                        value={selectedQuestion.label || ''}
                        onChange={(e) =>
                          handleUpdateQuestion(selectedQuestion.id, {
                            label: filterEnglishOnly(e.target.value),
                          })
                        }
                        className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500"
                      />
                    </div>

                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Internal Key (PostGIS) *
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. house_owner"
                          value={selectedQuestion.name || ''}
                          onChange={(e) => {
                            const cleanKey = filterKeyIdentifier(e.target.value);
                            handleUpdateQuestion(selectedQuestion.id, {
                              name: cleanKey,
                              gis_binding: selectedQuestion.gis_binding ? selectedQuestion.gis_binding : cleanKey,
                            });
                          }}
                          className={`w-full text-xs px-2 py-1.5 rounded-lg border font-mono text-slate-800 ${
                            questionValidationResults[selectedQuestion.id] && !questionValidationResults[selectedQuestion.id].valid && (!String(selectedQuestion.name || '').trim() || questionValidationResults[selectedQuestion.id].errors.some(e => e.includes('कुञ्जी')))
                              ? 'border-rose-500 bg-rose-50/30 ring-1 ring-rose-400 focus:ring-rose-500'
                              : 'border-slate-300 focus:ring-gov-blue-500'
                          }`}
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          GIS Column Binding
                        </label>
                        <input
                          type="text"
                          placeholder="e.g. house_owner"
                          value={selectedQuestion.gis_binding || ''}
                          onChange={(e) =>
                            handleUpdateQuestion(selectedQuestion.id, {
                              gis_binding: filterKeyIdentifier(e.target.value),
                            })
                          }
                          className="w-full text-xs px-2 py-1.5 rounded-lg border border-slate-300 font-mono text-slate-800"
                        />
                      </div>
                    </div>

                    <div>
                      <label className="block text-[11px] font-bold text-slate-600 mb-1">
                        Question Type (प्रश्नको प्रकार)
                      </label>
                      <div className="relative">
                        <button
                          type="button"
                          onClick={() => setShowTypeDropdown((prev) => !prev)}
                          className="w-full text-xs px-2.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 flex items-center justify-between transition-colors shadow-xs"
                        >
                          <div className="flex items-center gap-1.5 min-w-0 truncate">
                            <span className="text-xs font-bold font-nepali text-gov-blue-900 truncate">
                              {QUESTION_TYPES.find((t) => t.id === selectedQuestion.type)?.label || selectedQuestion.type}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.2 bg-slate-100 text-slate-500 rounded shrink-0">
                              {QUESTION_TYPES.find((t) => t.id === selectedQuestion.type)?.category}
                            </span>
                          </div>
                          {showTypeDropdown ? (
                            <ChevronUp className="w-3.5 h-3.5 text-slate-500 shrink-0 ml-1" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0 ml-1" />
                          )}
                        </button>

                        {showTypeDropdown && (
                          <>
                            <div
                              className="fixed inset-0 z-30"
                              onClick={() => setShowTypeDropdown(false)}
                            />
                            <div className="absolute left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-2xl z-40 max-h-64 overflow-y-auto scrollbar-thin p-1.5 animate-fade-in">
                              {QUESTION_TYPES.map((t) => (
                                <button
                                  key={t.id}
                                  type="button"
                                  onClick={() => {
                                    handleUpdateQuestion(selectedQuestion.id, { type: t.id });
                                    setShowTypeDropdown(false);
                                  }}
                                  className={`w-full text-left px-2.5 py-1.5 text-xs rounded-lg flex items-center justify-between transition-colors ${
                                    selectedQuestion.type === t.id
                                      ? 'bg-gov-blue-50 text-gov-blue-900 font-bold'
                                      : 'text-slate-700 hover:bg-slate-100'
                                  }`}
                                >
                                  <span className="font-nepali">{t.label}</span>
                                  <span className="text-[10px] px-1 bg-slate-100 text-slate-500 rounded">{t.category}</span>
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    </div>

                    {/* Help Text / Hint Template Inputs */}
                    <div className="grid grid-cols-1 gap-2 pt-1 border-t border-slate-100">
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1 font-nepali">
                          सहायक निर्देशन नेपाली (Help Text Nepali)
                        </label>
                        <input
                          type="text"
                          placeholder="सर्वेक्षकका लागि संक्षिप्त निर्देशन..."
                          value={selectedQuestion.help_text_ne || ''}
                          onChange={(e) =>
                            handleUpdateQuestion(selectedQuestion.id, {
                              help_text_ne: e.target.value,
                            })
                          }
                          className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300 font-nepali"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-bold text-slate-600 mb-1">
                          Help Text (English)
                        </label>
                        <input
                          type="text"
                          placeholder="Optional hint or instruction in English..."
                          value={selectedQuestion.help_text || ''}
                          onChange={(e) =>
                            handleUpdateQuestion(selectedQuestion.id, {
                              help_text: e.target.value,
                            })
                          }
                          className="w-full text-xs px-2.5 py-1.5 rounded-lg border border-slate-300"
                        />
                      </div>
                    </div>

                    <div className="flex items-center justify-between pt-1 border-t border-slate-100">
                      <span className="text-xs font-bold text-slate-700 font-nepali">अनिवार्य प्रश्न (Required)</span>
                      <input
                        type="checkbox"
                        checked={Boolean(selectedQuestion.required)}
                        onChange={(e) => handleUpdateQuestion(selectedQuestion.id, { required: e.target.checked })}
                        className="w-4 h-4 rounded text-gov-blue-600 focus:ring-gov-blue-500"
                      />
                    </div>
                  </div>

                  {/* Choice Manager (for selection types — Blank Option Template Rows) */}
                  {CHOICE_QUESTION_TYPES.includes(selectedQuestion.type) && (
                    <div className={`p-3 rounded-xl border shadow-sm space-y-2 min-w-0 ${
                      questionValidationResults[selectedQuestion.id] && !questionValidationResults[selectedQuestion.id].valid && (!selectedQuestion.options || selectedQuestion.options.length === 0 || questionValidationResults[selectedQuestion.id].errors.some(e => e.includes('विकल्प')))
                        ? 'bg-rose-50/20 border-rose-400 ring-1 ring-rose-300'
                        : 'bg-white border-slate-200'
                    }`}>
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-bold text-slate-700 font-nepali">छनोटका विकल्पहरू (Choices Template)</span>
                        <button
                          type="button"
                          onClick={() => {
                            const cur = selectedQuestion.options || [];
                            handleUpdateQuestion(selectedQuestion.id, {
                              options: [...cur, createBlankOptionTemplate()],
                            });
                          }}
                          className="text-[11px] font-bold text-gov-blue-700 hover:text-gov-blue-900 flex items-center gap-1 font-nepali"
                        >
                          <Plus className="w-3 h-3" />
                          <span>विकल्प थप्नुहोस्</span>
                        </button>
                      </div>

                      <div className="space-y-1.5">
                        {(selectedQuestion.options || []).map((opt, oIdx) => (
                          <div key={oIdx} className="flex flex-col gap-1 p-2 bg-slate-50 rounded-lg border border-slate-200">
                            <div className="flex items-center gap-1.5">
                              <input
                                type="text"
                                placeholder="Key (e.g. opt_1)"
                                value={opt.value || ''}
                                onChange={(e) => {
                                  const newOpts = [...(selectedQuestion.options || [])];
                                  newOpts[oIdx] = {
                                    ...newOpts[oIdx],
                                    value: filterKeyIdentifier(e.target.value),
                                  };
                                  handleUpdateQuestion(selectedQuestion.id, { options: newOpts });
                                }}
                                className="w-24 text-[11px] px-1.5 py-1 rounded border border-slate-300 font-mono bg-white"
                                title="Option Key (English/ASCII)"
                              />
                              <input
                                type="text"
                                placeholder="नेपाली विकल्प लेख्नुहोस्..."
                                value={opt.label_ne || ''}
                                onChange={(e) => {
                                  const newOpts = [...(selectedQuestion.options || [])];
                                  newOpts[oIdx] = {
                                    ...newOpts[oIdx],
                                    label_ne: filterNepaliOnly(e.target.value),
                                  };
                                  handleUpdateQuestion(selectedQuestion.id, { options: newOpts });
                                }}
                                className="flex-1 text-[11px] px-2 py-1 rounded border border-slate-300 font-nepali bg-white"
                                title="Nepali Label (Nepali only)"
                              />
                              <button
                                type="button"
                                onClick={() => {
                                  const newOpts = (selectedQuestion.options || []).filter((_, i) => i !== oIdx);
                                  handleUpdateQuestion(selectedQuestion.id, { options: newOpts });
                                }}
                                className="p-1 text-slate-400 hover:text-rose-600 rounded"
                                title="मेटाउनुहोस्"
                              >
                                <Trash2 className="w-3.5 h-3.5" />
                              </button>
                            </div>
                            <input
                              type="text"
                              placeholder="English Option Label (English only)..."
                              value={opt.label || ''}
                              onChange={(e) => {
                                const newOpts = [...(selectedQuestion.options || [])];
                                newOpts[oIdx] = {
                                  ...newOpts[oIdx],
                                  label: filterEnglishOnly(e.target.value),
                                };
                                handleUpdateQuestion(selectedQuestion.id, { options: newOpts });
                              }}
                              className="w-full text-[11px] px-2 py-1 rounded border border-slate-200 text-slate-700 bg-white"
                              title="English Label (English only)"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Conditional Logic / Skip Logic Builder */}
                  <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm space-y-2.5 min-w-0 overflow-hidden">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-slate-700 font-nepali">सर्त / स्किप लजिक (Skip Logic)</span>
                      <button
                        type="button"
                        onClick={() => {
                          const cur = selectedQuestion.conditions || [];
                          handleUpdateQuestion(selectedQuestion.id, {
                            conditions: [
                              ...cur,
                              { depends_on: '', operator: '==', value: '' },
                            ],
                          });
                        }}
                        className="text-[11px] font-bold text-gov-blue-700 hover:text-gov-blue-900 flex items-center gap-1 font-nepali"
                      >
                        <Plus className="w-3 h-3" />
                        <span>सर्त थप्नुहोस्</span>
                      </button>
                    </div>

                    {(selectedQuestion.conditions || []).length > 1 && (
                      <div className="flex items-center justify-between p-2 bg-gov-blue-50/70 rounded-lg border border-gov-blue-200">
                        <span className="text-[11px] font-bold text-gov-blue-900 font-nepali">
                          सर्त मिलान:
                        </span>
                        <div className="flex bg-white rounded border border-gov-blue-300 p-0.5 text-xs font-bold">
                          <button
                            type="button"
                            onClick={() => handleUpdateQuestion(selectedQuestion.id, { condition_logic: 'AND' })}
                            className={`px-2 py-0.5 rounded ${
                              (selectedQuestion.condition_logic || 'AND') === 'AND'
                                ? 'bg-gov-blue-800 text-white'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            AND (सबै)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUpdateQuestion(selectedQuestion.id, { condition_logic: 'OR' })}
                            className={`px-2 py-0.5 rounded ${
                              selectedQuestion.condition_logic === 'OR'
                                ? 'bg-gov-blue-800 text-white'
                                : 'text-slate-600 hover:text-slate-900'
                            }`}
                          >
                            OR (कुनै एक)
                          </button>
                        </div>
                      </div>
                    )}

                    {(selectedQuestion.conditions || []).length === 0 ? (
                      <p className="text-[11px] text-slate-400">यो प्रश्न सधैं देखिन्छ (Always visible).</p>
                    ) : (
                      selectedQuestion.conditions.map((cond, cIdx) => {
                        const targetQ = questions.find((q) => q.name && q.name === cond.depends_on);
                        return (
                          <div key={cIdx} className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 space-y-2 text-xs min-w-0 overflow-hidden">
                            <div className="flex items-center justify-between">
                              <span className="text-[10px] font-bold text-slate-500 uppercase">
                                IF (सर्त #{cIdx + 1})
                              </span>
                              <button
                                type="button"
                                onClick={() => {
                                  const updated = selectedQuestion.conditions.filter((_, i) => i !== cIdx);
                                  handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                }}
                                className="text-slate-400 hover:text-rose-600 p-0.5 rounded"
                                title="सर्त हटाउनुहोस्"
                              >
                                <X className="w-3.5 h-3.5" />
                              </button>
                            </div>

                            {/* 1. Target Question */}
                            <div>
                              <label className="block text-[10px] font-semibold text-slate-600 mb-0.5 font-nepali">
                                प्रश्न छनोट (Depends On Question)
                              </label>
                              <select
                                value={cond.depends_on}
                                onChange={(e) => {
                                  const updated = [...selectedQuestion.conditions];
                                  updated[cIdx] = { ...updated[cIdx], depends_on: e.target.value, value: '' };
                                  handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                }}
                                className="w-full text-xs p-1.5 border border-slate-300 rounded bg-white truncate font-nepali"
                              >
                                <option value="">-- प्रश्न छनोट गर्नुहोस् --</option>
                                {questions
                                  .filter((q) => q.id !== selectedQuestion.id && q.name)
                                  .map((q) => (
                                    <option key={q.id} value={q.name}>
                                      {q.label_ne || q.label || q.name} [{q.name}]
                                    </option>
                                  ))}
                              </select>
                            </div>

                            {/* 2. Operator */}
                            <div>
                              <label className="block text-[10px] font-semibold text-slate-600 mb-0.5 font-nepali">
                                सर्त (Operator)
                              </label>
                              <select
                                value={cond.operator || '=='}
                                onChange={(e) => {
                                  const updated = [...selectedQuestion.conditions];
                                  updated[cIdx] = { ...updated[cIdx], operator: e.target.value };
                                  handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                }}
                                className="w-full text-xs p-1.5 border border-slate-300 rounded bg-white truncate font-nepali"
                              >
                                {SKIP_OPERATORS.map((op) => (
                                  <option key={op.id} value={op.id}>
                                    {op.label}
                                  </option>
                                ))}
                              </select>
                            </div>

                            {/* 3. Expected Value */}
                            <div>
                              <label className="block text-[10px] font-semibold text-slate-600 mb-0.5 font-nepali">
                                अपेक्षित मान (Expected Value)
                              </label>
                              {['is_empty', 'is_not_empty'].includes(cond.operator) ? (
                                <div className="p-1.5 bg-slate-200/70 rounded text-[11px] text-slate-600 font-nepali">
                                  ✓ मान आवश्यक पर्दैन
                                </div>
                              ) : targetQ?.type === 'yes_no' ? (
                                <select
                                  value={cond.value}
                                  onChange={(e) => {
                                    const updated = [...selectedQuestion.conditions];
                                    updated[cIdx] = { ...updated[cIdx], value: e.target.value };
                                    handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                  }}
                                  className="w-full text-xs p-1.5 border border-slate-300 rounded bg-white font-nepali"
                                >
                                  <option value="">-- उत्तर छान्नुहोस् --</option>
                                  <option value="yes">हो (Yes)</option>
                                  <option value="no">होइन (No)</option>
                                </select>
                              ) : CHOICE_QUESTION_TYPES.includes(targetQ?.type) && targetQ?.options?.length > 0 ? (
                                <select
                                  value={cond.value}
                                  onChange={(e) => {
                                    const updated = [...selectedQuestion.conditions];
                                    updated[cIdx] = { ...updated[cIdx], value: e.target.value };
                                    handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                  }}
                                  className="w-full text-xs p-1.5 border border-slate-300 rounded bg-white font-nepali truncate"
                                >
                                  <option value="">-- विकल्प छनोट गर्नुहोस् --</option>
                                  {targetQ.options
                                    .filter((opt) => opt.value)
                                    .map((opt, idxOpt) => (
                                      <option key={`${opt.value}_${idxOpt}`} value={opt.value}>
                                        {opt.label_ne || opt.label || opt.value} ({opt.value})
                                      </option>
                                    ))}
                                </select>
                              ) : ['number', 'decimal', 'currency'].includes(targetQ?.type) ? (
                                <input
                                  type="number"
                                  placeholder="मान लेख्नुहोस्..."
                                  value={cond.value}
                                  onChange={(e) => {
                                    const updated = [...selectedQuestion.conditions];
                                    updated[cIdx] = { ...updated[cIdx], value: e.target.value };
                                    handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                  }}
                                  className="w-full text-xs p-1.5 border border-slate-300 rounded bg-white font-mono"
                                />
                              ) : (
                                <input
                                  type="text"
                                  placeholder="अपेक्षित मान लेख्नुहोस्..."
                                  value={cond.value}
                                  onChange={(e) => {
                                    const updated = [...selectedQuestion.conditions];
                                    updated[cIdx] = { ...updated[cIdx], value: e.target.value };
                                    handleUpdateQuestion(selectedQuestion.id, { conditions: updated });
                                  }}
                                  className="w-full text-xs p-1.5 border border-slate-300 rounded bg-white"
                                />
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Calculations & Formula (for calculated types) */}
                  {selectedQuestion.type === 'calculated' && (
                    <div className={`p-3 rounded-xl border shadow-sm space-y-2 ${
                      questionValidationResults[selectedQuestion.id] && !questionValidationResults[selectedQuestion.id].valid && !String(selectedQuestion.calculation?.formula || '').trim()
                        ? 'bg-rose-50/20 border-rose-400 ring-1 ring-rose-300'
                        : 'bg-white border-slate-200'
                    }`}>
                      <span className="text-xs font-bold text-slate-700 font-nepali">गणना सूत्र (Formula Template)</span>
                      <input
                        type="text"
                        placeholder="उदाहरण: length * width"
                        value={selectedQuestion.calculation?.formula || ''}
                        onChange={(e) =>
                          handleUpdateQuestion(selectedQuestion.id, {
                            calculation: { formula: e.target.value },
                          })
                        }
                        className={`w-full text-xs px-2.5 py-1.5 rounded-lg border font-mono ${
                          questionValidationResults[selectedQuestion.id] && !questionValidationResults[selectedQuestion.id].valid && !String(selectedQuestion.calculation?.formula || '').trim()
                            ? 'border-rose-500 bg-rose-50/30'
                            : 'border-slate-300'
                        }`}
                      />
                      <p className="text-[10px] text-slate-500">
                        अन्य प्रश्नका key हरू प्रयोग गरी गणितीय सूत्र लेख्नुहोस्।
                      </p>
                    </div>
                  )}

                  {/* Validation Limits */}
                  <div className="bg-white p-3 rounded-xl border border-slate-200 shadow-sm space-y-2">
                    <span className="text-xs font-bold text-slate-700 font-nepali">मान सीमा (Validation Limits)</span>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">न्यूनतम (Min)</label>
                        <input
                          type="number"
                          placeholder="Min"
                          value={selectedQuestion.validation?.min ?? ''}
                          onChange={(e) =>
                            handleUpdateQuestion(selectedQuestion.id, {
                              validation: {
                                ...selectedQuestion.validation,
                                min: e.target.value !== '' ? Number(e.target.value) : undefined,
                              },
                            })
                          }
                          className="w-full text-xs p-1.5 border border-slate-300 rounded"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] text-slate-500 mb-0.5">अधिकतम (Max)</label>
                        <input
                          type="number"
                          placeholder="Max"
                          value={selectedQuestion.validation?.max ?? ''}
                          onChange={(e) =>
                            handleUpdateQuestion(selectedQuestion.id, {
                              validation: {
                                ...selectedQuestion.validation,
                                max: e.target.value !== '' ? Number(e.target.value) : undefined,
                              },
                            })
                          }
                          className="w-full text-xs p-1.5 border border-slate-300 rounded"
                        />
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="flex flex-col items-center justify-center h-64 text-slate-400">
                  <HelpCircle className="w-10 h-10 stroke-[1.2] mb-2" />
                  <p className="text-xs font-nepali">कुनै प्रश्न छनोट गरिएको छैन।</p>
                  <p className="text-[11px]">बायाँबाट प्रश्न छान्नुहोस् वा नयाँ प्रश्न थप्नुहोस्।</p>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Live Preview Mode */}
      {viewMode === 'preview' && (
        <div className="flex-1 flex flex-col bg-slate-100 p-6 overflow-y-auto items-center">
          <div className="w-full max-w-2xl bg-white rounded-2xl shadow-xl border border-slate-200 overflow-hidden flex flex-col min-h-0">
            {/* Preview Banner */}
            <div className="px-6 py-4 bg-gradient-to-r from-gov-blue-900 to-gov-blue-800 text-white flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-wider text-gov-gold-400 font-bold">
                  प्रत्यक्ष पूर्वावलोकन (Live Questionnaire Preview)
                </div>
                <h3 className="text-base font-bold font-nepali mt-0.5">
                  {title.trim() ? title : 'प्रश्नावली शीर्षक भरिएको छैन (Untitled Questionnaire Template)'}
                </h3>
              </div>

              {/* Language Switcher */}
              <div className="flex items-center gap-1 bg-gov-blue-950/60 p-1 rounded-lg border border-gov-blue-700/50">
                <button
                  type="button"
                  onClick={() => setPreviewLanguage('ne')}
                  className={`px-2.5 py-1 text-xs font-bold rounded ${
                    previewLanguage === 'ne' ? 'bg-gov-gold-500 text-gov-blue-950 shadow-sm' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  नेपाली
                </button>
                <button
                  type="button"
                  onClick={() => setPreviewLanguage('en')}
                  className={`px-2.5 py-1 text-xs font-bold rounded ${
                    previewLanguage === 'en' ? 'bg-gov-gold-500 text-gov-blue-950 shadow-sm' : 'text-slate-300 hover:text-white'
                  }`}
                >
                  English
                </button>
              </div>
            </div>

            {/* Simulated Form Body */}
            <div className="p-6 space-y-6 overflow-y-auto">
              {sections.map((sec, sIdx) => {
                const secQs = questions.filter((q) => q.section_id === sec.id);
                const secHeading =
                  previewLanguage === 'ne'
                    ? sec.title_ne || sec.title || `खण्ड #${sIdx + 1} (शीर्षक खाली छ)`
                    : sec.title || sec.title_ne || `Section #${sIdx + 1} (Untitled)`;
                return (
                  <div key={sec.id} className="border border-slate-200 rounded-xl overflow-hidden shadow-sm">
                    <div className="px-4 py-2.5 bg-slate-50 border-b border-slate-200 flex items-center gap-2">
                      <span className="w-6 h-6 rounded-full bg-gov-blue-800 text-white flex items-center justify-center text-xs font-bold">
                        {sIdx + 1}
                      </span>
                      <h4 className="text-sm font-bold text-slate-800 font-nepali">
                        {secHeading}
                      </h4>
                    </div>

                    <div className="p-4 space-y-4">
                      {secQs.map((q, qIdx) => {
                        const isVisible = evaluateQuestionVisibility(q, previewAnswers);
                        if (!isVisible) return null;

                        const fieldKey = q.name || q.id;
                        const labelText =
                          previewLanguage === 'ne'
                            ? q.label_ne || q.label || `प्रश्न #${qIdx + 1} (शीर्षक खाली छ)`
                            : q.label || q.label_ne || `Question #${qIdx + 1} (Untitled)`;

                        return (
                          <div key={q.id} className="space-y-1.5 animate-fade-in">
                            <label className="block text-xs font-bold text-slate-700 font-nepali">
                              {labelText}
                              {q.required && <span className="text-rose-600 ml-1">*</span>}
                            </label>

                            {['text', 'nepali_text', 'phone', 'email'].includes(q.type) && (
                              <input
                                type="text"
                                value={previewAnswers[fieldKey] || ''}
                                onChange={(e) => setPreviewAnswers({ ...previewAnswers, [fieldKey]: e.target.value })}
                                className="w-full text-xs px-3 py-2 border rounded-lg focus:ring-1 focus:ring-gov-blue-500"
                              />
                            )}

                            {q.type === 'textarea' && (
                              <textarea
                                rows={2}
                                value={previewAnswers[fieldKey] || ''}
                                onChange={(e) => setPreviewAnswers({ ...previewAnswers, [fieldKey]: e.target.value })}
                                className="w-full text-xs px-3 py-2 border rounded-lg focus:ring-1 focus:ring-gov-blue-500"
                              />
                            )}

                            {['number', 'decimal', 'currency'].includes(q.type) && (
                              <input
                                type="number"
                                value={previewAnswers[fieldKey] || ''}
                                onChange={(e) => setPreviewAnswers({ ...previewAnswers, [fieldKey]: e.target.value })}
                                className="w-full text-xs px-3 py-2 border rounded-lg focus:ring-1 focus:ring-gov-blue-500"
                              />
                            )}

                            {q.type === 'dropdown' && (
                              <select
                                value={previewAnswers[fieldKey] || ''}
                                onChange={(e) => setPreviewAnswers({ ...previewAnswers, [fieldKey]: e.target.value })}
                                className="w-full text-xs px-3 py-2 border rounded-lg bg-white"
                              >
                                <option value="">-- छनोट गर्नुहोस् --</option>
                                {(q.options || []).map((opt, oIdx) => (
                                  <option key={`${opt.value}_${oIdx}`} value={opt.value}>
                                    {previewLanguage === 'ne'
                                      ? opt.label_ne || opt.label || `विकल्प #${oIdx + 1}`
                                      : opt.label || opt.label_ne || `Option #${oIdx + 1}`}
                                  </option>
                                ))}
                              </select>
                            )}

                            {q.type === 'single_choice' && (
                              <div className="space-y-1 pt-1">
                                {(q.options || []).map((opt, oIdx) => (
                                  <label key={`${opt.value}_${oIdx}`} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer font-nepali">
                                    <input
                                      type="radio"
                                      name={fieldKey}
                                      value={opt.value}
                                      checked={previewAnswers[fieldKey] === opt.value}
                                      onChange={() => setPreviewAnswers({ ...previewAnswers, [fieldKey]: opt.value })}
                                      className="text-gov-blue-600"
                                    />
                                    <span>
                                      {previewLanguage === 'ne'
                                        ? opt.label_ne || opt.label || `विकल्प #${oIdx + 1}`
                                        : opt.label || opt.label_ne || `Option #${oIdx + 1}`}
                                    </span>
                                  </label>
                                ))}
                              </div>
                            )}

                            {q.type === 'yes_no' && (
                              <div className="flex items-center gap-4 pt-1 font-nepali text-xs">
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={fieldKey}
                                    value="yes"
                                    checked={previewAnswers[fieldKey] === 'yes'}
                                    onChange={() => setPreviewAnswers({ ...previewAnswers, [fieldKey]: 'yes' })}
                                    className="text-gov-blue-600"
                                  />
                                  <span>{previewLanguage === 'ne' ? 'हो' : 'Yes'}</span>
                                </label>
                                <label className="flex items-center gap-1.5 cursor-pointer">
                                  <input
                                    type="radio"
                                    name={fieldKey}
                                    value="no"
                                    checked={previewAnswers[fieldKey] === 'no'}
                                    onChange={() => setPreviewAnswers({ ...previewAnswers, [fieldKey]: 'no' })}
                                    className="text-gov-blue-600"
                                  />
                                  <span>{previewLanguage === 'ne' ? 'होइन' : 'No'}</span>
                                </label>
                              </div>
                            )}

                            {q.type === 'multiple_choice' && (
                              <div className="space-y-1 pt-1">
                                {(q.options || []).map((opt, oIdx) => {
                                  const selectedList = previewAnswers[fieldKey] || [];
                                  const isChecked = selectedList.includes(opt.value);
                                  return (
                                    <label key={`${opt.value}_${oIdx}`} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer font-nepali">
                                      <input
                                        type="checkbox"
                                        checked={isChecked}
                                        onChange={() => {
                                          const updated = isChecked
                                            ? selectedList.filter((v) => v !== opt.value)
                                            : [...selectedList, opt.value];
                                          setPreviewAnswers({ ...previewAnswers, [fieldKey]: updated });
                                        }}
                                        className="text-gov-blue-600 rounded"
                                      />
                                      <span>
                                        {previewLanguage === 'ne'
                                          ? opt.label_ne || opt.label || `विकल्प #${oIdx + 1}`
                                          : opt.label || opt.label_ne || `Option #${oIdx + 1}`}
                                      </span>
                                    </label>
                                  );
                                })}
                              </div>
                            )}

                            {q.type === 'photo' && (
                              <div className="p-4 border-2 border-dashed border-slate-300 rounded-xl text-center text-slate-400 text-xs">
                                फोटो क्याप्चर क्षेत्र (Camera Capture Sandbox)
                              </div>
                            )}

                            {q.type === 'gps_coordinate' && (
                              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl flex items-center justify-between text-xs">
                                <span className="font-mono text-slate-600">GPS Coordinates Sandbox</span>
                                <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded font-bold text-[10px]">GPS Ready</span>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Validation Report View */}
      {viewMode === 'validation' && (
        <div className="flex-1 flex flex-col bg-slate-100 p-6 overflow-y-auto items-center">
          <div className="w-full max-w-xl bg-white rounded-2xl shadow-xl border border-slate-200 p-6 space-y-4">
            <div className="flex items-center justify-between border-b pb-3">
              <div className="flex items-center gap-2">
                <ShieldCheck className="w-6 h-6 text-gov-blue-800" />
                <h3 className="text-base font-bold font-nepali text-slate-800">
                  प्रश्नावली प्रमाणीकरण रिपोर्ट (Pre-Publish Verification)
                </h3>
              </div>
              <button
                type="button"
                onClick={handleRunValidation}
                disabled={validating}
                className="p-1.5 text-slate-500 hover:text-slate-800"
              >
                <RefreshCw className={`w-4 h-4 ${validating ? 'animate-spin' : ''}`} />
              </button>
            </div>

            {validationReport ? (
              <div className="space-y-4">
                <div className={`p-4 rounded-xl border flex items-center gap-3 ${
                  validationReport.valid
                    ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                    : 'bg-rose-50 border-rose-200 text-rose-900'
                }`}>
                  {validationReport.valid ? (
                    <CheckCircle2 className="w-6 h-6 text-emerald-600 shrink-0" />
                  ) : (
                    <AlertTriangle className="w-6 h-6 text-rose-600 shrink-0" />
                  )}
                  <div>
                    <h4 className="font-bold text-sm">
                      {validationReport.valid ? 'संरचना पूर्ण रूपमा प्रमाणित (Schema Valid)' : 'टेम्प्लेटमा अपूरा फिल्ड वा त्रुटिहरू फेला परे (Template Incomplete)'}
                    </h4>
                    <p className="text-xs mt-0.5 opacity-90">
                      {validationReport.valid
                        ? 'प्रश्नावली प्रकाशित गर्न पूर्ण रूपमा तयार छ। सबै कुञ्जीहरू, सर्तहरू तथा संरचना सही छन्।'
                        : 'कृपया तलका खाली टेम्प्लेट फिल्डहरू भरेर पुनः जाँच गर्नुहोस्।'}
                    </p>
                  </div>
                </div>

                {validationReport.errors && validationReport.errors.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-bold text-rose-800 uppercase tracking-wide">
                      त्रुटिहरू (Critical Errors - {validationReport.errors.length})
                    </span>
                    <ul className="space-y-1.5">
                      {validationReport.errors.map((err, i) => {
                        const matchingIssue = (validationReport.issues || []).find((iss) => iss.message === err) ||
                          (() => {
                            const qMatch = err.match(/प्रश्न\s*#(\d+)/);
                            if (qMatch && questions[parseInt(qMatch[1], 10) - 1]) {
                              const q = questions[parseInt(qMatch[1], 10) - 1];
                              return { targetType: 'question', sectionId: q.section_id, questionId: q.id };
                            }
                            const sMatch = err.match(/खण्ड\s*#(\d+)/);
                            if (sMatch && sections[parseInt(sMatch[1], 10) - 1]) {
                              const s = sections[parseInt(sMatch[1], 10) - 1];
                              return { targetType: 'section', sectionId: s.id };
                            }
                            if (err.includes('शीर्षक') || err.includes('Title')) {
                              return { targetType: 'header' };
                            }
                            return { targetType: 'header', message: err };
                          })();

                        return (
                          <li key={i} className="text-xs text-rose-800 bg-rose-50/80 p-2.5 rounded-lg border border-rose-200 flex items-center justify-between gap-2 font-nepali">
                            <div className="flex items-start gap-2 min-w-0 flex-1">
                              <X className="w-4 h-4 shrink-0 mt-0.5 text-rose-600" />
                              <span className="break-words leading-relaxed">{err}</span>
                            </div>
                            {matchingIssue && (
                              <button
                                type="button"
                                onClick={() => handleNavigateToIssue(matchingIssue)}
                                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold text-rose-900 bg-white hover:bg-rose-100 rounded-lg border border-rose-300 transition-colors shadow-2xs cursor-pointer"
                                title="यो त्रुटि भएको स्थानमा सिधै जानुहोस् (Jump directly to fix this issue)"
                              >
                                <ExternalLink className="w-3.5 h-3.5 text-rose-700" />
                                <span>सच्याउनुहोस्</span>
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                {validationReport.warnings && validationReport.warnings.length > 0 && (
                  <div className="space-y-2">
                    <span className="text-xs font-bold text-amber-800 uppercase tracking-wide">
                      चेतावनीहरू (Warnings - {validationReport.warnings.length})
                    </span>
                    <ul className="space-y-1.5">
                      {validationReport.warnings.map((warn, i) => {
                        const matchingIssue = (validationReport.issues || []).find((iss) => iss.message === warn) ||
                          (() => {
                            const qMatch = warn.match(/प्रश्न\s*#(\d+)/);
                            if (qMatch && questions[parseInt(qMatch[1], 10) - 1]) {
                              const q = questions[parseInt(qMatch[1], 10) - 1];
                              return { targetType: 'question', sectionId: q.section_id, questionId: q.id };
                            }
                            const sMatch = warn.match(/खण्ड\s*#(\d+)/);
                            if (sMatch && sections[parseInt(sMatch[1], 10) - 1]) {
                              const s = sections[parseInt(sMatch[1], 10) - 1];
                              return { targetType: 'section', sectionId: s.id };
                            }
                            return { targetType: 'header', message: warn };
                          })();

                        return (
                          <li key={i} className="text-xs text-amber-900 bg-amber-50/80 p-2.5 rounded-lg border border-amber-200 flex items-center justify-between gap-2 font-nepali">
                            <div className="flex items-start gap-2 min-w-0 flex-1">
                              <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5 text-amber-600" />
                              <span className="break-words leading-relaxed">{warn}</span>
                            </div>
                            {matchingIssue && (
                              <button
                                type="button"
                                onClick={() => handleNavigateToIssue(matchingIssue)}
                                className="shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[11px] font-bold text-amber-900 bg-white hover:bg-amber-100 rounded-lg border border-amber-300 transition-colors shadow-2xs cursor-pointer"
                                title="यो चेतावनी भएको स्थानमा जानुहोस् (View warning location)"
                              >
                                <ExternalLink className="w-3.5 h-3.5 text-amber-700" />
                                <span>हेर्नुहोस्</span>
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  </div>
                )}

                <div className="pt-4 border-t flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setViewMode('editor')}
                    className="px-4 py-2 bg-slate-200 hover:bg-slate-300 text-slate-800 text-xs font-bold rounded-lg font-nepali"
                  >
                    बिल्डरमा फर्कनुहोस्
                  </button>
                  {validationReport.valid && (
                    <button
                      type="button"
                      onClick={handlePublish}
                      className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg font-nepali shadow-md"
                    >
                      अहिले प्रकाशित गर्नुहोस् (Publish Now)
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-8 text-slate-400 text-xs font-nepali">
                परीक्षण गरिँदैछ...
              </div>
            )}
          </div>
        </div>
      )}

      {/* Section Edit Modal */}
      {editingSection && (
        <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in font-sans">
          <div className="bg-white rounded-2xl border border-slate-300 shadow-2xl w-full max-w-md max-h-[90dvh] flex flex-col overflow-hidden animate-scale-in">
            <div className="px-4 py-3 bg-gov-blue-800 text-white flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                <Pencil className="w-4 h-4 text-gov-gold-400" />
                <h3 className="text-xs font-bold font-nepali">खण्ड विवरण भर्नुहोस् (Edit Section Template)</h3>
              </div>
              <button
                type="button"
                onClick={() => setEditingSection(null)}
                className="text-gov-blue-200 hover:text-white p-1 rounded"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-4 space-y-3 flex-1 overflow-y-auto">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-700 font-nepali">
                    खण्डको नाम नेपाली (Nepali Title) *
                  </label>
                  <span className="text-[10px] text-gov-blue-700 bg-gov-blue-50 px-1.5 py-0.2 rounded font-semibold font-nepali">
                    नेपाली मात्र
                  </span>
                </div>
                <input
                  type="text"
                  placeholder="उदाहरण: सामान्य विवरण"
                  value={editingSection.title_ne || ''}
                  onChange={(e) =>
                    setEditingSection({ ...editingSection, title_ne: filterNepaliOnly(e.target.value) })
                  }
                  className="w-full text-xs px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500 font-nepali"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs font-bold text-slate-700">
                    Section Title (English)
                  </label>
                  <span className="text-[10px] text-slate-500 bg-slate-100 px-1.5 py-0.2 rounded font-semibold">
                    English only
                  </span>
                </div>
                <input
                  type="text"
                  placeholder="e.g. General Information"
                  value={editingSection.title || ''}
                  onChange={(e) =>
                    setEditingSection({ ...editingSection, title: filterEnglishOnly(e.target.value) })
                  }
                  className="w-full text-xs px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500"
                />
              </div>

              <div>
                <label className="block text-xs font-bold text-slate-700 mb-1 font-nepali">
                  खण्डको विवरण (Description / Instructions)
                </label>
                <textarea
                  rows={2}
                  placeholder="खण्ड सम्बन्धी संक्षिप्त विवरण..."
                  value={editingSection.description || ''}
                  onChange={(e) =>
                    setEditingSection({ ...editingSection, description: e.target.value })
                  }
                  className="w-full text-xs px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500 resize-none font-nepali"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-200">
                <button
                  type="button"
                  onClick={() => setEditingSection(null)}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-semibold text-slate-600 hover:bg-slate-100"
                >
                  रद्द (Cancel)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    handleUpdateSection(editingSection.id, {
                      title: editingSection.title,
                      title_ne: editingSection.title_ne,
                      description: editingSection.description,
                    });
                    setEditingSection(null);
                  }}
                  className="px-4 py-1.5 rounded-lg bg-gov-blue-800 hover:bg-gov-blue-700 text-white text-xs font-bold flex items-center gap-1.5 shadow-sm font-nepali"
                >
                  <Check className="w-3.5 h-3.5" />
                  <span>परिवर्तन सुरक्षित गर्नुहोस्</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Link / Implement Questionnaire on Project Vector Layers */}
      {showLinkLayerModal && (
        <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-xs flex items-center justify-center p-4 animate-fade-in">
          <div className="bg-white rounded-2xl shadow-2xl border border-slate-200 w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden animate-scale-up font-sans">
            {/* Header */}
            <div className="bg-gov-blue-900 text-white p-4 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2.5">
                <div className="p-2 bg-gov-blue-800 rounded-xl text-gov-gold-400">
                  <Link2 className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-sm font-nepali leading-tight">
                    प्रोजेक्टका भेक्टर तहहरूमा प्रश्नावली लागू गर्नुहोस्
                  </h3>
                  <p className="text-[11px] text-gov-blue-200 font-sans mt-0.5">
                    Implement this Questionnaire on Any Linked Vector Layers
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowLinkLayerModal(false)}
                className="text-gov-blue-200 hover:text-white p-1 rounded-lg"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Instruction description banner */}
            <div className="p-3.5 bg-gov-blue-50/70 border-b border-gov-blue-100 flex items-start gap-2.5 text-xs text-gov-blue-950 font-nepali">
              <HelpCircle className="w-4 h-4 text-gov-blue-700 shrink-0 mt-0.5" />
              <span>
                तलका कुनै पनि भेक्टर तहमा <strong>&ldquo;लागू गर्नुहोस् (Apply)&rdquo;</strong> थिचेर यो प्रश्नावलीलाई सो तहसँग जोड्न सक्नुहुन्छ। त्यसपछि नक्सामा सो तह सक्रिय राखी नयाँ फिचर (Point/Line/Polygon) कोर्दा यही प्रश्नावली स्वतः खुल्नेछ।
              </span>
            </div>

            {/* Layers List */}
            <div className="flex-1 overflow-y-auto p-4 space-y-2.5 min-h-0 scrollbar-thin">
              {linkingLoading ? (
                <div className="flex flex-col items-center justify-center py-12 text-slate-400 gap-2 font-nepali text-xs">
                  <RefreshCw className="w-6 h-6 animate-spin text-gov-blue-700" />
                  <span>प्रोजेक्टका तहहरू लोड हुँदैछ...</span>
                </div>
              ) : projectLayersList.length === 0 ? (
                <div className="text-center py-12 text-slate-500 font-nepali space-y-3">
                  <Layers className="w-10 h-10 mx-auto text-slate-300" />
                  <p className="text-xs">
                    {isGlobalStudio
                      ? 'कुनै पनि भेक्टर तह भेटिएन।'
                      : 'यस प्रोजेक्टमा हाल कुनै पनि भेक्टर तह आबद्ध छैन।'}
                  </p>
                  {!isGlobalStudio && (
                    <button
                      type="button"
                      onClick={handleCreateAndLinkNewLayer}
                      className="btn-gov-primary text-xs py-2 px-4 mx-auto inline-flex items-center gap-1.5"
                    >
                      <Plus className="w-4 h-4" />
                      <span>नयाँ भेक्टर तह सिर्जना गरी यो प्रश्नावली लागू गर्नुहोस्</span>
                    </button>
                  )}
                </div>
              ) : (
                projectLayersList.map((layer) => {
                  const isCurrentLinked = Number(layer.questionnaire_id) === Number(activeQId);
                  const isOtherLinked = layer.questionnaire_id && !isCurrentLinked;

                  return (
                    <div
                      key={layer.id}
                      className={`p-3.5 rounded-xl border transition-all flex items-center justify-between gap-3 ${
                        isCurrentLinked
                          ? 'bg-emerald-50/80 border-emerald-400 ring-1 ring-emerald-300 shadow-sm'
                          : 'bg-white border-slate-200 hover:border-slate-300 shadow-xs'
                      }`}
                    >
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1 flex-wrap">
                          <span className="font-bold text-xs text-slate-900 font-nepali">
                            {layer.name}
                          </span>
                          <span className="text-[10px] font-mono px-1.5 py-0.2 bg-slate-100 rounded text-slate-600">
                            {layer.geometry_type || 'Vector'}
                          </span>
                          {layer.feature_count != null && (
                            <span className="text-[10px] text-slate-500 font-nepali">
                              ({layer.feature_count} फिचरहरू)
                            </span>
                          )}
                          {isCurrentLinked && (
                            <span className="text-[10px] font-bold px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300 rounded-full flex items-center gap-1 font-nepali">
                              <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                              <span>यो प्रश्नावली लागू गरिएको छ (Active)</span>
                            </span>
                          )}
                          {isOtherLinked && (
                            <span className="text-[10px] font-bold px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 rounded-full font-nepali">
                              अन्य प्रश्नावली #{layer.questionnaire_id} लागू छ
                            </span>
                          )}
                        </div>
                        {layer.description && (
                          <p className="text-[11px] text-slate-500 font-nepali truncate">
                            {layer.description}
                          </p>
                        )}
                      </div>

                      {/* Action Button */}
                      <div className="shrink-0 flex items-center gap-2">
                        {isCurrentLinked ? (
                          <button
                            type="button"
                            onClick={() => handleUnlinkQuestionnaireFromLayer(layer.id)}
                            disabled={linkingLoading}
                            className="px-3 py-1.5 bg-white hover:bg-rose-50 text-rose-700 hover:text-rose-800 border border-rose-300 rounded-lg text-xs font-bold font-nepali transition-colors shadow-xs"
                          >
                            हटाउनुहोस् (Unlink)
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleApplyQuestionnaireToLayer(layer.id)}
                            disabled={linkingLoading}
                            className="btn-gov-primary text-xs py-1.5 px-3 font-nepali flex items-center gap-1 shadow-sm"
                          >
                            <Check className="w-3.5 h-3.5" />
                            <span>{isOtherLinked ? 'परिवर्तन गरी लागू गर्नुहोस्' : 'लागू गर्नुहोस् (Apply)'}</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer with Create New Layer Option */}
            <div className="p-3 bg-slate-50 border-t border-slate-200 flex items-center justify-between shrink-0 font-nepali">
              {!isGlobalStudio && (
                <button
                  type="button"
                  onClick={handleCreateAndLinkNewLayer}
                  disabled={linkingLoading}
                  className="text-xs font-bold text-gov-blue-800 hover:text-gov-blue-900 flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg hover:bg-gov-blue-50 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span>+ नयाँ भेक्टर तह सिर्जना गरी लागू गर्नुहोस्</span>
                </button>
              )}
              <button
                type="button"
                onClick={() => setShowLinkLayerModal(false)}
                className="px-4 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-700 rounded-lg text-xs font-bold transition-colors"
              >
                बन्द गर्नुहोस् (Close)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
