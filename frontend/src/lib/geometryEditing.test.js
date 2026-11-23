import test from 'node:test';
import assert from 'node:assert/strict';
import {
  flattenCoordinates,
  listLinearParts,
  countGeometryVertices,
  findNearestVertex,
  insertVertexAt,
  removeVertexAt,
  removeNearestVertex,
  removeLastVertex,
  validateGeometry,
  describeEditFailure,
} from './geometryEditing.js';

const square = () => ({
  type: 'Polygon',
  coordinates: [
    [
      [85.3, 27.7],
      [85.31, 27.7],
      [85.31, 27.71],
      [85.3, 27.71],
      [85.3, 27.7],
    ],
  ],
});

// Square with an inner hole (ring 1), so global indices span two rings.
const squareWithHole = () => ({
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [3, 3],
      [7, 3],
      [7, 7],
      [3, 7],
      [3, 3],
    ],
  ],
});

const twoPolygons = () => ({
  type: 'MultiPolygon',
  coordinates: [
    [[
      [0, 0],
      [4, 0],
      [4, 4],
      [0, 4],
      [0, 0],
    ]],
    [[
      [10, 10],
      [14, 10],
      [14, 14],
      [10, 14],
      [10, 10],
    ]],
  ],
});

test('flattenCoordinates keeps the duplicated closing vertex and global order', () => {
  const coords = flattenCoordinates(square());
  assert.equal(coords.length, 5);
  assert.deepEqual(coords[0], [85.3, 27.7]);
  assert.deepEqual(coords[4], [85.3, 27.7]);
  assert.equal(countGeometryVertices(square()), 5);
});

test('listLinearParts reports global index ranges for every ring (outer + hole)', () => {
  const parts = listLinearParts(squareWithHole());
  assert.equal(parts.length, 2);
  assert.equal(parts[0].start, 0);
  assert.equal(parts[0].end, 4);
  assert.equal(parts[1].start, 5);
  assert.equal(parts[1].end, 9);
  assert.equal(parts[1].closed, true);
});

test('बिस्तार appends before the closing vertex and returns the new global index', () => {
  const result = insertVertexAt(square(), [85.305, 27.715], 4);
  assert.equal(result.ok, true);
  assert.equal(result.insertedIndex, 4);

  const ring = result.geometry.coordinates[0];
  assert.equal(ring.length, 6);
  assert.deepEqual(ring[4], [85.305, 27.715]);
  assert.deepEqual(ring[5], ring[0], 'ring must stay closed');
  assert.deepEqual(ring[0], [85.3, 27.7], 'first vertex must not move');
});

test('बिस्तार inserts into the hole ring when the selected index belongs to it', () => {
  const polygon = squareWithHole();
  const holeVertexIndex = 6; // hole ring index 1: [7, 3]
  const result = insertVertexAt(polygon, [5, 2.5], holeVertexIndex);
  assert.equal(result.ok, true);
  assert.equal(result.insertedIndex, 7);

  const [outer, hole] = result.geometry.coordinates;
  assert.equal(outer.length, 5, 'outer ring untouched');
  assert.equal(hole.length, 6, 'hole gains one vertex');
  assert.deepEqual(hole[2], [5, 2.5]);
  assert.deepEqual(hole[hole.length - 1], hole[0], 'hole stays closed');
});

test('बिस्तार inserts into the correct part of a MultiPolygon', () => {
  const result = insertVertexAt(twoPolygons(), [12, 14], 8);
  assert.equal(result.ok, true);

  const polygonA = result.geometry.coordinates[0][0];
  const polygonB = result.geometry.coordinates[1][0];
  assert.equal(polygonA.length, 5, 'first polygon untouched');
  assert.equal(polygonB.length, 6);
  assert.deepEqual(polygonB[4], [12, 14]);
  assert.deepEqual(polygonB[5], polygonB[0]);
});

test('बिस्तार rejects a duplicate vertex instead of creating a zero-length segment', () => {
  const result = insertVertexAt(square(), [85.31, 27.7], 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'duplicate');
});

test('बिस्तार cannot extend a Point feature', () => {
  const result = insertVertexAt({ type: 'Point', coordinates: [85.3, 27.7] }, [85.31, 27.7], 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'unsupported');
});

test('मेट्ने on the closing duplicate deletes the last real vertex and re-closes', () => {
  const result = removeVertexAt(square(), 4);
  assert.equal(result.ok, true);
  const ring = result.geometry.coordinates[0];
  assert.equal(ring.length, 4);
  assert.deepEqual(ring[0], [85.3, 27.7]);
  assert.deepEqual(ring[ring.length - 1], ring[0]);
  assert.equal(validateGeometry(result.geometry).length, 0);
});

test('मेट्ने refuses to collapse a triangle below 3 vertices', () => {
  const triangle = {
    type: 'Polygon',
    coordinates: [[[0, 0], [1, 0], [0, 1], [0, 0]]],
  };
  const result = removeVertexAt(triangle, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'min_ring_vertices');
  assert.match(describeEditFailure(result.reason), /कम्तीमा ३ कुना/);
});

test('मेट्ने deletes the tapped vertex inside a hole ring, not the outer ring', () => {
  const result = removeVertexAt(squareWithHole(), 6); // [7, 3] in the hole
  assert.equal(result.ok, true);
  const [outer, hole] = result.geometry.coordinates;
  assert.equal(outer.length, 5);
  assert.equal(hole.length, 4);
  assert.deepEqual(hole, [[3, 3], [7, 7], [3, 7], [3, 3]]);
  assert.equal(validateGeometry(result.geometry).length, 0);
});

test('मेट्ने protects lines with only two vertices', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [1, 1]] };
  const result = removeVertexAt(line, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'min_line_vertices');
});

test('मेट्ने removes a LineString vertex when at least three remain', () => {
  const line = { type: 'LineString', coordinates: [[0, 0], [1, 1], [2, 2]] };
  const result = removeVertexAt(line, 1);
  assert.equal(result.ok, true);
  assert.deepEqual(result.geometry.coordinates, [[0, 0], [2, 2]]);
});

test('removeNearestVertex only deletes within tolerance and reports when nothing is near', () => {
  const near = removeNearestVertex(square(), [85.3001, 27.7001], 50);
  assert.equal(near.ok, true);

  const far = removeNearestVertex(square(), [86.0, 28.0], 0.001);
  assert.equal(far.ok, false);
  assert.equal(far.reason, 'no_vertex_nearby');
  assert.match(describeEditFailure(far.reason), /कुनै बिन्दु भेटिएन/);
});

test('findNearestVertex returns the closest vertex and its coordinate', () => {
  const hit = findNearestVertex(square(), [85.3095, 27.7005], 2);
  assert.ok(hit);
  assert.equal(hit.index, 1);
  assert.deepEqual(hit.coordinate, [85.31, 27.7]);
});

test('removeLastVertex drops the last real vertex of a closed ring', () => {
  const result = removeLastVertex({
    type: 'Polygon',
    coordinates: [[[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]]],
  });
  assert.equal(result.ok, true);
  const ring = result.geometry.coordinates[0];
  assert.equal(ring.length, 4);
  assert.deepEqual(ring, [[0, 0], [4, 0], [4, 4], [0, 0]]);
  assert.equal(validateGeometry(result.geometry).length, 0);
});

test('removeLastVertex works on MultiLineString parts', () => {
  const multi = {
    type: 'MultiLineString',
    coordinates: [
      [[0, 0], [1, 1], [2, 2]],
      [[10, 10], [11, 11], [12, 12]],
    ],
  };
  const result = removeLastVertex(multi);
  assert.equal(result.ok, true);
  assert.deepEqual(result.geometry.coordinates[1], [[10, 10], [11, 11]]);
});

test('MultiPoint supports extend and delete but never becomes empty', () => {
  const multiPoint = { type: 'MultiPoint', coordinates: [[0, 0], [1, 1]] };
  const extended = insertVertexAt(multiPoint, [2, 2], 1);
  assert.equal(extended.ok, true);
  assert.equal(extended.geometry.coordinates.length, 3);

  const oneLeft = { type: 'MultiPoint', coordinates: [[0, 0]] };
  const result = removeVertexAt(oneLeft, 0);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'min_vertices');
});

test('validateGeometry reports unclosed rings and missing vertices', () => {
  assert.ok(validateGeometry({ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1]]] }).length > 0);
  assert.ok(validateGeometry({ type: 'LineString', coordinates: [[0, 0]] }).length > 0);
  assert.deepEqual(validateGeometry(square()), []);
});
