"""
KMC-GIS-SERVER — 6-Mode Spatial Grid & AOI Partitioner (backend/app/spatial_grid.py)

Field tasking doctrine: an Area of Interest (AOI) is partitioned into **complete**,
non-overlapping task grids that a DataCollector can be assigned to. A grid engine is
therefore only correct when the union of all cells covers the whole AOI — no missing
patches, no cells outside the AOI.

This module is deliberately dependency-light: it uses Shapely (already a project
dependency) and a local metric projection, so grid generation works even when
PostGIS is temporarily unavailable. The PostGIS write is a best-effort mirror of the
authoritative in-memory/state payload.

Supported AOI sources (resolved by the API layer):
  - drawn polygon (GeoJSON drawn on the map)
  - persisted project boundary ("entire AOI")
  - union of an uploaded vector layer's features
  - a set of selected features

Supported grid geometries:
  1. SQUARE / RECTANGULAR  – square lattice clipped to the AOI
  2. HEXAGON               – pointy-top hexagon lattice
  3. TRIANGLE              – Delaunay triangulation of a lattice + AOI boundary
  4. CIRCULAR              – Voronoi cells of a close-packed circular seed lattice
  5. RANDOM / VORONOI      – Voronoi cells of seeded random points
  6. STRAIGHT_SKELETON     – straights aligned to the AOI's minimum rotated rectangle
                             (oriented grid; a true CGAL straight skeleton is not
                             available in this stack, so this is the documented,
                             deterministic straight-edged equivalent)
"""

import json
import math
import random
from typing import Any, Dict, List, Optional, Tuple

from shapely.geometry import (
    GeometryCollection,
    MultiPolygon,
    Point,
    Polygon,
    box,
    mapping,
    shape,
)
from shapely.ops import triangulate, unary_union, voronoi_diagram
from shapely.validation import make_valid

try:  # Shapely >= 2.1 (ops.transform is deprecated)
    from shapely import transform as _shapely_map_coordinates
except ImportError:  # pragma: no cover - older Shapely
    _shapely_map_coordinates = None

if _shapely_map_coordinates is None:  # pragma: no cover
    from shapely.ops import transform as _legacy_transform


def map_coordinates(geometry, coordinate_fn):
    """Applies `coordinate_fn(x, y) -> (x2, y2)` to every coordinate of a geometry."""
    if geometry is None or geometry.is_empty:
        return geometry
    if _shapely_map_coordinates is not None:
        import numpy as np

        def _apply(coords):
            array = np.asarray(coords, dtype=float)
            mapped = array.copy()
            for index in range(array.shape[0]):
                x, y = coordinate_fn(array[index, 0], array[index, 1])
                mapped[index, 0] = x
                mapped[index, 1] = y
            return mapped

        return _shapely_map_coordinates(geometry, _apply)

    return _legacy_transform(lambda x, y, z=None: coordinate_fn(x, y), geometry)

# A cell smaller than this (m²) is numeric boundary noise, not a real task area.
MIN_CELL_AREA_SQM = 1.0
MAX_GRID_CELLS = 5000

GRID_MODES = {
    "SQUARE": "SQUARE",
    "RECTANGULAR": "SQUARE",
    "RECTANGLE": "SQUARE",
    "HEXAGON": "HEXAGON",
    "HEXAGONAL": "HEXAGON",
    "TRIANGLE": "TRIANGLE",
    "TRIANGULAR": "TRIANGLE",
    "CIRCLE": "CIRCULAR",
    "CIRCULAR": "CIRCULAR",
    "RANDOM": "RANDOM",
    "VORONOI": "RANDOM",
    "STRAIGHT_SKELETON": "STRAIGHT_SKELETON",
    "SKELETON": "STRAIGHT_SKELETON",
}

GRID_LABELS_NE = {
    "SQUARE": "वर्ग",
    "HEXAGON": "षट्भुज",
    "TRIANGLE": "त्रिभुज",
    "CIRCULAR": "वृत्ताकार",
    "RANDOM": "भोरोनोई",
    "STRAIGHT_SKELETON": "सिधा-रेखा",
}

VALID_AOI_MODES = {"drawn_polygon", "entire_layer", "selected_features"}


def normalize_grid_mode(grid_shape: Any) -> str:
    key = str(grid_shape or "HEXAGON").strip().upper().replace(" ", "_").replace("-", "_")
    mode = GRID_MODES.get(key)
    if mode is None:
        raise ValueError(
            f"Unknown grid type '{grid_shape}'. Expected one of: {', '.join(sorted(set(GRID_MODES.values())))}"
        )
    return mode


def validate_cell_size(grid_size_m: Any) -> float:
    try:
        size = float(grid_size_m)
    except (TypeError, ValueError):
        raise ValueError("Grid cell size must be a number of metres.")
    if not math.isfinite(size) or size < 5 or size > 5000:
        raise ValueError("Grid cell size must be between 5 m and 5000 m.")
    return size


# ---------------------------------------------------------------------------
# AOI geometry helpers
# ---------------------------------------------------------------------------

def _as_polygonal(geometry) -> Optional[Any]:
    """Returns a valid Polygon/MultiPolygon or None (drops lines/points)."""
    if geometry is None or geometry.is_empty:
        return None
    if geometry.geom_type in ("Polygon", "MultiPolygon"):
        return geometry
    if geometry.geom_type in ("GeometryCollection", "MultiLineString", "LineString", "Point", "MultiPoint"):
        polygons = [
            part for part in getattr(geometry, "geoms", [])
            if part.geom_type in ("Polygon", "MultiPolygon") and not part.is_empty
        ]
        if not polygons:
            return None
        return unary_union(polygons)
    return None


def normalize_aoi_geometry(geojson: Any):
    """Validates GeoJSON input and returns a snapped, valid polygonal AOI."""
    if isinstance(geojson, str):
        try:
            geojson = json.loads(geojson)
        except json.JSONDecodeError as exc:
            raise ValueError(f"AOI is not valid JSON: {exc}") from exc
    if not isinstance(geojson, dict):
        raise ValueError("AOI must be a GeoJSON geometry or Feature.")

    if geojson.get("type") == "FeatureCollection":
        features = geojson.get("features") or []
        parts = []
        for feature in features:
            geometry = feature.get("geometry") if isinstance(feature, dict) else None
            polygonal = _as_polygonal(shape(geometry)) if geometry else None
            if polygonal is not None:
                parts.append(polygonal)
        if not parts:
            raise ValueError("The uploaded AOI contains no polygon features.")
        geometry = unary_union(parts)
    elif geojson.get("type") == "Feature":
        geometry = shape(geojson.get("geometry") or {})
    elif geojson.get("type") in ("Polygon", "MultiPolygon", "GeometryCollection"):
        geometry = shape(geojson)
    else:
        raise ValueError("AOI must be a Polygon or MultiPolygon GeoJSON geometry.")

    geometry = _as_polygonal(make_valid(geometry))
    if geometry is None or geometry.is_empty or geometry.area <= 0:
        raise ValueError("AOI has no usable polygon area.")
    return geometry


def aoi_centroid_lonlat(aoi_geometry) -> Tuple[float, float]:
    centroid = aoi_geometry.centroid
    return float(centroid.x), float(centroid.y)


def make_local_projector(lon0: float, lat0: float):
    """Local WGS84 ellipsoidal metric projection around the AOI centroid."""
    phi = math.radians(lat0)
    metres_per_degree_lat = (
        111132.92 - 559.82 * math.cos(2.0 * phi) + 1.175 * math.cos(4.0 * phi)
    )
    metres_per_degree_lon = max(
        1.0,
        111412.84 * math.cos(phi) - 93.5 * math.cos(3.0 * phi),
    )

    def forward(lon, lat, z=None):
        return ((lon - lon0) * metres_per_degree_lon, (lat - lat0) * metres_per_degree_lat)

    def inverse(x, y, z=None):
        return (lon0 + x / metres_per_degree_lon, lat0 + y / metres_per_degree_lat)

    return forward, inverse


def project_aoi_to_local(aoi_geometry):
    lon0, lat0 = aoi_centroid_lonlat(aoi_geometry)
    forward, inverse = make_local_projector(lon0, lat0)
    return map_coordinates(aoi_geometry, forward), inverse


# ---------------------------------------------------------------------------
# Cell generators (all operate in the local metric plane)
# ---------------------------------------------------------------------------

def _square_cells(aoi_local, size: float):
    minx, miny, maxx, maxy = aoi_local.bounds
    cells = []
    y = math.floor(miny / size) * size
    while y < maxy:
        x = math.floor(minx / size) * size
        while x < maxx:
            cells.append(box(x, y, x + size, y + size))
            x += size
        y += size
    return cells


def _hexagon_radius(size: float) -> float:
    # Pointy-top hexagon with flat-to-flat width == size.
    return size / math.sqrt(3.0)


def _hexagon(center_x: float, center_y: float, radius: float) -> Polygon:
    points = []
    for index in range(6):
        angle = math.radians(60.0 * index - 30.0)
        points.append((center_x + radius * math.cos(angle), center_y + radius * math.sin(angle)))
    points.append(points[0])
    return Polygon(points)


def _hexagon_cells(aoi_local, size: float):
    radius = _hexagon_radius(size)
    dx = math.sqrt(3.0) * radius
    dy = 1.5 * radius
    minx, miny, maxx, maxy = aoi_local.bounds
    cells = []
    row = 0
    y = miny - dy
    while y <= maxy + dy:
        offset = (dx / 2.0) if row % 2 else 0.0
        x = minx - dx + offset
        while x <= maxx + dx:
            cells.append(_hexagon(x, y, radius))
            x += dx
        y += dy
        row += 1
    return cells


def _lattice_points(aoi_local, size: float, boundary_step: Optional[float] = None):
    minx, miny, maxx, maxy = aoi_local.bounds
    points = []
    y = miny
    while y <= maxy:
        x = minx
        while x <= maxx:
            if aoi_local.buffer(max(size, 1.0)).contains(Point(x, y)):
                points.append((x, y))
            x += size
        y += size

    # Sample the AOI boundary so triangles follow concave edges instead of spanning them.
    step = boundary_step or max(size / 2.0, 1.0)
    boundary = aoi_local.boundary
    length = boundary.length
    if length > 0:
        distance = 0.0
        while distance <= length:
            point = boundary.interpolate(distance)
            points.append((point.x, point.y))
            distance += step
    return points


def _triangle_cells(aoi_local, size: float):
    points = _lattice_points(aoi_local, size, boundary_step=max(size / 2.0, 1.0))
    if len(points) < 3:
        return []
    from shapely.geometry import MultiPoint

    try:
        triangles = list(triangulate(MultiPoint(points)))
    except Exception:
        return []
    return [triangle for triangle in triangles if triangle.area > 0]


def _voronoi_cells_from_seeds(aoi_local, seeds):
    if len(seeds) < 2:
        return []
    envelope = box(*aoi_local.bounds).buffer(max(aoi_local.length / 100.0, 1.0))
    from shapely.geometry import MultiPoint

    try:
        diagram = voronoi_diagram(MultiPoint(seeds), envelope=envelope)
    except Exception:
        return []
    return [cell for cell in polygonals(diagram)]


def polygonals(geometry) -> List[Polygon]:
    if geometry is None or geometry.is_empty:
        return []
    if isinstance(geometry, Polygon):
        return [geometry]
    if isinstance(geometry, (MultiPolygon, GeometryCollection)):
        polygons: List[Polygon] = []
        for part in geometry.geoms:
            polygons.extend(polygonals(part))
        return polygons
    return []


def _circular_cells(aoi_local, size: float):
    """Voronoi cells of a close-packed circular seed lattice (complete, non-overlapping)."""
    radius = _hexagon_radius(size)
    dx = math.sqrt(3.0) * radius
    dy = 1.5 * radius
    minx, miny, maxx, maxy = aoi_local.bounds
    seeds = []
    row = 0
    y = miny - dy
    while y <= maxy + dy:
        offset = (dx / 2.0) if row % 2 else 0.0
        x = minx - dx + offset
        while x <= maxx + dx:
            seeds.append((x, y))
            x += dx
        y += dy
        row += 1
    return _voronoi_cells_from_seeds(aoi_local, seeds)


def _random_cells(aoi_local, size: float, seed: int = 2083):
    area = aoi_local.area
    count = max(2, min(MAX_GRID_CELLS, int(round(area / (size * size)))))
    rng = random.Random(seed)
    minx, miny, maxx, maxy = aoi_local.bounds
    seeds = []
    attempts = 0
    while len(seeds) < count and attempts < count * 60:
        attempts += 1
        candidate = (rng.uniform(minx, maxx), rng.uniform(miny, maxy))
        if aoi_local.contains(Point(candidate)):
            seeds.append(candidate)
    # Guarantee coverage of the whole AOI even for very irregular shapes.
    boundary = aoi_local.boundary
    length = boundary.length
    step = max(size / 2.0, 1.0)
    distance = 0.0
    while length > 0 and distance <= length:
        point = boundary.interpolate(distance)
        seeds.append((point.x, point.y))
        distance += step
    return _voronoi_cells_from_seeds(aoi_local, seeds)


def _straight_skeleton_cells(aoi_local, size: float):
    """Oriented grid aligned to the AOI's minimum rotated rectangle (straight edges)."""
    try:
        rotated_rect = aoi_local.minimum_rotated_rectangle
    except Exception:
        rotated_rect = None
    if rotated_rect is None or rotated_rect.is_empty or len(list(rotated_rect.exterior.coords)) < 4:
        return _square_cells(aoi_local, size)

    coords = list(rotated_rect.exterior.coords)[:4]
    # Rotation angle of the first rectangle edge.
    angle = math.atan2(coords[1][1] - coords[0][1], coords[1][0] - coords[0][0])
    cos_a, sin_a = math.cos(-angle), math.sin(-angle)

    def rotate(x, y, z=None):
        return (x * cos_a - y * sin_a, x * sin_a + y * cos_a)

    def unrotate(x, y, z=None):
        return (x * cos_a + y * sin_a, -x * sin_a + y * cos_a)

    rotated_aoi = map_coordinates(aoi_local, rotate)
    rotated_cells = _square_cells(rotated_aoi, size)
    return [map_coordinates(cell, unrotate) for cell in rotated_cells]


GENERATORS = {
    "SQUARE": _square_cells,
    "HEXAGON": _hexagon_cells,
    "TRIANGLE": _triangle_cells,
    "CIRCULAR": _circular_cells,
    "RANDOM": _random_cells,
    "STRAIGHT_SKELETON": _straight_skeleton_cells,
}


# ---------------------------------------------------------------------------
# Public grid generation API
# ---------------------------------------------------------------------------

def geometry_area_sqm(geojson: Any) -> float:
    """Approximate geodesic area (m²) of a GeoJSON polygon using the local projection."""
    aoi = normalize_aoi_geometry(geojson)
    lon0, lat0 = aoi_centroid_lonlat(aoi)
    forward, _ = make_local_projector(lon0, lat0)
    return float(map_coordinates(aoi, forward).area)


def generate_grid_cells(
    aoi_geojson: Any,
    grid_shape: Any = "HEXAGON",
    grid_size_m: Any = 200,
    seed: int = 2083,
) -> Dict[str, Any]:
    """Partitions an AOI into task cells and reports coverage.

    Returns `{grid_shape, cell_size_m, cells, stats}` where each cell is
    `{grid_index, grid_code, name, geometry, bbox, area_sqm, centroid, cell_size_m}`.
    """
    mode = normalize_grid_mode(grid_shape)
    size = validate_cell_size(grid_size_m)
    aoi = normalize_aoi_geometry(aoi_geojson)
    aoi_local, inverse = project_aoi_to_local(aoi)

    generator = GENERATORS[mode]
    raw_cells = generator(aoi_local, size) if mode != "RANDOM" else generator(aoi_local, size, seed)

    def _clip_to_aoi(raw_cells) -> List[Any]:
        clipped_cells: List[Any] = []
        for raw in raw_cells:
            if raw is None or raw.is_empty:
                continue
            try:
                part = make_valid(raw.intersection(aoi_local))
            except Exception:
                continue
            for polygonal in polygonals(part):
                if polygonal.area >= MIN_CELL_AREA_SQM:
                    clipped_cells.append(polygonal)
        return clipped_cells

    clipped = _clip_to_aoi(raw_cells)

    # A generator can fail on degenerate input; a square lattice always tiles the plane.
    if not clipped:
        clipped = _clip_to_aoi(_square_cells(aoi_local, size))

    # Last resort: the AOI itself becomes the single task area rather than losing coverage.
    if not clipped:
        clipped = [part for part in polygonals(aoi_local) if part.area >= MIN_CELL_AREA_SQM]

    # Residual-gap repair: any AOI area left uncovered (numeric slivers, concave
    # boundaries, or dropped generator output) becomes an additional cell, so the
    # union of task grids always equals the AOI.
    if clipped:
        covered = unary_union(clipped)
        try:
            residual = make_valid(aoi_local.difference(covered))
        except Exception:
            residual = aoi_local.difference(covered)
        clipped.extend(
            part for part in polygonals(residual) if part.area >= MIN_CELL_AREA_SQM
        )

    if len(clipped) > MAX_GRID_CELLS:
        raise ValueError(
            f"Grid would create {len(clipped)} cells (limit {MAX_GRID_CELLS}). "
            "Increase the cell size or reduce the AOI."
        )
    if not clipped:
        raise ValueError("No grid cells were produced for this AOI — check the AOI geometry and cell size.")

    # Deterministic numbering: top-to-bottom, left-to-right by centroid.
    clipped.sort(key=lambda cell: (-round(cell.centroid.y, 3), round(cell.centroid.x, 3)))

    cells = []
    for index, cell in enumerate(clipped, start=1):
        lon, lat = inverse(cell.centroid.x, cell.centroid.y)
        cell_geo = map_coordinates(cell, inverse)
        bbox_local = cell.bounds
        minx, miny = inverse(bbox_local[0], bbox_local[1])
        maxx, maxy = inverse(bbox_local[2], bbox_local[3])
        cells.append(
            {
                "grid_index": index,
                "grid_code": f"G-{index:03d}",
                "name": f"{GRID_LABELS_NE.get(mode, 'ग्रिड')} #{index}",
                "geometry": mapping(cell_geo),
                "bbox": [min(float(minx), float(maxx)), min(float(miny), float(maxy)),
                         max(float(minx), float(maxx)), max(float(miny), float(maxy))],
                "centroid": [float(lon), float(lat)],
                "area_sqm": round(float(cell.area), 2),
                "cell_size_m": size,
            }
        )

    union_area = float(unary_union(clipped).area)
    aoi_area = float(aoi_local.area)
    coverage = round(min(100.0, (union_area / aoi_area) * 100.0), 2) if aoi_area else 0.0

    return {
        "grid_shape": mode,
        "cell_size_m": size,
        "cells": cells,
        "stats": {
            "cells": len(cells),
            "aoi_area_sqm": round(aoi_area, 2),
            "covered_area_sqm": round(union_area, 2),
            "coverage_percent": coverage,
            "min_cell_area_sqm": round(min(cell["area_sqm"] for cell in cells), 2),
            "max_cell_area_sqm": round(max(cell["area_sqm"] for cell in cells), 2),
        },
    }


# ---------------------------------------------------------------------------
# PostGIS mirror (best effort; the state payload stays authoritative)
# ---------------------------------------------------------------------------

async def generate_six_mode_grid(
    db,
    boundary_geojson: dict,
    grid_shape: str,
    grid_size_m: float,
    project_id: int,
    barrier_layer_id: Optional[int] = None,
    project_name: Optional[str] = None,
    aoi_mode: str = "drawn_polygon",
    grid_params: Optional[Dict[str, Any]] = None,
) -> int:
    """Persists the generated cells into PostGIS `task_grids` (best effort).

    Runtime project ids are epoch milliseconds, so the parent `survey_projects` row is
    upserted first to satisfy the foreign key. Each cell is stored as a MULTIPOLYGON so
    AOI-clipped multi-part slivers survive the mirror (the state payload remains
    authoritative). Callers must not depend on this function for correctness.
    """
    normalized_aoi = normalize_aoi_geometry(boundary_geojson)
    normalized_aoi_geojson = mapping(normalized_aoi)
    result = generate_grid_cells(normalized_aoi_geojson, grid_shape, grid_size_m, seed=int(project_id) or 2083)
    from sqlalchemy import text

    pid = int(project_id)
    display_name = (project_name or "").strip() or f"Project {pid}"
    resolved_aoi_mode = str(aoi_mode or "drawn_polygon").strip()
    if resolved_aoi_mode not in VALID_AOI_MODES:
        resolved_aoi_mode = "drawn_polygon"

    resolved_grid_params: Dict[str, Any] = dict(grid_params) if isinstance(grid_params, dict) else {}
    resolved_grid_params.setdefault("grid_size_m", result["cell_size_m"])
    resolved_grid_params.setdefault("grid_shape", result["grid_shape"])
    if barrier_layer_id is not None:
        resolved_grid_params.setdefault("barrier_layer_id", barrier_layer_id)

    await db.execute(
        text(
            """
            INSERT INTO survey_projects
                (id, name, status, mode, aoi_source_type, grid_shape, grid_params, boundary, created_at)
            VALUES
                (:pid, :name, 'ACTIVE', 'STANDARD', :aoi_mode, :shape, CAST(:grid_params AS jsonb),
                 ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON(:aoi), 4326)), NOW())
            ON CONFLICT (id) DO UPDATE
            SET boundary = COALESCE(EXCLUDED.boundary, survey_projects.boundary),
                aoi_source_type = EXCLUDED.aoi_source_type,
                grid_shape = EXCLUDED.grid_shape,
                grid_params = EXCLUDED.grid_params
            """
        ),
        {
            "pid": pid,
            "name": display_name[:255],
            "aoi_mode": resolved_aoi_mode,
            "shape": result["grid_shape"],
            "grid_params": json.dumps(resolved_grid_params),
            "aoi": json.dumps(normalized_aoi_geojson),
        },
    )
    await db.execute(
        text(
            "UPDATE vector_features SET task_grid_id = NULL "
            "WHERE task_grid_id IN (SELECT id FROM task_grids WHERE project_id = :pid)"
        ),
        {"pid": pid},
    )
    await db.execute(text("DELETE FROM task_grids WHERE project_id = :pid"), {"pid": pid})

    insert_sql = text(
        """
        INSERT INTO task_grids (project_id, grid_index, name, grid_shape, status, geom, properties)
        VALUES (
            :pid,
            :idx,
            :name,
            :shape,
            'READY',
            ST_Multi(
                ST_CollectionExtract(
                    ST_MakeValid(ST_SetSRID(ST_GeomFromGeoJSON(:geojson), 4326)), 3
                )
            ),
            CAST(:props AS jsonb)
        )
        """
    )
    for cell in result["cells"]:
        await db.execute(
            insert_sql,
            {
                "pid": pid,
                "idx": cell["grid_index"],
                "name": cell["name"],
                "shape": result["grid_shape"],
                "geojson": json.dumps(cell["geometry"]),
                "props": json.dumps(
                    {
                        "task_id": pid * 1000 + int(cell["grid_index"]),
                        "grid_code": cell["grid_code"],
                        "bbox": cell["bbox"],
                        "centroid": cell["centroid"],
                        "area_sqm": cell["area_sqm"],
                    }
                ),
            },
        )
    return len(result["cells"])
