'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Save, CheckCircle2, ChevronRight, ChevronLeft, ChevronDown, ChevronUp,
  AlertCircle, AlertTriangle, Check, X, Camera, MapPin, Plus, Trash2,
  Search, Globe, Clock, FileText, Layers, Hash, Calendar, Percent,
  HelpCircle, RefreshCw, PenTool, Image, Eye, Cloud, Star, RotateCcw,
  FileUp, Sparkles, CheckSquare
} from 'lucide-react';
import { recordsAPI } from '../../lib/api';
import { formatApiError } from '../../lib/apiError';
import { evaluateQuestionVisibility } from '../../lib/questionnaireUtils';

// Interactive Canvas Signature Pad Subcomponent
function SignaturePad({ value, onChange, disabled, lang = 'ne' }) {
  const canvasRef = useRef(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [hasStroke, setHasStroke] = useState(Boolean(value));

  const startDrawing = (e) => {
    if (disabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#0447af'; // Gov blue
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    ctx.beginPath();
    ctx.moveTo(clientX - rect.left, clientY - rect.top);
    setIsDrawing(true);
  };

  const draw = (e) => {
    if (!isDrawing || disabled) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const ctx = canvas.getContext('2d');
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    ctx.lineTo(clientX - rect.left, clientY - rect.top);
    ctx.stroke();
    setHasStroke(true);
  };

  const stopDrawing = () => {
    if (!isDrawing) return;
    setIsDrawing(false);
    const canvas = canvasRef.current;
    if (canvas) {
      onChange(canvas.toDataURL('image/png'));
    }
  };

  const clearCanvas = () => {
    const canvas = canvasRef.current;
    if (canvas) {
      const ctx = canvas.getContext('2d');
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    setHasStroke(false);
    onChange('');
  };

  return (
    <div className="space-y-2">
      <div className="border border-slate-300 rounded-lg overflow-hidden bg-white relative">
        <canvas
          ref={canvasRef}
          width={500}
          height={140}
          className="w-full h-32 touch-none cursor-crosshair bg-slate-50/50"
          onMouseDown={startDrawing}
          onMouseMove={draw}
          onMouseUp={stopDrawing}
          onMouseLeave={stopDrawing}
          onTouchStart={startDrawing}
          onTouchMove={draw}
          onTouchEnd={stopDrawing}
        />
        {!hasStroke && !value && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none text-slate-400 text-xs font-nepali">
            {lang === 'ne' ? 'यहाँ औँला वा माउसले हस्ताक्षर गर्नुहोस्' : 'Sign here using touch or mouse'}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between">
        <button
          type="button"
          onClick={clearCanvas}
          className="text-xs text-rose-600 hover:text-rose-800 font-bold flex items-center gap-1 font-nepali transition-colors"
        >
          <RotateCcw className="w-3.5 h-3.5" />
          <span>हस्ताक्षर मेटाउनुहोस् (Clear)</span>
        </button>
        {value && (
          <span className="text-[11px] text-emerald-700 font-bold flex items-center gap-1 font-nepali">
            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
            <span>हस्ताक्षर सुरक्षित (Captured)</span>
          </span>
        )}
      </div>
    </div>
  );
}

export default function QuestionnaireForm({
  projectId,
  // Vector layer the questionnaire is bound to. The backend refuses to write a
  // survey record without a concrete layer, so this must never be inferred.
  layerId = null,
  questionnaire,
  geometry,
  geometryType = 'POINT',
  initialRecord = null,
  onSaved,
  onSubmitSuccess,
  onCancel,
  currentGps = null,
  // Layer attributes that are not questionnaire questions but are still part of
  // the vector feature schema; rendered alongside the survey for this layer.
  extraFields = [],
  // Optional feature link chosen during new-feature capture. It is applied by the
  // backend together with the submitted survey feature.
  linkTo = null,
}) {
  const schemaDef = questionnaire?.schema_definition || {};
  const baseSections = useMemo(() => {
    const list = schemaDef.sections || questionnaire?.sections || [];
    return Array.isArray(list) ? list : [];
  }, [schemaDef, questionnaire]);

  const baseQuestions = useMemo(() => {
    const list = schemaDef.questions || questionnaire?.questions || [];
    return Array.isArray(list) ? list : [];
  }, [schemaDef, questionnaire]);

  const sections = useMemo(() => {
    const res = [];
    if (extraFields && extraFields.length > 0) {
      res.push({
        id: '__layer_attributes__',
        title: 'तहका मुख्य विशेषताहरू (Layer Attributes)',
        title_ne: 'तहका मुख्य विशेषताहरू (Layer Attributes)',
        title_en: 'Layer Attributes',
        description: 'यस तहका मुख्य विशेषता विवरण भर्नुहोस्। (Primary Layer Fields)',
        description_ne: 'यस तहका मुख्य विशेषता विवरण भर्नुहोस्। (Primary Layer Fields)',
      });
    }
    if (baseSections.length > 0) {
      res.push(...baseSections);
    } else if (baseQuestions.length > 0) {
      res.push({
        id: '__survey_main__',
        title: questionnaire?.title || 'सर्वेक्षण फारम (Survey)',
        title_ne: questionnaire?.title || 'सर्वेक्षण फारम (Survey)',
        title_en: 'Survey Questions',
        description: questionnaire?.description || '',
      });
    }
    return res;
  }, [extraFields, baseSections, baseQuestions, questionnaire]);

  const questions = useMemo(() => {
    return baseQuestions;
  }, [baseQuestions]);

  const settings = useMemo(() => schemaDef.settings || questionnaire?.settings || {}, [schemaDef, questionnaire]);

  // Active language: 'ne' (Nepali Unicode) | 'en' (English)
  const [lang, setLang] = useState('ne');

  // Active section index
  const [activeSectionIndex, setActiveSectionIndex] = useState(0);

  // Form State: answers, repeats, calculated values, media
  const [answers, setAnswers] = useState(initialRecord?.answers || {});
  const [repeatData, setRepeatData] = useState(initialRecord?.repeat_data || {});
  const [calculatedValues, setCalculatedValues] = useState(initialRecord?.calculated_values || {});
  const [mediaRefs, setMediaRefs] = useState(initialRecord?.media_refs || []);
  const [recordId, setRecordId] = useState(initialRecord?.record_id || null);

  useEffect(() => {
    if (!extraFields.length) return;
    setAnswers((prev) => {
      const next = { ...prev };
      let changed = false;
      extraFields.forEach((field) => {
        if (field?.name && !(field.name in next)) {
          next[field.name] = '';
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [extraFields]);

  // Saving / Sync State
  const [saveStatus, setSaveStatus] = useState('saved'); // 'saved' | 'saving' | 'unsaved' | 'error'
  const [lastSavedTime, setLastSavedTime] = useState(initialRecord?.last_saved_at ? new Date(initialRecord.last_saved_at) : null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState({});
  const [searchQuery, setSearchQuery] = useState('');

  // Signature drawing state
  const [activeSignatureQId, setActiveSignatureQId] = useState(null);

  // Per-question validation feedback: { [qName]: { checked: boolean, valid: boolean, error?: string } }
  const [validatedQuestions, setValidatedQuestions] = useState({});

  // Per-section validation feedback: { [secId]: { checked: boolean, valid: boolean, errorCount: number } }
  const [sectionValidationStatus, setSectionValidationStatus] = useState({});
  const [sectionBannerMessage, setSectionBannerMessage] = useState(null); // { type: 'success' | 'error', text: string }

  // Mark unsaved on answer change
  const handleAnswerChange = (qName, value) => {
    setAnswers((prev) => ({ ...prev, [qName]: value }));
    setSaveStatus('unsaved');
    if (validationErrors[qName]) {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[qName];
        return next;
      });
    }
    // Also reset checked state if answer changes
    if (validatedQuestions[qName]) {
      setValidatedQuestions((prev) => {
        const next = { ...prev };
        delete next[qName];
        return next;
      });
    }
  };

  // Real-time calculation engine
  useEffect(() => {
    const calculatedQs = questions.filter((q) => q.type === 'calculated' && q.calculation?.formula);
    if (calculatedQs.length === 0) return;

    const newCalculated = { ...calculatedValues };
    let hasChanges = false;

    for (const q of calculatedQs) {
      try {
        let formula = q.calculation.formula;
        // Replace question keys with current answer values
        for (const [key, val] of Object.entries(answers)) {
          if (val !== undefined && val !== null && val !== '') {
            const num = Number(val);
            if (!isNaN(num)) {
              formula = formula.replaceAll(key, String(num));
            }
          }
        }
        // Safely evaluate simple math expressions
        if (/^[\d\s+\-*/().]+$/.test(formula)) {
          // eslint-disable-next-line no-eval
          const result = Function(`"use strict"; return (${formula})`)();
          if (!isNaN(result) && isFinite(result)) {
            const rounded = Math.round(result * 100) / 100;
            if (newCalculated[q.name] !== rounded) {
              newCalculated[q.name] = rounded;
              hasChanges = true;
            }
          }
        }
      } catch (e) {
        // Calculation error ignored
      }
    }

    if (hasChanges) {
      setCalculatedValues(newCalculated);
    }
  }, [answers, questions, calculatedValues]);

  // Evaluate Skip Logic visibility for a question
  const isQuestionVisible = useCallback((q) => {
    return evaluateQuestionVisibility(q, answers);
  }, [answers]);

  // Overall Completion Calculation
  const { completionPercentage, answeredCount, totalRequiredCount, incompleteSectionIndices } = useMemo(() => {
    const requiredQs = questions.filter((q) => q.required && isQuestionVisible(q));
    const requiredExtras = (extraFields || []).filter((f) => f.required);
    const totalReq = requiredQs.length + requiredExtras.length;
    let answered = 0;
    const incompleteSecs = new Set();

    if (extraFields && extraFields.length > 0) {
      extraFields.forEach((field) => {
        const val = answers[field.name];
        const isAnswered = val !== undefined && val !== null && String(val).trim() !== '';
        if (field.required) {
          if (isAnswered) answered++;
          else incompleteSecs.add(0);
        }
      });
    }

    for (const q of questions) {
      if (!isQuestionVisible(q)) continue;
      const val = answers[q.name];
      const isAnswered = val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0);

      if (q.required) {
        if (isAnswered) {
          answered++;
        } else {
          const sIdx = sections.findIndex((s) => s.id === q.section_id || s.id === '__survey_main__');
          if (sIdx !== -1) incompleteSecs.add(sIdx);
        }
      }
    }

    const pct = totalReq > 0 ? Math.round((answered / totalReq) * 100) : (Object.keys(answers).length > 0 ? 100 : 0);
    return {
      completionPercentage: pct,
      answeredCount: answered,
      totalRequiredCount: totalReq,
      incompleteSectionIndices: Array.from(incompleteSecs),
    };
  }, [questions, answers, isQuestionVisible, sections, extraFields]);

  // Autosave Timer
  useEffect(() => {
    const intervalSec = settings.autosave_seconds || 30;
    if (intervalSec <= 0) return;

    const timer = setInterval(() => {
      if (saveStatus === 'unsaved') {
        handleSaveDraft(true); // silent autosave
      }
    }, intervalSec * 1000);

    return () => clearInterval(timer);
  }, [saveStatus, answers, repeatData, calculatedValues, mediaRefs, recordId]);

  // Debounced LocalStorage Draft Sync (Resilience against accidental page reloads)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const timeout = setTimeout(() => {
      try {
        const draftObj = {
          id: recordId || ('draft_' + Date.now()),
          recordId: recordId || null,
          projectId,
          questionnaireId: questionnaire.id,
          questionnaireTitle: questionnaire.title_ne || questionnaire.title || 'प्रश्नावली',
          geometry: geometry || null,
          geometryType: geometryType || 'POINT',
          answers,
          repeatData,
          calculatedValues,
          mediaRefs,
          activeSectionIndex,
          completionPercentage,
          savedAt: new Date().toISOString(),
        };
        localStorage.setItem('kmc_unfinished_feature_creation_draft', JSON.stringify(draftObj));
      } catch (e) {
        console.warn('Failed to sync draft to localStorage', e);
      }
    }, 1200);
    return () => clearTimeout(timeout);
  }, [answers, repeatData, calculatedValues, mediaRefs, geometry, geometryType, questionnaire?.id, projectId, activeSectionIndex, completionPercentage, recordId]);

  // Save Draft Handler
  const handleSaveDraft = async (isAutosave = false) => {
    try {
      setSaveStatus('saving');
      const payload = {
        record_id: recordId,
        questionnaire_id: questionnaire.id,
        layer_id: layerId || null,
        geom_geojson: geometry || null,
        geometry_type: geometryType,
        answers,
        repeat_data: repeatData,
        calculated_values: calculatedValues,
        media_refs: mediaRefs,
        completion_percentage: completionPercentage,
        status: completionPercentage > 0 ? 'IN_PROGRESS' : 'DRAFT',
      };

      // Always persist locally for immediate reload recovery
      try {
        if (typeof window !== 'undefined') {
          const draftObj = {
            id: recordId || ('draft_' + Date.now()),
            recordId: recordId || null,
            projectId,
            layerId: layerId || null,
            questionnaireId: questionnaire.id,
            questionnaireTitle: questionnaire.title_ne || questionnaire.title || 'प्रश्नावली',
            geometry: geometry || null,
            geometryType: geometryType || 'POINT',
            answers,
            repeatData,
            calculatedValues,
            mediaRefs,
            activeSectionIndex,
            completionPercentage,
            savedAt: new Date().toISOString(),
          };
          localStorage.setItem('kmc_unfinished_feature_creation_draft', JSON.stringify(draftObj));
        }
      } catch (lsErr) {
        console.warn('Failed to save draft to localStorage', lsErr);
      }

      const res = await recordsAPI.saveDraft(projectId, payload);
      setRecordId(res.data.record_id);
      setSaveStatus('saved');
      setLastSavedTime(new Date());

      if (onSaved) onSaved(res.data, isAutosave);
      if (!isAutosave) {
        alert('मस्यौदा सफलतापूर्वक सुरक्षित गरियो! तपाईंले पेज रिलोड गरेर पनि जुनसुकै बेला यो फारम जारी राख्न सक्नुहुन्छ (Draft saved successfully)!');
      }
    } catch (err) {
      console.error('Failed to save draft to backend, local draft preserved', err);
      setSaveStatus('saved'); // Local draft was saved
      setLastSavedTime(new Date());
    }
  };

  // Single Question Comprehensive Validator
  const validateSingleQuestion = useCallback((q) => {
    if (!isQuestionVisible(q)) return { valid: true };
    const val = answers[q.name];
    const isAnswered = val !== undefined && val !== null && val !== '' && !(Array.isArray(val) && val.length === 0);

    // 1. Required check
    if (q.required && !isAnswered) {
      return {
        valid: false,
        error: lang === 'ne'
          ? 'यो प्रश्न अनिवार्य छ। कृपया उत्तर भर्नुहोस्।'
          : 'This question is required. Please provide an answer.',
      };
    }

    if (!isAnswered) {
      return { valid: true };
    }

    // 2. Numeric validations
    if (['number', 'decimal', 'currency'].includes(q.type)) {
      const num = Number(val);
      if (isNaN(num)) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया मान्य संख्या मात्र प्रविष्ट गर्नुहोस्।' : 'Please enter a valid number.',
        };
      }
      if (q.type === 'number' && !Number.isInteger(num)) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया पूर्ण संख्या (Integer) मात्र प्रविष्ट गर्नुहोस्।' : 'Please enter a whole integer number.',
        };
      }
      const minVal = q.validation?.min ?? q.min;
      const maxVal = q.validation?.max ?? q.max;
      if (minVal !== undefined && minVal !== null && minVal !== '' && num < Number(minVal)) {
        return {
          valid: false,
          error: lang === 'ne' ? `न्यूनतम मान ${minVal} हुनुपर्छ।` : `Minimum value must be ${minVal}.`,
        };
      }
      if (maxVal !== undefined && maxVal !== null && maxVal !== '' && num > Number(maxVal)) {
        return {
          valid: false,
          error: lang === 'ne' ? `अधिकतम मान ${maxVal} भन्दा बढी हुन सक्दैन।` : `Maximum value cannot exceed ${maxVal}.`,
        };
      }
    }

    // 3. Phone validation
    if (q.type === 'phone') {
      const digitsOnly = String(val).replace(/\D/g, '');
      if (digitsOnly.length < 7 || digitsOnly.length > 15) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया मान्य फोन नम्बर (७-१५ अङ्क) प्रविष्ट गर्नुहोस्।' : 'Please enter a valid phone number (7-15 digits).',
        };
      }
    }

    // 4. Email validation
    if (q.type === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(val).trim())) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया मान्य इमेल ठेगाना प्रविष्ट गर्नुहोस्।' : 'Please enter a valid email address.',
        };
      }
    }

    // 5. Rating validation
    if (q.type === 'rating') {
      const rNum = Number(val);
      if (isNaN(rNum) || rNum < 1 || rNum > 5) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया १ देखि ५ सम्मको रेटिङ दिनुहोस्।' : 'Please select a rating between 1 and 5.',
        };
      }
    }

    // 6. Photo validation
    if (q.type === 'photo') {
      const hasPhoto = mediaRefs.some((m) => m.field === q.name && m.dataUrl);
      if (q.required && !hasPhoto) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया कम्तीमा एउटा फोटो खिच्नुहोस् वा अपलोड गर्नुहोस्।' : 'Please capture or upload at least one photo.',
        };
      }
    }

    // 7. Signature validation
    if (q.type === 'signature') {
      if (q.required && (!val || typeof val !== 'string' || !val.startsWith('data:image'))) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया डिजिटल हस्ताक्षर गर्नुहोस्।' : 'Please provide a digital signature.',
        };
      }
    }

    // 8. Document validation
    if (q.type === 'document') {
      if (q.required && !val) {
        return {
          valid: false,
          error: lang === 'ne' ? 'कृपया आवश्यक कागजात/फाइल अपलोड गर्नुहोस्।' : 'Please upload the required document.',
        };
      }
    }

    // 9. GPS validation
    if (q.type === 'gps_coordinate') {
      const hasGps = (val && (val.lat != null || val.latitude != null)) || (currentGps && (currentGps.lat != null || currentGps.latitude != null));
      if (q.required && !hasGps) {
        return {
          valid: false,
          error: lang === 'ne' ? 'GPS स्थान लिन आवश्यक छ।' : 'GPS location stamp is required.',
        };
      }
    }

    // 10. Regex pattern
    if (q.validation?.regex) {
      try {
        const re = new RegExp(q.validation.regex);
        if (!re.test(String(val))) {
          return {
            valid: false,
            error: q.validation?.message || (lang === 'ne' ? 'प्रविष्ट गरिएको मान ढाँचासँग मेल खाएन।' : 'Value does not match required pattern.'),
          };
        }
      } catch (e) {}
    }

    return { valid: true };
  }, [answers, isQuestionVisible, mediaRefs, currentGps, lang]);

  // Per-Question Check / Validate Handler
  const handleValidateQuestion = useCallback((q) => {
    const result = validateSingleQuestion(q);
    setValidatedQuestions((prev) => ({
      ...prev,
      [q.name]: { checked: true, valid: result.valid, error: result.error },
    }));

    if (!result.valid) {
      setValidationErrors((prev) => ({ ...prev, [q.name]: result.error }));
    } else {
      setValidationErrors((prev) => {
        const next = { ...prev };
        delete next[q.name];
        return next;
      });
    }
    return result;
  }, [validateSingleQuestion]);

  // Per-Section Check / Validate Handler
  const handleValidateSection = useCallback((secIndex) => {
    const sec = sections[secIndex];
    if (!sec) return;

    if (sec.id === '__layer_attributes__') {
      let errorCount = 0;
      const newErrors = {};
      const newValidated = {};
      (extraFields || []).forEach((field) => {
        const val = answers[field.name];
        const isMissing = field.required && (val === undefined || val === null || String(val).trim() === '');
        if (isMissing) {
          errorCount++;
          const msg = lang === 'ne' ? 'यो फिल्ड अनिवार्य छ।' : 'This field is required.';
          newErrors[field.name] = msg;
          newValidated[field.name] = { checked: true, valid: false, error: msg };
        } else {
          newValidated[field.name] = { checked: true, valid: true };
        }
      });
      setValidatedQuestions((prev) => ({ ...prev, ...newValidated }));
      setValidationErrors((prev) => {
        const next = { ...prev };
        (extraFields || []).forEach((f) => delete next[f.name]);
        return { ...next, ...newErrors };
      });
      setSectionValidationStatus((prev) => ({
        ...prev,
        [sec.id]: { checked: true, valid: errorCount === 0, errorCount },
      }));
      if (errorCount > 0) {
        setSectionBannerMessage({
          type: 'error',
          text: lang === 'ne'
            ? `तहका विशेषताहरूमा ${errorCount} वटा अनिवार्य फिल्ड खाली छन्।`
            : `Found ${errorCount} missing required layer attributes.`,
        });
      } else {
        setSectionBannerMessage({
          type: 'success',
          text: lang === 'ne'
            ? '✓ तहका सबै विशेषताहरू मान्य छन्।'
            : '✓ All layer attributes are valid!',
        });
      }
      return;
    }

    const secQs = questions.filter((q) => (q.section_id === sec.id || sec.id === '__survey_main__') && isQuestionVisible(q));

    let errorCount = 0;
    const newErrors = {};
    const newValidated = {};

    secQs.forEach((q) => {
      const res = validateSingleQuestion(q);
      newValidated[q.name] = { checked: true, valid: res.valid, error: res.error };
      if (!res.valid) {
        errorCount++;
        newErrors[q.name] = res.error;
      }
    });

    setValidatedQuestions((prev) => ({ ...prev, ...newValidated }));

    setValidationErrors((prev) => {
      const next = { ...prev };
      secQs.forEach((q) => delete next[q.name]);
      return { ...next, ...newErrors };
    });

    setSectionValidationStatus((prev) => ({
      ...prev,
      [sec.id]: { checked: true, valid: errorCount === 0, errorCount },
    }));

    if (errorCount > 0) {
      setSectionBannerMessage({
        type: 'error',
        text: lang === 'ne'
          ? `यस खण्डमा ${errorCount} वटा समस्या फेला पर्यो। कृपया रातो चिन्ह लगाइएका प्रश्नहरू सच्याउनुहोस्।`
          : `Found ${errorCount} issues in this section. Please fix highlighted questions.`,
      });
    } else {
      setSectionBannerMessage({
        type: 'success',
        text: lang === 'ne'
          ? '✓ यस खण्डका सबै प्रश्नहरू मान्य छन्। कुनै समस्या छैन।'
          : '✓ All questions in this section are verified! No issues found.',
      });
    }
  }, [sections, questions, isQuestionVisible, validateSingleQuestion, lang, extraFields, answers]);

  // Submit Handler
  const handleSubmit = async () => {
    // Validate required & type-specific questions
    const errors = {};
    const newValidated = {};
    for (const q of questions) {
      if (!isQuestionVisible(q)) continue;
      const res = validateSingleQuestion(q);
      newValidated[q.name] = { checked: true, valid: res.valid, error: res.error };
      if (!res.valid) {
        errors[q.name] = res.error;
      }
    }
    const extraErrors = {};
    extraFields.forEach((field) => {
      if (!field?.required) return;
      const value = answers[field.name];
      if (value === undefined || value === null || String(value).trim() === '') {
        extraErrors[field.name] = 'यो फिल्ड अनिवार्य छ (This field is required).';
      }
    });
    Object.assign(errors, extraErrors);

    setValidatedQuestions((prev) => ({ ...prev, ...newValidated }));

    if (Object.keys(errors).length > 0) {
      setValidationErrors(errors);
      // Jump to first section with error
      if (Object.keys(extraErrors).length > 0) {
        const layerSecIdx = sections.findIndex((s) => s.id === '__layer_attributes__');
        if (layerSecIdx !== -1) setActiveSectionIndex(layerSecIdx);
      } else {
        const firstErrorQ = questions.find((q) => errors[q.name]);
        if (firstErrorQ) {
          const secIdx = sections.findIndex((s) => s.id === firstErrorQ.section_id || s.id === '__survey_main__');
          if (secIdx !== -1) setActiveSectionIndex(secIdx);
        }
      }
      alert('कृपया सबै अनिवार्य तथा त्रुटि भएका प्रश्नहरू सच्याउनुहोस् (Please fix all highlighted errors).');
      return;
    }

    try {
      setIsSubmitting(true);
      const payload = {
        record_id: recordId,
        questionnaire_id: questionnaire.id,
        layer_id: layerId || null,
        geom_geojson: geometry || null,
        geometry_type: geometryType,
        answers,
        repeat_data: repeatData,
        calculated_values: calculatedValues,
        media_refs: mediaRefs,
        completion_percentage: 100.0,
      };
      if (linkTo?.target_feature_id) {
        payload.link_to = linkTo;
      }

      const res = await recordsAPI.submit(projectId, payload);
      setSaveStatus('saved');
      if (typeof window !== 'undefined') {
        localStorage.removeItem('kmc_unfinished_feature_creation_draft');
      }
      if (onSubmitSuccess) onSubmitSuccess(res.data);
    } catch (err) {
      console.error('Failed to submit questionnaire', err);
      alert(formatApiError(err, 'सर्वेक्षण बुझाउन सकिएन।'));
    } finally {
      setIsSubmitting(false);
    }
  };

  // Active section data
  const currentSection = sections[activeSectionIndex] || sections[0];
  const sectionQuestions = useMemo(() => {
    let list = questions.filter((q) => q.section_id === currentSection?.id || currentSection?.id === '__survey_main__');
    if (searchQuery.trim()) {
      const qLower = searchQuery.toLowerCase();
      list = list.filter(
        (q) =>
          (q.label && q.label.toLowerCase().includes(qLower)) ||
          (q.label_ne && q.label_ne.includes(qLower)) ||
          (q.name && q.name.toLowerCase().includes(qLower))
      );
    }
    return list;
  }, [questions, currentSection, searchQuery]);

  // Repeat Group Helpers
  const handleAddRepeatRow = (qName) => {
    const existing = repeatData[qName] || [];
    setRepeatData({
      ...repeatData,
      [qName]: [...existing, {}],
    });
    setSaveStatus('unsaved');
  };

  const handleRemoveRepeatRow = (qName, index) => {
    const existing = repeatData[qName] || [];
    setRepeatData({
      ...repeatData,
      [qName]: existing.filter((_, i) => i !== index),
    });
    setSaveStatus('unsaved');
  };

  const handleUpdateRepeatField = (qName, rowIndex, fieldKey, val) => {
    const existing = [...(repeatData[qName] || [])];
    if (!existing[rowIndex]) existing[rowIndex] = {};
    existing[rowIndex][fieldKey] = val;
    setRepeatData({
      ...repeatData,
      [qName]: existing,
    });
    setSaveStatus('unsaved');
  };

  return (
    <div className="flex flex-col h-full bg-slate-50 font-sans select-none overflow-hidden relative">
      {/* Top Header Bar */}
      <div className="px-4 py-3 bg-gov-blue-900 text-white shadow-md flex items-center justify-between shrink-0">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-gov-blue-800 flex items-center justify-center text-gov-gold-400 shrink-0">
            <FileText className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="font-bold text-sm truncate font-nepali">
              {lang === 'ne' ? questionnaire.title : (questionnaire.title_en || questionnaire.title)}
            </h3>
            <div className="flex items-center gap-2 text-[10px] text-gov-blue-200">
              <span>{questionnaire.version}</span>
              <span>•</span>
              <span className="font-mono text-[9px]">{recordId || 'New Draft'}</span>
              <span>•</span>
              <span className="capitalize">{geometryType} Feature</span>
            </div>
          </div>
        </div>

        {/* Header Controls: Language + Autosave Status */}
        <div className="flex items-center gap-2">
          {/* Save Status Pill */}
          <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-gov-blue-950/60 rounded-full text-[11px] border border-gov-blue-800">
            {saveStatus === 'saving' && (
              <>
                <RefreshCw className="w-3 h-3 animate-spin text-gov-gold-400" />
                <span className="text-gov-gold-300">सुरक्षित हुँदैछ...</span>
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <Cloud className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-emerald-300">
                  {lastSavedTime ? `${lastSavedTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} मा सुरक्षित` : 'सुरक्षित'}
                </span>
              </>
            )}
            {saveStatus === 'unsaved' && (
              <>
                <AlertCircle className="w-3 h-3 text-amber-400" />
                <span className="text-amber-300">असुरक्षित परिवर्तन</span>
              </>
            )}
          </div>

          {/* Bilingual Switcher */}
          <button
            type="button"
            onClick={() => setLang(lang === 'ne' ? 'en' : 'ne')}
            className="flex items-center gap-1 px-2.5 py-1 bg-gov-blue-800 hover:bg-gov-blue-700 text-white rounded-lg text-xs font-bold transition-colors border border-gov-blue-700"
            title="भाषा परिवर्तन गर्नुहोस् (Switch Language)"
          >
            <Globe className="w-3 h-3 text-gov-gold-400" />
            <span>{lang === 'ne' ? 'नेपाली' : 'EN'}</span>
          </button>

          {onCancel && (
            <button
              type="button"
              onClick={onCancel}
              className="p-1 text-gov-blue-200 hover:text-white rounded-lg"
              title="बन्द गर्नुहोस्"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {/* Progress Bar & Jump Bar */}
      <div className="bg-white border-b border-slate-200 px-4 py-2 shrink-0">
        <div className="flex items-center justify-between text-xs mb-1.5 font-nepali">
          <span className="font-bold text-slate-700">
            फारम पूर्णता (Progress): <span className="text-gov-blue-800">{completionPercentage}%</span>
          </span>
          <span className="text-[11px] text-slate-500">
            {answeredCount} / {totalRequiredCount} अनिवार्य प्रश्नहरू भरिए
          </span>
        </div>

        <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-gradient-to-r from-gov-blue-700 to-emerald-500 transition-all duration-300 rounded-full"
            style={{ width: `${completionPercentage}%` }}
          />
        </div>

        {/* Section Pill Carousel */}
        <div className="flex items-center gap-1.5 mt-2.5 overflow-x-auto scrollbar-none pb-1">
          {sections.map((sec, idx) => {
            const isActive = idx === activeSectionIndex;
            const secVal = sectionValidationStatus[sec.id];
            const hasIssues = secVal?.checked && !secVal.valid;
            const isClean = secVal?.checked && secVal.valid;
            const isIncomplete = incompleteSectionIndices.includes(idx);

            return (
              <button
                key={sec.id}
                type="button"
                onClick={() => {
                  setActiveSectionIndex(idx);
                  setSectionBannerMessage(null);
                }}
                className={`flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold whitespace-nowrap transition-all font-nepali ${
                  isActive
                    ? hasIssues
                      ? 'bg-rose-700 text-white shadow-sm ring-2 ring-rose-400'
                      : isClean
                      ? 'bg-emerald-700 text-white shadow-sm ring-2 ring-emerald-400'
                      : 'bg-gov-blue-800 text-white shadow-sm'
                    : hasIssues
                    ? 'bg-rose-100 text-rose-900 border-2 border-rose-500 hover:bg-rose-200'
                    : isClean
                    ? 'bg-emerald-50 text-emerald-800 border border-emerald-400 hover:bg-emerald-100'
                    : isIncomplete
                    ? 'bg-amber-50 text-amber-900 border border-amber-300 hover:bg-amber-100'
                    : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                <span>{idx + 1}.</span>
                <span>{lang === 'ne' ? sec.title_ne || sec.title : sec.title}</span>
                {hasIssues && (
                  <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse ml-0.5" />
                )}
                {isClean && (
                  <Check className="w-3 h-3 text-emerald-300 ml-0.5" />
                )}
                {isIncomplete && !isActive && !hasIssues && !isClean && (
                  <span className="w-1.5 h-1.5 rounded-full bg-amber-500" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Main Section Content Area */}
      <div className="flex-1 overflow-y-auto p-4 sm:p-5 space-y-4 scrollbar-thin">
        {/* Section Header */}
        <div className="p-3 bg-white rounded-xl border border-slate-200 shadow-xs flex items-center justify-between gap-3">
          <div className="min-w-0">
            <h4 className="font-bold text-sm text-slate-800 font-nepali">
              {lang === 'ne' ? currentSection?.title_ne || currentSection?.title : currentSection?.title}
            </h4>
            {currentSection?.description && (
              <p className="text-xs text-slate-500 mt-0.5 font-nepali truncate">{currentSection.description}</p>
            )}
          </div>
          <span className="text-xs px-2.5 py-1 bg-slate-100 rounded-lg text-slate-600 font-bold shrink-0 font-nepali">
            खण्ड {activeSectionIndex + 1} / {sections.length}
          </span>
        </div>

        {/* Layer Attributes Section (Displayed first when layer has configured attributes) */}
        {currentSection?.id === '__layer_attributes__' && (
          <div className="p-4 bg-white rounded-xl border border-gov-blue-200 shadow-sm space-y-4">
            <div className="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
              <div>
                <h4 className="font-bold text-sm text-gov-blue-900 font-nepali">
                  तहका मुख्य विशेषताहरू (Layer Attributes)
                </h4>
                <p className="text-xs text-slate-500 font-nepali">
                  यो फिचरको मुख्य विवरण यहाँ प्रविष्ट गर्नुहोस् (Enter primary layer attributes for this feature)
                </p>
              </div>
              <span className="text-[11px] px-2.5 py-0.5 bg-gov-blue-50 text-gov-blue-800 font-bold rounded-full font-nepali border border-gov-blue-200">
                {extraFields.length} फिल्ड
              </span>
            </div>
            <div className="space-y-3">
              {extraFields.map((field) => {
                const err = validationErrors[field.name];
                const label = lang === 'ne' ? (field.label_ne || field.label || field.name) : (field.label || field.name);
                const options = Array.isArray(field.options) ? field.options : [];
                const type = String(field.type || 'text').toLowerCase();
                return (
                  <div key={field.name} className={`p-3 rounded-lg border transition-all ${err ? 'border-rose-400 bg-rose-50/40 ring-1 ring-rose-200' : 'border-slate-200 bg-slate-50/50 hover:bg-white'}`}>
                    <label className="block text-xs font-bold text-slate-800 font-nepali mb-1.5">
                      {label}
                      {field.required && <span className="text-rose-600 ml-1 font-bold">*</span>}
                    </label>
                    {type === 'select' || options.length > 0 ? (
                      <select
                        value={answers[field.name] ?? ''}
                        onChange={(e) => handleAnswerChange(field.name, e.target.value)}
                        className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white focus:ring-2 focus:ring-gov-blue-500 focus:outline-none"
                      >
                        <option value="">छान्नुहोस्... (Select)</option>
                        {options.map((opt) => {
                          const value = typeof opt === 'object' ? opt.value : opt;
                          const labelOpt = typeof opt === 'object' ? (opt.label || opt.value) : opt;
                          return <option key={String(value)} value={value}>{labelOpt}</option>;
                        })}
                      </select>
                    ) : type === 'boolean' || type === 'checkbox' ? (
                      <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer py-1">
                        <input
                          type="checkbox"
                          checked={answers[field.name] === true || answers[field.name] === 'true' || answers[field.name] === 'yes'}
                          onChange={(e) => handleAnswerChange(field.name, e.target.checked)}
                          className="w-4 h-4 accent-gov-blue-800 rounded"
                        />
                        <span className="font-nepali font-medium">हो (Yes)</span>
                      </label>
                    ) : type === 'textarea' ? (
                      <textarea
                        rows={2}
                        value={answers[field.name] ?? ''}
                        onChange={(e) => handleAnswerChange(field.name, e.target.value)}
                        placeholder={`${label} प्रविष्ट गर्नुहोस्...`}
                        className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white font-nepali focus:ring-2 focus:ring-gov-blue-500 focus:outline-none"
                      />
                    ) : (
                      <input
                        type={type === 'number' || type === 'integer' || type === 'decimal' ? 'number' : type === 'date' ? 'date' : 'text'}
                        value={answers[field.name] ?? ''}
                        onChange={(e) => handleAnswerChange(field.name, e.target.value)}
                        placeholder={`${label} प्रविष्ट गर्नुहोस्...`}
                        className="w-full text-xs px-3 py-2 border border-slate-300 rounded-lg bg-white font-nepali focus:ring-2 focus:ring-gov-blue-500 focus:outline-none"
                      />
                    )}
                    {err && <p className="text-[11px] text-rose-600 font-bold mt-1.5 font-nepali flex items-center gap-1"><AlertCircle className="w-3.5 h-3.5" />{err}</p>}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* Questions in Section */}
        {currentSection?.id !== '__layer_attributes__' && sectionQuestions.map((q) => {
          if (!isQuestionVisible(q)) return null;

          const labelText = lang === 'ne' ? q.label_ne || q.label : q.label;
          const helpText = lang === 'ne' ? q.help_text_ne || q.help_text : q.help_text;
          const errorMsg = validationErrors[q.name];

          return (
            <div
              key={q.id}
              className={`p-4 bg-white rounded-xl border transition-all ${
                errorMsg
                  ? 'border-2 border-rose-500 bg-rose-50/25 shadow-sm ring-1 ring-rose-200'
                  : 'border-slate-200 shadow-sm'
              }`}
            >
              {/* Question Label */}
              <div className="flex items-start justify-between gap-2 mb-2">
                <label className="block text-xs font-bold text-slate-800 font-nepali leading-relaxed flex-1">
                  {labelText}
                  {q.required && <span className="text-rose-600 ml-1 font-bold">*</span>}
                </label>
                {q.type === 'calculated' && (
                  <span className="text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-800 font-bold rounded shrink-0">
                    स्वतः गणना (Auto)
                  </span>
                )}
              </div>

              {helpText && (
                <p className="text-[11px] text-slate-500 mb-2 font-nepali">{helpText}</p>
              )}

              {/* Universal Question Type Renderers */}
              {/* 1. Text & Unicode Input */}
              {['text', 'nepali_text', 'phone', 'email'].includes(q.type) && (
                <input
                  type={q.type === 'email' ? 'email' : q.type === 'phone' ? 'tel' : 'text'}
                  value={answers[q.name] ?? ''}
                  onChange={(e) => handleAnswerChange(q.name, e.target.value)}
                  placeholder={lang === 'ne' ? 'यहाँ लेख्नुहोस्...' : 'Type answer here...'}
                  className={`w-full text-xs px-3 py-2 rounded-lg border focus:outline-none focus:ring-1 ${
                    errorMsg ? 'border-rose-400 focus:ring-rose-500 bg-white' : 'border-slate-300 focus:ring-gov-blue-500 bg-white'
                  } ${q.type === 'nepali_text' ? 'font-nepali' : ''}`}
                />
              )}

              {/* 2. Long Text / Textarea */}
              {q.type === 'textarea' && (
                <textarea
                  rows={3}
                  value={answers[q.name] ?? ''}
                  onChange={(e) => handleAnswerChange(q.name, e.target.value)}
                  placeholder={lang === 'ne' ? 'विस्तृत विवरण लेख्नुहोस्...' : 'Detailed description...'}
                  className={`w-full text-xs px-3 py-2 rounded-lg border focus:outline-none focus:ring-1 ${
                    errorMsg ? 'border-rose-400 focus:ring-rose-500 bg-white' : 'border-slate-300 focus:ring-gov-blue-500 bg-white'
                  } font-nepali`}
                />
              )}

              {/* 3. Number, Decimal, Currency */}
              {['number', 'decimal', 'currency'].includes(q.type) && (
                <div className="relative">
                  {q.type === 'currency' && (
                    <span className="absolute left-3 top-2 text-xs font-bold text-slate-500 font-nepali">
                      रू
                    </span>
                  )}
                  <input
                    type="number"
                    step={q.type === 'decimal' ? '0.01' : '1'}
                    value={answers[q.name] ?? ''}
                    onChange={(e) => handleAnswerChange(q.name, e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="0"
                    className={`w-full text-xs px-3 py-2 rounded-lg border focus:outline-none focus:ring-1 ${
                      q.type === 'currency' ? 'pl-8' : ''
                    } ${errorMsg ? 'border-rose-400 focus:ring-rose-500 bg-white' : 'border-slate-300 focus:ring-gov-blue-500 bg-white'}`}
                  />
                </div>
              )}

              {/* 4. Single Choice / Radio */}
              {q.type === 'single_choice' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  {(q.options || []).map((opt) => {
                    const isSelected = answers[q.name] === opt.value;
                    const optLabel = lang === 'ne' ? opt.label_ne || opt.label : opt.label;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => handleAnswerChange(q.name, opt.value)}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-all font-nepali cursor-pointer ${
                          isSelected
                            ? 'bg-gov-blue-50 border-gov-blue-600 text-gov-blue-900 font-bold shadow-sm'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            isSelected ? 'border-gov-blue-700 bg-gov-blue-700' : 'border-slate-300'
                          }`}
                        >
                          {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <span className="truncate">{optLabel}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 5. Multiple Choice / Checkbox */}
              {q.type === 'multiple_choice' && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1">
                  {(q.options || []).map((opt) => {
                    const selectedList = answers[q.name] || [];
                    const isChecked = selectedList.includes(opt.value);
                    const optLabel = lang === 'ne' ? opt.label_ne || opt.label : opt.label;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => {
                          const updated = isChecked
                            ? selectedList.filter((v) => v !== opt.value)
                            : [...selectedList, opt.value];
                          handleAnswerChange(q.name, updated);
                        }}
                        className={`flex items-center gap-2.5 px-3 py-2 rounded-lg border text-left text-xs transition-all font-nepali cursor-pointer ${
                          isChecked
                            ? 'bg-gov-blue-50 border-gov-blue-600 text-gov-blue-900 font-bold shadow-sm'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded border flex items-center justify-center ${
                            isChecked ? 'border-gov-blue-700 bg-gov-blue-700 text-white' : 'border-slate-300'
                          }`}
                        >
                          {isChecked && <Check className="w-3 h-3 stroke-[3]" />}
                        </div>
                        <span className="truncate">{optLabel}</span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 6. Dropdown */}
              {q.type === 'dropdown' && (
                <select
                  value={answers[q.name] ?? ''}
                  onChange={(e) => handleAnswerChange(q.name, e.target.value)}
                  className={`w-full text-xs px-3 py-2 rounded-lg border bg-white focus:outline-none focus:ring-1 font-nepali ${
                    errorMsg ? 'border-rose-400 focus:ring-rose-500' : 'border-slate-300 focus:ring-gov-blue-500'
                  }`}
                >
                  <option value="">-- छनोट गर्नुहोस् (Select) --</option>
                  {(q.options || []).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {lang === 'ne' ? opt.label_ne || opt.label : opt.label}
                    </option>
                  ))}
                </select>
              )}

              {/* 7. Yes / No Switch */}
              {q.type === 'yes_no' && (
                <div className="flex items-center gap-2 pt-1 font-nepali">
                  <button
                    type="button"
                    onClick={() => handleAnswerChange(q.name, 'yes')}
                    className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-all cursor-pointer ${
                      answers[q.name] === 'yes'
                        ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    हो (Yes)
                  </button>
                  <button
                    type="button"
                    onClick={() => handleAnswerChange(q.name, 'no')}
                    className={`flex-1 py-2 text-xs font-bold rounded-lg border transition-all cursor-pointer ${
                      answers[q.name] === 'no'
                        ? 'bg-rose-600 text-white border-rose-600 shadow-sm'
                        : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
                    }`}
                  >
                    होइन (No)
                  </button>
                </div>
              )}

              {/* 8. Rating 1-5 Stars */}
              {q.type === 'rating' && (
                <div className="space-y-1.5 pt-1">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {[1, 2, 3, 4, 5].map((starVal) => {
                      const currentRating = Number(answers[q.name]) || 0;
                      const isFilled = starVal <= currentRating;
                      return (
                        <button
                          key={starVal}
                          type="button"
                          onClick={() => handleAnswerChange(q.name, starVal)}
                          className="p-1 rounded-lg hover:scale-110 transition-transform focus:outline-none cursor-pointer"
                          title={`${starVal} Star`}
                        >
                          <Star
                            className={`w-7 h-7 transition-colors ${
                              isFilled
                                ? 'text-amber-500 fill-amber-400 drop-shadow-sm'
                                : 'text-slate-300 hover:text-amber-300'
                            }`}
                          />
                        </button>
                      );
                    })}
                    {answers[q.name] && (
                      <span className="ml-2 text-xs font-bold font-nepali text-gov-blue-900 bg-gov-blue-50 px-2.5 py-1 rounded-full border border-gov-blue-200">
                        {answers[q.name] === 1 && '१ - धेरै कमजोर (Very Poor)'}
                        {answers[q.name] === 2 && '२ - कमजोर (Poor)'}
                        {answers[q.name] === 3 && '३ - सामान्य (Average)'}
                        {answers[q.name] === 4 && '४ - राम्रो (Good)'}
                        {answers[q.name] === 5 && '५ - उत्कृष्ट (Excellent)'}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* 9. Likert Scale (5-point) */}
              {q.type === 'likert' && (
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 pt-1 font-nepali">
                  {[
                    { value: '1', label: 'Strongly Disagree', label_ne: '१. पूर्ण असहमत' },
                    { value: '2', label: 'Disagree', label_ne: '२. असहमत' },
                    { value: '3', label: 'Neutral', label_ne: '३. तटस्थ' },
                    { value: '4', label: 'Agree', label_ne: '४. सहमत' },
                    { value: '5', label: 'Strongly Agree', label_ne: '५. पूर्ण सहमत' },
                  ].map((item) => {
                    const isSelected = String(answers[q.name]) === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        onClick={() => handleAnswerChange(q.name, item.value)}
                        className={`p-2 rounded-lg border text-center text-xs transition-all flex flex-col items-center gap-1 cursor-pointer ${
                          isSelected
                            ? 'bg-gov-blue-50 border-gov-blue-600 text-gov-blue-900 font-bold shadow-sm ring-1 ring-gov-blue-500'
                            : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        <div
                          className={`w-4 h-4 rounded-full border flex items-center justify-center ${
                            isSelected ? 'border-gov-blue-700 bg-gov-blue-700 text-white' : 'border-slate-300'
                          }`}
                        >
                          {isSelected && <div className="w-1.5 h-1.5 rounded-full bg-white" />}
                        </div>
                        <span className="text-[11px] leading-tight">
                          {lang === 'ne' ? item.label_ne : item.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

              {/* 10. Date / Time */}
              {['date', 'time', 'datetime'].includes(q.type) && (
                <input
                  type={q.type === 'datetime' ? 'datetime-local' : q.type}
                  value={answers[q.name] ?? ''}
                  onChange={(e) => handleAnswerChange(q.name, e.target.value)}
                  className="w-full text-xs px-3 py-2 rounded-lg border border-slate-300 focus:outline-none focus:ring-1 focus:ring-gov-blue-500 bg-white"
                />
              )}

              {/* 11. Calculated Field (Read Only) */}
              {q.type === 'calculated' && (
                <div className="flex items-center justify-between p-3 bg-purple-50 rounded-lg border border-purple-200">
                  <span className="text-xs font-mono text-purple-900 font-bold">
                    {calculatedValues[q.name] ?? answers[q.name] ?? '0'}
                  </span>
                  <span className="text-[10px] text-purple-600 font-mono">
                    सूत्र: {q.calculation?.formula || ''}
                  </span>
                </div>
              )}

              {/* 12. Photo Capture & Upload */}
              {q.type === 'photo' && (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <label className="flex items-center gap-1.5 px-3 py-2 bg-gov-blue-800 hover:bg-gov-blue-700 text-white text-xs font-bold rounded-lg cursor-pointer shadow-sm font-nepali transition-colors">
                      <Camera className="w-3.5 h-3.5" />
                      <span>तस्बिर खिच्नुहोस् / अपलोड</span>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) {
                            const reader = new FileReader();
                            reader.onload = (event) => {
                              const newRef = {
                                type: 'photo',
                                field: q.name,
                                name: file.name,
                                dataUrl: event.target.result,
                                timestamp: new Date().toISOString(),
                              };
                              setMediaRefs((prev) => [...prev, newRef]);
                              handleAnswerChange(q.name, file.name);
                            };
                            reader.readAsDataURL(file);
                          }
                        }}
                      />
                    </label>
                  </div>

                  {/* Photo Thumbnail Previews */}
                  <div className="flex flex-wrap gap-2 pt-1">
                    {mediaRefs
                      .filter((m) => m.field === q.name)
                      .map((media, mIdx) => (
                        <div key={mIdx} className="relative w-20 h-20 rounded-lg overflow-hidden border border-slate-300 group shadow-xs">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img src={media.dataUrl} alt="Captured" className="w-full h-full object-cover" />
                          <button
                            type="button"
                            onClick={() => {
                              setMediaRefs((prev) => prev.filter((_, i) => i !== mIdx));
                              handleAnswerChange(q.name, '');
                            }}
                            className="absolute top-1 right-1 p-0.5 bg-rose-600 text-white rounded-full opacity-80 hover:opacity-100 transition-opacity"
                            title="तस्बिर मेटाउनुहोस्"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ))}
                  </div>
                </div>
              )}

              {/* 13. Digital Signature */}
              {q.type === 'signature' && (
                <SignaturePad
                  value={answers[q.name] ?? ''}
                  onChange={(dataUrl) => handleAnswerChange(q.name, dataUrl)}
                  lang={lang}
                />
              )}

              {/* 14. Document / File Upload */}
              {q.type === 'document' && (
                <div className="space-y-2">
                  <label className="flex items-center gap-2 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-800 text-xs font-bold rounded-lg border border-slate-300 cursor-pointer shadow-xs font-nepali transition-colors w-fit">
                    <FileUp className="w-4 h-4 text-gov-blue-800" />
                    <span>कागजात / फाइल अपलोड (Upload Document)</span>
                    <input
                      type="file"
                      accept=".pdf,.doc,.docx,.xls,.xlsx,.jpg,.jpeg,.png,.zip"
                      className="hidden"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) {
                          const reader = new FileReader();
                          reader.onload = (event) => {
                            const newRef = {
                              type: 'document',
                              field: q.name,
                              name: file.name,
                              size: file.size,
                              dataUrl: event.target.result,
                              timestamp: new Date().toISOString(),
                            };
                            setMediaRefs((prev) => [...prev.filter((m) => m.field !== q.name), newRef]);
                            handleAnswerChange(q.name, file.name);
                          };
                          reader.readAsDataURL(file);
                        }
                      }}
                    />
                  </label>
                  {answers[q.name] && (
                    <div className="p-2.5 bg-slate-50 rounded-lg border border-slate-200 flex items-center justify-between">
                      <div className="flex items-center gap-2 min-w-0">
                        <FileText className="w-4 h-4 text-gov-blue-700 shrink-0" />
                        <span className="text-xs font-mono text-slate-800 truncate">{answers[q.name]}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setMediaRefs((prev) => prev.filter((m) => m.field !== q.name));
                          handleAnswerChange(q.name, '');
                        }}
                        className="text-rose-600 hover:text-rose-800 p-1"
                        title="फाइल हटाउनुहोस्"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* 15. Feature Picker (Pick/Link GIS Feature ID) */}
              {q.type === 'feature_picker' && (
                <div className="space-y-2">
                  <div className="relative">
                    <input
                      type="text"
                      value={answers[q.name] ?? ''}
                      onChange={(e) => handleAnswerChange(q.name, e.target.value)}
                      placeholder={lang === 'ne' ? 'फिचर आईडी प्रविष्ट वा खोजी गर्नुहोस् (e.g. BLD_0102)...' : 'Enter or search feature ID...'}
                      className={`w-full text-xs px-3 py-2 rounded-lg border focus:outline-none focus:ring-1 ${
                        errorMsg ? 'border-rose-400 focus:ring-rose-500 bg-white' : 'border-slate-300 focus:ring-gov-blue-500 bg-white'
                      } font-mono`}
                    />
                  </div>
                  {initialRecord?.properties?._id && (
                    <button
                      type="button"
                      onClick={() => handleAnswerChange(q.name, initialRecord.properties._id)}
                      className="text-[11px] font-bold text-gov-blue-700 hover:text-gov-blue-900 flex items-center gap-1 font-nepali cursor-pointer"
                    >
                      <MapPin className="w-3 h-3" />
                      <span>हालको सक्रिय फिचर आईडी प्रयोग गर्नुहोस् (#{initialRecord.properties._id})</span>
                    </button>
                  )}
                </div>
              )}

              {/* 16. GPS Coordinate Stamp with Accuracy and Fallback */}
              {q.type === 'gps_coordinate' && (() => {
                const curLat = currentGps?.lat ?? currentGps?.latitude;
                const curLng = currentGps?.lng ?? currentGps?.longitude;
                const curAcc = currentGps?.accuracy;
                const hasRecordedGps = answers[q.name] && (answers[q.name].lat != null || answers[q.name].latitude != null);
                const recordedLat = answers[q.name]?.lat ?? answers[q.name]?.latitude;
                const recordedLng = answers[q.name]?.lng ?? answers[q.name]?.longitude;
                const recordedAcc = answers[q.name]?.accuracy;

                return (
                  <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2.5">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <div className="flex items-center gap-2">
                        <MapPin className="w-4 h-4 text-gov-blue-700 shrink-0" />
                        <span className="text-xs font-mono text-slate-800">
                          {hasRecordedGps
                            ? `${Number(recordedLat).toFixed(6)}, ${Number(recordedLng).toFixed(6)} (±${Math.round(recordedAcc || 0)}m)`
                            : (curLat != null && curLng != null)
                            ? `${Number(curLat).toFixed(6)}, ${Number(curLng).toFixed(6)} (GPS उपलब्ध)`
                            : 'GPS स्थान अपेक्षित (GPS pending)'}
                        </span>
                      </div>
                      {(curLat != null && curLng != null) && (
                        <button
                          type="button"
                          onClick={() =>
                            handleAnswerChange(q.name, {
                              lat: curLat,
                              lng: curLng,
                              accuracy: curAcc,
                              timestamp: new Date().toISOString(),
                            })
                          }
                          className="px-2.5 py-1 bg-gov-blue-800 hover:bg-gov-blue-700 text-white text-[11px] font-bold rounded font-nepali shadow-xs transition-colors shrink-0 cursor-pointer"
                        >
                          हालको स्थान लिनुहोस्
                        </button>
                      )}
                    </div>

                    {/* Manual GPS fallback coordinates */}
                    <div className="grid grid-cols-2 gap-2 pt-1 border-t border-slate-200">
                      <div>
                        <label className="text-[10px] text-slate-500 font-nepali block mb-0.5">अक्षांश (Latitude)</label>
                        <input
                          type="number"
                          step="any"
                          placeholder="27.7172"
                          value={recordedLat ?? curLat ?? ''}
                          onChange={(e) =>
                            handleAnswerChange(q.name, {
                              lat: e.target.value === '' ? '' : Number(e.target.value),
                              lng: recordedLng ?? curLng ?? '',
                              accuracy: recordedAcc ?? curAcc ?? 10,
                            })
                          }
                          className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                        />
                      </div>
                      <div>
                        <label className="text-[10px] text-slate-500 font-nepali block mb-0.5">देशान्तर (Longitude)</label>
                        <input
                          type="number"
                          step="any"
                          placeholder="85.3240"
                          value={recordedLng ?? curLng ?? ''}
                          onChange={(e) =>
                            handleAnswerChange(q.name, {
                              lat: recordedLat ?? curLat ?? '',
                              lng: e.target.value === '' ? '' : Number(e.target.value),
                              accuracy: recordedAcc ?? curAcc ?? 10,
                            })
                          }
                          className="w-full text-xs px-2.5 py-1.5 border border-slate-300 rounded bg-white font-mono"
                        />
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* 17. Repeat Group / Dynamic Roster */}
              {q.type === 'repeat_group' && (
                <div className="space-y-3 pt-2">
                  <div className="space-y-2">
                    {(repeatData[q.name] || []).map((row, rIdx) => (
                      <div key={rIdx} className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
                        <div className="flex items-center justify-between text-xs font-bold text-slate-700 font-nepali">
                          <span>प्रविष्टि #{rIdx + 1} (Entry #{rIdx + 1})</span>
                          <button
                            type="button"
                            onClick={() => handleRemoveRepeatRow(q.name, rIdx)}
                            className="text-rose-600 hover:text-rose-800 p-0.5 cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                        <div className="grid grid-cols-2 gap-2">
                          <input
                            type="text"
                            placeholder="नाम (Name / Item)"
                            value={row.name || ''}
                            onChange={(e) => handleUpdateRepeatField(q.name, rIdx, 'name', e.target.value)}
                            className="text-xs px-2 py-1.5 border rounded bg-white font-nepali"
                          />
                          <input
                            type="number"
                            placeholder="संख्या / उमेर (Number / Value)"
                            value={row.value || ''}
                            onChange={(e) => handleUpdateRepeatField(q.name, rIdx, 'value', e.target.value)}
                            className="text-xs px-2 py-1.5 border rounded bg-white"
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => handleAddRepeatRow(q.name)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-100 hover:bg-slate-200 text-gov-blue-900 rounded-lg text-xs font-bold font-nepali transition-colors border border-slate-200 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>नयाँ प्रविष्टि थप्नुहोस् (+ Add Row)</span>
                  </button>
                </div>
              )}

              {/* Error Message */}
              {errorMsg && (
                <div className="p-2 bg-rose-50 border border-rose-300 rounded-lg text-[11px] text-rose-700 font-bold mt-2 flex items-center gap-1.5 font-nepali animate-fade-in">
                  <AlertCircle className="w-3.5 h-3.5 text-rose-600 shrink-0" />
                  <span>{errorMsg}</span>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Bottom Sticky Action Footer */}
      <div className="p-3 bg-white border-t border-slate-200 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between shrink-0 shadow-lg">
        {/* Navigation Buttons: Previous & Next */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            disabled={activeSectionIndex === 0}
            onClick={() => setActiveSectionIndex(activeSectionIndex - 1)}
            className="flex items-center justify-center gap-1 px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-bold rounded-lg disabled:opacity-40 transition-colors font-nepali flex-1 sm:flex-none"
          >
            <ChevronLeft className="w-4 h-4" />
            <span>अघिल्लो (Prev)</span>
          </button>

          {activeSectionIndex < sections.length - 1 ? (
            <button
              type="button"
              onClick={() => setActiveSectionIndex(activeSectionIndex + 1)}
              className="flex items-center justify-center gap-1 px-3.5 py-2 bg-gov-blue-800 hover:bg-gov-blue-700 text-white text-xs font-bold rounded-lg shadow-sm transition-colors font-nepali flex-1 sm:flex-none"
            >
              <span>पछिल्लो (Next)</span>
              <ChevronRight className="w-4 h-4" />
            </button>
          ) : null}
        </div>

        {/* Action Buttons: Save Draft vs Submit */}
        <div className="flex items-center gap-2 w-full sm:w-auto">
          <button
            type="button"
            onClick={() => handleSaveDraft(false)}
            disabled={saveStatus === 'saving'}
            className="flex items-center justify-center gap-1.5 px-3.5 py-2 bg-slate-700 hover:bg-slate-600 text-white text-xs font-bold rounded-lg transition-colors font-nepali flex-1 sm:flex-none"
          >
            <Save className={`w-3.5 h-3.5 ${saveStatus === 'saving' ? 'animate-spin' : ''}`} />
            <span>मस्यौदा सुरक्षित (Save Draft)</span>
          </button>

          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="flex items-center justify-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-bold rounded-lg shadow-md transition-colors font-nepali disabled:opacity-50 flex-1 sm:flex-none"
          >
            <CheckCircle2 className="w-4 h-4" />
            <span>बुझाउनुहोस् (Submit Survey)</span>
          </button>
        </div>
      </div>
    </div>
  );
}
