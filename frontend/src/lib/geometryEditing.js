/**
 * KMC-GIS-SERVER — Pure geometry vertex-editing engine.
 *
 * Field surveyors digitize points, lines and polygons inside their assigned task
 * grid. The map workbench exposes three Nepali edit tools:
 *
 *   ताने   (tane)   — move: drag an existing vertex, or relocate a point feature
 *   बिस्तार (bistar) — extend: insert a new vertex next to the selected one
 *   मेट्ने  (metne)  — delete: remove the vertex the user taps
 *
 * OpenLayers geometries are converted by the caller into plain GeoJSON
 * `{ type, coordinates }`, so every operation here is a pure function that can be
 * unit-tested without a browser or a map instance. This module is the single
 * source of truth for vertex indexing: it understands
 *
 *   - Polygon / MultiPolygon rings (outer ring + holes), including the duplicated
 *     closing coordinate that must never be treated as a regular vertex,
 *   - MultiLineString / MultiPolygon parts and their global vertex indices,
 *   - minimum valid vertex counts, so an edit can never produce invalid geometry.
 *
 * Index convention: "global index" = position in the flattened coordinate list
 * produced by `flattenCoordinates()`, which is exactly the order the map renders
 * vertex handles in. Every function returns new geometry objects; inputs are
 * never mutated.
 */

const EPSILON = 1e-9;

export const MIN_LINE_VERTICES = 2;
export const MIN_RING_VERTICES = 3;

function clonePosition(pos) {
  return [Number(pos[0]), Number(pos[1])];
}

function samePosition(a, b) {
  return (
    Array.isArray(a) &&
    Array.isArray(b) &&
    Math.abs(a[0] - b[0]) < EPSILON &&
    Math.abs(a[1] - b[1]) < EPSILON
  );
}

function isValidPosition(pos) {
  return Array.isArray(pos) && pos.length >= 2 && Number.isFinite(pos[0]) && Number.isFinite(pos[1]);
}

function cloneDeepCoordinates(coordinates) {
  if (!Array.isArray(coordinates)) return coordinates;
  if (isValidPosition(coordinates)) return clonePosition(coordinates);
  return coordinates.map((entry) => cloneDeepCoordinates(entry));
}

/**
 * Lists the ordered linear components (rings/lines) of a geometry together with
 * the global index range each one occupies.
 */
export function listLinearParts(geometry) {
  const type = geometry?.type;
  const coordinates = geometry?.coordinates;
  const parts = [];
  if (!Array.isArray(coordinates)) return parts;

  let start = 0;
  const addPart = (ring, closed, path) => {
    if (!Array.isArray(ring)) return;
    parts.push({
      ring,
      closed,
      start,
      end: start + Math.max(0, ring.length - 1),
      path,
    });
    start += ring.length;
  };

  if (type === 'LineString') {
    addPart(coordinates, false, []);
  } else if (type === 'MultiLineString') {
    coordinates.forEach((ring, index) => addPart(ring, false, [index]));
  } else if (type === 'Polygon') {
    coordinates.forEach((ring, index) => addPart(ring, true, [index]));
  } else if (type === 'MultiPolygon') {
    coordinates.forEach((polygon, polygonIndex) => {
      if (!Array.isArray(polygon)) return;
      polygon.forEach((ring, ringIndex) => addPart(ring, true, [polygonIndex, ringIndex]));
    });
  }
  return parts;
}

/**
 * Flattens every vertex of a geometry into a single ordered list.
 * A closed ring contributes its duplicated closing coordinate, matching the
 * handles the map draws.
 */
export function flattenCoordinates(geometry) {
  const type = geometry?.type;
  const coordinates = geometry?.coordinates;
  if (type === 'Point') {
    return isValidPosition(coordinates) ? [clonePosition(coordinates)] : [];
  }
  if (type === 'MultiPoint') {
    return Array.isArray(coordinates)
      ? coordinates.filter(isValidPosition).map(clonePosition)
      : [];
  }
  const flattened = [];
  for (const part of listLinearParts(geometry)) {
    for (const pos of part.ring) {
      if (isValidPosition(pos)) flattened.push(clonePosition(pos));
    }
  }
  return flattened;
}

export function countGeometryVertices(geometry) {
  return flattenCoordinates(geometry).length;
}

export function isPointGeometry(geometry) {
  return geometry?.type === 'Point';
}

export function isExtendableGeometry(geometry) {
  const type = geometry?.type;
  return type === 'LineString' || type === 'MultiLineString' ||
    type === 'Polygon' || type === 'MultiPolygon' || type === 'MultiPoint';
}

/**
 * Finds the vertex closest to `target` within `tolerance` map units.
 * Returns `{ index, coordinate, distance }` or `null`.
 */
export function findNearestVertex(geometry, target, tolerance = 20) {
  if (!isValidPosition(target)) return null;
  const vertices = flattenCoordinates(geometry);
  let bestIndex = -1;
  let bestDistance = Number(tolerance);

  for (let index = 0; index < vertices.length; index++) {
    const vertex = vertices[index];
    const distance = Math.hypot(vertex[0] - target[0], vertex[1] - target[1]);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  }

  if (bestIndex === -1) return null;
  return { index: bestIndex, coordinate: vertices[bestIndex], distance: bestDistance };
}

function findPartForIndex(parts, index) {
  if (typeof index !== 'number' || Number.isNaN(index)) return null;
  return parts.find((part) => index >= part.start && index <= part.end) || null;
}

/**
 * Inserts `target` adjacent to the selected vertex (बिस्तार / extend).
 *
 * - Lines: append at the end, prepend at the start, otherwise insert after the
 *   selected vertex.
 * - Rings: the inserted vertex is always placed *before* the duplicated closing
 *   coordinate, and the ring is re-closed afterwards.
 * - Multi-part geometries: inserts into the part that owns `selectedIndex`.
 *
 * Returns `{ ok: true, geometry, insertedIndex }` or
 * `{ ok: false, reason: 'duplicate' | 'unsupported' }`.
 */
export function insertVertexAt(geometry, target, selectedIndex = null) {
  if (!geometry || !isValidPosition(target)) {
    return { ok: false, reason: 'unsupported' };
  }

  const type = geometry.type;
  const coordinates = cloneDeepCoordinates(geometry.coordinates);
  const position = clonePosition(target);

  if (type === 'Point') {
    return { ok: false, reason: 'unsupported' };
  }

  if (type === 'MultiPoint') {
    if (!Array.isArray(coordinates)) return { ok: false, reason: 'unsupported' };
    if (coordinates.some((existing) => samePosition(existing, position))) {
      return { ok: false, reason: 'duplicate' };
    }
    coordinates.push(position);
    return {
      ok: true,
      geometry: { type, coordinates },
      insertedIndex: coordinates.length - 1,
    };
  }

  const parts = listLinearParts({ type, coordinates });
  if (parts.length === 0) return { ok: false, reason: 'unsupported' };

  const part = findPartForIndex(parts, selectedIndex) || parts[parts.length - 1];
  const ring = part.ring;
  const localIndex =
    selectedIndex == null || !part ? null : selectedIndex - part.start;

  let insertAt;
  if (part.closed) {
    if (localIndex == null || localIndex >= ring.length - 1) {
      insertAt = Math.max(0, ring.length - 1);
    } else if (localIndex <= 0) {
      insertAt = Math.min(1, ring.length - 1);
    } else {
      insertAt = localIndex + 1;
    }
  } else if (localIndex == null || localIndex >= ring.length - 1) {
    insertAt = ring.length;
  } else if (localIndex <= 0) {
    insertAt = 0;
  } else {
    insertAt = localIndex + 1;
  }

  const previous = insertAt > 0 ? ring[insertAt - 1] : null;
  const next = insertAt < ring.length ? ring[insertAt] : null;
  if (samePosition(previous, position) || samePosition(next, position)) {
    return { ok: false, reason: 'duplicate' };
  }

  ring.splice(insertAt, 0, position);

  if (part.closed && ring.length > 1) {
    ring[ring.length - 1] = clonePosition(ring[0]);
  }

  return {
    ok: true,
    geometry: { type, coordinates },
    insertedIndex: part.start + insertAt,
  };
}

function removeRingVertex(coordinates, part, localIndex) {
  const ring = part.ring;
  const distinctCount = part.closed ? ring.length - 1 : ring.length;
  const index = part.closed && localIndex >= ring.length - 1
    ? Math.max(0, ring.length - 2)
    : Math.max(0, localIndex);

  if (distinctCount <= MIN_RING_VERTICES) {
    return { ok: false, reason: 'min_ring_vertices' };
  }

  ring.splice(index, 1);
  if (part.closed && ring.length > 1) {
    ring[ring.length - 1] = clonePosition(ring[0]);
  }
  return { ok: true, removedIndex: part.start + index };
}

function removeLineVertex(coordinates, part, localIndex) {
  const ring = part.ring;
  if (ring.length <= MIN_LINE_VERTICES) {
    return { ok: false, reason: 'min_line_vertices' };
  }
  const index = Math.max(0, Math.min(localIndex, ring.length - 1));
  ring.splice(index, 1);
  return { ok: true, removedIndex: part.start + index };
}

/**
 * Removes a single vertex by global index (मेट्ने / delete).
 *
 * Never produces invalid geometry: lines keep at least two vertices, rings keep
 * at least three distinct vertices. Touching the duplicated closing coordinate
 * deletes the last real vertex instead. For multi-part geometries an emptied part
 * is dropped, and if nothing valid remains `ok: false` is returned.
 */
export function removeVertexAt(geometry, vertexIndex) {
  if (!geometry) return { ok: false, reason: 'unsupported' };
  const type = geometry.type;
  const coordinates = cloneDeepCoordinates(geometry.coordinates);

  if (type === 'Point') return { ok: false, reason: 'min_vertices' };

  if (type === 'MultiPoint') {
    if (!Array.isArray(coordinates) || coordinates.length <= 1) {
      return { ok: false, reason: 'min_vertices' };
    }
    const index = Math.max(0, Math.min(vertexIndex, coordinates.length - 1));
    coordinates.splice(index, 1);
    return { ok: true, geometry: { type, coordinates }, removedIndex: index };
  }

  const parts = listLinearParts({ type, coordinates });
  const part = findPartForIndex(parts, vertexIndex);
  if (!part) return { ok: false, reason: 'not_found' };

  const localIndex = vertexIndex - part.start;
  const result = part.closed
    ? removeRingVertex(coordinates, part, localIndex)
    : removeLineVertex(coordinates, part, localIndex);
  if (!result.ok) return result;

  return { ok: true, geometry: { type, coordinates }, removedIndex: result.removedIndex };
}

/**
 * Removes the vertex nearest to `target` within `tolerance`.
 */
export function removeNearestVertex(geometry, target, tolerance = 20) {
  const hit = findNearestVertex(geometry, target, tolerance);
  if (!hit) return { ok: false, reason: 'no_vertex_nearby' };
  return removeVertexAt(geometry, hit.index);
}

/**
 * Removes the last real vertex of the geometry (keyboard-free "undo last point"
 * helper used by the edit panel). Closed rings drop the last distinct vertex, not
 * the closing duplicate.
 */
export function removeLastVertex(geometry) {
  if (!geometry) return { ok: false, reason: 'unsupported' };
  const type = geometry.type;

  if (type === 'Point') return { ok: false, reason: 'min_vertices' };

  if (type === 'MultiPoint') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length <= 1) {
      return { ok: false, reason: 'min_vertices' };
    }
    return removeVertexAt(geometry, geometry.coordinates.length - 1);
  }

  const parts = listLinearParts(geometry);
  if (parts.length === 0) return { ok: false, reason: 'unsupported' };
  const lastPart = parts[parts.length - 1];
  const lastIndex = lastPart.closed
    ? Math.max(lastPart.start, lastPart.end - 1)
    : lastPart.end;
  return removeVertexAt(geometry, lastIndex);
}

/**
 * Structural validation used before persisting an edited geometry.
 * Returns a (possibly empty) list of human-readable problems.
 */
export function validateGeometry(geometry) {
  const problems = [];
  if (!geometry || typeof geometry.type !== 'string') {
    return ['Geometry is missing a type'];
  }
  const type = geometry.type;
  const coordinates = geometry.coordinates;
  if (type === 'Point') {
    return isValidPosition(coordinates) ? [] : ['Point has invalid coordinates'];
  }
  if (type === 'MultiPoint') {
    if (!Array.isArray(coordinates) || coordinates.length === 0) {
      problems.push('MultiPoint has no points');
    }
    return problems;
  }
  const parts = listLinearParts(geometry);
  if (parts.length === 0) problems.push(`${type} has no vertices`);
  for (const part of parts) {
    if (part.ring.some((pos) => !isValidPosition(pos))) {
      problems.push(`${type} contains a non-finite coordinate`);
      break;
    }
    if (part.closed) {
      if (part.ring.length < MIN_RING_VERTICES + 1) {
        problems.push(`${type} ring has fewer than ${MIN_RING_VERTICES} vertices`);
      }
      if (part.ring.length > 1 && !samePosition(part.ring[0], part.ring[part.ring.length - 1])) {
        problems.push(`${type} ring is not closed`);
      }
    } else if (part.ring.length < MIN_LINE_VERTICES) {
      problems.push(`${type} part has fewer than ${MIN_LINE_VERTICES} vertices`);
    }
  }
  return problems;
}

/**
 * Maps a rejected edit operation to a bilingual field-collector message.
 */
export function describeEditFailure(reason) {
  switch (reason) {
    case 'min_line_vertices':
      return '⚠️ रेखामा कम्तीमा २ बिन्दु हुनुपर्छ, थप मेट्न सकिँदैन। (A line must keep at least 2 vertices.)';
    case 'min_ring_vertices':
    case 'min_vertices':
      return '⚠️ बहुभुजमा कम्तीमा ३ कुना हुनुपर्छ, थप मेट्न सकिँदैन। (A polygon must keep at least 3 vertices.)';
    case 'duplicate':
      return '⚠️ यही स्थानमा पहिले नै बिन्दु छ — नयाँ बिन्दु अलि पर राख्नुहोस्। (A vertex already exists there.)';
    case 'no_vertex_nearby':
      return '⚠️ मेट्न कुनै बिन्दु भेटिएन — बिन्दुको ठीक माथि क्लिक गर्नुहोस्। (No vertex was close enough to delete.)';
    case 'not_found':
      return '⚠️ बिन्दु फेला परेन। (Vertex not found.)';
    default:
      return '⚠️ यो ज्यामितिमा यो कार्य सम्भव छैन। (This operation is not possible on this geometry.)';
  }
}
