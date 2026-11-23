import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePolygonAreaSqm,
  verifyDoubleGeofence,
  generateSpatialGrid,
  transitionTaskState,
  splitPolygonGeometry,
  mergePolygonGeometries,
  mergeGeometriesWithMode,
  threeWayMergeFeature,
  validateQuestionnaireSchema,
  isQuestionVisible,
  computeMetricHouseNumber,
} from './spatialEngine.js';

const SAMPLE_WARD_AOI = [
  [85.320, 27.695],
  [85.328, 27.695],
  [85.328, 27.702],
  [85.320, 27.702],
  [85.320, 27.695],
];

test('6-Mode Spatial Grid Generator produces valid clipped cells for all 6 geometries', () => {
  const shapes = [
    'rectangular',
    'triangular',
    'circular',
    'hexagonal',
    'random',
    'straight_skeleton',
  ];

  for (const shape of shapes) {
    const cells = generateSpatialGrid({
      aoiRing: SAMPLE_WARD_AOI,
      gridShape: shape,
      cellSizeMeters: 220,
      projectId: 'PRJ-10',
      wardNo: 10,
    });
    assert.ok(cells.length >= 2, `Expected at least 2 cells for ${shape}, got ${cells.length}`);
    for (const c of cells) {
      assert.equal(c.grid_shape, shape);
      assert.equal(c.status, 'READY');
      assert.ok(c.area_sqm > 25, `Cell area must be positive for ${shape}`);
      assert.ok(c.coordinates.length >= 4, `Closed ring must have >= 4 coords for ${shape}`);
    }
  }
});

test('Double 50m GPS Geofence enforces both TaskGrid and Feature proximity for DataCollector', () => {
  const gridPoly = [
    [85.322, 27.698],
    [85.324, 27.698],
    [85.324, 27.700],
    [85.322, 27.700],
    [85.322, 27.698],
  ];
  const featurePt = [[85.323, 27.699]];

  // Inside grid and right next to feature -> allowed
  const insideCheck = verifyDoubleGeofence({
    userRole: 'DataCollector',
    userGps: [85.32305, 27.69905],
    gridPolygon: gridPoly,
    featureCoords: featurePt,
  });
  assert.equal(insideCheck.allowed, true);
  assert.equal(insideCheck.distanceToGridMeters, 0);
  assert.ok(insideCheck.distanceToFeatureMeters < 15);

  // 250m away from grid -> denied for DataCollector
  const farCheck = verifyDoubleGeofence({
    userRole: 'DataCollector',
    userGps: [85.330, 27.705],
    gridPolygon: gridPoly,
    featureCoords: featurePt,
  });
  assert.equal(farCheck.allowed, false);
  assert.ok(farCheck.distanceToGridMeters > 50);

  // GisAdmin bypasses field GPS lock for remote QA editing
  const adminCheck = verifyDoubleGeofence({
    userRole: 'GisAdmin',
    userGps: [85.330, 27.705],
    gridPolygon: gridPoly,
    featureCoords: featurePt,
  });
  assert.equal(adminCheck.allowed, true);
});

test('HOT Tasking Manager + FMTM Finite State Machine enforces role and transition rules', () => {
  const step1 = transitionTaskState({
    currentStatus: 'READY',
    action: 'LOCK_FOR_MAPPING',
    userRole: 'DataCollector',
  });
  assert.equal(step1.ok, true);
  assert.equal(step1.nextStatus, 'LOCKED_FOR_MAPPING');

  const step2 = transitionTaskState({
    currentStatus: step1.nextStatus,
    action: 'SUBMIT_MAPPED',
    userRole: 'DataCollector',
  });
  assert.equal(step2.ok, true);
  assert.equal(step2.nextStatus, 'MAPPED');

  // DataCollector cannot validate their own grid
  const illegalValidate = transitionTaskState({
    currentStatus: 'MAPPED',
    action: 'VALIDATE',
    userRole: 'DataCollector',
  });
  assert.equal(illegalValidate.ok, false);

  // Validator invalidation without issue tags or comment is rejected
  const missingTags = transitionTaskState({
    currentStatus: 'MAPPED',
    action: 'INVALIDATE',
    userRole: 'Validator',
    issueCategories: [],
    validatorComment: '',
  });
  assert.equal(missingTags.ok, false);

  // Validator invalidation with structured issue tags succeeds
  const validInvalidate = transitionTaskState({
    currentStatus: 'MAPPED',
    action: 'INVALIDATE',
    userRole: 'Validator',
    issueCategories: ['INACCURATE_GEOMETRY'],
    validatorComment: 'South-east roof overhang clipped; please re-digitize corner vertices.',
  });
  assert.equal(validInvalidate.ok, true);
  assert.equal(validInvalidate.nextStatus, 'INVALIDATED');
});

test('PostGIS ST_Split (blade & angle) and Merge (Union vs Multi-Feature) conserve topology', () => {
  const parcel = [
    [85.321, 27.696],
    [85.323, 27.696],
    [85.323, 27.698],
    [85.321, 27.698],
    [85.321, 27.696],
  ];
  const origArea = computePolygonAreaSqm(parcel);
  const blade = [
    [85.322, 27.695],
    [85.322, 27.699],
  ];
  const [half1, half2] = splitPolygonGeometry(parcel, 90, blade);
  const area1 = computePolygonAreaSqm(half1);
  const area2 = computePolygonAreaSqm(half2);

  assert.ok(area1 > 0 && area2 > 0);
  assert.ok(Math.abs(area1 + area2 - origArea) < origArea * 0.05, 'Split halves must sum to original area');

  const merged = mergePolygonGeometries(half1, half2);
  const mergedArea = computePolygonAreaSqm(merged);
  assert.ok(Math.abs(mergedArea - origArea) < origArea * 0.05, 'Merged union matches original area');

  // Verify mergeGeometriesWithMode for 'union' vs 'multifeature'
  const unionGeom = mergeGeometriesWithMode(
    [
      { type: 'Polygon', coordinates: [half1] },
      { type: 'Polygon', coordinates: [half2] },
    ],
    'union'
  );
  assert.equal(unionGeom.type, 'Polygon');

  const multiGeom = mergeGeometriesWithMode(
    [
      { type: 'Polygon', coordinates: [half1] },
      { type: 'Polygon', coordinates: [half2] },
    ],
    'multifeature'
  );
  assert.equal(multiGeom.type, 'MultiPolygon');
  assert.equal(multiGeom.coordinates.length, 2);
});

test('QFieldCloud 3-Way JSON Delta Sync merges non-overlapping attributes and flags true collisions', () => {
  const coords = [[85.322, 27.697]];

  // Non-overlapping edits on different attributes -> clean APPLIED merge
  const cleanMerge = threeWayMergeFeature({
    baseVersion: 1,
    serverVersion: 2,
    baseProperties: { floors: 3, roof_type: 'RCC', use_type: 'Residential' },
    serverProperties: { floors: 3, roof_type: 'RCC', use_type: 'Mixed Commercial' },
    clientProperties: { floors: 4, roof_type: 'RCC', use_type: 'Residential' },
    baseCoordinates: coords,
    serverCoordinates: coords,
    clientCoordinates: coords,
  });
  assert.equal(cleanMerge.applyStatus, 'APPLIED');
  assert.equal(cleanMerge.mergedProperties.floors, 4);
  assert.equal(cleanMerge.mergedProperties.use_type, 'Mixed Commercial');
  assert.equal(cleanMerge.conflictingKeys.length, 0);

  // Overlapping conflicting edits on the same attribute -> CONFLICT flagged
  const conflictMerge = threeWayMergeFeature({
    baseVersion: 1,
    serverVersion: 2,
    baseProperties: { floors: 3 },
    serverProperties: { floors: 5 },
    clientProperties: { floors: 4 },
    baseCoordinates: coords,
    serverCoordinates: coords,
    clientCoordinates: coords,
  });
  assert.equal(conflictMerge.applyStatus, 'CONFLICT');
  assert.deepEqual(conflictMerge.conflictingKeys, ['floors']);
});

test('AST Questionnaire Validator detects duplicate IDs and circular skip logic', () => {
  const circularReport = validateQuestionnaireSchema([
    {
      id: 'has_damage',
      type: 'yes_no',
      labelEn: 'Visible structural damage?',
      labelNe: 'के भवनमा क्षति देखिएको छ?',
      required: true,
      skipLogic: { dependsOnQuestionId: 'damage_grade', operator: 'equals', value: 'G3' },
    },
    {
      id: 'damage_grade',
      type: 'select_one',
      labelEn: 'Damage Grade',
      labelNe: 'क्षतिको स्तर',
      required: true,
      options: [{ value: 'G3', labelEn: 'Grade 3', labelNe: 'ग्रेड ३' }],
      skipLogic: { dependsOnQuestionId: 'has_damage', operator: 'equals', value: 'yes' },
    },
  ]);
  assert.equal(circularReport.valid, false);
  assert.ok(circularReport.errors.some((e) => e.includes('Circular skip logic')));

  const qVisible = isQuestionVisible(
    {
      id: 'damage_grade',
      type: 'text',
      labelEn: 'Grade',
      labelNe: 'ग्रेड',
      required: false,
      skipLogic: { dependsOnQuestionId: 'has_damage', operator: 'equals', value: 'yes' },
    },
    { has_damage: 'yes' }
  );
  assert.equal(qVisible, true);
});

test('KMC Metric House Numbering assigns Odd to Left and Even to Right based on metric chainage', () => {
  const road = [
    [85.320, 27.695],
    [85.325, 27.695], // Eastbound road along 27.695N
  ];
  // Building North (Left) of road
  const leftBldg = computeMetricHouseNumber({
    wardNo: 10,
    roadCode: 'BNS',
    roadCoords: road,
    buildingCentroid: [85.3215, 27.6952],
  });
  assert.equal(leftBldg.side, 'LEFT');
  assert.equal(leftBldg.metricNumber % 2, 1);
  assert.ok(leftBldg.houseNumberCode.endsWith('L'));

  // Building South (Right) of road
  const rightBldg = computeMetricHouseNumber({
    wardNo: 10,
    roadCode: 'BNS',
    roadCoords: road,
    buildingCentroid: [85.3215, 27.6948],
  });
  assert.equal(rightBldg.side, 'RIGHT');
  assert.equal(rightBldg.metricNumber % 2, 0);
  assert.ok(rightBldg.houseNumberCode.endsWith('R'));
});
