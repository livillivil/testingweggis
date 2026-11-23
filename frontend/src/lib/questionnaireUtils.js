/**
 * Universal Utility Functions for KMC Questionnaire Engine
 * Supports:
 * - Strict Language Character Filtering (Nepali-only vs English-only)
 * - Blank Template Factory Functions (No pre-populated values by default)
 * - Template Schema Validation
 * - Enterprise Skip Logic Condition Evaluation
 * - Operator definitions
 */

/**
 * Strips all Latin/English alphabet characters (A-Za-z) from text.
 * Keeps Devanagari script (\u0900-\u097F), digits, punctuation, and whitespace.
 */
export function filterNepaliOnly(text = '') {
  if (typeof text !== 'string') return '';
  return text.replace(/[a-zA-Z]/g, '');
}

/**
 * Strips all Devanagari script characters (\u0900-\u097F) from text.
 * Keeps ASCII / Latin characters, digits, punctuation, and whitespace.
 */
export function filterEnglishOnly(text = '') {
  if (typeof text !== 'string') return '';
  return text.replace(/[\u0900-\u097F]/g, '');
}

/**
 * Generates a clean database / PostGIS column identifier (snake_case, ASCII only).
 */
export function filterKeyIdentifier(text = '') {
  if (typeof text !== 'string') return '';
  const noDevanagari = text.replace(/[\u0900-\u097F]/g, '');
  return noDevanagari
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_');
}

/**
 * Question types that require selectable options
 */
export const CHOICE_QUESTION_TYPES = [
  'single_choice',
  'multiple_choice',
  'dropdown',
  'ranking',
  'likert',
];

/**
 * Creates a blank choice option template slot with empty values.
 */
export function createBlankOptionTemplate() {
  return {
    value: '',
    label: '',
    label_ne: '',
  };
}

/**
 * Creates a blank section template slot with empty values to be filled by the user.
 */
export function createBlankSectionTemplate(order = 1, id = null) {
  return {
    id: id || `sec_${order}`,
    title: '',
    title_ne: '',
    order,
    description: '',
  };
}

/**
 * Creates a blank question template slot with empty values to be filled by the user.
 */
export function createBlankQuestionTemplate(type = 'text', sectionId = 'sec_1', id = null) {
  const normalizedType = type || 'text';
  const isChoice = CHOICE_QUESTION_TYPES.includes(normalizedType);

  return {
    id: id || `q_${Date.now()}`,
    name: '',
    label: '',
    label_ne: '',
    type: normalizedType,
    section_id: sectionId || 'sec_1',
    required: false,
    help_text: '',
    help_text_ne: '',
    gis_binding: '',
    options: isChoice
      ? [createBlankOptionTemplate(), createBlankOptionTemplate()]
      : undefined,
    conditions: [],
    calculation: normalizedType === 'calculated' ? { formula: '' } : undefined,
    validation: {},
  };
}

/**
 * Creates a complete blank questionnaire template structure with empty fields ready to be filled.
 */
export function createBlankQuestionnaireTemplate() {
  const firstSection = createBlankSectionTemplate(1, 'sec_1');
  const firstQuestion = createBlankQuestionTemplate('text', firstSection.id, 'q_1');

  return {
    title: '',
    description: '',
    version: 'v1.0',
    status: 'DRAFT',
    sections: [firstSection],
    questions: [firstQuestion],
    settings: {
      autosave_seconds: 30,
      require_gps: true,
      gps_accuracy_threshold_m: 15,
      allow_offline: true,
    },
  };
}

/**
 * Validates whether a questionnaire template has been properly filled out before publishing.
 */
export function validateQuestionnaireTemplate({
  title = '',
  sections = [],
  questions = [],
} = {}) {
  const errors = [];
  const warnings = [];
  const issues = [];

  const addError = (msg, meta = {}) => {
    errors.push(msg);
    issues.push({
      type: 'error',
      message: msg,
      targetType: meta.targetType || 'general',
      sectionId: meta.sectionId || null,
      questionId: meta.questionId || null,
      field: meta.field || null,
    });
  };

  const addWarning = (msg, meta = {}) => {
    warnings.push(msg);
    issues.push({
      type: 'warning',
      message: msg,
      targetType: meta.targetType || 'general',
      sectionId: meta.sectionId || null,
      questionId: meta.questionId || null,
      field: meta.field || null,
    });
  };

  if (!String(title || '').trim()) {
    addError('प्रश्नावलीको शीर्षक (Questionnaire Title) खाली छ। कृपया शीर्षक भर्नुहोस्।', { targetType: 'header', field: 'title' });
  }

  if (!Array.isArray(sections) || sections.length === 0) {
    addError('प्रश्नावलीमा कम्तीमा एक खण्ड (Section) आवश्यक छ।', { targetType: 'section', field: 'sections' });
  } else {
    sections.forEach((sec, idx) => {
      const hasSecTitle =
        Boolean(String(sec?.title_ne || '').trim()) ||
        Boolean(String(sec?.title || '').trim());
      if (!hasSecTitle) {
        addError(`खण्ड #${idx + 1} को शीर्षक (Section Title) खाली छ।`, { targetType: 'section', sectionId: sec.id, field: 'title' });
      }

      const secQuestions = (questions || []).filter((q) => q.section_id === sec.id);
      if (secQuestions.length === 0) {
        addWarning(`खण्ड #${idx + 1} मा कुनै पनि प्रश्न थपिएको छैन।`, { targetType: 'section', sectionId: sec.id });
      }
    });
  }

  if (!Array.isArray(questions) || questions.length === 0) {
    addError('प्रश्नावलीमा कम्तीमा एक प्रश्न (Question) आवश्यक छ।', { targetType: 'question', field: 'questions' });
  } else {
    const seenKeys = new Set();

    questions.forEach((q, idx) => {
      const qNum = idx + 1;
      const hasLabel =
        Boolean(String(q?.label_ne || '').trim()) ||
        Boolean(String(q?.label || '').trim());
      if (!hasLabel) {
        addError(`प्रश्न #${qNum} को प्रश्न शीर्षक (Question Label) खाली छ।`, { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'label' });
      }

      const keyName = String(q?.name || '').trim();
      if (!keyName) {
        addError(`प्रश्न #${qNum} को आन्तरिक कुञ्जी (Internal Key / PostGIS Column) खाली छ।`, { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'name' });
      } else if (seenKeys.has(keyName)) {
        addError(`प्रश्न #${qNum} को आन्तरिक कुञ्जी '${keyName}' दोहोरिएको छ (Duplicate Key)।`, { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'name' });
      } else {
        seenKeys.add(keyName);
      }

      if (CHOICE_QUESTION_TYPES.includes(q?.type)) {
        const opts = Array.isArray(q?.options) ? q.options : [];
        if (opts.length === 0) {
          addError(`प्रश्न #${qNum} मा कम्तीमा एक छनोट विकल्प (Choice Option) आवश्यक छ।`, { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'options' });
        } else {
          opts.forEach((opt, oIdx) => {
            const hasOptVal = Boolean(String(opt?.value || '').trim());
            const hasOptLabel =
              Boolean(String(opt?.label_ne || '').trim()) ||
              Boolean(String(opt?.label || '').trim());
            if (!hasOptVal || !hasOptLabel) {
              addError(
                `प्रश्न #${qNum} को विकल्प #${oIdx + 1} मा विकल्प Key वा नाम खाली छ।`,
                { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'options' }
              );
            }
          });
        }
      }

      if (q?.type === 'calculated') {
        const formula = String(q?.calculation?.formula || '').trim();
        if (!formula) {
          addError(`प्रश्न #${qNum} (गणना प्रश्न) को सूत्र (Formula) खाली छ।`, { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'calculation' });
        }
      }

      if (Array.isArray(q?.conditions) && q.conditions.length > 0) {
        q.conditions.forEach((cond, cIdx) => {
          if (!String(cond?.depends_on || '').trim()) {
            addWarning(`प्रश्न #${qNum} को सर्त #${cIdx + 1} मा आधार प्रश्न (Depends On) छानिएको छैन।`, { targetType: 'question', sectionId: q.section_id, questionId: q.id, field: 'conditions' });
          }
        });
      }
    });
  }

  const valid = errors.length === 0;
  return {
    valid,
    is_valid: valid,
    errors,
    warnings,
    issues,
    total_sections: Array.isArray(sections) ? sections.length : 0,
    total_questions: Array.isArray(questions) ? questions.length : 0,
    conditional_rules_count: Array.isArray(questions)
      ? questions.filter((item) => item?.conditions?.length > 0).length
      : 0,
    repeat_groups_count: Array.isArray(questions)
      ? questions.filter((item) => item?.type === 'repeat_group').length
      : 0,
  };
}

/**
 * Skip Logic Operators
 */
export const SKIP_OPERATORS = [
  { id: '==', label: 'बराबर (Equals)', labelEn: 'Equals', requiresValue: true },
  { id: '!=', label: 'फरक (Not Equals)', labelEn: 'Not Equals', requiresValue: true },
  { id: '>', label: 'ठूलो (Greater Than >)', labelEn: 'Greater Than', requiresValue: true },
  { id: '<', label: 'सानो (Less Than <)', labelEn: 'Less Than', requiresValue: true },
  { id: '>=', label: 'ठूलो वा बराबर (>=)', labelEn: 'Greater or Equal', requiresValue: true },
  { id: '<=', label: 'सानो वा बराबर (<=)', labelEn: 'Less or Equal', requiresValue: true },
  { id: 'contains', label: 'समावेश भएको (Contains)', labelEn: 'Contains', requiresValue: true },
  { id: 'is_not_empty', label: 'उत्तर दिइएको (Answered / Not Empty)', labelEn: 'Is Not Empty', requiresValue: false },
  { id: 'is_empty', label: 'खाली भएको (Empty / Unanswered)', labelEn: 'Is Empty', requiresValue: false },
];

/**
 * Evaluates whether a question should be visible based on its conditions and logic.
 *
 * @param {Object} question - The question definition
 * @param {Object} answers - Current dictionary of answers { [fieldName]: value }
 * @returns {boolean} - true if question should be rendered, false if skipped
 */
export function evaluateQuestionVisibility(question, answers = {}) {
  if (!question || !question.conditions || question.conditions.length === 0) {
    return true;
  }

  const logicType = question.condition_logic || 'AND'; // 'AND' or 'OR'

  const conditionResults = question.conditions.map((cond) => {
    if (!cond || !cond.depends_on) return true;

    const parentVal = answers[cond.depends_on];
    const op = cond.operator || '==';
    const targetVal = cond.value;

    const isParentEmpty =
      parentVal === undefined ||
      parentVal === null ||
      parentVal === '' ||
      (Array.isArray(parentVal) && parentVal.length === 0);

    // Empty / Not Empty operators
    if (op === 'is_empty') {
      return isParentEmpty;
    }
    if (op === 'is_not_empty') {
      return !isParentEmpty;
    }

    // If parent is empty and testing positive equality or comparison, it's not satisfied
    if (isParentEmpty) {
      return op === '!=';
    }

    // If parent value is an array (e.g. multiple_choice)
    if (Array.isArray(parentVal)) {
      const stringifiedArray = parentVal.map((v) => String(v).trim().toLowerCase());
      const targetStr = String(targetVal ?? '').trim().toLowerCase();
      const hasMatch = stringifiedArray.includes(targetStr);

      if (op === '==' || op === 'contains') return hasMatch;
      if (op === '!=') return !hasMatch;
      return hasMatch;
    }

    // String normalization for comparison
    const parentStr = String(parentVal).trim().toLowerCase();
    const targetStr = String(targetVal ?? '').trim().toLowerCase();

    if (op === '==') {
      return parentStr === targetStr;
    }
    if (op === '!=') {
      return parentStr !== targetStr;
    }
    if (op === 'contains') {
      return parentStr.includes(targetStr);
    }

    // Numeric comparisons
    const numParent = Number(parentVal);
    const numTarget = Number(targetVal);

    if (!isNaN(numParent) && !isNaN(numTarget)) {
      if (op === '>') return numParent > numTarget;
      if (op === '<') return numParent < numTarget;
      if (op === '>=') return numParent >= numTarget;
      if (op === '<=') return numParent <= numTarget;
    }

    return true;
  });

  if (logicType === 'OR') {
    return conditionResults.some(Boolean);
  }
  return conditionResults.every(Boolean);
}
