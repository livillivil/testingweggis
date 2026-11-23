import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBlankOptionTemplate,
  createBlankSectionTemplate,
  createBlankQuestionTemplate,
  createBlankQuestionnaireTemplate,
  validateQuestionnaireTemplate,
  filterNepaliOnly,
  filterEnglishOnly,
  filterKeyIdentifier,
} from './questionnaireUtils.js';

describe('Questionnaire Blank Template Architecture', () => {
  it('createBlankQuestionnaireTemplate initializes with empty title, description, section fields, and question fields', () => {
    const tpl = createBlankQuestionnaireTemplate();
    assert.equal(tpl.title, '');
    assert.equal(tpl.description, '');
    assert.equal(tpl.status, 'DRAFT');
    assert.equal(tpl.sections.length, 1);
    assert.equal(tpl.sections[0].title, '');
    assert.equal(tpl.sections[0].title_ne, '');
    assert.equal(tpl.sections[0].description, '');

    assert.equal(tpl.questions.length, 1);
    assert.equal(tpl.questions[0].name, '');
    assert.equal(tpl.questions[0].label, '');
    assert.equal(tpl.questions[0].label_ne, '');
    assert.equal(tpl.questions[0].gis_binding, '');
    assert.equal(tpl.questions[0].help_text, '');
    assert.equal(tpl.questions[0].help_text_ne, '');
  });

  it('createBlankSectionTemplate returns empty title and title_ne strings', () => {
    const sec = createBlankSectionTemplate(2, 'sec_custom');
    assert.equal(sec.id, 'sec_custom');
    assert.equal(sec.order, 2);
    assert.equal(sec.title, '');
    assert.equal(sec.title_ne, '');
    assert.equal(sec.description, '');
  });

  it('createBlankQuestionTemplate creates empty choice option slots for selection types and empty formula for calculated types', () => {
    const qChoice = createBlankQuestionTemplate('single_choice', 'sec_1', 'q_choice');
    assert.equal(qChoice.name, '');
    assert.equal(qChoice.label, '');
    assert.equal(qChoice.label_ne, '');
    assert.ok(Array.isArray(qChoice.options));
    assert.equal(qChoice.options.length, 2);
    assert.deepEqual(qChoice.options[0], { value: '', label: '', label_ne: '' });
    assert.deepEqual(qChoice.options[1], { value: '', label: '', label_ne: '' });

    const qCalc = createBlankQuestionTemplate('calculated', 'sec_1', 'q_calc');
    assert.deepEqual(qCalc.calculation, { formula: '' });
  });

  it('validateQuestionnaireTemplate rejects an unfilled blank template and passes when filled', () => {
    const blank = createBlankQuestionnaireTemplate();
    const blankReport = validateQuestionnaireTemplate(blank);
    assert.equal(blankReport.valid, false);
    assert.ok(blankReport.errors.length >= 3);

    const filled = {
      title: 'नगरपालिका घरधुरी सर्वेक्षण',
      sections: [
        { id: 'sec_1', title: 'General Info', title_ne: 'सामान्य विवरण', order: 1, description: '' },
      ],
      questions: [
        {
          id: 'q_1',
          name: 'house_owner',
          label: 'House Owner Name',
          label_ne: 'घरधनीको नाम',
          type: 'text',
          section_id: 'sec_1',
          required: true,
        },
        {
          id: 'q_2',
          name: 'building_use',
          label: 'Building Use',
          label_ne: 'भवनको प्रयोग',
          type: 'single_choice',
          section_id: 'sec_1',
          required: true,
          options: [
            { value: 'residential', label: 'Residential', label_ne: 'आवासीय' },
            { value: 'commercial', label: 'Commercial', label_ne: 'व्यापारिक' },
          ],
        },
      ],
    };

    const filledReport = validateQuestionnaireTemplate(filled);
    assert.equal(filledReport.valid, true);
    assert.equal(filledReport.errors.length, 0);
  });

  it('validateQuestionnaireTemplate detects duplicate question keys and blank choice options', () => {
    const brokenChoice = {
      title: 'सर्वेक्षण',
      sections: [{ id: 'sec_1', title: 'Sec', title_ne: 'खण्ड', order: 1 }],
      questions: [
        {
          id: 'q_1',
          name: 'dup_key',
          label: 'Q1',
          label_ne: 'प्रश्न १',
          type: 'dropdown',
          section_id: 'sec_1',
          options: [createBlankOptionTemplate()],
        },
        {
          id: 'q_2',
          name: 'dup_key',
          label: 'Q2',
          label_ne: 'प्रश्न २',
          type: 'text',
          section_id: 'sec_1',
        },
      ],
    };

    const report = validateQuestionnaireTemplate(brokenChoice);
    assert.equal(report.valid, false);
    assert.ok(report.errors.some((e) => e.includes('दोहोरिएको')));
    assert.ok(report.errors.some((e) => e.includes('विकल्प')));
    assert.ok(Array.isArray(report.issues));
    assert.ok(report.issues.length >= 2);
    assert.ok(report.issues.some((issue) => issue.questionId === 'q_2' && issue.targetType === 'question'));
  });

  it('character filters enforce script boundaries', () => {
    assert.equal(filterNepaliOnly('खण्ड 1 Section'), 'खण्ड 1 ');
    assert.equal(filterEnglishOnly('Ward वडा 10'), 'Ward  10');
    assert.equal(filterKeyIdentifier('Owner Name घरधनी 1'), 'owner_name_1');
  });
});
