"""
KMC-GIS-SERVER Region & Assigned-Grid Clipped Offline Packager (backend/app/routers/offline.py)

Builds an authenticated, real offline reference bundle for field PWA work:
reference vector features intersecting a buffered AOI / assigned task grid,
per-layer metadata, the active questionnaire schema and a SHA-256 manifest.
The bundle is written to the shared uploads volume and streamed through the
nginx internal X-Accel-Redirect location.
"""

import hashlib
import json
import math
import os
import re
import time
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel
from sqlalchemy import text

router = APIRouter(prefix="/api/offline", tags=["Offline PWA Packager"])

BUNDLE_NAME_PATTERN = re.compile(r"^bundle_[A-Za-z0-9_-]{8,80}\.json$")
GRID_SCOPE_PATTERN = re.compile(r"^grid_?(\d+)$")


class OfflinePackageRequest(BaseModel):
    project_id: int
    task_grid_id: Optional[int] = None
    custom_aoi_geojson: Optional[dict] = None
    layer_ids: List[int]
    buffer_meters: float = 100.0
    zoom_min: int = 14
    zoom_max: int = 21


def _backend():
    # Deferred import: main imports this router at module load time.
    from .. import main as backend

    return backend


def _aoi_geometry(req: OfflinePackageRequest, backend):
    if req.custom_aoi_geojson:
        from shapely.geometry import shape

        try:
            geometry = shape(req.custom_aoi_geojson)
        except Exception:
            raise HTTPException(status_code=400, detail="Invalid `custom_aoi_geojson` geometry.")
        if geometry.is_empty:
            raise HTTPException(status_code=400, detail="`custom_aoi_geojson` is empty.")
        return geometry, "custom_aoi"

    if req.task_grid_id is None:
        raise HTTPException(
            status_code=400,
            detail="Provide either `task_grid_id` or `custom_aoi_geojson`.",
        )
    from shapely.geometry import shape

    for task in backend._project_task_grids(req.project_id):
        if str(task.get("id")) == str(req.task_grid_id):
            try:
                geometry = shape(task["geometry"])
            except Exception:
                raise HTTPException(status_code=400, detail="Assigned task grid geometry is invalid.")
            return geometry, f"grid_{req.task_grid_id}"
    raise HTTPException(status_code=404, detail="Task grid not found in this project.")


def _enforce_aoi_scope(req, aoi, project, user, backend):
    """Keeps packaged AOIs inside the project boundary and assigned field grids.

    DataCollectors may only package a grid assigned to them; every caller must
    request an AOI that lies predominantly inside the project boundary so the
    bundle cannot be used to pull arbitrary municipal data.
    """
    from shapely.geometry import shape

    if str(user.get("role")) == "DataCollector":
        if req.task_grid_id is None:
            raise HTTPException(
                status_code=403,
                detail="संकलकले आफूलाई तोकिएको ग्रिड मात्र अफलाइन प्याकेज गर्न सक्छ। (Collectors must package an assigned task grid.)",
            )
        task = next(
            (t for t in backend._project_task_grids(req.project_id) if str(t.get("id")) == str(req.task_grid_id)),
            None,
        )
        if task is None or str(user.get("id")) not in backend._task_assignee_ids(task):
            raise HTTPException(
                status_code=403,
                detail="यो ग्रिड तपाईंलाई तोकिएको छैन। (This task grid is not assigned to you.)",
            )

    boundary_payload = project.get("boundary_geojson")
    if not boundary_payload:
        return
    try:
        boundary = shape(boundary_payload)
    except Exception:
        return
    if boundary.is_empty or aoi.is_empty:
        return
    clipped = aoi.intersection(boundary)
    if clipped.is_empty or clipped.area < aoi.area * 0.5:
        raise HTTPException(
            status_code=403,
            detail="अनुरोध गरिएको क्षेत्र परियोजना सीमा भित्र पर्दैन। (The requested AOI lies outside the project boundary.)",
        )


def _buffered_aoi(geometry, buffer_meters: float):
    """Buffers the AOI in metres by projecting to local equirectangular metres."""
    from shapely.ops import transform

    lat0 = geometry.centroid.y
    metres_per_degree_lon = max(1.0, 111320.0 * math.cos(math.radians(lat0)))
    metres_per_degree_lat = 111320.0

    def to_metres(x, y, z=None):
        return (x * metres_per_degree_lon, y * metres_per_degree_lat)

    metres = transform(to_metres, geometry)
    return metres.buffer(buffer_meters)


def _buffered_aoi_wgs84_geojson(geometry, buffer_meters: float) -> str:
    """Returns the buffered AOI projected back to WGS84 GeoJSON for PostGIS queries."""
    from shapely.geometry import mapping
    from shapely.ops import transform

    lat0 = geometry.centroid.y
    metres_per_degree_lon = max(1.0, 111320.0 * math.cos(math.radians(lat0)))
    metres_per_degree_lat = 111320.0

    buffered_m = _buffered_aoi(geometry, buffer_meters)
    buffered_wgs84 = transform(
        lambda x, y, z=None: (x / metres_per_degree_lon, y / metres_per_degree_lat),
        buffered_m,
    )
    return json.dumps(mapping(buffered_wgs84))


async def _fetch_postgis_clipped_features(
    layer_id: Any,
    buffered_wgs84_geojson: str,
    backend,
) -> Optional[List[Dict[str, Any]]]:
    """Fetches PostGIS features intersecting the buffered AOI."""
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    try:
        engine = backend.get_engine()
        async with engine.connect() as conn:
            q = text(
                """
                SELECT id, record_id, ST_AsGeoJSON(geom) AS geom_json, properties
                FROM vector_features
                WHERE layer_id = :lid
                  AND ST_Intersects(geom, ST_SetSRID(ST_GeomFromGeoJSON(:buf_geojson), 4326))
                ORDER BY id;
                """
            )
            rows = (
                await conn.execute(
                    q,
                    {"lid": pg_lid, "buf_geojson": buffered_wgs84_geojson},
                )
            ).fetchall()
            features: List[Dict[str, Any]] = []
            for row in rows:
                geom_obj = json.loads(row.geom_json) if isinstance(row.geom_json, str) else row.geom_json
                props = dict(row.properties or {})
                props["_id"] = row.id
                if row.record_id is not None:
                    props["_record_id"] = row.record_id
                features.append(
                    {
                        "type": "Feature",
                        "id": row.id,
                        "geometry": geom_obj,
                        "properties": props,
                    }
                )
            return features
    except Exception:
        return None


def _feature_intersects(feature_geom: Dict[str, Any], buffered) -> bool:
    from shapely.geometry import shape
    from shapely.ops import transform

    if not isinstance(feature_geom, dict) or not feature_geom.get("coordinates"):
        return False
    try:
        geometry = shape(feature_geom)
    except Exception:
        return False
    lat0 = geometry.centroid.y
    lon_scale = max(1.0, 111320.0 * math.cos(math.radians(lat0)))
    lat_scale = 111320.0
    metres = transform(lambda x, y, z=None: (x * lon_scale, y * lat_scale), geometry)
    return metres.intersects(buffered)


def _tile_range(aoi, zoom_min: int, zoom_max: int) -> Dict[str, Any]:
    min_x, min_y, max_x, max_y = aoi.bounds
    ranges = {}
    for zoom in range(zoom_min, zoom_max + 1):
        n = 2 ** zoom
        x_min = int((min_x + 180.0) / 360.0 * n)
        x_max = int((max_x + 180.0) / 360.0 * n)
        y_min = int((1.0 - math.log(math.tan(math.radians(max_y)) + 1.0 / math.cos(math.radians(max_y))) / math.pi) / 2.0 * n)
        y_max = int((1.0 - math.log(math.tan(math.radians(min_y)) + 1.0 / math.cos(math.radians(min_y))) / math.pi) / 2.0 * n)
        ranges[str(zoom)] = {
            "x": [max(0, min(x_min, x_max)), min(n - 1, max(x_min, x_max))],
            "y": [max(0, min(y_min, y_max)), min(n - 1, max(y_min, y_max))],
        }
    return ranges


def _bundle_directory() -> str:
    backend = _backend()
    directory = os.path.join(backend.settings.upload_dir, "offline_bundles")
    os.makedirs(directory, exist_ok=True)
    return directory


@router.post("/package")
async def create_clipped_offline_package(req: OfflinePackageRequest, request: Request):
    """Builds a region/grid-clipped offline reference bundle for a field device."""
    backend = _backend()
    user = backend._require_user(request)

    if not 0 < req.buffer_meters <= 5000:
        raise HTTPException(status_code=400, detail="`buffer_meters` must be between 0 and 5000.")
    if not (0 <= req.zoom_min <= req.zoom_max <= 22):
        raise HTTPException(status_code=400, detail="Zoom range must satisfy 0 <= zoom_min <= zoom_max <= 22.")

    project = backend._find_project(req.project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found.")
    if not backend._user_can_access_project(user, req.project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनाको अफलाइन प्याकेज बनाउन पहुँच छैन। (No access to this project.)")
    if not req.layer_ids:
        raise HTTPException(status_code=400, detail="Select at least one reference layer.")

    aoi, aoi_label = _aoi_geometry(req, backend)
    _enforce_aoi_scope(req, aoi, project, user, backend)
    buffered = _buffered_aoi(aoi, req.buffer_meters)
    buffered_wgs84_geojson: Optional[str] = None

    layers_meta: List[Dict[str, Any]] = []
    features_out: List[Dict[str, Any]] = []
    for layer_id in req.layer_ids:
        layer = backend._layer_by_id(layer_id)
        if layer is None or layer.get("deleted_at"):
            raise HTTPException(status_code=404, detail=f"Layer {layer_id} not found.")
        if str(layer.get("project_id")) != str(req.project_id):
            raise HTTPException(status_code=403, detail=f"Layer {layer_id} does not belong to this project.")
        if not backend._layer_visible_to_user(layer, user):
            raise HTTPException(status_code=403, detail=f"No access to layer {layer_id}.")

        matched: Optional[List[Dict[str, Any]]] = None
        if await backend._is_postgis_layer(layer_id):
            if buffered_wgs84_geojson is None:
                buffered_wgs84_geojson = _buffered_aoi_wgs84_geojson(aoi, req.buffer_meters)
            matched = await _fetch_postgis_clipped_features(layer_id, buffered_wgs84_geojson, backend)

        if matched is None:
            matched = [
                feature
                for feature in backend.get_layer_features_list(layer_id)
                if _feature_intersects(feature.get("geometry") or {}, buffered)
            ]

        filtered = backend._portal_filter_feature_properties(layer, user, matched)
        features_out.extend(filtered)
        layers_meta.append(
            {
                "id": layer.get("id"),
                "name": layer.get("name"),
                "geometry_type": layer.get("geometry_type"),
                "questionnaire_id": layer.get("questionnaire_id"),
                "fields_config": layer.get("fields_config") or [],
                "feature_count": len(filtered),
            }
        )

    questionnaires = {}
    for meta in layers_meta:
        qid = meta.get("questionnaire_id")
        if qid is None or str(qid) in questionnaires:
            continue
        questionnaire = next(
            (q for q in backend.STATE.get("questionnaires", []) if str(q.get("id")) == str(qid)),
            None,
        )
        if questionnaire is not None:
            questionnaires[str(qid)] = {
                "id": questionnaire.get("id"),
                "title": questionnaire.get("title"),
                "version": questionnaire.get("version"),
                "schema_definition": questionnaire.get("schema_definition"),
            }

    raster_layers = []
    for raster in backend.STATE.get("raster_layers", []):
        if str(raster.get("project_id")) != str(req.project_id):
            continue
        raster_layers.append(
            {
                "id": raster.get("id"),
                "name": raster.get("name"),
                "tile_url": raster.get("tile_url"),
                "min_zoom": raster.get("min_zoom"),
                "max_zoom": raster.get("max_zoom"),
            }
        )

    manifest = {
        "format": "kmc-offline-reference-bundle",
        "version": 1,
        "generated_at": int(time.time()),
        "generated_by": user.get("username"),
        "project": {"id": project.get("id"), "name": project.get("name")},
        "aoi": {"label": aoi_label, "buffer_meters": req.buffer_meters, "bounds": list(aoi.bounds)},
        "tile_ranges": _tile_range(aoi, req.zoom_min, req.zoom_max),
        "raster_layers": raster_layers,
        "layers": layers_meta,
        "questionnaires": questionnaires,
        "feature_count": len(features_out),
        "features": {
            "type": "FeatureCollection",
            "features": features_out,
        },
    }

    raw_bytes = json.dumps(manifest, sort_keys=True, ensure_ascii=False).encode("utf-8")
    checksum = hashlib.sha256(raw_bytes).hexdigest()

    bundle_name = f"bundle_{req.project_id}_{aoi_label.replace('grid_', 'grid')}_{checksum[:12]}.json"
    bundle_path = os.path.join(_bundle_directory(), bundle_name)
    with open(bundle_path, "wb") as bundle_file:
        bundle_file.write(raw_bytes)

    return {
        "status": "READY",
        "checksum_sha256": checksum,
        "size_bytes": len(raw_bytes),
        "bundle_filename": bundle_name,
        "download_url": f"/api/offline/packages/{bundle_name}",
        "x_accel_redirect": f"/internal_offline_bundles/{bundle_name}",
        "manifest": {k: v for k, v in manifest.items() if k != "features"},
    }


@router.get("/packages/{bundle_name}")
async def download_offline_package(bundle_name: str, request: Request):
    """Streams a previously built bundle through nginx X-Accel-Redirect (zero-copy)."""
    backend = _backend()
    user = backend._require_user(request)
    if not BUNDLE_NAME_PATTERN.match(bundle_name):
        raise HTTPException(status_code=404, detail="Bundle not found.")
    parts = bundle_name[:-5].split("_")
    if len(parts) < 4:
        raise HTTPException(status_code=404, detail="Bundle not found.")
    project_id_str = parts[1]
    scope_token = "_".join(parts[2:-1])
    try:
        project_id_int = int(project_id_str)
        project = backend._find_project(project_id_int)
    except ValueError:
        project_id_int = None
        project = None
    if project is None or project_id_int is None or not backend._user_can_access_project(user, project_id_int):
        raise HTTPException(status_code=404, detail="Bundle not found.")

    if str(user.get("role")) == "DataCollector":
        grid_match = GRID_SCOPE_PATTERN.match(scope_token)
        if not grid_match:
            raise HTTPException(
                status_code=403,
                detail="संकलकले आफूलाई तोकिएको ग्रिडको प्याकेज मात्र डाउनलोड गर्न सक्छ। (Collectors may only download bundles for their assigned task grids.)",
            )
        grid_id = grid_match.group(1)
        task = next(
            (t for t in backend._project_task_grids(project_id_int) if str(t.get("id")) == str(grid_id)),
            None,
        )
        if task is None or str(user.get("id")) not in backend._task_assignee_ids(task):
            raise HTTPException(
                status_code=403,
                detail="यो ग्रिड तपाईंलाई तोकिएको छैन। (This task grid is not assigned to you.)",
            )

    if not os.path.isfile(os.path.join(_bundle_directory(), bundle_name)):
        raise HTTPException(status_code=404, detail="Bundle not found.")
    return Response(
        content=b"",
        media_type="application/json",
        headers={
            "X-Accel-Redirect": f"/internal_offline_bundles/{bundle_name}",
            "Content-Disposition": f'attachment; filename="{bundle_name}"',
        },
    )
