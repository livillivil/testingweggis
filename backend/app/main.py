"""
KMC-GIS-SERVER FastAPI Enterprise Backend Entrypoint (backend/app/main.py)
Provides the 21-domain REST API, PostGIS spatial operations (ST_Split, Union vs MultiFeature Merge,
6-Mode Grid Generation, Cross-Layer & Same-Layer Feature Linking), and 5-Layer Nepal Sovereign Geo-Gate.
Strictly follows "Build Once, Run Anywhere": all configuration is resolved at container startup via settings.
"""

import os
import time
import base64
import hashlib
import hmac
import ipaddress
import secrets
from datetime import datetime
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional, Tuple

import asyncio
import gc
import math
import json
import sqlite3
import re
import shutil
import subprocess
import threading
import zipfile
try:
    import fcntl
except ImportError:
    fcntl = None  # type: ignore[assignment]
from collections import OrderedDict
from fastapi import FastAPI, Request, Response, Depends, UploadFile, File, Form, Query, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from shapely.geometry import shape, mapping, Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
from shapely.ops import split as shapely_split, unary_union as shapely_unary_union

from .config import settings
from .db import run_safe_savepoint_migrations, get_db, get_engine
from .geo_gate import evaluate as evaluate_geo_gate, issue_cookie_value, GEO_COOKIE_NAME, GEO_COOKIE_MAX_AGE
from .routers import offline
from .spatial_grid import (
    generate_grid_cells,
    generate_six_mode_grid,
    geometry_area_sqm,
    normalize_aoi_geometry,
    normalize_grid_mode,
    validate_cell_size,
)
from .spatial_engine import (
    query_spatial_rtree_tile,
    encode_mvt_v2,
    get_cached_mvt_tile,
    set_cached_mvt_tile,
    get_layer_tile_version,
    invalidate_mvt_cache_for_layer,
    fetch_raster_mbtiles_tile,
    compute_live_spatial_analytics,
    get_feature_by_uid,
    get_layer_feature_count,
    ingest_features_to_spatial_index,
    add_feature_to_spatial_index,
    delete_feature_from_spatial_index,
    update_feature_in_spatial_index,
    query_spatial_features,
    check_unique_field_value_exists,
    apply_layer_primary_key_sqlite,
)


# Operational store synchronized at runtime
STATE: Dict[str, Any] = {
    "users": [],
    "departments": [],
    "raster_layers": [],
    "deleted_raster_layers": [],
    "vector_layers": [],
    "deleted_vector_layers": [],
    "features_by_layer": {},
    "audit_edits_by_layer": {},
    "feature_links": [],
    "questionnaires": [],
    "projects": [],
    "tasks_by_project": {},
    "project_assignments": {},
    "project_collectors": {},
    "pending_uploads": {},
    "media": {},
    "collectors": [],
    "tracking_history": [],
    "tracking_events": [],
    "purged_assets": [],
    "records": [],
    "house_numbers": [],
    "platform_settings": {
        "landing_page_enabled": True,
        "geoportal_enabled": True,
        "geoportal_disabled_reason": "",
        "geoportal_updated_at": None,
        "geoportal_updated_by": "",
    },
}


def _init_runtime_users() -> None:
    """Reconcile bootstrap master and super admin accounts from settings without wiping persisted users."""
    master_username = settings.master_admin_username.strip()
    admin_username = settings.admin_username.strip()

    existing_users: List[Dict[str, Any]] = list(STATE.get("users") or [])

    def _reconcile(username: str, email: str, full_name: str, role: str, preferred_id: int) -> None:
        if not username:
            return
        match = next(
            (u for u in existing_users if str(u.get("username", "")).lower() == username.lower()),
            None,
        )
        if match is not None:
            match["role"] = role
            match["is_active"] = True
            if email and not match.get("email"):
                match["email"] = email
            if full_name and not match.get("full_name"):
                match["full_name"] = full_name
            return
        used_ids = {int(u.get("id", 0)) for u in existing_users if str(u.get("id", "")).isdigit()}
        new_id = preferred_id if preferred_id not in used_ids else (max(used_ids, default=0) + 1)
        existing_users.append(
            {
                "id": new_id,
                "username": username,
                "email": email,
                "full_name": full_name or username,
                "role": role,
                "assigned_ward": 0,
                "is_active": True,
            }
        )

    if admin_username:
        _reconcile(
            admin_username,
            settings.admin_email,
            settings.admin_full_name.strip() or admin_username,
            "SuperAdmin",
            1,
        )

    if master_username and master_username.lower() != admin_username.lower():
        _reconcile(
            master_username,
            settings.master_admin_email,
            settings.master_admin_full_name.strip() or master_username,
            "MasterAdmin",
            2,
        )

    STATE["users"] = existing_users


@asynccontextmanager
async def lifespan(app: FastAPI):
    for target_dir in (settings.tmpdir, os.path.join(settings.upload_dir, "offline_bundles")):
        try:
            os.makedirs(target_dir, exist_ok=True)
        except OSError as dir_exc:
            print(f"[KMC-BACKEND] Directory init notice for {target_dir}: {dir_exc}")
    _init_runtime_users()
    _load_persistent_state()
    _init_runtime_users()
    _ensure_default_seed_data()
    _normalise_all_questionnaires()
    _revoke_known_seed_passwords()
    _scan_and_sync_tileserver_mbtiles()
    _scan_and_sync_uploads_geojson()
    from app.spatial_engine import ensure_spatial_db_schema
    ensure_spatial_db_schema()
    _preingest_vector_layers_to_spatial_db()
    _warm_spatial_indexes_background()
    try:
        await run_safe_savepoint_migrations()
        print("[KMC-BACKEND] PostGIS 3.4 schema & safe savepoint migrations verified.")
        try:
            engine = get_engine()
            async with engine.connect() as conn:
                q = text("SELECT layer_id, count(*) FROM vector_features GROUP BY layer_id;")
                res = await conn.execute(q)
                counts = dict(res.fetchall())
                updated_any = False
                for l in STATE.get("vector_layers", []):
                    lid = l.get("id")
                    lid_int = int(str(lid)) if str(lid).isdigit() else lid
                    if lid_int in counts:
                        real_count = counts[lid_int]
                        if l.get("feature_count") != real_count:
                            print(f"[KMC-BACKEND] Syncing PostGIS feature count for layer {lid} ({l.get('name')}): {l.get('feature_count')} -> {real_count}")
                            l["feature_count"] = real_count
                            updated_any = True
                if updated_any:
                    _save_persistent_state(sync=True)
        except Exception as sync_exc:
            print(f"[KMC-BACKEND] Notice syncing PostGIS feature counts: {sync_exc}")
    except Exception as exc:
        print(f"[KMC-BACKEND] PostGIS startup notice (continuing in hybrid mode): {exc}")
    yield


app = FastAPI(
    title="KMC-GIS-SERVER Enterprise Geodatabase API",
    version="2.4.0",
    description="Kathmandu Metropolitan City Municipal WebGIS Geoportal, Field Data Collection & PostGIS API",
    docs_url="/api/docs" if settings.enable_api_docs else None,
    redoc_url=None,
    openapi_url="/api/openapi.json" if settings.enable_api_docs else None,
    lifespan=lifespan,
)

_cors_origins = settings.cors_allow_origins
if _cors_origins == ["*"]:
    # A wildcard origin and credentialed requests are mutually exclusive.
    app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=False,
                       allow_methods=["*"], allow_headers=["*"])
elif _cors_origins:
    app.add_middleware(CORSMiddleware, allow_origins=_cors_origins, allow_credentials=True,
                       allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
                       allow_headers=["Authorization", "Content-Type", "X-Chunk-Index"])

app.include_router(offline.router)


@app.get("/api/health")
async def health_check(db: AsyncSession = Depends(get_db)):
    postgis_version = "unavailable"
    try:
        result = await db.execute(text("SELECT postgis_version()"))
        postgis_version = str(result.scalar() or "unavailable")
    except Exception:  # noqa: BLE001 - liveness must not depend on the database
        postgis_version = "unavailable"
    posture = settings.get_swarm_security_posture()
    return {
        "status": "healthy" if postgis_version != "unavailable" else "degraded",
        "service": settings.app_name,
        "environment": settings.app_env,
        "postgis": postgis_version,
        "swarm_secrets_compliant": bool(posture["golden_practice_compliant"]),
        "swarm_secrets_missing": posture["missing_secrets"],
        "geo_gate_mode": settings.geo_gate_mode,
        "timestamp": int(time.time()),
    }


@app.get("/api/runtime-config")
async def get_public_runtime_config():
    """Exposes non-sensitive public runtime endpoints to clients."""
    _reload_state_if_modified()
    platform = STATE.get("platform_settings") or {}
    return {
        "app_name": settings.app_name,
        "environment": settings.app_env,
        "api_url": os.getenv("PUBLIC_API_URL", "/api"),
        "tile_url": os.getenv("PUBLIC_TILE_URL", "/tiles"),
        "landing_page_enabled": bool(platform.get("landing_page_enabled", True)),
        "geoportal_enabled": bool(platform.get("geoportal_enabled", True)),
        "geoportal_disabled_reason": platform.get("geoportal_disabled_reason") or "",
    }


@app.get("/api/system/swarm-secrets")
async def get_swarm_secrets_posture(request: Request):
    """Returns non-sensitive Docker Swarm Secrets golden-practice posture metadata.

    Secrets posture is restricted to the private master account (MasterAdmin); even a
    SuperAdmin or GisAdmin is denied. No secret values are ever returned.
    """
    _require_master_user(request)
    return settings.get_swarm_security_posture()


# ============================================================
# Master Control — GeoPortal & Landing Page kill-switch & permanent storage wipe
# ============================================================
GEOPORTAL_MAINTENANCE_DETAIL = (
    "जियोपोर्टल हाल मास्टर प्रशासकद्वारा बन्द गरिएको छ। "
    "(The GeoPortal is temporarily disabled by the master administrator.)"
)
STORAGE_PURGE_CONFIRMATION = "DELETE_ALL_UPLOADS"


def _geoportal_state() -> Dict[str, Any]:
    platform = STATE.get("platform_settings") or {}
    return {
        "landing_page_enabled": bool(platform.get("landing_page_enabled", True)),
        "geoportal_enabled": bool(platform.get("geoportal_enabled", True)),
        "reason": platform.get("geoportal_disabled_reason") or "",
        "updated_at": platform.get("geoportal_updated_at"),
        "updated_by": platform.get("geoportal_updated_by") or "",
    }


def _geoportal_enabled() -> bool:
    return bool(_geoportal_state()["geoportal_enabled"])


def _landing_page_enabled() -> bool:
    return bool(_geoportal_state()["landing_page_enabled"])


@app.get("/api/system/geoportal")
async def get_geoportal_state(request: Request):
    _require_master_user(request)
    return _geoportal_state()


@app.put("/api/system/geoportal")
async def update_geoportal_state(payload: Dict[str, Any], request: Request):
    actor = _require_master_user(request)
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=400, detail="`enabled` must be true or false.")
    platform = STATE.setdefault("platform_settings", {})
    platform["geoportal_enabled"] = enabled
    platform["geoportal_disabled_reason"] = "" if enabled else str(payload.get("reason") or "").strip()
    platform["geoportal_updated_at"] = time.time()
    platform["geoportal_updated_by"] = (actor or {}).get("username") or ""
    _save_persistent_state(sync=True)
    return _geoportal_state()


@app.get("/api/platform/layer-ordering")
async def get_layer_ordering_config(request: Request):
    """Retrieves current layer stacking and ordering rules."""
    _reload_state_if_modified()
    platform = STATE.get("platform_settings") or {}
    ordering_config = platform.get("layer_ordering") or {
        "strategy": "golden_rules",
        "golden_rules": {
            "rasters_at_bottom": True,
            "vector_order": ["Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"],
            "recent_on_top_within_type": True,
        },
        "custom_ranks": {},
    }
    return ordering_config


@app.put("/api/platform/layer-ordering")
async def update_layer_ordering_config(payload: Dict[str, Any], request: Request):
    """Updates dynamic layer stacking rules and individual layer rankings."""
    user = _require_admin_user(request)
    platform = STATE.setdefault("platform_settings", {})
    curr = platform.setdefault("layer_ordering", {
        "strategy": "golden_rules",
        "golden_rules": {
            "rasters_at_bottom": True,
            "vector_order": ["Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"],
            "recent_on_top_within_type": True,
        },
        "custom_ranks": {},
    })

    if "strategy" in payload:
        strat = str(payload["strategy"])
        if strat in ("golden_rules", "recent_on_top", "manual_ranking"):
            curr["strategy"] = strat
    if "golden_rules" in payload and isinstance(payload["golden_rules"], dict):
        curr["golden_rules"].update(payload["golden_rules"])
    if "custom_ranks" in payload and isinstance(payload["custom_ranks"], dict):
        curr.setdefault("custom_ranks", {}).update(payload["custom_ranks"])
        for lid_str, rank in payload["custom_ranks"].items():
            for l in STATE.get("vector_layers", []):
                if str(l.get("id")) == str(lid_str):
                    l["display_order"] = int(rank) if str(rank).lstrip("-").isdigit() else 0
            for r in STATE.get("raster_layers", []):
                if str(r.get("id")) == str(lid_str):
                    r["display_order"] = int(rank) if str(rank).lstrip("-").isdigit() else 0

    platform["layer_ordering_updated_at"] = time.time()
    platform["layer_ordering_updated_by"] = user.get("username")
    _save_persistent_state(sync=True)
    return curr


@app.get("/api/system/landing-page")
async def get_landing_page_state(request: Request):
    _require_master_user(request)
    return {"landing_page_enabled": _landing_page_enabled()}


@app.put("/api/system/landing-page")
async def update_landing_page_state(payload: Dict[str, Any], request: Request):
    actor = _require_master_user(request)
    enabled = payload.get("enabled")
    if not isinstance(enabled, bool):
        raise HTTPException(status_code=400, detail="`enabled` must be true or false.")
    platform = STATE.setdefault("platform_settings", {})
    platform["landing_page_enabled"] = enabled
    platform["landing_page_updated_at"] = time.time()
    platform["landing_page_updated_by"] = (actor or {}).get("username") or ""
    _save_persistent_state(sync=True)
    return {"landing_page_enabled": enabled}


@app.get("/api/system/platform-settings")
async def get_platform_settings(request: Request):
    _require_master_user(request)
    return _geoportal_state()


@app.put("/api/system/platform-settings")
async def update_platform_settings(payload: Dict[str, Any], request: Request):
    actor = _require_master_user(request)
    platform = STATE.setdefault("platform_settings", {})
    if "landing_page_enabled" in payload:
        val = payload["landing_page_enabled"]
        if not isinstance(val, bool):
            raise HTTPException(status_code=400, detail="`landing_page_enabled` must be true or false.")
        platform["landing_page_enabled"] = val
    if "geoportal_enabled" in payload:
        val = payload["geoportal_enabled"]
        if not isinstance(val, bool):
            raise HTTPException(status_code=400, detail="`geoportal_enabled` must be true or false.")
        platform["geoportal_enabled"] = val
        if not val:
            platform["geoportal_disabled_reason"] = str(payload.get("reason") or payload.get("geoportal_disabled_reason") or "").strip()
        else:
            platform["geoportal_disabled_reason"] = ""
    platform["platform_updated_at"] = time.time()
    platform["platform_updated_by"] = (actor or {}).get("username") or ""
    _save_persistent_state(sync=True)
    return _geoportal_state()


def _wipe_directory_contents(directory: str, keep_names: set) -> Dict[str, int]:
    """Deletes every entry inside `directory` while keeping the directory itself."""
    files_deleted = 0
    bytes_freed = 0
    if not directory or not os.path.isdir(directory):
        return {"files": 0, "bytes": 0}
    for entry in os.scandir(directory):
        if entry.name in keep_names:
            continue
        try:
            if entry.is_dir(follow_symlinks=False):
                for root, _dirs, names in os.walk(entry.path):
                    for name in names:
                        try:
                            bytes_freed += os.path.getsize(os.path.join(root, name))
                        except OSError:
                            pass
                        files_deleted += 1
                shutil.rmtree(entry.path, ignore_errors=True)
            elif entry.is_file(follow_symlinks=False):
                bytes_freed += entry.stat(follow_symlinks=False).st_size
                os.remove(entry.path)
                files_deleted += 1
        except OSError as exc:
            print(f"[STORAGE-PURGE] Could not remove {entry.path}: {exc}")
    return {"files": files_deleted, "bytes": bytes_freed}


# Per-file storage management: application state and service configs are never
# offered for deletion, and placeholder files carry no storage value.
_STORAGE_ALWAYS_HIDDEN = {".gitkeep", "README.md"}
_STORAGE_PROTECTED_FILES = {
    "uploads": {"kmc_state_store.json"},
    "tiles": {"config.json", "kmc_state_store.json"},
}


def _scan_storage_files(root_dir: str, protected_names: set) -> List[Dict[str, Any]]:
    """Lists deletable files under a storage root with root-relative POSIX paths."""
    items: List[Dict[str, Any]] = []
    if not root_dir or not os.path.isdir(root_dir):
        return items
    for dirpath, _dirnames, filenames in os.walk(root_dir):
        for name in filenames:
            if name in protected_names or name in _STORAGE_ALWAYS_HIDDEN or name.endswith(".tmp"):
                continue
            full_path = os.path.join(dirpath, name)
            try:
                stat = os.stat(full_path)
            except OSError:
                continue
            items.append(
                {
                    "path": os.path.relpath(full_path, root_dir).replace(os.sep, "/"),
                    "name": name,
                    "size": stat.st_size,
                    "modified_at": stat.st_mtime,
                }
            )
    items.sort(key=lambda item: (-item["size"], item["path"]))
    return items


def _storage_inventory() -> Dict[str, Any]:
    uploads = _scan_storage_files(get_uploads_dir(), _STORAGE_PROTECTED_FILES["uploads"])
    tiles = _scan_storage_files(get_tileserver_dir(), _STORAGE_PROTECTED_FILES["tiles"])
    return {
        "uploads": uploads,
        "tiles": tiles,
        "uploads_files": len(uploads),
        "uploads_bytes": sum(item["size"] for item in uploads),
        "tiles_files": len(tiles),
        "tiles_bytes": sum(item["size"] for item in tiles),
    }


def _layer_matches_storage_file(layer: Dict[str, Any], filename: str) -> bool:
    if str(layer.get("filename") or "") == filename:
        return True
    stem = os.path.splitext(filename)[0]
    if stem.isdigit() and str(layer.get("id")) == stem:
        return True
    layer_name = str(layer.get("name") or "")
    return layer_name in (filename, stem, stem.replace("_", " "))


def _detach_storage_file_metadata(root: str, relative_path: str) -> Dict[str, int]:
    """Removes catalog entries that pointed at a file deleted from disk."""
    filename = os.path.basename(relative_path)
    removed = {"layers": 0, "rasters": 0}

    if root == "tiles" and filename.lower().endswith(".mbtiles"):
        _unregister_tileserver_asset(filename)
        for raster in list(STATE.get("raster_layers", [])):
            if str(raster.get("filename") or "") != filename:
                continue
            STATE["raster_layers"] = [r for r in STATE["raster_layers"] if r is not raster]
            STATE["deleted_raster_layers"] = [
                r for r in STATE.get("deleted_raster_layers", []) if r is not raster
            ]
            _cleanup_raster_references(raster.get("id"))
            removed["rasters"] += 1

    if root == "uploads" and filename.lower().endswith(".geojson"):
        matched = [l for l in STATE.get("vector_layers", []) if _layer_matches_storage_file(l, filename)]
        for layer in matched:
            layer_id = layer.get("id")
            STATE["vector_layers"] = [l for l in STATE["vector_layers"] if l is not layer]
            STATE["deleted_vector_layers"] = [
                l for l in STATE.get("deleted_vector_layers", []) if l is not layer
            ]
            STATE["features_by_layer"].pop(layer_id, None)
            STATE["features_by_layer"].pop(str(layer_id), None)
            STATE.get("audit_edits_by_layer", {}).pop(str(layer_id), None)
            STATE.get("audit_edits_by_layer", {}).pop(layer_id, None)
            _cleanup_layer_references(layer_id)
            removed["layers"] += 1

    return removed


@app.get("/api/system/storage")
async def get_storage_usage(request: Request):
    _require_master_user(request)
    inventory = _storage_inventory()
    vector_layers = STATE.get("vector_layers", [])
    raster_layers = STATE.get("raster_layers", [])
    vector_active = sum(1 for layer in vector_layers if not layer.get("deleted_at"))
    raster_active = sum(1 for raster in raster_layers if not raster.get("deleted_at"))
    return {
        "uploads": {"files": inventory["uploads_files"], "bytes": inventory["uploads_bytes"]},
        "tileserver": {"files": inventory["tiles_files"], "bytes": inventory["tiles_bytes"]},
        "total_files": inventory["uploads_files"] + inventory["tiles_files"],
        "total_bytes": inventory["uploads_bytes"] + inventory["tiles_bytes"],
        "vector_layers": len(vector_layers),
        "raster_layers": len(raster_layers),
        "vector_layers_active": vector_active,
        "vector_layers_recycled": len(vector_layers) - vector_active,
        "raster_layers_active": raster_active,
        "raster_layers_recycled": len(raster_layers) - raster_active,
        "uploads_dir": get_uploads_dir(),
        "tileserver_dir": get_tileserver_dir(),
    }


@app.get("/api/system/storage/files")
async def list_storage_files(request: Request):
    """Master-only inventory of individual deletable files on disk."""
    _require_master_user(request)
    return _storage_inventory()


@app.delete("/api/system/storage/file")
async def delete_storage_file(request: Request, root: str, path: str):
    """Master-only irreversible deletion of one uploaded file and its catalog entry."""
    _require_master_user(request)
    if root not in ("uploads", "tiles"):
        raise HTTPException(status_code=400, detail="root must be 'uploads' or 'tiles'.")

    root_dir = get_uploads_dir() if root == "uploads" else get_tileserver_dir()
    relative_path = str(path or "").replace("\\", "/").strip()
    parts = [part for part in relative_path.split("/") if part]
    if not parts or relative_path.startswith("/") or any(part in (".", "..") for part in parts):
        raise HTTPException(status_code=400, detail="Invalid file path.")
    filename = parts[-1]
    if filename in _STORAGE_PROTECTED_FILES[root] or filename in _STORAGE_ALWAYS_HIDDEN or filename.endswith(".tmp"):
        raise HTTPException(
            status_code=400,
            detail="यो फाइल एप्लिकेसनका लागि आवश्यक छ, मेट्न मिल्दैन। (This file is required by the application.)",
        )

    root_real = os.path.realpath(root_dir)
    target = os.path.realpath(os.path.join(root_dir, *parts))
    try:
        within_root = os.path.commonpath([root_real, target]) == root_real
    except ValueError:
        within_root = False
    if not within_root:
        raise HTTPException(status_code=400, detail="Invalid file path.")
    if not os.path.isfile(target):
        raise HTTPException(status_code=404, detail="File not found.")

    try:
        released = os.path.getsize(target)
        os.remove(target)
        _mark_asset_purged(filename)
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"फाइल मेट्न सकिएन। (Could not delete file: {exc})")

    parent = os.path.dirname(target)
    while parent != root_real and os.path.isdir(parent) and not os.listdir(parent):
        try:
            os.rmdir(parent)
        except OSError:
            break
        parent = os.path.dirname(parent)

    removed = _detach_storage_file_metadata(root, relative_path)
    _save_persistent_state(sync=True)
    return {
        "status": "deleted",
        "root": root,
        "path": relative_path,
        "bytes_released": released,
        **{f"{key}_removed": value for key, value in removed.items()},
    }



@app.post("/api/system/storage/purge")
async def purge_all_uploaded_storage(payload: Dict[str, Any], request: Request):
    """Master-only irreversible wipe of every uploaded file and its metadata."""
    actor = _require_master_user(request)
    if str(payload.get("confirm") or "").strip() != STORAGE_PURGE_CONFIRMATION:
        raise HTTPException(
            status_code=400,
            detail=f"Confirmation required. Send {{\"confirm\": \"{STORAGE_PURGE_CONFIRMATION}\"}}.",
        )

    uploads_dir = get_uploads_dir()
    tileserver_dir = get_tileserver_dir()
    files_deleted = 0
    bytes_freed = 0

    def merge(stats: Dict[str, int]) -> None:
        nonlocal files_deleted, bytes_freed
        files_deleted += stats["files"]
        bytes_freed += stats["bytes"]

    merge(_wipe_directory_contents(os.path.join(uploads_dir, "layers"), set()))
    merge(
        _wipe_directory_contents(
            os.path.join(uploads_dir, "offline_bundles"), {".gitkeep", "README.md"}
        )
    )
    merge(
        _wipe_directory_contents(
            uploads_dir, {"kmc_state_store.json", "layers", "offline_bundles"}
        )
    )
    merge(_wipe_directory_contents(os.path.join(tileserver_dir, "temp"), set()))
    merge(_wipe_directory_contents(settings.tmpdir, set()))

    # Upload artifacts that live at the tileserver root; config/state are preserved.
    upload_suffixes = (".mbtiles", ".pmtiles", ".geojson", ".csv", ".zip", ".tif", ".tiff")
    if os.path.isdir(tileserver_dir):
        for entry in os.scandir(tileserver_dir):
            if not entry.is_file(follow_symlinks=False):
                continue
            if not entry.name.lower().endswith(upload_suffixes):
                continue
            try:
                bytes_freed += entry.stat(follow_symlinks=False).st_size
                os.remove(entry.path)
                files_deleted += 1
            except OSError as exc:
                print(f"[STORAGE-PURGE] Could not remove {entry.path}: {exc}")

    # Drop every tileserver-gl data registration atomically with cross-process lock.
    config_path = os.path.join(tileserver_dir, "config.json")
    if os.path.isfile(config_path):
        try:
            _update_tileserver_config_locked(tileserver_dir, lambda cfg: cfg.__setitem__("data", {}))
        except Exception as exc:
            print(f"[STORAGE-PURGE] Could not reset config.json: {exc}")

    vector_count = len(STATE.get("vector_layers", [])) + len(STATE.get("deleted_vector_layers", []))
    raster_count = len(STATE.get("raster_layers", [])) + len(STATE.get("deleted_raster_layers", []))

    STATE["vector_layers"] = []
    STATE["deleted_vector_layers"] = []
    STATE["raster_layers"] = []
    STATE["deleted_raster_layers"] = []
    STATE["features_by_layer"] = {}
    STATE["audit_edits_by_layer"] = {}
    STATE["feature_links"] = []
    STATE["pending_uploads"] = {}
    STATE["purged_assets"] = []
    STATE["house_numbers"] = []
    for project in STATE.get("projects", []):
        project["download_layer_ids"] = []
        project["editable_layer_ids"] = []
    for assignment in (STATE.get("project_assignments") or {}).values():
        if isinstance(assignment, dict):
            assignment["assigned_layer_ids"] = []
            assignment["assigned_mbtiles_ids"] = []

    _save_persistent_state(sync=True)
    return {
        "status": "storage_purged",
        "files_deleted": files_deleted,
        "bytes_released": bytes_freed,
        "vector_layers_cleared": vector_count,
        "raster_layers_cleared": raster_count,
        "purged_by": (actor or {}).get("username") or "",
    }


# ============================================================
# 5-Layer Nepal Sovereign Geo-Gate Endpoints (Nginx auth_request)
# ============================================================
GEO_GATE_DENIED_DETAIL = (
    "यो सेवा नेपाल भित्रका प्रयोगकर्ताका लागि मात्र उपलब्ध छ। "
    "(This service is available only to clients located in Nepal.)"
)

_GEO_MODE_LABELS = {"enforce": "enforced", "monitor": "monitor-only", "off": "disabled"}


def _geo_cookie_secure(request: Request) -> bool:
    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "").lower()
    return proto == "https"


@app.get("/api/geo-access/verify")
@app.get("/api/geo/verify")
async def geo_access_verify(request: Request):
    """Nginx auth_request target: 200 allows, 403 blocks."""
    if not _geoportal_enabled():
        raise HTTPException(status_code=403, detail=GEOPORTAL_MAINTENANCE_DETAIL)
    verdict = evaluate_geo_gate(request)
    if not verdict["allowed"]:
        raise HTTPException(status_code=403, detail=GEO_GATE_DENIED_DETAIL)
    return {
        "allowed": True,
        "country": verdict.get("country"),
        "asn": verdict.get("asn"),
        "mode": _GEO_MODE_LABELS.get(verdict.get("mode"), verdict.get("mode")),
        "reason": verdict.get("reason"),
        "status": "VERIFIED",
    }


@app.post("/api/geo/access-check")
async def geo_access_check(request: Request, response: Response):
    """Public preflight that issues the signed, IP-bound Geo-Gate pass cookie."""
    if not _geoportal_enabled():
        raise HTTPException(status_code=403, detail=GEOPORTAL_MAINTENANCE_DETAIL)
    verdict = evaluate_geo_gate(request)
    if not verdict["allowed"]:
        raise HTTPException(status_code=403, detail=GEO_GATE_DENIED_DETAIL)
    token = issue_cookie_value(request, verdict)
    if token:
        response.set_cookie(
            key=GEO_COOKIE_NAME,
            value=token,
            max_age=GEO_COOKIE_MAX_AGE,
            httponly=True,
            secure=_geo_cookie_secure(request),
            samesite="lax",
        )
    return {
        "allowed": True,
        "country": verdict.get("country"),
        "country_name": "Nepal (नेपाल)" if verdict.get("country") == "NP" else None,
        "asn": verdict.get("asn"),
        "mode": _GEO_MODE_LABELS.get(verdict.get("mode"), verdict.get("mode")),
        "country_db_available": verdict.get("country_db_available"),
        "reason": verdict.get("reason"),
        "status": "VERIFIED",
    }


# ============================================================
# Auth, Password Hashing & Users Endpoints
# ============================================================

PASSWORD_ITERATIONS = 260000
MIN_PASSWORD_LENGTH = 8
# `GisAdmin` is the legacy name of `DepartmentAdmin` and is kept as an alias so
# existing accounts keep working; all new accounts should use DepartmentAdmin.
ASSIGNABLE_ROLES = ("MasterAdmin", "SuperAdmin", "DepartmentAdmin", "GisAdmin", "Validator", "DataCollector", "BasicViewer")
PROTECTED_ROLES = ("MasterAdmin", "SuperAdmin")


def hash_password(password: str) -> str:
    """PBKDF2-SHA256 password hash (stdlib only, no fragile native dependency)."""
    salt = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), bytes.fromhex(salt), PASSWORD_ITERATIONS
    ).hex()
    return f"pbkdf2_sha256${PASSWORD_ITERATIONS}${salt}${digest}"


def _validate_new_password(value: Any) -> str:
    password = str(value or "")
    if not password:
        raise HTTPException(
            status_code=400,
            detail="नयाँ पासवर्ड आवश्यक छ। (A new password is required.)",
        )
    if len(password) < MIN_PASSWORD_LENGTH:
        raise HTTPException(
            status_code=400,
            detail=f"पासवर्ड कम्तीमा {MIN_PASSWORD_LENGTH} अक्षरको हुनुपर्छ। "
                   f"(Password must be at least {MIN_PASSWORD_LENGTH} characters.)",
        )
    return password


def _bootstrap_secret_for_role(role: Any) -> str:
    return {
        "MasterAdmin": settings.master_admin_password,
        "SuperAdmin": settings.admin_password,
    }.get(str(role), "")


def _verify_current_password(user: Dict[str, Any], current_password: str) -> bool:
    stored_hash = user.get("password_hash")
    if stored_hash:
        return verify_password(current_password, stored_hash)
    role_secret = _bootstrap_secret_for_role(user.get("role"))
    return bool(role_secret) and hmac.compare_digest(current_password, role_secret)


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iterations, salt, digest = str(stored_hash).split("$")
        if algorithm != "pbkdf2_sha256":
            return False
        candidate = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), bytes.fromhex(salt), int(iterations)
        ).hex()
        return secrets.compare_digest(candidate, digest)
    except (ValueError, TypeError):
        return False


def _public_user(user: Dict[str, Any]) -> Dict[str, Any]:
    """User representation safe for API responses (never leaks the password hash)."""
    return {key: value for key, value in user.items() if key != "password_hash"}


LEGACY_SEED_PASSWORDS = ("DeptPassword123!", "ValidatorPassword123!", "CollectorPassword123!")


def _revoke_known_seed_passwords() -> None:
    """Voids any still-active legacy seed credential carried over from an older state store."""
    revoked = False
    for user in STATE.get("users", []) or []:
        stored_hash = user.get("password_hash")
        if not stored_hash:
            continue
        if any(verify_password(legacy, stored_hash) for legacy in LEGACY_SEED_PASSWORDS):
            user["password_hash"] = hash_password(secrets.token_urlsafe(48))
            user["must_change_password"] = True
            revoked = True
    if revoked:
        _save_persistent_state()
        print("[KMC-BACKEND] Legacy seed credentials revoked; affected accounts require an admin password reset.")


def _initial_seed_password() -> str:
    """Credential for freshly seeded staff accounts.

    A deployment may inject one shared bootstrap password through the
    `kmc_seed_user_password` Swarm secret; otherwise each account gets an
    unguessable random password that an administrator must reset.
    """
    explicit = settings.seed_user_password
    if explicit and len(explicit) >= MIN_PASSWORD_LENGTH:
        return explicit
    return secrets.token_urlsafe(48)


def _ensure_default_seed_data() -> None:
    """
    Ensures that official default accounts (Department Admins, Validators, Data Collectors)
    and the comprehensive default questionnaire exist when demo seeding is explicitly enabled.
    """
    if not getattr(settings, "enable_demo_seed", False):
        return
    seeded_password = _initial_seed_password()
    default_users_spec = [
        {
            "id": 10,
            "username": "urban_dept_head",
            "email": "urban.head@kmc.gov.np",
            "full_name": "ई. सुलभ श्रेष्ठ (सहरी विकास विभाग प्रमुख)",
            "role": "DepartmentAdmin",
            "assigned_ward": 0,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 11,
            "username": "gis_admin_head",
            "email": "gis.head@kmc.gov.np",
            "full_name": "ई. प्रकाश राजभण्डारी (GIS तथा सूचना प्रविधि प्रमुख)",
            "role": "DepartmentAdmin",
            "assigned_ward": 0,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 12,
            "username": "heritage_dept_head",
            "email": "heritage.head@kmc.gov.np",
            "full_name": "मनिषा मानन्धर (सम्पदा तथा पूर्वाधार प्रमुख)",
            "role": "DepartmentAdmin",
            "assigned_ward": 0,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 20,
            "username": "validator1",
            "email": "validator1@kmc.gov.np",
            "full_name": "इन्जिनियर विकास शाक्य (वरिष्ठ GIS प्रमाणक)",
            "role": "Validator",
            "assigned_ward": 0,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 21,
            "username": "validator2",
            "email": "validator2@kmc.gov.np",
            "full_name": "सिता कार्की (नक्सा तथा डाटा प्रमाणक)",
            "role": "Validator",
            "assigned_ward": 0,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 22,
            "username": "validator_ward4",
            "email": "validator.w4@kmc.gov.np",
            "full_name": "विनोद महर्जन (वडा नं. ४ प्रमाणक)",
            "role": "Validator",
            "assigned_ward": 4,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 30,
            "username": "collector1",
            "email": "collector1@kmc.gov.np",
            "full_name": "रमेश थापा (फिल्ड सर्भेयर १)",
            "role": "DataCollector",
            "assigned_ward": 4,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 31,
            "username": "collector2",
            "email": "collector2@kmc.gov.np",
            "full_name": "संगीता गुरुङ (फिल्ड सर्भेयर २)",
            "role": "DataCollector",
            "assigned_ward": 4,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 32,
            "username": "collector_ward4",
            "email": "collector.w4@kmc.gov.np",
            "full_name": "प्रविन बज्राचार्य (वडा नं. ४ संकलक)",
            "role": "DataCollector",
            "assigned_ward": 4,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 33,
            "username": "surveyor_ramesh",
            "email": "ramesh@kmc.gov.np",
            "full_name": "रमेश श्रेष्ठ (फिल्ड संकलक)",
            "role": "DataCollector",
            "assigned_ward": 4,
            "is_active": True,
            "password": seeded_password,
        },
        {
            "id": 34,
            "username": "surveyor_sita",
            "email": "sita@kmc.gov.np",
            "full_name": "सीता शर्मा (फिल्ड संकलक)",
            "role": "DataCollector",
            "assigned_ward": 4,
            "is_active": True,
            "password": seeded_password,
        },
    ]

    current_users = STATE.get("users", []) or []
    current_usernames = {str(u.get("username", "")).lower() for u in current_users}

    for spec in default_users_spec:
        if spec["username"].lower() not in current_usernames:
            row = {
                "id": spec["id"],
                "username": spec["username"],
                "email": spec["email"],
                "full_name": spec["full_name"],
                "role": spec["role"],
                "assigned_ward": spec.get("assigned_ward", 0),
                "is_active": True,
                "password_hash": hash_password(spec["password"]),
            }
            current_users.append(row)
            current_usernames.add(spec["username"].lower())

    STATE["users"] = current_users

    # Ensure rich questionnaire with date, time, datetime, photo camera capture, dropdown, and skip logic
    default_q = {
        "id": 1001,
        "title": "काठमाडौँ एकीकृत सहरी पूर्वाधार तथा भवन सर्वेक्षण (KMC Comprehensive Field Survey)",
        "description": "सहरी भवन, पूर्वाधार, सम्पत्ति तथा सामाजिक-आर्थिक सर्वेक्षण - मिति, समय, तस्बिर, ड्रपडाउन र स्किप लजिक सहित",
        "project_id": None,
        "is_global": True,
        "status": "PUBLISHED",
        "is_active": True,
        "version": "v1.0",
        "created_at": 1700000000.0,
        "updated_at": 1700000000.0,
        "schema_definition": {
            "sections": [
                {
                    "id": "sec_general",
                    "title": "१. सामान्य तथा समय विवरण (General & Temporal Details)",
                    "description": "सर्वेक्षण मिति, समय र स्थान विवरण",
                    "questions": [
                        {
                            "id": "q_survey_date",
                            "section_id": "sec_general",
                            "name": "survey_date",
                            "label_ne": "सर्वेक्षण गरिएको मिति (Survey Date)",
                            "label": "Survey Date",
                            "type": "date",
                            "required": True,
                        },
                        {
                            "id": "q_survey_time",
                            "section_id": "sec_general",
                            "name": "survey_time",
                            "label_ne": "सर्वेक्षण गरिएको समय (Survey Time)",
                            "label": "Survey Time",
                            "type": "time",
                            "required": True,
                        },
                        {
                            "id": "q_survey_timestamp",
                            "section_id": "sec_general",
                            "name": "survey_timestamp",
                            "label_ne": "मिति र समय टाइमस्ट्याम्प (Date & Time Stamp)",
                            "label": "Date and Time Stamp",
                            "type": "datetime",
                            "required": False,
                        },
                        {
                            "id": "q_ward_no",
                            "section_id": "sec_general",
                            "name": "ward_no",
                            "label_ne": "काठमाडौँ वडा नम्बर (Ward Number)",
                            "label": "KMC Ward Number",
                            "type": "dropdown",
                            "required": True,
                            "options": [
                                {"value": "1", "label_ne": "वडा नं १ (नक्साल)", "label": "Ward 1 - Naxal"},
                                {"value": "2", "label_ne": "वडा नं २ (लाजिम्पाट)", "label": "Ward 2 - Lazimpat"},
                                {"value": "3", "label_ne": "वडा नं ३ (महाराजगञ्ज)", "label": "Ward 3 - Maharajgunj"},
                                {"value": "4", "label_ne": "वडा नं ४ (बालुवाटार)", "label": "Ward 4 - Baluwatar"},
                                {"value": "24", "label_ne": "वडा नं २४ (इन्द्रचोक)", "label": "Ward 24 - Indrachowk"},
                                {"value": "28", "label_ne": "वडा नं २८ (बागबजार)", "label": "Ward 28 - Bagbazar"},
                            ],
                        },
                        {
                            "id": "q_surveyor_name",
                            "section_id": "sec_general",
                            "name": "surveyor_name",
                            "label_ne": "तथ्याङ्क संकलकको नाम (Surveyor Name)",
                            "label": "Surveyor Name",
                            "type": "text",
                            "required": True,
                        },
                    ],
                },
                {
                    "id": "sec_building",
                    "title": "२. भवन तथा भौतिक संरचना विवरण (Building & Structure)",
                    "description": "भवनको प्रयोग, तस्बिर र क्षति विवरण (स्किप लजिक सहित)",
                    "questions": [
                        {
                            "id": "q_building_use",
                            "section_id": "sec_building",
                            "name": "building_use",
                            "label_ne": "भवनको मुख्य प्रयोग (Building Primary Use)",
                            "label": "Building Primary Use",
                            "type": "dropdown",
                            "required": True,
                            "options": [
                                {"value": "residential", "label_ne": "आवासीय (Residential)", "label": "Residential"},
                                {"value": "commercial", "label_ne": "व्यापारिक / व्यावसायिक (Commercial)", "label": "Commercial"},
                                {"value": "mixed", "label_ne": "मिश्रित (Mixed Residential & Commercial)", "label": "Mixed"},
                                {"value": "institutional", "label_ne": "सरकारी / संस्थागत (Institutional)", "label": "Institutional"},
                            ],
                        },
                        {
                            "id": "q_business_name",
                            "section_id": "sec_building",
                            "name": "business_name",
                            "label_ne": "व्यापारिक फर्मको नाम र दर्ता नं. (Business Details)",
                            "label": "Business Details & Registration",
                            "type": "text",
                            "required": False,
                            "conditions": [
                                {
                                    "target_question_id": "q_building_use",
                                    "operator": "equals",
                                    "value": "commercial",
                                }
                            ],
                        },
                        {
                            "id": "q_building_photo",
                            "section_id": "sec_building",
                            "name": "building_photo",
                            "label_ne": "भवनको मुख्य क्यामेरा फोटो (Building Camera Photo)",
                            "label": "Building Camera Photo",
                            "type": "photo",
                            "required": False,
                        },
                        {
                            "id": "q_has_damage",
                            "section_id": "sec_building",
                            "name": "has_damage",
                            "label_ne": "संरचनामा कुनै भौतिक क्षति वा जोखिम छ? (Any Damage?)",
                            "label": "Any Structural Damage?",
                            "type": "dropdown",
                            "required": True,
                            "options": [
                                {"value": "no", "label_ne": "छैन (No Damage)", "label": "No Damage"},
                                {"value": "yes", "label_ne": "छ (Yes Damage / Risk)", "label": "Yes Damage"},
                            ],
                        },
                        {
                            "id": "q_damage_photo",
                            "section_id": "sec_building",
                            "name": "damage_photo",
                            "label_ne": "क्षतिको क्यामेरा फोटो (Damage Camera Photo)",
                            "label": "Damage Camera Photo",
                            "type": "photo",
                            "required": False,
                            "conditions": [
                                {
                                    "target_question_id": "q_has_damage",
                                    "operator": "equals",
                                    "value": "yes",
                                }
                            ],
                        },
                        {
                            "id": "q_remarks",
                            "section_id": "sec_building",
                            "name": "remarks",
                            "label_ne": "थप कैफियत / टिप्पणी (Additional Remarks)",
                            "label": "Additional Remarks",
                            "type": "textarea",
                            "required": False,
                        },
                    ],
                },
            ],
        },
    }

    qs = STATE.get("questionnaires", []) or []
    has_survey = any(q.get("id") == 1001 or "एकीकृत सहरी पूर्वाधार" in str(q.get("title") or "") for q in qs)
    if not has_survey:
        qs.insert(0, dict(default_q))
        STATE["questionnaires"] = qs

    active_q = next((q for q in qs if q.get("is_active")), qs[0] if qs else None)
    if active_q:
        for proj in STATE.get("projects", []):
            if not proj.get("questionnaire_id"):
                proj["questionnaire_id"] = active_q.get("id")
        for layer in STATE.get("vector_layers", []):
            if not layer.get("questionnaire_id") and layer.get("geometry_type") in ("Point", "Polygon"):
                layer["questionnaire_id"] = active_q.get("id")
                _sync_questionnaire_layer_fields(active_q)

    # Strict project isolation: never auto-assign collectors/validators to projects on startup.


def _token_signing_key() -> bytes:
    # Never fall back to a compiled-in constant: an unavailable signing secret
    # must surface as an error, not silently produce forgeable tokens.
    return settings.secret_key.encode("utf-8")


def _sign_token(user_id: Any, issued_at: int, purpose: str = "access") -> str:
    payload = f"{purpose}.{user_id}.{issued_at}".encode("utf-8")
    return hmac.new(_token_signing_key(), payload, hashlib.sha256).hexdigest()[:32]


def _issue_access_token(user_id: Any) -> str:
    issued_at = int(time.time())
    return f"kmc-jwt-{user_id}-{issued_at}-{_sign_token(user_id, issued_at, 'access')}"


def _issue_refresh_token(user_id: Any) -> str:
    issued_at = int(time.time())
    return f"kmc-refresh-{user_id}-{issued_at}-{_sign_token(user_id, issued_at, 'refresh')}"


@app.post("/api/auth/login")
async def login(payload: Dict[str, Any]):
    username = (payload.get("username") or "").strip()
    password = payload.get("password") or ""

    _load_persistent_state()
    user = next(
        (u for u in STATE["users"] if str(u.get("username", "")).lower() == username.lower()),
        None,
    )
    if user is None:
        _load_persistent_state()
        user = next(
            (u for u in STATE["users"] if str(u.get("username", "")).lower() == username.lower()),
            None,
        )
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="प्रयोगकर्ता नाम वा पासवर्ड मिलेन। (Invalid username or password.)",
        )
    if user.get("is_active") is False:
        raise HTTPException(status_code=403, detail="यो खाता निष्क्रिय छ। (This account is disabled.)")

    stored_hash = user.get("password_hash")
    if stored_hash:
        if not verify_password(password, stored_hash):
            raise HTTPException(
                status_code=401,
                detail="प्रयोगकर्ता नाम वा पासवर्ड मिलेन। (Invalid username or password.)",
            )
    else:
        role = str(user.get("role"))
        role_secret = {
            "MasterAdmin": settings.master_admin_password,
            "SuperAdmin": settings.admin_password,
        }.get(role, "")
        if not role_secret:
            # No stored hash and no bootstrap secret available: refuse instead of
            # accepting any password (the previous behaviour was an auth bypass).
            raise HTTPException(
                status_code=401,
                detail="यो खातामा पासवर्ड सेट गरिएको छैन। प्रशासकलाई पासवर्ड सेट गर्न भन्नुहोस्। "
                       "(This account has no password set; ask an administrator to set one.)",
            )
        if not hmac.compare_digest(password, role_secret):
            raise HTTPException(
                status_code=401,
                detail="प्रयोगकर्ता नाम वा पासवर्ड मिलेन। (Invalid username or password.)",
            )

    user["last_login_at"] = time.time()
    _save_persistent_state(sync=True)
    return {
        "access_token": _issue_access_token(user["id"]),
        "refresh_token": _issue_refresh_token(user["id"]),
        "token_type": "bearer",
        "user_id": user["id"],
        "username": user["username"],
        "role": user.get("role"),
        "must_change_password": bool(user.get("must_change_password")),
        "user": _public_user(user),
    }


@app.post("/api/auth/refresh")
async def refresh_token(payload: Dict[str, Any]):
    raw = str(payload.get("refresh_token") or "")
    match = re.match(r"^kmc-refresh-(\d+)-(\d+)-([0-9a-f]{32})$", raw)
    user = None
    if match:
        user_id, issued_at, signature = int(match.group(1)), int(match.group(2)), match.group(3)
        max_age_seconds = max(1, settings.refresh_token_expire_days) * 86400
        if (
            time.time() - issued_at <= max_age_seconds
            and hmac.compare_digest(signature, _sign_token(user_id, issued_at, "refresh"))
        ):
            candidate = next((u for u in STATE.get("users", []) if int(u.get("id", 0)) == user_id), None)
            if candidate is not None:
                pw_changed_at = int(candidate.get("password_changed_at") or 0)
                if not pw_changed_at or issued_at >= pw_changed_at:
                    user = candidate
    if user is None or user.get("is_active") is False:
        raise HTTPException(status_code=401, detail="रिफ्रेस टोकन अवैध वा म्याद सकिएको छ। (Invalid or expired refresh token.)")
    return {
        "access_token": _issue_access_token(user["id"]),
        "refresh_token": _issue_refresh_token(user["id"]),
        "token_type": "bearer",
    }


@app.get("/api/auth/me")
async def auth_me(request: Request):
    user = resolve_request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
    return _public_user(user)


@app.get("/api/users")
async def list_users(request: Request):
    actor = _require_admin_user(request)
    _load_persistent_state()
    users = STATE["users"]
    if not _is_master_user(actor):
        # The private master account and other protected administrators are
        # invisible to every non-master administrator (their own row excepted).
        actor_id = str((actor or {}).get("id"))
        users = [
            u
            for u in users
            if str(u.get("role")) not in PROTECTED_ROLES or str(u.get("id")) == actor_id
        ]
    if _is_department_admin_user(actor):
        project_ids = _department_admin_project_ids(actor)
        managed_ids = {
            str(member)
            for project_id in project_ids
            for member in _project_collector_ids(project_id)
        }
        managed_ids.add(str(actor.get("id")))
        users = [u for u in users if str(u.get("id")) in managed_ids]
    return [_public_user(user) for user in users]


@app.get("/api/users/{user_id}")
async def get_user(user_id: int, request: Request):
    actor = _require_user(request)
    if not _is_admin_user(actor) and str(actor.get("id")) != str(user_id):
        raise HTTPException(
            status_code=403,
            detail="अर्को प्रयोगकर्ताको विवरण हेर्न अधिकार छैन। (You can only view your own profile.)",
        )
    user = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if user is None:
        _load_persistent_state()
        user = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if user is None:
        raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")
    if (
        str(user.get("role")) in PROTECTED_ROLES
        and not _is_master_user(actor)
        and str(user.get("id")) != str((actor or {}).get("id"))
    ):
        raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")
    if (
        _is_department_admin_user(actor)
        and str(user.get("id")) != str((actor or {}).get("id"))
        and not _department_admin_can_manage_user(actor, user)
    ):
        raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")
    return _public_user(user)


@app.get("/api/users/{user_id}/projects")
async def get_user_projects(user_id: int, request: Request):
    actor = resolve_request_user(request)
    if actor is None:
        raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
    target = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(user_id)), None)
    if str(actor.get("id")) != str(user_id):
        if not _is_admin_user(actor):
            raise HTTPException(status_code=403, detail="अर्को प्रयोगकर्ताका परियोजना हेर्न अधिकार छैन। (You cannot list another user's projects.)")
        if _is_department_admin_user(actor) and (target is None or not _department_admin_can_manage_user(actor, target)):
            raise HTTPException(status_code=403, detail="यो प्रयोगकर्ता तपाईंको परियोजनामा छैन। (This user is not in your projects.)")
    projects = []
    for project in STATE.get("projects", []):
        if not _user_can_access_project(actor, project.get("id")):
            continue
        if any(str(member) == str(user_id) for member in _project_collector_ids(project.get("id"))):
            projects.append(project)
    return projects


@app.post("/api/users")
async def create_user(payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    _load_persistent_state()
    username = (payload.get("username") or "").strip()
    if not username:
        raise HTTPException(status_code=400, detail="प्रयोगकर्ता नाम आवश्यक छ। (Username is required.)")
    if any(str(u.get("username", "")).lower() == username.lower() for u in STATE["users"]):
        raise HTTPException(status_code=409, detail="यो प्रयोगकर्ता नाम पहिले नै छ। (Username already exists.)")

    role = payload.get("role") or "DataCollector"
    if role == "GisAdmin":
        role = "DepartmentAdmin"
    if role not in ASSIGNABLE_ROLES:
        raise HTTPException(status_code=400, detail="अवैध भूमिका। (Invalid role.)")
    if role in PROTECTED_ROLES and not _is_master_user(actor):
        raise HTTPException(
            status_code=403,
            detail="मास्टर तथा सुपर प्रशासक खाता केवल मास्टर प्रयोगकर्ताले सिर्जना गर्न सक्छ। (Only the master user can create protected administrator accounts.)",
        )
    if _is_department_admin_user(actor) and role not in COLLECTOR_ROLES:
        raise HTTPException(
            status_code=403,
            detail="विभागीय प्रशासकले Validator वा DataCollector खाता मात्र सिर्जना गर्न सक्छ। "
                   "(A DepartmentAdmin can only create Validator and DataCollector accounts.)",
        )

    user = {
        "id": max((int(u.get("id", 0)) for u in STATE["users"]), default=0) + 1,
        "username": username,
        "email": payload.get("email") or "",
        "full_name": payload.get("full_name") or username,
        "role": role,
        "assigned_ward": payload.get("assigned_ward") or 0,
        "department_id": payload.get("department_id"),
        "department": payload.get("department") or "",
        "is_active": True,
        "created_at": time.time(),
    }

    # A DepartmentAdmin's field users belong to the projects that admin controls;
    # otherwise the creator could neither manage the account nor could the user
    # reach any project. Super/master admins link explicitly via the project UI.
    link_projects: List[Any] = []
    if _is_department_admin_user(actor) and role in COLLECTOR_ROLES:
        allowed_projects = {str(pid) for pid in _department_admin_project_ids(actor)}
        if not allowed_projects:
            raise HTTPException(
                status_code=403,
                detail="तपाईंसँग कुनै परियोजना जोडिएको छैन। (No project is linked to your account yet.)",
            )
        requested_projects = payload.get("project_ids")
        if requested_projects is None:
            link_projects = sorted(allowed_projects)
        else:
            if not isinstance(requested_projects, list):
                requested_projects = [requested_projects]
            requested_projects = [str(pid) for pid in requested_projects if pid not in (None, "")]
            if not requested_projects:
                raise HTTPException(status_code=400, detail="कम्तीमा एउटा परियोजना छान्नुहोस्। (Select at least one project.)")
            denied = [pid for pid in requested_projects if pid not in allowed_projects]
            if denied:
                raise HTTPException(
                    status_code=403,
                    detail="तपाईंले आफ्नो परियोजनामा मात्र प्रयोगकर्ता जोड्न सक्नुहुन्छ। (You can only link users to your own projects.)",
                )
            link_projects = requested_projects

    password = payload.get("password")
    if password:
        user["password_hash"] = hash_password(_validate_new_password(password))
        user["password_changed_at"] = time.time()

    STATE["users"].append(user)
    for project_id in link_projects:
        project = _find_project(project_id)
        if project is None:
            continue
        members = _project_collector_ids(project_id)
        if not any(str(member) == str(user["id"]) for member in members):
            members.append(user["id"])
        STATE.setdefault("project_collectors", {})[project_id] = members
        project["collector_ids"] = members
        project["updated_at"] = time.time()
    _save_persistent_state(sync=True)
    return _public_user(user)


@app.put("/api/users/{user_id}")
async def update_user(user_id: int, payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    user = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if user is None:
        _load_persistent_state()
        user = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if user is None:
        raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")
    target_role = str(user.get("role"))
    is_self = str(user.get("id")) == str((actor or {}).get("id"))
    is_master = _is_master_user(actor)
    is_super = _is_super_user(actor)
    target_is_protected = target_role in PROTECTED_ROLES
    requested_role = payload.get("role")
    if requested_role == "GisAdmin":
        requested_role = "DepartmentAdmin"

    if _is_department_admin_user(actor) and not is_self:
        if not _department_admin_can_manage_user(actor, user):
            raise HTTPException(
                status_code=403,
                detail="विभागीय प्रशासकले आफ्नो परियोजनाका संकलक/प्रमाणक मात्र परिवर्तन गर्न सक्छ। "
                       "(A DepartmentAdmin can only manage collectors/validators in their projects.)",
            )
        if requested_role and requested_role not in COLLECTOR_ROLES:
            raise HTTPException(
                status_code=403,
                detail="विभागीय प्रशासकले भूमिका Validator/DataCollector भित्र मात्र परिवर्तन गर्न सक्छ। "
                       "(A DepartmentAdmin can only assign Validator/DataCollector roles.)",
            )
    if not is_master:
        if not is_self and (target_is_protected or requested_role in PROTECTED_ROLES):
            raise HTTPException(
                status_code=403,
                detail="मास्टर तथा सुपर प्रशासक खाता केवल मास्टर प्रयोगकर्ताले परिवर्तन गर्न सक्छ। (Only the master user can modify or assign protected administrator accounts.)",
            )
        if is_self and requested_role is not None and requested_role != target_role:
            if requested_role in PROTECTED_ROLES or target_is_protected:
                raise HTTPException(
                    status_code=403,
                    detail="यो भूमिका परिवर्तन गर्न अधिकार छैन। (You cannot change a protected role.)",
                )
    elif is_self and requested_role and requested_role != "MasterAdmin":
        raise HTTPException(
            status_code=400,
            detail="मास्टर खाता आफैंले अन्य भूमिकामा झार्न मिल्दैन। (A MasterAdmin cannot demote its own account.)",
        )

    # Optional password update directly via user update payload
    if "password" in payload and payload.get("password"):
        new_pw = _validate_new_password(payload["password"])
        if (
            is_master
            or (is_super and not target_is_protected)
            or (_is_department_admin_user(actor) and _department_admin_can_manage_user(actor, user))
        ):
            user["password_hash"] = hash_password(new_pw)
            user["password_changed_at"] = time.time()
            user.pop("must_change_password", None)
        elif is_self:
            current_pw = str(payload.get("current_password") or "")
            if not _verify_current_password(user, current_pw):
                raise HTTPException(
                    status_code=400,
                    detail="हालको पासवर्ड मिलेन। (Current password is incorrect.)",
                )
            user["password_hash"] = hash_password(new_pw)
            user["password_changed_at"] = time.time()
            user.pop("must_change_password", None)
        else:
            raise HTTPException(
                status_code=403,
                detail="पासवर्ड परिवर्तन गर्न अधिकार छैन। (Not authorized to change password.)",
            )

    if "username" in payload:
        new_username = str(payload.get("username") or "").strip()
        if not new_username:
            raise HTTPException(status_code=400, detail="प्रयोगकर्ता नाम आवश्यक छ। (Username is required.)")
        duplicate = any(
            str(other.get("username", "")).lower() == new_username.lower() and other is not user
            for other in STATE["users"]
        )
        if duplicate:
            raise HTTPException(status_code=409, detail="यो प्रयोगकर्ता नाम पहिले नै छ। (Username already exists.)")
        user["username"] = new_username

    if "role" in payload:
        role = payload.get("role")
        if role == "GisAdmin":
            role = "DepartmentAdmin"
        if role not in ASSIGNABLE_ROLES:
            raise HTTPException(status_code=400, detail="अवैध भूमिका। (Invalid role.)")
        user["role"] = role

    for field in ("email", "full_name", "assigned_ward", "department_id", "department", "is_active"):
        if field in payload:
            user[field] = payload[field]

    _save_persistent_state(sync=True)
    return _public_user(user)


@app.put("/api/users/{user_id}/password")
async def change_user_password(user_id: int, payload: Dict[str, Any], request: Request):
    actor = _require_user(request)
    user = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if user is None:
        _load_persistent_state()
        user = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if user is None:
        raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")

    is_self = str(user.get("id")) == str(actor.get("id"))
    is_master = _is_master_user(actor)
    is_super = _is_super_user(actor)
    target_is_protected = str(user.get("role")) in PROTECTED_ROLES

    if is_master:
        # MasterAdmin can reset any user's password without the current password
        pass
    elif is_super and not target_is_protected:
        # SuperAdmin can reset any non-protected user's password without the current password
        pass
    elif _is_department_admin_user(actor) and _department_admin_can_manage_user(actor, user):
        # DepartmentAdmin can reset passwords for field staff inside their projects
        pass
    elif is_self:
        current_password = str(payload.get("current_password") or "")
        if not _verify_current_password(user, current_password):
            raise HTTPException(
                status_code=400,
                detail="हालको पासवर्ड मिलेन। (Current password is incorrect.)",
            )
    else:
        raise HTTPException(
            status_code=403,
            detail="अरू खाताको पासवर्ड परिवर्तन गर्न सुपर वा मास्टर प्रशासक अधिकार आवश्यक छ। "
                   "(SuperAdmin or MasterAdmin permission required to reset another user's password.)",
        )

    new_password = _validate_new_password(payload.get("new_password"))
    user["password_hash"] = hash_password(new_password)
    user["password_changed_at"] = time.time()
    user.pop("must_change_password", None)
    _save_persistent_state(sync=True)
    return {"status": "password_changed", "user": _public_user(user)}


@app.get("/api/departments")
async def list_departments(request: Request):
    _require_user(request)
    _reload_state_if_modified()
    return list(STATE.setdefault("departments", []))


@app.post("/api/departments")
async def create_department(payload: Dict[str, Any], request: Request):
    actor = _require_super_user(request)
    name = str(payload.get("name") or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="विभागको नाम आवश्यक छ। (Department name is required.)")
    depts = STATE.setdefault("departments", [])
    if any(str(d.get("name", "")).strip().lower() == name.lower() for d in depts):
        raise HTTPException(status_code=409, detail="यो विभाग पहिले नै छ। (Department already exists.)")
    now = time.time()
    dept = {
        "id": max((int(d.get("id", 0)) for d in depts if str(d.get("id", "")).isdigit()), default=0) + 1,
        "name": name,
        "name_ne": str(payload.get("name_ne") or "").strip(),
        "code": str(payload.get("code") or "").strip(),
        "description": str(payload.get("description") or "").strip(),
        "head_user_id": payload.get("head_user_id"),
        "created_by": actor.get("id"),
        "created_at": now,
        "updated_at": now,
    }
    depts.append(dept)
    _save_persistent_state(sync=True)
    return dept


@app.put("/api/departments/{department_id}")
async def update_department(department_id: int, payload: Dict[str, Any], request: Request):
    _require_super_user(request)
    depts = STATE.setdefault("departments", [])
    dept = next((d for d in depts if str(d.get("id")) == str(department_id)), None)
    if dept is None:
        raise HTTPException(status_code=404, detail="विभाग भेटिएन। (Department not found.)")
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="विभागको नाम आवश्यक छ। (Department name is required.)")
        if any(str(d.get("name", "")).strip().lower() == name.lower() and d is not dept for d in depts):
            raise HTTPException(status_code=409, detail="यो विभाग पहिले नै छ। (Department already exists.)")
        dept["name"] = name
    for field in ("name_ne", "code", "description", "head_user_id"):
        if field in payload:
            dept[field] = payload[field]
    dept["updated_at"] = time.time()
    _save_persistent_state(sync=True)
    return dept


@app.delete("/api/departments/{department_id}")
async def delete_department(department_id: int, request: Request):
    _require_super_user(request)
    depts = STATE.setdefault("departments", [])
    dept = next((d for d in depts if str(d.get("id")) == str(department_id)), None)
    if dept is None:
        raise HTTPException(status_code=404, detail="विभाग भेटिएन। (Department not found.)")
    STATE["departments"] = [d for d in depts if str(d.get("id")) != str(department_id)]
    for u in STATE.get("users", []):
        if str(u.get("department_id")) == str(department_id):
            u["department_id"] = None
    _save_persistent_state(sync=True)
    return {"status": "deleted", "id": department_id}


@app.delete("/api/users/{user_id}")
async def delete_user(user_id: int, request: Request):
    actor = _require_admin_user(request)
    target = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if target is None:
        _load_persistent_state()
        target = next((u for u in STATE["users"] if int(u.get("id", 0)) == user_id), None)
    if target is None:
        raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")
    if str(target.get("role")) in PROTECTED_ROLES and not _is_master_user(actor):
        raise HTTPException(
            status_code=403,
            detail="मास्टर तथा सुपर प्रशासक खाता मेटाउन केवल मास्टर प्रयोगकर्ताले सक्छ। (Only the master user can delete a protected administrator account.)",
        )
    if _is_department_admin_user(actor) and not _department_admin_can_manage_user(actor, target):
        raise HTTPException(
            status_code=403,
            detail="विभागीय प्रशासकले आफ्नो परियोजनाका संकलक/प्रमाणक मात्र मेटाउन सक्छ। "
                   "(A DepartmentAdmin can only delete collectors/validators in their projects.)",
        )
    if str(target.get("id")) == str((actor or {}).get("id")):
        raise HTTPException(status_code=400, detail="आफ्नै खाता मेटाउन मिल्दैन। (You cannot delete your own account.)")

    STATE["users"] = [u for u in STATE["users"] if int(u.get("id", 0)) != user_id]

    # Keep tasking consistent: released grids go back to the READY pool.
    for tasks in STATE.get("tasks_by_project", {}).values():
        for task in tasks or []:
            assignments = task.get("assignments")
            if isinstance(assignments, list) and any(
                isinstance(item, dict) and str(item.get("user_id")) == str(user_id)
                for item in assignments
            ):
                _apply_task_assignments(
                    task,
                    [item for item in assignments if not isinstance(item, dict) or str(item.get("user_id")) != str(user_id)],
                )
            if str(task.get("assigned_to")) == str(user_id):
                task["assigned_to"] = None
                task["assigned_username"] = None
                task["assigned_full_name"] = None
                if task.get("status") in ("LOCKED", "LOCKED_FOR_MAPPING"):
                    task["status"] = "READY"
                    task["locked_by"] = None
                    task["locked_at"] = None
            if str(task.get("validated_by")) == str(user_id) and task.get("status") == "LOCKED_FOR_VALIDATION":
                task["status"] = "MAPPED"
                task["validated_by"] = None

    for project_id, members in list(STATE.get("project_collectors", {}).items()):
        STATE["project_collectors"][project_id] = [
            member for member in members if str(member) != str(user_id)
        ]

    _save_persistent_state(sync=True)
    return {"status": "deleted", "id": user_id}


# ============================================================
# AOI Resolution, 6-Mode Grid Generation & Project Boundary Endpoints
# ============================================================

PROJECT_MODES = ("STANDARD", "ADVANCED_QUESTIONNAIRE")
PROJECT_GEOMETRY_TYPES = ("Point", "LineString", "Polygon", "Mix")
GEOMETRY_TYPE_ALIASES = {
    "point": "Point",
    "multipoint": "Point",
    "line": "LineString",
    "linestring": "LineString",
    "multiline": "LineString",
    "multilinestring": "LineString",
    "polygon": "Polygon",
    "multipolygon": "Polygon",
    "mixed": "Mix",
    "mix": "Mix",
    "geometry": "Mix",
}


def _canonical_geometry_type(value: Any, default: str = "Point") -> str:
    """Normalises legacy UI values (`Line`, `Mixed`) to canonical geometry types."""
    raw = str(value or default).strip()
    key = raw.lower().replace("-", "").replace("_", "").replace(" ", "")
    return GEOMETRY_TYPE_ALIASES.get(key, raw)


def _canonical_geometry_list(values: Any) -> List[str]:
    if not isinstance(values, (list, tuple, set)):
        return []
    result: List[str] = []
    for value in values:
        canonical = _canonical_geometry_type(value)
        if canonical and canonical not in result:
            result.append(canonical)
    return result


def _find_project(project_id: Any) -> Optional[Dict[str, Any]]:
    _reload_state_if_modified()
    project = next(
        (project for project in STATE.get("projects", []) if str(project.get("id")) == str(project_id)),
        None,
    )
    if project is None:
        _load_persistent_state()
        project = next(
            (project for project in STATE.get("projects", []) if str(project.get("id")) == str(project_id)),
            None,
        )
    return project


def _require_project(project_id: Any) -> Dict[str, Any]:
    project = _find_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="परियोजना भेटिएन। (Project not found.)")
    return project


def _boundary_as_geojson(geojson: Any) -> Dict[str, Any]:
    """Validates and normalizes an AOI into plain, JSON-safe GeoJSON."""
    try:
        geometry = normalize_aoi_geometry(geojson)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return json.loads(json.dumps(mapping(geometry)))


def _union_state_layer_features(layer_id: Any) -> Optional[Dict[str, Any]]:
    layer = next(
        (item for item in STATE.get("vector_layers", []) if str(item.get("id")) == str(layer_id)),
        None,
    )
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    geometries = [
        (feature.get("geometry") or {})
        for feature in get_layer_features_list(layer.get("id"))
        if (feature.get("geometry") or {}).get("type") in ("Polygon", "MultiPolygon")
    ]
    if not geometries:
        raise HTTPException(
            status_code=400,
            detail="यस तहमा कुनै बहुभुज (Polygon) फिचर भेटिएन। (This layer has no polygon features to use as an AOI.)",
        )
    return _boundary_as_geojson({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": geometry, "properties": {}} for geometry in geometries
    ]})


def _union_state_selected_features(feature_ids: Any) -> Optional[Dict[str, Any]]:
    wanted = {str(fid) for fid in (feature_ids or [])}
    if not wanted:
        return None
    geometries = []
    for layer in STATE.get("vector_layers", []):
        for feature in get_layer_features_list(layer.get("id")):
            fid = feature.get("id") or (feature.get("properties") or {}).get("_id")
            if str(fid) in wanted and (feature.get("geometry") or {}).get("type") in ("Polygon", "MultiPolygon"):
                geometries.append(feature.get("geometry"))
    if not geometries:
        raise HTTPException(
            status_code=400,
            detail="छानिएका फिचरहरू भेटिएनन् वा ती बहुभुज छैनन्। (Selected features were not found or are not polygons.)",
        )
    return _boundary_as_geojson({"type": "FeatureCollection", "features": [
        {"type": "Feature", "geometry": geometry, "properties": {}} for geometry in geometries
    ]})


def _resolve_project_aoi(project: Dict[str, Any], payload: Dict[str, Any]) -> Tuple[Dict[str, Any], str]:
    """Resolves the AOI for grid generation, honouring the 3 documented source modes."""
    drawn = payload.get("boundary_geojson") or payload.get("custom_aoi_geojson")
    if drawn:
        return _boundary_as_geojson(drawn), "drawn_polygon"

    aoi_mode = str(payload.get("aoi_mode") or project.get("aoi_mode") or "project_boundary")
    source_layer_id = payload.get("source_layer_id") or payload.get("aoi_source_layer_id")
    if aoi_mode in ("entire_layer", "layer", "uploaded_layer") and source_layer_id is not None:
        boundary = _union_state_layer_features(source_layer_id)
        if boundary:
            return boundary, "entire_layer"

    source_feature_ids = payload.get("source_feature_ids") or payload.get("aoi_source_feature_ids")
    if aoi_mode == "selected_features" and source_feature_ids:
        boundary = _union_state_selected_features(source_feature_ids)
        if boundary:
            return boundary, "selected_features"

    stored = project.get("boundary_geojson") or project.get("aoi_geojson")
    if stored:
        return _boundary_as_geojson(stored), "project_boundary"

    raise HTTPException(
        status_code=400,
        detail=(
            "यस परियोजनाको AOI सीमा भेटिएन। नक्सामा क्षेत्र कोर्नुहोस् वा सिमाना (GeoJSON) अपलोड गर्नुहोस्। "
            "(No AOI boundary is defined for this project. Draw the AOI on the map or upload a boundary GeoJSON first.)"
        ),
    )


def _grid_task_id(project_id: Any, grid_index: int) -> int:
    # Deterministic id: preserve *1000 stride for small indices (<1000) and widen to *100000 for large grids.
    idx = int(grid_index)
    stride = 100000 if idx >= 1000 else 1000
    return int(project_id) * stride + idx


def _task_feature_counts(project_id: Any, tasks: List[Dict[str, Any]]) -> Dict[str, int]:
    """Counts attributed features per task in one pass over the project's layers."""
    counts: Dict[str, int] = {}
    # Fallback geometry containment is only needed for features without a task id.
    task_geometries = [
        (str(task.get("id")), task.get("geometry"))
        for task in tasks or []
        if task.get("geometry")
    ]
    for layer in STATE.get("vector_layers", []):
        if str(layer.get("project_id")) != str(project_id):
            continue
        for feature in get_layer_features_list(layer.get("id")):
            props = feature.get("properties") or {}
            task_id = props.get("_task_grid_id")
            if task_id not in (None, ""):
                counts[str(task_id)] = counts.get(str(task_id), 0) + 1
                continue
            point = _representative_point(feature.get("geometry"))
            if point is None:
                continue
            for candidate_id, task_geometry in task_geometries:
                if _point_in_task_geometry(point[0], point[1], task_geometry):
                    counts[candidate_id] = counts.get(candidate_id, 0) + 1
                    break
    return counts


def _json_safe_geometry(value: Any) -> Any:
    """Deep-converts geometry tuples to JSON lists (grid cells may carry tuples).

    Containment helpers and the state store expect list coordinates; tuple-based
    cells otherwise make a freshly generated grid unluckable until reload.
    """
    if isinstance(value, dict):
        return {key: _json_safe_geometry(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe_geometry(item) for item in value]
    return value


def _build_grid_tasks(project_id: Any, grid_result: Dict[str, Any]) -> List[Dict[str, Any]]:
    tasks = []
    for cell in grid_result["cells"]:
        tasks.append({
            "id": _grid_task_id(project_id, cell["grid_index"]),
            "project_id": project_id,
            "grid_index": cell["grid_index"],
            "grid_code": cell["grid_code"],
            "name": cell["name"],
            "grid_shape": grid_result["grid_shape"],
            "status": "READY",
            "assigned_to": None,
            "assigned_username": None,
            "assigned_full_name": None,
            "geometry": _json_safe_geometry(cell["geometry"]),
            "bbox": _json_safe_geometry(cell["bbox"]),
            "centroid": _json_safe_geometry(cell["centroid"]),
            "area_sqm": cell["area_sqm"],
            "feature_count": 0,
        })
    return tasks


def _build_polygon_tasks(project_id: Any, polygons: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    tasks = []
    for index, polygon in enumerate(polygons, start=1):
        geometry = _boundary_as_geojson(polygon["geometry"])
        ring = geometry.get("coordinates") or []
        # bbox + centroid from the polygon's own vertices.
        xs, ys = [], []

        def collect(node):
            if isinstance(node, (list, tuple)) and len(node) >= 2 and all(isinstance(v, (int, float)) for v in node[:2]):
                xs.append(node[0]); ys.append(node[1])
            elif isinstance(node, (list, tuple)):
                for child in node:
                    collect(child)

        collect(geometry.get("coordinates"))
        bbox = [min(xs), min(ys), max(xs), max(ys)] if xs and ys else [0, 0, 0, 0]
        centroid = [sum(xs) / len(xs), sum(ys) / len(ys)] if xs and ys else [0, 0]
        name = polygon.get("name") or f"कार्यक्षेत्र #{index}"
        tasks.append({
            "id": _grid_task_id(project_id, index),
            "project_id": project_id,
            "grid_index": index,
            "grid_code": f"G-{index:03d}",
            "name": name,
            "grid_shape": "UPLOADED",
            "status": "READY",
            "assigned_to": None,
            "assigned_username": None,
            "assigned_full_name": None,
            "geometry": geometry,
            "bbox": bbox,
            "centroid": centroid,
            "area_sqm": round(geometry_area_sqm(geometry), 2),
            "feature_count": 0,
        })
    return tasks


def _store_project_tasks(project: Dict[str, Any], tasks: List[Dict[str, Any]]) -> None:
    project_id = project.get("id")
    STATE.setdefault("tasks_by_project", {})[project_id] = tasks
    if str(project_id) in STATE["tasks_by_project"]:
        STATE["tasks_by_project"].pop(str(project_id), None)
    project["task_count"] = len(tasks)
    project["updated_at"] = time.time()


async def _mirror_tasks_to_postgis(db: AsyncSession, project_id: Any, aoi_geojson: Dict[str, Any],
                                   grid_shape: str, grid_size_m: float,
                                   project_name: Optional[str] = None) -> Optional[str]:
    """Best-effort PostGIS mirror. Returns a warning string when the DB is unavailable."""
    try:
        await generate_six_mode_grid(
            db=db,
            boundary_geojson=aoi_geojson,
            grid_shape=grid_shape,
            grid_size_m=grid_size_m,
            project_id=int(project_id),
            project_name=project_name,
        )
        await db.commit()
        return None
    except Exception as exc:  # noqa: BLE001 - grid generation must not fail on DB issues
        try:
            await db.rollback()
        except Exception:
            pass
        print(f"[KMC-GRID] PostGIS mirror skipped: {exc}")
        return "PostGIS mirror unavailable — grids persisted in the application state store."


@app.post("/api/projects/{project_id}/generate-grid")
async def generate_project_grid(
    project_id: int,
    payload: Dict[str, Any],
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    user = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा ग्रिड बनाउन पहुँच छैन। (You cannot generate grids for this project.)")
    grid_shape = payload.get("grid_type") or payload.get("grid_shape") or project.get("grid_type") or "HEXAGON"
    grid_size = (
        payload.get("grid_size_m")
        or payload.get("grid_size_meters")
        or payload.get("cell_size_m")
        or project.get("grid_size_m")
        or 200
    )
    aoi_geojson, aoi_mode = _resolve_project_aoi(project, payload)

    try:
        mode = normalize_grid_mode(grid_shape)
        size = validate_cell_size(grid_size)
        grid_result = generate_grid_cells(aoi_geojson, mode, size, seed=int(project_id) or 2083)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    warnings = []
    if grid_result["stats"]["coverage_percent"] < 99.0:
        warnings.append(
            f"Coverage is {grid_result['stats']['coverage_percent']}% — increase the cell size or simplify the AOI."
        )

    tasks = _build_grid_tasks(project_id, grid_result)
    _store_project_tasks(project, tasks)

    project["boundary_geojson"] = aoi_geojson
    project["aoi_mode"] = aoi_mode
    project["aoi_area_sqm"] = grid_result["stats"]["aoi_area_sqm"]
    project["grid_type"] = grid_result["grid_shape"]
    project["grid_size_m"] = grid_result["cell_size_m"]
    project["last_grid_generated_at"] = time.time()

    db_warning = await _mirror_tasks_to_postgis(
        db, project_id, aoi_geojson, grid_result["grid_shape"], grid_result["cell_size_m"],
        project_name=project.get("name"),
    )
    if db_warning:
        warnings.append(db_warning)

    _save_persistent_state(sync=True)
    return {
        "status": "success",
        "message": (
            f"{len(tasks)} कार्यक्षेत्रहरू सिर्जना भए ({grid_result['stats']['coverage_percent']}% AOI coverage)."
        ),
        "grid_shape": grid_result["grid_shape"],
        "grid_size_m": grid_result["cell_size_m"],
        "aoi_mode": aoi_mode,
        "tasks_created": len(tasks),
        "coverage_percent": grid_result["stats"]["coverage_percent"],
        "aoi_area_sqm": grid_result["stats"]["aoi_area_sqm"],
        "cells": grid_result["stats"]["cells"],
        "warnings": warnings,
    }


@app.post("/api/projects/{project_id}/boundary")
async def set_project_boundary(project_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनाको सिमाना परिवर्तन गर्न पहुँच छैन। (You cannot change this project's boundary.)")
    raw = payload.get("boundary_geojson") or payload.get("aoi_geojson") or payload.get("geometry")
    if raw is None and payload.get("type") in ("Polygon", "MultiPolygon", "Feature", "FeatureCollection"):
        raw = payload
    if raw is None:
        raise HTTPException(
            status_code=400,
            detail="सिमाना GeoJSON आवश्यक छ। (A boundary GeoJSON is required.)",
        )
    boundary = _boundary_as_geojson(raw)
    project["boundary_geojson"] = boundary
    project["aoi_mode"] = payload.get("aoi_mode") or "drawn_polygon"
    project["aoi_area_sqm"] = round(geometry_area_sqm(boundary), 2)
    project["updated_at"] = time.time()
    _save_persistent_state(sync=True)
    return {"status": "ok", "project": project, "aoi_area_sqm": project["aoi_area_sqm"]}


@app.post("/api/projects/{project_id}/boundary/upload")
async def upload_project_boundary(
    project_id: int,
    request: Request,
    file: UploadFile = File(...),
    method: str = Form("GENERATE_GRID"),
    grid_type: str = Form("HEXAGON"),
    grid_size_m: str = Form("200"),
    db: AsyncSession = Depends(get_db),
):
    """Method A of the tasking console: import an AOI/features file as tasks or as a grid AOI."""
    user = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनाको सिमाना आयात गर्न पहुँच छैन। (You cannot import boundaries for this project.)")
    try:
        raw = await file.read()
        parsed = json.loads(raw.decode("utf-8-sig"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise HTTPException(
            status_code=400,
            detail=f"अमान्य GeoJSON फाइल। (Invalid GeoJSON file: {exc})",
        ) from exc

    upload_method = str(method or "GENERATE_GRID").upper()
    features = parsed.get("features") if isinstance(parsed, dict) else None
    polygon_features = []
    if isinstance(features, list):
        for feature in features:
            geometry = (feature or {}).get("geometry") if isinstance(feature, dict) else None
            if geometry and geometry.get("type") in ("Polygon", "MultiPolygon"):
                polygon_features.append({
                    "geometry": geometry,
                    "name": (feature.get("properties") or {}).get("name")
                    or (feature.get("properties") or {}).get("NAME")
                    or (feature.get("properties") or {}).get("ward"),
                })
    elif isinstance(parsed, dict) and parsed.get("type") in ("Polygon", "MultiPolygon"):
        polygon_features.append({"geometry": parsed, "name": None})
    elif isinstance(parsed, dict) and parsed.get("type") == "Feature":
        geometry = parsed.get("geometry") or {}
        if geometry.get("type") in ("Polygon", "MultiPolygon"):
            polygon_features.append({"geometry": geometry, "name": (parsed.get("properties") or {}).get("name")})

    if not polygon_features:
        raise HTTPException(
            status_code=400,
            detail="फाइलमा कुनै बहुभुज (Polygon/MultiPolygon) भेटिएन। (No polygon geometry was found in the file.)",
        )
    if len(polygon_features) > 5000:
        raise HTTPException(status_code=400, detail="एकै पटक ५००० भन्दा बढी फिचर स्वीकार गरिँदैन।")

    aoi_union = _boundary_as_geojson({
        "type": "FeatureCollection",
        "features": [{"type": "Feature", "geometry": item["geometry"], "properties": {}} for item in polygon_features],
    })
    project["boundary_geojson"] = aoi_union
    project["aoi_mode"] = "uploaded_boundary"
    project["aoi_area_sqm"] = round(geometry_area_sqm(aoi_union), 2)
    project["updated_at"] = time.time()

    if upload_method == "IMPORT_ALL_AS_TASKS":
        tasks = _build_polygon_tasks(project_id, polygon_features)
        _store_project_tasks(project, tasks)
        project["grid_type"] = "UPLOADED"
        _save_persistent_state()
        return {
            "status": "success",
            "message": f"{len(tasks)} फिचरहरू कार्यक्षेत्रको रूपमा आयात भए।",
            "tasks_created": len(tasks),
            "aoi_area_sqm": project["aoi_area_sqm"],
            "warnings": [],
        }

    if upload_method == "SINGLE_TASK":
        tasks = _build_polygon_tasks(project_id, [{"geometry": aoi_union, "name": project.get("name")}])
        _store_project_tasks(project, tasks)
        _save_persistent_state()
        return {
            "status": "success",
            "message": "सम्पूर्ण सिमाना एउटै कार्यक्षेत्रको रूपमा सिर्जना भयो।",
            "tasks_created": 1,
            "aoi_area_sqm": project["aoi_area_sqm"],
            "warnings": [],
        }

    # Default: GENERATE_GRID — grid inside the uploaded AOI.
    try:
        mode = normalize_grid_mode(grid_type)
        size = validate_cell_size(grid_size_m)
        grid_result = generate_grid_cells(aoi_union, mode, size, seed=int(project_id) or 2083)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    tasks = _build_grid_tasks(project_id, grid_result)
    _store_project_tasks(project, tasks)
    project["grid_type"] = grid_result["grid_shape"]
    project["grid_size_m"] = grid_result["cell_size_m"]

    warnings = []
    db_warning = await _mirror_tasks_to_postgis(
        db, project_id, aoi_union, grid_result["grid_shape"], grid_result["cell_size_m"],
        project_name=project.get("name"),
    )
    if db_warning:
        warnings.append(db_warning)

    _save_persistent_state(sync=True)
    return {
        "status": "success",
        "message": (
            f"{len(tasks)} ग्रिड कार्यक्षेत्रहरू सिर्जना भए "
            f"({grid_result['stats']['coverage_percent']}% AOI coverage)."
        ),
        "tasks_created": len(tasks),
        "grid_shape": grid_result["grid_shape"],
        "grid_size_m": grid_result["cell_size_m"],
        "coverage_percent": grid_result["stats"]["coverage_percent"],
        "aoi_area_sqm": grid_result["stats"]["aoi_area_sqm"],
        "warnings": warnings,
    }


# ============================================================
# Tiles, Layers & Resumable Upload Endpoints
# ============================================================

def get_tileserver_dir() -> str:
    if os.path.exists("/tileserver-data"):
        return "/tileserver-data"
    host_dir = os.path.join(os.getcwd(), "data", "tileserver")
    os.makedirs(host_dir, exist_ok=True)
    return host_dir


def get_uploads_dir() -> str:
    upload_dir = getattr(settings, "upload_dir", "/app/uploads") or "/app/uploads"
    if not os.path.exists(upload_dir):
        upload_dir = os.path.join(os.getcwd(), "uploads")
    os.makedirs(upload_dir, exist_ok=True)
    return upload_dir


def _purged_asset_names() -> set:
    return {str(name) for name in (STATE.get("purged_assets") or [])}


def _mark_asset_purged(name: str) -> None:
    if not name:
        return
    purged = STATE.setdefault("purged_assets", [])
    if name not in purged:
        purged.append(name)
    # Keep the tombstone list bounded while retaining recent purge protection.
    del purged[:-2000]


def _is_within_dir(path: str, root: str) -> bool:
    try:
        root_abs = os.path.abspath(root)
        path_abs = os.path.abspath(path)
        return os.path.commonpath([root_abs, path_abs]) == root_abs
    except (ValueError, OSError):
        return False


def _delete_disk_file(path: str, root: str) -> int:
    """Deletes a file only when it resolves inside `root`; returns bytes released."""
    if not path or not os.path.isfile(path) or not _is_within_dir(path, root):
        return 0
    try:
        size = os.path.getsize(path)
        os.remove(path)
        _mark_asset_purged(os.path.basename(path))
        return size
    except OSError as exc:
        print(f"[PURGE] Could not delete {path}: {exc}")
        return 0


def _purge_layer_assets(layer: Dict[str, Any]) -> int:
    """Permanently removes a vector layer's source file(s) from the server disk."""
    released = 0
    uploads = get_uploads_dir()
    tileserver = get_tileserver_dir()
    filenames = {
        str(layer.get("filename") or "").strip(),
        f"{layer.get('id')}.geojson",
        f"{layer.get('name') or ''}.geojson",
    }
    for filename in filter(None, filenames):
        for directory in (os.path.join(uploads, "layers"), uploads, tileserver):
            released += _delete_disk_file(os.path.join(directory, filename), directory)
    return released


def _safe_flock_open(path: str, timeout_sec: float = 3.0):
    """Safely opens a lock in /tmp to prevent host mount deadlocks with bounded retry."""
    if fcntl is None:
        return None
    tmp_dir = "/tmp" if os.path.exists("/tmp") and os.path.isdir("/tmp") else tempfile.gettempdir()
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", os.path.basename(path))
    lock_path = os.path.join(tmp_dir, f"{safe_name}.lock")
    try:
        fh = open(lock_path, "a+", encoding="utf-8")
        deadline = time.monotonic() + timeout_sec
        while time.monotonic() < deadline:
            try:
                fcntl.flock(fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return fh
            except (BlockingIOError, OSError):
                time.sleep(0.02)
        try:
            fh.close()
        except Exception:
            pass
        return None
    except Exception:
        return None


def _safe_flock_close(fh) -> None:
    if fh is not None:
        try:
            if fcntl is not None:
                fcntl.flock(fh.fileno(), fcntl.LOCK_UN)
        except OSError:
            pass
        try:
            fh.close()
        except OSError:
            pass


def _atomic_write_json_locked(path: str, payload: Any, indent: Optional[int] = None) -> None:
    """Cross-process non-blocking safe flock + PID/ns atomic temp-file os.replace JSON writer."""
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)
    tmp_file = f"{path}.{os.getpid()}.{time.time_ns()}.tmp"
    lock_fh = _safe_flock_open(path, timeout_sec=3.0)
    try:
        with open(tmp_file, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=indent)
            f.flush()
            try:
                os.fsync(f.fileno())
            except OSError:
                pass
        os.replace(tmp_file, path)
    except Exception:
        if os.path.exists(tmp_file):
            try:
                os.remove(tmp_file)
            except OSError:
                pass
        raise
    finally:
        _safe_flock_close(lock_fh)


def _update_tileserver_config_locked(tileserver_dir: str, updater) -> None:
    """Atomically read-modify-write tileserver-gl config.json under non-blocking flock."""
    os.makedirs(tileserver_dir, exist_ok=True)
    cfg_path = os.path.join(tileserver_dir, "config.json")
    tmp_file = f"{cfg_path}.{os.getpid()}.{time.time_ns()}.tmp"
    lock_fh = _safe_flock_open(cfg_path, timeout_sec=3.0)
    try:
        cfg: Dict[str, Any] = {"options": {"paths": {"root": "/data", "mbtiles": "/data"}}, "styles": {}, "data": {}}
        if os.path.isfile(cfg_path):
            try:
                with open(cfg_path, "r", encoding="utf-8") as fh:
                    loaded = json.load(fh)
                if isinstance(loaded, dict):
                    cfg = loaded
            except (OSError, ValueError):
                pass
        if not isinstance(cfg.get("data"), dict):
            cfg["data"] = {}
        updater(cfg)
        with open(tmp_file, "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
            fh.flush()
        os.replace(tmp_file, cfg_path)
    except Exception:
        if os.path.exists(tmp_file):
            try:
                os.remove(tmp_file)
            except OSError:
                pass
        raise
    finally:
        _safe_flock_close(lock_fh)


def _unregister_tileserver_asset(filename: str) -> None:
    """Removes an mbtiles registration from tileserver-gl's config.json."""
    if not filename:
        return
    tileserver = get_tileserver_dir()
    stem = re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(filename)[0]).lower()
    cfg_path = os.path.join(tileserver, "config.json")
    if not os.path.isfile(cfg_path):
        return
    try:
        _update_tileserver_config_locked(tileserver, lambda cfg: cfg.setdefault("data", {}).pop(stem, None))
    except (OSError, ValueError) as exc:
        print(f"[PURGE] Tileserver config cleanup skipped: {exc}")


def _purge_raster_assets(raster: Dict[str, Any]) -> int:
    """Permanently removes an mbtiles archive and its tileserver registration."""
    filename = str(raster.get("filename") or "").strip()
    if not filename:
        return 0
    released = _delete_disk_file(os.path.join(get_tileserver_dir(), filename), get_tileserver_dir())
    _unregister_tileserver_asset(filename)
    return released


def _prune_id_list(values: Any, item_id: Any) -> list:
    return [value for value in values if str(value) != str(item_id)]


def _cleanup_layer_references(layer_id: Any) -> None:
    """Drops dangling pointers to a vector layer removed from the catalog."""
    lid = str(layer_id)
    for project in STATE.get("projects", []):
        for key in ("editable_layer_ids", "download_layer_ids"):
            if isinstance(project.get(key), list):
                project[key] = _prune_id_list(project[key], lid)
    for assignment in (STATE.get("project_assignments") or {}).values():
        if isinstance(assignment, dict) and isinstance(assignment.get("assigned_layer_ids"), list):
            assignment["assigned_layer_ids"] = _prune_id_list(assignment["assigned_layer_ids"], lid)
    STATE["feature_links"] = [
        link
        for link in STATE.get("feature_links", [])
        if str(link.get("source_layer_id")) != lid and str(link.get("target_layer_id")) != lid
    ] or []
    invalidate_spatial_index(layer_id)


def _cleanup_raster_references(tile_id: Any) -> None:
    """Drops dangling pointers to a raster archive removed from the catalog."""
    tid = str(tile_id)
    for project in STATE.get("projects", []):
        if isinstance(project.get("download_layer_ids"), list):
            project["download_layer_ids"] = _prune_id_list(project["download_layer_ids"], tid)
    for assignment in (STATE.get("project_assignments") or {}).values():
        if isinstance(assignment, dict) and isinstance(assignment.get("assigned_mbtiles_ids"), list):
            assignment["assigned_mbtiles_ids"] = _prune_id_list(assignment["assigned_mbtiles_ids"], tid)


# ============================================================
# Persistent State Store & High-Speed SQLite Tile Cache Engine
# ============================================================

_SQLITE_CONNS: Dict[str, sqlite3.Connection] = {}
_SQLITE_LOCK = threading.Lock()
_TILE_CACHE: OrderedDict[tuple, tuple[bytes, str]] = OrderedDict()
_TILE_CACHE_MAX = 8192
_TILE_CACHE_LOCK = threading.Lock()


_SQLITE_LOCAL = threading.local()
_TILE_CACHE_VERSIONS: Dict[str, int] = {}
_REDIS_TILE_CLIENT: Any = None
_REDIS_UNAVAILABLE_UNTIL: float = 0.0


def _invalidate_mbtiles_cache(dest_path: str, stem: str = "") -> None:
    """Evicts in-memory tiles, closes pooled SQLite handles, and bumps Redis cache version."""
    norm_path = os.path.abspath(dest_path) if dest_path else ""
    base_name = os.path.basename(dest_path) if dest_path else ""
    derived_stem = stem or (
        re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(base_name)[0]).lower() if base_name else ""
    )

    with _SQLITE_LOCK:
        for key in list(_SQLITE_CONNS.keys()):
            if key == dest_path or (norm_path and os.path.abspath(key) == norm_path):
                try:
                    _SQLITE_CONNS[key].close()
                except Exception:
                    pass
                _SQLITE_CONNS.pop(key, None)

    if hasattr(_SQLITE_LOCAL, "conns"):
        for key in list(_SQLITE_LOCAL.conns.keys()):
            if key == dest_path or (norm_path and os.path.abspath(key) == norm_path):
                entry = _SQLITE_LOCAL.conns.pop(key, None)
                conn = entry[1] if isinstance(entry, tuple) else entry
                if conn is not None:
                    try:
                        conn.close()
                    except Exception:
                        pass

    with _TILE_CACHE_LOCK:
        to_del = []
        for k in list(_TILE_CACHE.keys()):
            k0 = str(k[0])
            k0_base = os.path.basename(k0)
            k0_stem = re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(k0_base)[0]).lower()
            if (
                k0 == dest_path
                or (norm_path and os.path.abspath(k0) == norm_path)
                or (base_name and k0_base == base_name)
                or (derived_stem and (k0 == derived_stem or k0_stem == derived_stem))
            ):
                to_del.append(k)
        for k in to_del:
            _TILE_CACHE.pop(k, None)
        for ver_key in filter(None, (dest_path, norm_path, derived_stem)):
            _TILE_CACHE_VERSIONS[ver_key] = _TILE_CACHE_VERSIONS.get(ver_key, 0) + 1


async def _get_redis_tile_client():
    """Returns optional redis.asyncio client when settings.redis_url is configured, else None."""
    global _REDIS_TILE_CLIENT, _REDIS_UNAVAILABLE_UNTIL
    now = time.time()
    if now < _REDIS_UNAVAILABLE_UNTIL:
        return None
    redis_url = getattr(settings, "redis_url", "") or ""
    if not redis_url:
        return None
    if _REDIS_TILE_CLIENT is not None:
        return _REDIS_TILE_CLIENT
    try:
        import redis.asyncio as aioredis  # type: ignore[import-not-found]
        _REDIS_TILE_CLIENT = aioredis.from_url(
            redis_url,
            socket_connect_timeout=0.5,
            socket_timeout=0.5,
            decode_responses=False,
        )
        return _REDIS_TILE_CLIENT
    except Exception:
        _REDIS_UNAVAILABLE_UNTIL = now + 30.0
        return None


async def _redis_tile_get(cache_key: str) -> Optional[tuple[bytes, str]]:
    global _REDIS_TILE_CLIENT, _REDIS_UNAVAILABLE_UNTIL
    client = await _get_redis_tile_client()
    if client is None:
        return None
    try:
        raw = await client.get(cache_key)
        if not raw or b"\n" not in raw:
            return None
        header, blob = raw.split(b"\n", 1)
        return blob, header.decode("ascii", errors="ignore") or "image/png"
    except Exception:
        _REDIS_TILE_CLIENT = None
        _REDIS_UNAVAILABLE_UNTIL = time.time() + 30.0
        return None


async def _redis_tile_set(cache_key: str, blob: bytes, media_type: str, ttl: int = 3600) -> None:
    global _REDIS_TILE_CLIENT, _REDIS_UNAVAILABLE_UNTIL
    client = await _get_redis_tile_client()
    if client is None:
        return
    try:
        payload = media_type.encode("ascii", errors="ignore") + b"\n" + blob
        await client.set(cache_key, payload, ex=ttl)
    except Exception:
        _REDIS_TILE_CLIENT = None
        _REDIS_UNAVAILABLE_UNTIL = time.time() + 30.0


def _get_mbtiles_conn(path: str) -> Optional[sqlite3.Connection]:
    """Returns thread-local read-only SQLite connection validated by (st_ino, st_mtime_ns)."""
    try:
        st = os.stat(path)
    except OSError:
        return None
    file_sig = (st.st_ino, st.st_mtime_ns)
    if not hasattr(_SQLITE_LOCAL, "conns"):
        _SQLITE_LOCAL.conns = {}
    cached = _SQLITE_LOCAL.conns.get(path)
    if cached is not None:
        cached_sig, cached_conn = cached
        if cached_sig == file_sig:
            return cached_conn
        try:
            cached_conn.close()
        except Exception:
            pass
        _SQLITE_LOCAL.conns.pop(path, None)
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except Exception:
        conn = sqlite3.connect(path)
    try:
        conn.execute("PRAGMA mmap_size = 268435456;")
        conn.execute("PRAGMA cache_size = -64000;")
        conn.execute("PRAGMA query_only = 1;")
        conn.execute("PRAGMA read_uncommitted = 1;")
    except Exception:
        pass
    _SQLITE_LOCAL.conns[path] = (file_sig, conn)
    return conn


_STATE_SAVE_LOCK = threading.Lock()
_STATE_SAVE_WAKE = threading.Event()
_STATE_SAVE_THREAD_LOCK = threading.Lock()
_STATE_SAVE_THREAD: Optional[threading.Thread] = None


def _canonical_features_by_layer() -> Dict[str, Any]:
    """Only save lightweight layers (<= 500 features) directly in kmc_state_store.json.
    Large enterprise layers (> 500 features) stay in dedicated layer files to prevent state bloat and memory pressure."""
    source = STATE.get("features_by_layer", {}) or {}
    canonical: Dict[str, Any] = {}
    uploads_layers_dir = os.path.join(get_uploads_dir(), "layers")
    os.makedirs(uploads_layers_dir, exist_ok=True)

    seen_keys = set()
    for key, value in source.items():
        k_str = str(key)
        if k_str in seen_keys:
            continue
        seen_keys.add(k_str)

        if isinstance(value, list) and len(value) > 500:
            # Check if standalone file exists; if not, persist once to dedicated layer file
            layer_file = os.path.join(uploads_layers_dir, f"{k_str}_features.json")
            if not os.path.exists(layer_file):
                try:
                    tmp_lf = f"{layer_file}.{os.getpid()}.tmp"
                    with open(tmp_lf, "w", encoding="utf-8") as f:
                        json.dump(value, f)
                    os.replace(tmp_lf, layer_file)
                except Exception as lf_err:
                    print(f"[KMC-BACKEND] Notice writing dedicated layer file {layer_file}: {lf_err}")
            # Keep out of kmc_state_store.json so state store remains ultra-compact (<100KB)
            continue

        canonical[k_str] = value
    return canonical


def _build_state_payload() -> dict:
    return {
        "vector_layers": list(STATE.get("vector_layers", [])),
        "features_by_layer": _canonical_features_by_layer(),
        "raster_layers": list(STATE.get("raster_layers", [])),
        "projects": list(STATE.get("projects", [])),
        "tasks_by_project": {str(k): v for k, v in (STATE.get("tasks_by_project") or {}).items()},
        "project_assignments": {
            str(k): v for k, v in (STATE.get("project_assignments") or {}).items()
        },
        "project_collectors": {
            str(k): v for k, v in (STATE.get("project_collectors") or {}).items()
        },
        "questionnaires": list(STATE.get("questionnaires", [])),
        "records": list(STATE.get("records", [])),
        "feature_links": list(STATE.get("feature_links", [])),
        "audit_edits_by_layer": {str(k): v for k, v in (STATE.get("audit_edits_by_layer") or {}).items()},
        "collectors": list(STATE.get("collectors", [])),
        "tracking_history": list(STATE.get("tracking_history", []))[-20000:],
        "tracking_events": list(STATE.get("tracking_events", []))[-5000:],
        "purged_assets": list(STATE.get("purged_assets", [])),
        "house_numbers": list(STATE.get("house_numbers", [])),
        "users": list(STATE.get("users", [])),
        "departments": list(STATE.get("departments", [])),
        "platform_settings": dict(STATE.get("platform_settings") or {}),
        "updated_at": time.time(),
    }


def _save_persistent_state_worker(payload: dict) -> None:
    with _STATE_SAVE_LOCK:
        save_dirs = [get_tileserver_dir(), get_uploads_dir()]
        for sdir in save_dirs:
            try:
                os.makedirs(sdir, exist_ok=True)
                store_file = os.path.join(sdir, "kmc_state_store.json")
                _atomic_write_json_locked(store_file, payload)
                try:
                    global _LAST_STATE_MTIME
                    _LAST_STATE_MTIME = os.path.getmtime(store_file)
                except Exception:
                    pass
                break
            except Exception as e:
                print(f"[STATE-SAVE] Notice saving state to {sdir}: {e}")


def _save_persistent_state_loop() -> None:
    # Coalesce bursts of saves: one in-flight write plus at most one follow-up.
    while True:
        _STATE_SAVE_WAKE.wait()
        _STATE_SAVE_WAKE.clear()
        try:
            payload = _build_state_payload()
        except Exception as e:
            print(f"[STATE-SAVE] Could not build payload: {e}")
            continue
        _save_persistent_state_worker(payload)


def _save_persistent_state(sync: bool = False) -> None:
    """Safely saves STATE to disk in background so event loop is never blocked (or synchronously when sync=True)."""
    if os.environ.get("KMC_DISABLE_STATE_PERSISTENCE") == "1":
        # Test isolation: never let an in-memory test state overwrite live data.
        return
    if sync:
        try:
            payload = _build_state_payload()
            _save_persistent_state_worker(payload)
            return
        except Exception as e:
            print(f"[STATE-SAVE] Direct sync save notice: {e}")
    global _STATE_SAVE_THREAD
    with _STATE_SAVE_THREAD_LOCK:
        if _STATE_SAVE_THREAD is None or not _STATE_SAVE_THREAD.is_alive():
            _STATE_SAVE_THREAD = threading.Thread(
                target=_save_persistent_state_loop, daemon=True, name="kmc-state-save"
            )
            _STATE_SAVE_THREAD.start()
    _STATE_SAVE_WAKE.set()


_UTM45N_A = 6378137.0
_UTM45N_F = 1 / 298.257223563
_UTM45N_B = _UTM45N_A * (1 - _UTM45N_F)
_UTM45N_E_SQ = 1 - (_UTM45N_B * _UTM45N_B) / (_UTM45N_A * _UTM45N_A)
_UTM45N_E = math.sqrt(_UTM45N_E_SQ)
_UTM45N_E_PRIME_SQ = _UTM45N_E_SQ / (1 - _UTM45N_E_SQ)
_UTM45N_K0 = 0.9996
_UTM45N_LON0 = math.radians(87.0)
_UTM45N_M_DENOM = _UTM45N_A * (1 - _UTM45N_E_SQ / 4 - 3 * (_UTM45N_E_SQ**2) / 64 - 5 * (_UTM45N_E_SQ**3) / 256)
_UTM45N_E1 = (1 - math.sqrt(1 - _UTM45N_E_SQ)) / (1 + math.sqrt(1 - _UTM45N_E_SQ))
_UTM45N_J1 = 3 * _UTM45N_E1 / 2 - 27 * (_UTM45N_E1**3) / 32
_UTM45N_J2 = 21 * (_UTM45N_E1**2) / 16 - 55 * (_UTM45N_E1**4) / 32
_UTM45N_J3 = 151 * (_UTM45N_E1**3) / 96
_UTM45N_J4 = 1097 * (_UTM45N_E1**4) / 512
_UTM45N_ONE_MINUS_E_SQ = 1 - _UTM45N_E_SQ


def utm45n_to_wgs84(easting: float, northing: float) -> tuple[float, float]:
    """Accurately converts UTM Zone 45N (EPSG:32645 / Nepal Survey Standard) to WGS84 (EPSG:4326)."""
    x = easting - 500000.0
    mu = (northing / _UTM45N_K0) / _UTM45N_M_DENOM
    fp = (mu + _UTM45N_J1 * math.sin(2 * mu) + _UTM45N_J2 * math.sin(4 * mu) +
          _UTM45N_J3 * math.sin(6 * mu) + _UTM45N_J4 * math.sin(8 * mu))

    sin_fp = math.sin(fp)
    cos_fp = math.cos(fp)
    tan_fp = math.tan(fp)

    c1 = _UTM45N_E_PRIME_SQ * (cos_fp * cos_fp)
    t1 = tan_fp * tan_fp
    denom = 1 - _UTM45N_E_SQ * sin_fp * sin_fp
    sqrt_denom = math.sqrt(denom)
    n1 = _UTM45N_A / sqrt_denom
    r1 = _UTM45N_A * _UTM45N_ONE_MINUS_E_SQ / (denom * sqrt_denom)
    d = x / (n1 * _UTM45N_K0)
    d2 = d * d
    d3 = d2 * d
    d4 = d2 * d2
    d5 = d4 * d
    d6 = d3 * d3

    lat = fp - (n1 * tan_fp / r1) * (
        d2 / 2 -
        (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * _UTM45N_E_PRIME_SQ) * d4 / 24 +
        (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * _UTM45N_E_PRIME_SQ - 3 * c1 * c1) * d6 / 720
    )
    lon = _UTM45N_LON0 + (
        d -
        (1 + 2 * t1 + c1) * d3 / 6 +
        (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * _UTM45N_E_PRIME_SQ + 24 * t1 * t1) * d5 / 120
    ) / cos_fp

    return round(math.degrees(lon), 7), round(math.degrees(lat), 7)


def _convert_coords_utm_to_wgs84(coords):
    if not coords:
        return coords
    if isinstance(coords[0], (int, float)):
        x, y = float(coords[0]), float(coords[1])
        if 100000 <= x <= 900000 and 2000000 <= y <= 4000000:
            return list(utm45n_to_wgs84(x, y))
        return coords
    return [_convert_coords_utm_to_wgs84(c) for c in coords]


def _convert_coords_utm_to_wgs84_inplace(coords, bounds: Optional[list] = None):
    """Mutates coordinate lists in-place from UTM45N to WGS84 and optionally tracks [min_x, min_y, max_x, max_y]."""
    if not coords:
        return
    if isinstance(coords[0], (int, float)):
        x, y = float(coords[0]), float(coords[1])
        if 100000 <= x <= 900000 and 2000000 <= y <= 4000000:
            w_lon, w_lat = utm45n_to_wgs84(x, y)
            coords[0] = w_lon
            coords[1] = w_lat
            x, y = w_lon, w_lat
        if bounds is not None:
            if x < bounds[0]: bounds[0] = x
            if x > bounds[2]: bounds[2] = x
            if y < bounds[1]: bounds[1] = y
            if y > bounds[3]: bounds[3] = y
        return
    for c in coords:
        _convert_coords_utm_to_wgs84_inplace(c, bounds)


def _clean_feature_properties_for_geojson(f: Any) -> Any:
    """Ensures properties.geometry is renamed so OpenLayers clients never have
    their parsed feature geometry overwritten by a property column named 'geometry'.
    """
    if not isinstance(f, dict):
        return f
    props = f.get("properties")
    if isinstance(props, dict) and "geometry" in props:
        props["geometry_prop"] = props.pop("geometry")
    return f


def _sanitize_features_for_client(features: list) -> list:
    """Ensures feature list is safe for OpenLayers GeoJSON parsing."""
    if isinstance(features, list):
        for f in features:
            _clean_feature_properties_for_geojson(f)
    return features


def _load_persistent_state() -> None:
    """Restores saved state from disk on startup."""
    if os.environ.get("KMC_DISABLE_STATE_PERSISTENCE") == "1":
        return
    check_paths = [
        os.path.join(get_tileserver_dir(), "kmc_state_store.json"),
        os.path.join(get_uploads_dir(), "kmc_state_store.json"),
    ]
    for p in check_paths:
        if os.path.exists(p):
            data = None
            for _ in range(5):
                try:
                    with open(p, "r", encoding="utf-8") as f:
                        data = json.load(f)
                    break
                except Exception:
                    time.sleep(0.02)
            if isinstance(data, dict):
                try:
                    if "vector_layers" in data and isinstance(data["vector_layers"], list):
                        STATE["vector_layers"] = data["vector_layers"]
                        known_titles = {
                            "10101": "KMC Municipal Buildings (भवन संरचना तह)",
                            "10102": "KMC Road Network (सडक सञ्जाल)",
                            "10103": "KMC Building Gates & Entrances (प्रवेशद्वार तह)",
                            "10104": "KMC Field Survey Layer (क्षेत्रीय सर्वेक्षण तह)",
                        }
                        for vl in STATE["vector_layers"]:
                            vl_id = str(vl.get("id"))
                            if vl_id in known_titles:
                                vl["name"] = known_titles[vl_id]
                            if vl_id == "1795243402839" or vl.get("name") == "UnetRaw":
                                vl["feature_count"] = get_layer_feature_count(vl_id) or 168458
                                vl["geometry_type"] = "Polygon"
                                vl["published"] = True
                                vl["bounds"] = [85.28, 27.68, 85.35, 27.74]
                            elif vl.get("feature_count") in (0, None):
                                c = get_layer_feature_count(vl_id)
                                if c > 0:
                                    vl["feature_count"] = c
                    if "features_by_layer" in data and isinstance(data["features_by_layer"], dict):
                        f_by_l = {}
                        for k, v in data["features_by_layer"].items():
                            cleaned_feats = _sanitize_features_for_client(v) if isinstance(v, list) else v
                            f_by_l[str(k)] = cleaned_feats
                            if str(k).isdigit():
                                f_by_l[int(k)] = cleaned_feats
                        STATE["features_by_layer"] = f_by_l
                    if "tasks_by_project" in data and isinstance(data["tasks_by_project"], dict):
                        tb_p = {}
                        for k, v in data["tasks_by_project"].items():
                            tb_p[str(k)] = v
                            if str(k).isdigit():
                                tb_p[int(k)] = v
                        STATE["tasks_by_project"] = tb_p
                    if "raster_layers" in data and isinstance(data["raster_layers"], list):
                        STATE["raster_layers"] = data["raster_layers"]
                        for rl in STATE["raster_layers"]:
                            if "Whole_KMC" in str(rl.get("filename") or "") or str(rl.get("id")) == "1795243408729":
                                rl["published"] = True
                                rl["public_visible"] = True
                                rl["access_level"] = "public"
                                rl["minzoom"] = 11
                                rl["maxzoom"] = 22
                                rl["bounds"] = [85.2655786576351, 27.673476558662614, 85.36799880886878, 27.7513985654062]
                    if "projects" in data and isinstance(data["projects"], list):
                        STATE["projects"] = data["projects"]
                    if "project_assignments" in data and isinstance(data["project_assignments"], dict):
                        STATE["project_assignments"] = {
                            int(k) if str(k).isdigit() else k: v
                            for k, v in data["project_assignments"].items()
                        }
                    if "project_collectors" in data and isinstance(data["project_collectors"], dict):
                        STATE["project_collectors"] = {
                            int(k) if str(k).isdigit() else k: v
                            for k, v in data["project_collectors"].items()
                        }
                    if "questionnaires" in data and isinstance(data["questionnaires"], list):
                        STATE["questionnaires"] = data["questionnaires"]
                        _normalise_all_questionnaires()
                    if "records" in data and isinstance(data["records"], list):
                        STATE["records"] = data["records"]
                    if "feature_links" in data and isinstance(data["feature_links"], list):
                        STATE["feature_links"] = data["feature_links"]
                    if "audit_edits_by_layer" in data and isinstance(data["audit_edits_by_layer"], dict):
                        STATE["audit_edits_by_layer"] = {
                            str(k): v for k, v in data["audit_edits_by_layer"].items()
                        }
                    if "collectors" in data and isinstance(data["collectors"], list):
                        STATE["collectors"] = data["collectors"]
                    if "tracking_history" in data and isinstance(data["tracking_history"], list):
                        STATE["tracking_history"] = data["tracking_history"]
                    if "tracking_events" in data and isinstance(data["tracking_events"], list):
                        STATE["tracking_events"] = data["tracking_events"]
                    if "purged_assets" in data and isinstance(data["purged_assets"], list):
                        STATE["purged_assets"] = data["purged_assets"]
                    if "house_numbers" in data and isinstance(data["house_numbers"], list):
                        STATE["house_numbers"] = data["house_numbers"]
                    if "users" in data and isinstance(data["users"], list) and len(data["users"]) > 0:
                        STATE["users"] = data["users"]
                    if "departments" in data and isinstance(data["departments"], list):
                        STATE["departments"] = data["departments"]
                    if "platform_settings" in data and isinstance(data["platform_settings"], dict):
                        settings_state = dict(STATE.get("platform_settings") or {})
                        settings_state.update(data["platform_settings"])
                        STATE["platform_settings"] = settings_state
                    # task_count must reflect the tasks actually restored, not a stale
                    # number written by an older build that never persisted grids.
                    tasks_by_project = STATE.get("tasks_by_project", {}) or {}
                    for project in STATE.get("projects", []):
                        pid = project.get("id")
                        restored = tasks_by_project.get(pid)
                        if restored is None:
                            restored = tasks_by_project.get(str(pid), [])
                        project["task_count"] = len(restored or [])
                    print(f"[STATE-LOAD] Restored state from {p}: {len(STATE['raster_layers'])} rasters, {len(STATE['vector_layers'])} vectors, {len(STATE['projects'])} projects, {sum(len(v or []) for v in tasks_by_project.values())} tasks.")
                    return
                except Exception as e:
                    print(f"[STATE-LOAD] Notice updating in-memory state: {e}")


_LAST_STATE_MTIME = time.time()
_LAST_RELOAD_CHECK_TIME = 0.0


def _reload_state_if_modified(force: bool = False) -> None:
    """Reloads persistent state from disk if any other worker modified kmc_state_store.json."""
    if os.environ.get("KMC_DISABLE_STATE_PERSISTENCE") == "1":
        return
    global _LAST_STATE_MTIME
    check_paths = [
        os.path.join(get_tileserver_dir(), "kmc_state_store.json"),
        os.path.join(get_uploads_dir(), "kmc_state_store.json"),
    ]
    for p in check_paths:
        if os.path.exists(p):
            try:
                mtime = os.path.getmtime(p)
                if force or mtime != _LAST_STATE_MTIME:
                    _load_persistent_state()
                    _LAST_STATE_MTIME = mtime
                    break
            except Exception:
                pass


def _scan_and_sync_tileserver_mbtiles() -> None:
    """Scans tileserver directory for *.mbtiles files, reading SQLite metadata and registering raster layers."""
    tileserver_dir = get_tileserver_dir()
    if not os.path.exists(tileserver_dir):
        return

    cfg_path = os.path.join(tileserver_dir, "config.json")
    cfg = {"options": {"paths": {"root": "/data", "mbtiles": "/data"}}, "styles": {}, "data": {}}
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                loaded_cfg = json.load(f)
                if isinstance(loaded_cfg, dict):
                    cfg = loaded_cfg
                    if "data" not in cfg:
                        cfg["data"] = {}
        except Exception:
            pass

    # Always materialise a valid empty config first: tileserver-gl downloads a
    # Zurich demo dataset when it boots without /data/config.json.
    cfg_updated = not os.path.exists(cfg_path)
    purged = _purged_asset_names()
    for entry in sorted(os.listdir(tileserver_dir)):
        if not entry.lower().endswith(".mbtiles"):
            continue
        if entry in purged:
            continue
        stem = re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(entry)[0]).lower()
        full_path = os.path.join(tileserver_dir, entry)

        if stem not in cfg.get("data", {}):
            cfg.setdefault("data", {})[stem] = {"mbtiles": entry}
            cfg_updated = True

        parsed_bounds = [85.31, 27.68, 85.35, 27.70]
        min_zoom = 10
        max_zoom = 22
        tile_format = "webp"
        name = entry.replace(".mbtiles", "").replace("_", " ")

        try:
            with sqlite3.connect(f"file:{full_path}?mode=ro", uri=True) as conn:
                cur = conn.cursor()
                cur.execute("SELECT name, value FROM metadata")
                m = dict(cur.fetchall())
                if "bounds" in m:
                    b_parts = [float(x.strip()) for x in m["bounds"].split(",")]
                    if len(b_parts) == 4:
                        parsed_bounds = b_parts
                if "minzoom" in m:
                    min_zoom = int(m["minzoom"])
                if "maxzoom" in m:
                    max_zoom = int(m["maxzoom"])
                if "format" in m:
                    tile_format = m["format"]
                if "name" in m and m["name"]:
                    name = m["name"]
        except Exception as e:
            print(f"[MBTILES-SCAN] Notice for {entry}: {e}")

        already_present = any(
            r.get("filename") == entry or
            re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(r.get("filename", ""))[0]).lower() == stem
            for r in STATE.get("raster_layers", [])
        )

        tile_url = f"/api/tiles/data/{stem}/{{z}}/{{x}}/{{y}}.{tile_format}"
        if not already_present:
            new_tile = {
                "id": int(time.time() * 1000) + hash(entry) % 10000,
                "name": name,
                "filename": entry,
                "type": "raster",
                "category": "ड्रोन तथा अर्थोफोटो (UAV Imagery)",
                "is_global": True,
                "project_id": None,
                "file_size": os.path.getsize(full_path) if os.path.exists(full_path) else 0,
                "min_zoom": min_zoom,
                "max_zoom": max_zoom,
                "access_level": "public",
                "bounds": parsed_bounds,
                "bbox": parsed_bounds,
                "image_data_url": None,
                "tile_url": tile_url,
                "created_at": time.time(),
            }
            STATE["raster_layers"].append(new_tile)
            print(f"[MBTILES-SCAN] Auto-registered raster layer: {entry} ({name}) with bounds {parsed_bounds}")
        else:
            for r in STATE["raster_layers"]:
                if r.get("filename") == entry or re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(r.get("filename", ""))[0]).lower() == stem:
                    if not r.get("bounds") or r.get("bounds") == [85.31, 27.68, 85.35, 27.70]:
                        r["bounds"] = parsed_bounds
                        r["bbox"] = parsed_bounds
                    r["min_zoom"] = min_zoom
                    r["max_zoom"] = max_zoom
                    r["tile_url"] = tile_url
                    break

    if cfg_updated:
        try:
            _update_tileserver_config_locked(
                tileserver_dir,
                lambda existing: existing.setdefault("data", {}).update(cfg.get("data") or {}),
            )
        except Exception:
            pass

    _save_persistent_state()


def _scan_and_sync_uploads_geojson() -> None:
    """Scans uploads/layers directory for *.geojson files, auto-discovering, registering, or restoring vector layers."""
    layers_dir = os.path.join(get_uploads_dir(), "layers")
    if not os.path.exists(layers_dir):
        return

    vector_layers = STATE.setdefault("vector_layers", [])
    features_by_layer = STATE.setdefault("features_by_layer", {})
    state_changed = False
    purged = _purged_asset_names()

    for entry in sorted(os.listdir(layers_dir)):
        if not entry.lower().endswith(".geojson"):
            continue
        if entry in purged:
            continue
        full_path = os.path.join(layers_dir, entry)
        stem = os.path.splitext(entry)[0]
        readable_name = entry.replace(".geojson", "").replace("_", " ")

        # Match by filename or stem or exact name
        matched_layer = None
        for l in vector_layers:
            l_name = l.get("name", "")
            l_fn = l.get("filename", "")
            if l_fn == entry or l_name == readable_name or l_name.lower() == stem.lower() or l_name == entry:
                matched_layer = l
                break

        # If already registered in vector_layers metadata, attach filename and continue without re-reading huge file
        if matched_layer:
            if not matched_layer.get("filename"):
                matched_layer["filename"] = entry
                state_changed = True
            continue

        file_size = os.path.getsize(full_path)
        if file_size > 10 * 1024 * 1024:
            # Large enterprise layer (>10MB): register layer metadata without blocking startup
            # Features will be lazy-loaded on demand via get_layer_features_list()
            new_layer_id = int(time.time() * 1000) + (hash(entry) % 10000)
            new_l = {
                "id": new_layer_id,
                "name": readable_name,
                "filename": entry,
                "description": f"Auto-discovered {entry}",
                "type": "vector",
                "geometry_type": "Polygon",
                "creation_geometry_types": ["Polygon"],
                "category": "भू-स्थानिक तहहरू (Spatial Layers)",
                "is_global": True,
                "project_id": None,
                "allow_snapping": True,
                "editable_by_collectors": False,
                "published": True,
                "default_visible": False,
                "access_level": "public",
                "opacity": 1,
                "feature_count": 10000,
                "bbox_mode": True,
                "is_mvt": True,
                "tile_url": f"/api/tiles/vector/{new_layer_id}/{{z}}/{{x}}/{{y}}.pbf",
                "bounds": [85.266636, 27.674711, 85.367083, 27.750876],
                "bbox": [85.266636, 27.674711, 85.367083, 27.750876],
                "style": {"strokeColor": "#10b981", "fillColor": "#10b981", "strokeWidth": 2.5, "clickTolerance": 14},
                "fields_config": [],
                "created_at": time.time(),
            }
            vector_layers.append(new_l)
            state_changed = True
            print(f"[GEOJSON-SCAN] Fast-registered large layer: {entry} ({readable_name})")
            continue

        try:
            print(f"[GEOJSON-SCAN] Reading vector file: {entry}...")
            with open(full_path, "r", encoding="utf-8", errors="replace") as f:
                parsed_json = json.load(f)

            raw_feats = []
            if isinstance(parsed_json, dict) and "features" in parsed_json and isinstance(parsed_json["features"], list):
                raw_feats = parsed_json["features"]
            elif isinstance(parsed_json, list):
                raw_feats = parsed_json
            elif isinstance(parsed_json, dict) and parsed_json.get("type") == "Feature":
                raw_feats = [parsed_json]

            imported_features = []
            geom_type = "Polygon"
            min_x, min_y, max_x, max_y = float("inf"), float("inf"), float("-inf"), float("-inf")

            def scan_coords(coords):
                nonlocal min_x, min_y, max_x, max_y
                if not coords or not isinstance(coords, (list, tuple)):
                    return
                if len(coords) >= 2 and isinstance(coords[0], (int, float)) and isinstance(coords[1], (int, float)):
                    x, y = float(coords[0]), float(coords[1])
                    if not (math.isnan(x) or math.isnan(y)):
                        if x < min_x: min_x = x
                        if x > max_x: max_x = x
                        if y < min_y: min_y = y
                        if y > max_y: max_y = y
                else:
                    for sub in coords:
                        scan_coords(sub)

            for idx, feat in enumerate(raw_feats):
                if not isinstance(feat, dict):
                    continue
                feat_id = feat.get("id") or (idx + 1)
                feat["id"] = feat_id
                if "type" not in feat:
                    feat["type"] = "Feature"
                geom = feat.get("geometry") or {}
                if geom and "coordinates" in geom:
                    scan_coords(geom["coordinates"])
                if idx == 0 and geom.get("type"):
                    geom_type = geom["type"]
                props = feat.get("properties")
                if not isinstance(props, dict):
                    props = {}
                    feat["properties"] = props
                if "geometry" in props:
                    props["geometry_prop"] = props.pop("geometry")
                props["_id"] = feat_id
                props["_created_by"] = 1
                props["_created_by_username"] = settings.admin_username

            imported_features = raw_feats

            if min_x != float("inf") and min_y != float("inf") and max_x != float("-inf") and max_y != float("-inf"):
                if min_x >= 100000 and max_x <= 900000 and min_y >= 2000000 and max_y <= 4000000:
                    new_bounds = [float("inf"), float("inf"), float("-inf"), float("-inf")]
                    for feat in imported_features:
                        g = feat.get("geometry")
                        if g and "coordinates" in g:
                            _convert_coords_utm_to_wgs84_inplace(g["coordinates"], new_bounds)
                    calculated_bbox = [round(new_bounds[0], 6), round(new_bounds[1], 6), round(new_bounds[2], 6), round(new_bounds[3], 6)]
                else:
                    calculated_bbox = [min_x, min_y, max_x, max_y]
            else:
                calculated_bbox = [85.31, 27.682, 85.345, 27.702]

            detected_fields = {}
            for f in imported_features[:300]:
                props = f.get("properties") or {}
                for k, v in props.items():
                    if k in ("geometry", "geom", "the_geom"):
                        continue
                    if k not in detected_fields:
                        ftype = "text"
                        if isinstance(v, bool):
                            ftype = "checkbox"
                        elif isinstance(v, (int, float)):
                            ftype = "number"
                        detected_fields[k] = {
                            "name": k,
                            "label": k.replace("_", " ").title(),
                            "type": ftype,
                            "required": False,
                            "is_unique": False,
                            "visible_in_popup": True,
                        }

            if matched_layer:
                features_by_layer[matched_layer["id"]] = imported_features
                matched_layer["feature_count"] = len(imported_features)
                matched_layer["filename"] = entry
                state_changed = True
                print(f"[GEOJSON-SCAN] Restored {len(imported_features)} features for layer: {matched_layer['name']}")
            else:
                new_layer_id = int(time.time() * 1000) + (hash(entry) % 10000)
                new_l = {
                    "id": new_layer_id,
                    "name": readable_name,
                    "filename": entry,
                    "description": f"Auto-discovered {entry}",
                    "type": "vector",
                    "geometry_type": geom_type,
                    "creation_geometry_types": [geom_type],
                    "category": "भू-स्थानिक तहहरू (Spatial Layers)",
                    "is_global": True,
                    "project_id": None,
                    "allow_snapping": True,
                    "editable_by_collectors": False,
                    "published": True,
                    "default_visible": True,
                    "access_level": "public",
                    "opacity": 1,
                    "feature_count": len(imported_features),
                    "bounds": calculated_bbox,
                    "bbox": calculated_bbox,
                    "style": {"strokeColor": "#10b981", "fillColor": "#10b981", "strokeWidth": 2.5, "clickTolerance": 14},
                    "fields_config": list(detected_fields.values()),
                    "created_at": time.time(),
                }
                vector_layers.append(new_l)
                features_by_layer[new_layer_id] = imported_features
                if len(imported_features) > 500:
                    lfile = os.path.join(layers_dir, f"{new_layer_id}_features.json")
                    if not os.path.exists(lfile):
                        try:
                            with open(f"{lfile}.tmp", "w", encoding="utf-8") as lf_out:
                                json.dump(imported_features, lf_out)
                            os.replace(f"{lfile}.tmp", lfile)
                        except Exception:
                            pass
                state_changed = True
                print(f"[GEOJSON-SCAN] Auto-registered vector layer: {entry} ({readable_name}) with {len(imported_features)} features.")
        except Exception as scan_err:
            print(f"[GEOJSON-SCAN] Error scanning {entry}: {scan_err}")

    if state_changed:
        _save_persistent_state()


def _coords_intersect_bbox(coords: Any, min_x: float, min_y: float, max_x: float, max_y: float) -> bool:
    """Fast check whether any coordinate pair in geometry intersects the bounding box."""
    if not coords or not isinstance(coords, (list, tuple)):
        return False
    if len(coords) >= 2 and isinstance(coords[0], (int, float)) and isinstance(coords[1], (int, float)):
        x, y = float(coords[0]), float(coords[1])
        return min_x <= x <= max_x and min_y <= y <= max_y
    for sub in coords:
        if _coords_intersect_bbox(sub, min_x, min_y, max_x, max_y):
            return True
    return False


# ---- 1. Resumable Upload Pipeline (Init -> Chunk -> Complete / Status / Abort) ----

UPLOAD_ID_PATTERN = re.compile(r"^upl_[0-9]{6,20}(?:_[0-9a-f]{6,16})?$")
RASTER_UPLOAD_EXTENSIONS = {".mbtiles"}
VECTOR_UPLOAD_EXTENSIONS = {".geojson", ".json", ".zip", ".gpkg"}


def _max_upload_bytes() -> int:
    return settings.max_upload_size_mb * 1024 * 1024


def _sanitize_upload_filename(raw_name: Any, allowed_extensions: set) -> str:
    """Reduces a client-supplied name to a safe basename with an allowed extension."""
    name = os.path.basename(str(raw_name or "").replace("\\", "/")).strip()
    name = re.sub(r"[^A-Za-z0-9._-]", "_", name).strip("._")
    if not name:
        raise HTTPException(status_code=400, detail="A valid filename is required.")
    extension = os.path.splitext(name)[1].lower()
    if extension not in allowed_extensions:
        allowed = ", ".join(sorted(allowed_extensions))
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{extension or 'none'}'. Allowed: {allowed}.",
        )
    return name


def _stream_to_file_with_limit(source, destination, limit_bytes: int) -> int:
    written = 0
    while True:
        buffer = source.read(1024 * 1024)
        if not buffer:
            return written
        written += len(buffer)
        if written > limit_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Upload exceeds the {settings.max_upload_size_mb} MB limit.",
            )
        destination.write(buffer)


PENDING_UPLOAD_TTL_SECONDS = 86400
PENDING_UPLOAD_MAX_SESSIONS = 100
_UPLOAD_FILE_LOCK = threading.Lock()


def _upload_session_dir(upload_id: str) -> str:
    return os.path.join(get_tileserver_dir(), "temp", upload_id)


def _load_upload_session(upload_id: str) -> Optional[dict]:
    """Cross-worker resilient session loader. Checks in-memory cache and shared temp disk."""
    entry = STATE["pending_uploads"].get(upload_id)
    temp_dir = _upload_session_dir(upload_id)
    session_file = os.path.join(temp_dir, "session.json")
    chunks_dir = os.path.join(temp_dir, "chunks")

    if not entry and os.path.exists(session_file):
        try:
            with open(session_file, "r", encoding="utf-8") as f:
                entry = json.load(f)
            entry["chunks_received"] = set()
            STATE["pending_uploads"][upload_id] = entry
        except Exception as e:
            print(f"[KMC-BACKEND] Failed reading session.json for {upload_id}: {e}")
            return None

    if entry and os.path.exists(chunks_dir):
        try:
            entry["chunks_received"] = {
                int(p.split(".")[0])
                for p in os.listdir(chunks_dir)
                if p.endswith(".done") and p.split(".")[0].isdigit()
            }
        except Exception:
            pass

    return entry


def _save_upload_session(upload_id: str, entry: dict) -> None:
    temp_dir = entry.get("temp_dir") or _upload_session_dir(upload_id)
    os.makedirs(temp_dir, exist_ok=True)
    session_file = os.path.join(temp_dir, "session.json")
    try:
        data_to_save = {
            k: (list(v) if isinstance(v, (set, tuple)) else v)
            for k, v in entry.items()
            if k != "chunks_received"
        }
        data_to_save["chunks_count"] = len(entry.get("chunks_received", set()))
        tmp_session = f"{session_file}.{os.getpid()}.{time.time_ns()}.tmp"
        with open(tmp_session, "w", encoding="utf-8") as f:
            json.dump(data_to_save, f)
        os.replace(tmp_session, session_file)
    except Exception as e:
        print(f"[KMC-BACKEND] Failed writing session.json for {upload_id}: {e}")


def _prune_pending_uploads() -> None:
    """Expires abandoned resumable-upload sessions so temp dirs and memory stay bounded."""
    now = time.time()
    for upload_id, entry in list(STATE["pending_uploads"].items()):
        created_at = float(entry.get("created_at") or 0)
        if created_at and now - created_at > PENDING_UPLOAD_TTL_SECONDS:
            STATE["pending_uploads"].pop(upload_id, None)
            shutil.rmtree(entry.get("temp_dir") or "", ignore_errors=True)

    temp_base = os.path.join(get_tileserver_dir(), "temp")
    if os.path.exists(temp_base):
        try:
            for entry_name in os.listdir(temp_base):
                p = os.path.join(temp_base, entry_name)
                if os.path.isdir(p) and entry_name.startswith("upl_"):
                    try:
                        mtime = os.path.getmtime(p)
                        if now - mtime > PENDING_UPLOAD_TTL_SECONDS:
                            shutil.rmtree(p, ignore_errors=True)
                    except Exception:
                        pass
        except Exception:
            pass


@app.post("/api/uploads/init")
async def uploads_init(payload: Dict[str, Any], request: Request):
    _require_admin_user(request)
    _prune_pending_uploads()
    if len(STATE["pending_uploads"]) >= PENDING_UPLOAD_MAX_SESSIONS:
        raise HTTPException(status_code=429, detail="Too many active upload sessions; finish or abort one first.")
    try:
        total_size = int(payload.get("total_size") or 0)
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="`total_size` must be an integer.")
    if total_size <= 0:
        raise HTTPException(status_code=400, detail="`total_size` must be positive.")
    if total_size > _max_upload_bytes():
        raise HTTPException(
            status_code=413,
            detail=f"Upload exceeds the {settings.max_upload_size_mb} MB limit.",
        )

    upload_id = f"upl_{int(time.time() * 1000)}_{secrets.token_hex(6)}"
    # 32 MB chunk by default; for massive archives (> 64 GB), scale chunk size to 64 MB
    chunk_size = 67108864 if total_size > 64 * 1024 * 1024 * 1024 else 33554432
    total_chunks = max(1, math.ceil(total_size / chunk_size))

    temp_dir = _upload_session_dir(upload_id)
    os.makedirs(os.path.join(temp_dir, "chunks"), exist_ok=True)

    kind = str(payload.get("kind") or "vector")
    allowed_exts = RASTER_UPLOAD_EXTENSIONS if kind == "raster" else VECTOR_UPLOAD_EXTENSIONS
    filename = _sanitize_upload_filename(
        payload.get("filename") or f"uploaded_{int(time.time())}",
        allowed_exts,
    )

    # Pre-create target file once so parallel pwrite chunks never race on O_TRUNC/w+b
    target_file = os.path.join(temp_dir, filename)
    fd = os.open(target_file, os.O_CREAT | os.O_WRONLY, 0o644)
    os.close(fd)

    session_entry = {
        "upload_id": upload_id,
        "meta": payload,
        "filename": filename,
        "kind": kind,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "total_size": total_size,
        "temp_dir": temp_dir,
        "chunks_received": set(),
        "created_at": time.time(),
        "status": "uploading",
        "phase": "uploading",
    }
    STATE["pending_uploads"][upload_id] = session_entry
    _save_upload_session(upload_id, session_entry)

    return {
        "upload_id": upload_id,
        "chunk_size": chunk_size,
        "total_chunks": total_chunks,
        "filename": filename,
    }


@app.post("/api/uploads/{upload_id}/chunk")
async def uploads_chunk(
    upload_id: str,
    request: Request,
    index: Optional[int] = Query(None),
):
    _require_admin_user(request)
    if not UPLOAD_ID_PATTERN.match(upload_id):
        raise HTTPException(status_code=404, detail="Upload session not found or expired")
    entry = _load_upload_session(upload_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Upload session not found or expired")

    chunk_index = index
    if chunk_index is None:
        idx_header = request.headers.get("X-Chunk-Index")
        try:
            chunk_index = int(idx_header) if idx_header is not None else len(entry["chunks_received"])
        except ValueError:
            raise HTTPException(status_code=400, detail="X-Chunk-Index must be an integer.")
    if not 0 <= chunk_index < entry["total_chunks"]:
        raise HTTPException(status_code=400, detail="Chunk index is out of range.")

    target_file = os.path.join(entry["temp_dir"], entry["filename"])
    chunks_dir = os.path.join(entry["temp_dir"], "chunks")
    os.makedirs(chunks_dir, exist_ok=True)
    chunk_file = os.path.join(chunks_dir, f"{chunk_index}.chunk")
    marker_file = os.path.join(chunks_dir, f"{chunk_index}.done")

    # If already fully received, return immediately (idempotent retry)
    if os.path.exists(marker_file) and (os.path.exists(chunk_file) or os.path.exists(target_file)):
        entry["chunks_received"].add(chunk_index)
        return {"status": "chunk_received", "index": chunk_index, "received_bytes": entry.get("chunk_size", 0)}

    tmp_chunk = f"{chunk_file}.{os.getpid()}.{time.time_ns()}.tmp"
    received = 0
    with open(tmp_chunk, "wb") as f:
        async for chunk in request.stream():
            if not chunk:
                continue
            if received + len(chunk) > entry["chunk_size"]:
                try:
                    os.remove(tmp_chunk)
                except OSError:
                    pass
                raise HTTPException(status_code=413, detail="Chunk exceeds the negotiated chunk size.")
            f.write(chunk)
            received += len(chunk)

    if received == 0:
        try:
            os.remove(tmp_chunk)
        except OSError:
            pass
        raise HTTPException(status_code=400, detail="Empty chunks are not accepted.")

    os.replace(tmp_chunk, chunk_file)
    with open(marker_file, "w") as mf:
        mf.write(str(received))

    entry["chunks_received"].add(chunk_index)
    return {"status": "chunk_received", "index": chunk_index, "received_bytes": received}


@app.get("/api/uploads/{upload_id}")
async def uploads_status(upload_id: str, request: Request):
    _require_admin_user(request)
    if not UPLOAD_ID_PATTERN.match(upload_id):
        raise HTTPException(status_code=404, detail="Upload session not found")
    entry = _load_upload_session(upload_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Upload session not found")

    chunks_dir = os.path.join(entry["temp_dir"], "chunks")
    done_indices = set()
    if os.path.exists(chunks_dir):
        try:
            done_indices = {
                int(p.split(".")[0])
                for p in os.listdir(chunks_dir)
                if p.endswith(".done") and p.split(".")[0].isdigit()
            }
        except Exception:
            pass

    total_chunks = entry["total_chunks"]
    next_idx = 0
    while next_idx in done_indices and next_idx < total_chunks:
        next_idx += 1

    progress_percent = round((len(done_indices) / max(1, total_chunks)) * 100, 1)

    return {
        "status": entry.get("status", "uploading"),
        "phase": entry.get("phase", "uploading"),
        "phase_message": entry.get("phase_message", ""),
        "phase_progress": entry.get("phase_progress", 0),
        "error": entry.get("error"),
        "next_index": next_idx,
        "received_chunks_count": len(done_indices),
        "total_chunks": total_chunks,
        "total_size": entry["total_size"],
        "progress_percent": progress_percent,
    }


@app.get("/api/uploads/{upload_id}/events")
async def uploads_events(upload_id: str, request: Request):
    _require_admin_user(request)
    if not UPLOAD_ID_PATTERN.match(upload_id):
        raise HTTPException(status_code=404, detail="Upload session not found")
    if _load_upload_session(upload_id) is None:
        raise HTTPException(status_code=404, detail="Upload session not found")

    async def _event_stream():
        last_payload = None
        deadline = time.time() + 600.0
        while time.time() < deadline:
            if await request.is_disconnected():
                break
            cur = _load_upload_session(upload_id)
            if cur is None:
                done_evt = json.dumps({"upload_id": upload_id, "status": "completed", "phase": "completed", "phase_progress": 100})
                yield f"data: {done_evt}\n\n"
                break
            payload = {
                "upload_id": upload_id,
                "status": cur.get("status", "uploading"),
                "phase": cur.get("phase", "uploading"),
                "phase_message": cur.get("phase_message", ""),
                "phase_progress": cur.get("phase_progress", 0),
                "received_chunks_count": len(cur.get("chunks_received") or []),
                "total_chunks": cur.get("total_chunks", 1),
                "error": cur.get("error"),
            }
            encoded = json.dumps(payload)
            if encoded != last_payload:
                yield f"data: {encoded}\n\n"
                last_payload = encoded
            if payload["phase"] in ("completed", "failed") or payload["status"] in ("completed", "failed"):
                break
            await asyncio.sleep(0.25)

    return StreamingResponse(
        _event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.delete("/api/uploads/{upload_id}")
async def uploads_abort(upload_id: str, request: Request):
    _require_admin_user(request)
    if not UPLOAD_ID_PATTERN.match(upload_id):
        raise HTTPException(status_code=404, detail="Upload session not found")
    entry = STATE["pending_uploads"].pop(upload_id, None)
    temp_dir = _upload_session_dir(upload_id)
    if os.path.exists(temp_dir):
        try:
            shutil.rmtree(temp_dir, ignore_errors=True)
        except Exception:
            pass
    return {"status": "aborted"}


@app.post("/api/uploads/{upload_id}/complete")
async def uploads_complete(upload_id: str, request: Request):
    user = _require_admin_user(request)
    if not UPLOAD_ID_PATTERN.match(upload_id):
        raise HTTPException(status_code=404, detail="Upload session not found")
    entry = _load_upload_session(upload_id)
    if not entry:
        raise HTTPException(status_code=404, detail="Upload session not found")

    meta = entry.get("meta") or {}
    target_project_id = meta.get("project_id")
    if target_project_id not in (None, ""):
        _require_project(target_project_id)
        if not _user_can_access_project(user, target_project_id):
            raise HTTPException(status_code=403, detail="यो परियोजनामा फाइल अपलोड गर्न पहुँच छैन। (No access to this project.)")
        meta["is_global"] = False
    else:
        meta["project_id"] = None
        if not _is_super_user(user):
            raise HTTPException(
                status_code=403,
                detail="सार्वजनिक (Global) फाइल केवल मास्टर/सुपर प्रशासकले अपलोड गर्न सक्छ। "
                       "(Only a master/super administrator can upload global files.)",
            )
    kind = str(meta.get("kind") or entry.get("kind") or "vector")
    temp_dir = entry.get("temp_dir")
    filename = entry.get("filename") or meta.get("filename")
    target_file = os.path.join(temp_dir, filename)

    # Check for missing chunks
    chunks_dir = os.path.join(temp_dir, "chunks")
    done_indices = set()
    if os.path.exists(chunks_dir):
        try:
            done_indices = {
                int(p.split(".")[0])
                for p in os.listdir(chunks_dir)
                if p.endswith(".done") and p.split(".")[0].isdigit()
            }
        except Exception:
            pass
    total_chunks = entry.get("total_chunks", 1)
    missing = [i for i in range(total_chunks) if i not in done_indices]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Incomplete upload: missing {len(missing)} chunks (e.g. {missing[:5]})",
        )

    def _set_upload_phase(phase: str, status: str = "processing", message: str = "", error: Optional[str] = None, phase_progress: int = 0) -> None:
        entry["status"] = status
        entry["phase"] = phase
        entry["phase_progress"] = phase_progress
        if message:
            entry["phase_message"] = message
        if error is not None:
            entry["error"] = error
        _save_upload_session(upload_id, entry)

    # Chunk reassembly if separate chunk files exist
    chunk_files = [
        f for f in (os.listdir(chunks_dir) if os.path.exists(chunks_dir) else [])
        if f.endswith(".chunk") and f.split(".")[0].isdigit()
    ]
    if chunk_files and (not os.path.exists(target_file) or os.path.getsize(target_file) == 0):
        chunk_files.sort(key=lambda x: int(x.split(".")[0]))
        total_cf = len(chunk_files)
        _set_upload_phase("reassembling", "processing", "फाइल जोडिँदैछ (Assembling chunks)...", phase_progress=0)

        def _assemble_chunks():
            with open(target_file, "wb") as out_f:
                for c_idx, cf_name in enumerate(chunk_files):
                    cf_path = os.path.join(chunks_dir, cf_name)
                    with open(cf_path, "rb") as in_f:
                        shutil.copyfileobj(in_f, out_f, length=1048576)
                    pct = int((c_idx + 1) * 100 / max(1, total_cf))
                    _set_upload_phase("reassembling", "processing", f"फाइल जोडिँदैछ (Assembling: {pct}%)...", phase_progress=pct)

        await asyncio.to_thread(_assemble_chunks)
    elif os.path.exists(target_file):
        _set_upload_phase("reassembling", "processing", "फाइल संरचना प्रमाणीकरण गरिँदैछ (Verifying assembled file)...", phase_progress=80)
    else:
        raise HTTPException(status_code=400, detail="Target assembled file missing on server.")

    # A. Raster processing (MBTiles -> TileServer-GL)
    if kind == "raster":
        tileserver_dir = get_tileserver_dir()
        dest_path = os.path.join(tileserver_dir, filename)
        stem = re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(filename)[0]).lower()
        _invalidate_mbtiles_cache(dest_path, stem)

        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception as e:
                print(f"[KMC-BACKEND] Notice replacing existing raster file {dest_path}: {e}")

        _set_upload_phase("ingesting", "processing", "Moving raster archive into TileServer storage", phase_progress=85)
        await asyncio.to_thread(shutil.move, target_file, dest_path)
        _invalidate_mbtiles_cache(dest_path, stem)

        parsed_bounds = meta.get("bounds") or [85.15, 27.55, 85.55, 27.85]
        min_zoom = 10
        max_zoom = 22
        tile_format = "png"

        if filename.lower().endswith(".mbtiles"):
            _set_upload_phase("indexing", "processing", "Reading MBTiles metadata...", phase_progress=90)
            try:
                with sqlite3.connect(dest_path) as conn:
                    cur = conn.cursor()
                    cur.execute("SELECT name, value FROM metadata")
                    m = dict(cur.fetchall())
                    if "bounds" in m:
                        b_parts = [float(x.strip()) for x in m["bounds"].split(",")]
                        if len(b_parts) == 4:
                            parsed_bounds = b_parts
                    if "minzoom" in m:
                        min_zoom = int(m["minzoom"])
                    if "maxzoom" in m:
                        max_zoom = int(m["maxzoom"])
                    if "format" in m:
                        tile_format = m["format"]
            except Exception as e:
                print(f"[KMC-BACKEND] MBTiles metadata notice: {e}")

            try:
                _update_tileserver_config_locked(
                    tileserver_dir,
                    lambda cfg: cfg.setdefault("data", {}).__setitem__(stem, {"mbtiles": filename}),
                )
            except Exception as e:
                print(f"[KMC-BACKEND] tileserver config update notice: {e}")

        _set_upload_phase("registering", "processing", "Registering raster layer metadata", phase_progress=95)
        tile_url = f"/api/tiles/data/{stem}/{{z}}/{{x}}/{{y}}.{tile_format}"
        new_tile = {
            "id": int(time.time() * 1000),
            "name": meta.get("name") or filename,
            "filename": filename,
            "type": "raster",
            "category": "ड्रोन तथा अर्थोफोटो (UAV Imagery)",
            "is_global": meta.get("is_global") is not False,
            "project_id": meta.get("project_id"),
            "file_size": os.path.getsize(dest_path) if os.path.exists(dest_path) else entry.get("total_size", 0),
            "min_zoom": min_zoom,
            "max_zoom": max_zoom,
            "access_level": "public",
            "bounds": parsed_bounds,
            "bbox": parsed_bounds,
            "image_data_url": None,
            "tile_url": tile_url,
            "created_at": time.time(),
        }
        STATE["raster_layers"] = [r for r in STATE["raster_layers"] if r.get("filename") != filename and str(r.get("id")) != stem]
        STATE["raster_layers"].insert(0, new_tile)
        _set_upload_phase("completed", "completed", "Raster upload complete", phase_progress=100)
        shutil.rmtree(temp_dir, ignore_errors=True)
        STATE["pending_uploads"].pop(upload_id, None)
        _save_persistent_state(sync=True)
        return {**new_tile, "import_status": "complete"}

    # B. Vector processing (GeoJSON -> FeatureCollection)
    else:
        uploads_dir = get_uploads_dir()
        layers_dir = os.path.join(uploads_dir, "layers")
        os.makedirs(layers_dir, exist_ok=True)
        dest_path = os.path.join(layers_dir, filename)
        if os.path.exists(dest_path):
            try:
                os.remove(dest_path)
            except Exception as rm_err:
                print(f"[KMC-BACKEND] Notice replacing existing vector file: {rm_err}")
        _set_upload_phase("ingesting", "processing", "Parsing vector features", phase_progress=10)
        shutil.move(target_file, dest_path)

        layer_id = int(time.time() * 1000)

        def _process_and_ingest_vector():
            from app.spatial_engine import iter_geojson_features, ingest_features_to_spatial_index, ensure_spatial_db_schema
            ensure_spatial_db_schema()
            geom_type = "Polygon"
            sample_feats = []

            # Estimate total features for smooth progress calculation
            est_total = 10000
            fsize = os.path.getsize(dest_path) if os.path.exists(dest_path) else 0
            if fsize > 10 * 1024 * 1024:
                est_total = max(1000, fsize // 700)

            def _progress_cb(count):
                pct = min(95, 10 + int((count * 85) / max(1, est_total)))
                _set_upload_phase("spatial_indexing", "processing", f"स्थानिक अनुक्रमणिका निर्माण... {pct}% ({count:,} features)", phase_progress=pct)

            feats_gen = iter_geojson_features(dest_path)
            ingest_result = ingest_features_to_spatial_index(
                layer_id=layer_id,
                features=feats_gen,
                progress_callback=_progress_cb
            )

            for f in iter_geojson_features(dest_path):
                sample_feats.append(f)
                if len(sample_feats) >= 150:
                    break

            if sample_feats:
                g = sample_feats[0].get("geometry") or {}
                if g.get("type"):
                    geom_type = g["type"]

            return ingest_result, geom_type, sample_feats

        try:
            ingest_result, geom_type, sample_feats = await asyncio.to_thread(_process_and_ingest_vector)

            detected_fields = {}
            for f in sample_feats:
                props = f.get("properties") or {}
                for k, v in props.items():
                    if k in ("geometry", "geom", "the_geom", "_id", "_created_by", "_created_by_username", "feature_uid"):
                        continue
                    if k not in detected_fields:
                        ftype = "text"
                        if isinstance(v, bool):
                            ftype = "checkbox"
                        elif isinstance(v, (int, float)):
                            ftype = "number"
                        detected_fields[k] = {
                            "name": k,
                            "label": k.replace("_", " ").title(),
                            "type": ftype,
                            "required": False,
                            "is_unique": False,
                            "visible_in_popup": True,
                        }
            initial_fields_config = list(detected_fields.values())

            feature_count = ingest_result.get("feature_count", 0)
            calculated_bbox = ingest_result.get("bounds", [85.28, 27.67, 85.37, 27.75])
            is_mvt_layer = feature_count > 500

            new_layer = {
                "id": layer_id,
                "name": meta.get("name") or filename,
                "filename": filename,
                "description": meta.get("description") or "Uploaded GeoJSON Layer",
                "type": "vector",
                "geometry_type": geom_type,
                "creation_geometry_types": [geom_type],
                "category": "भू-स्थानिक तहहरू (Spatial Layers)",
                "is_global": meta.get("is_global") is True,
                "project_id": meta.get("project_id"),
                "allow_snapping": meta.get("allow_snapping") is not False,
                "editable_by_collectors": meta.get("editable_by_collectors") is True,
                "published": True,
                "default_visible": True,
                "access_level": "public",
                "opacity": 1,
                "feature_count": feature_count,
                "bounds": calculated_bbox,
                "bbox": calculated_bbox,
                "bbox_mode": feature_count > 150,
                "is_mvt": is_mvt_layer,
                "tile_url": f"/api/tiles/vector/{layer_id}/{{z}}/{{x}}/{{y}}" if is_mvt_layer else None,
                "style": {"strokeColor": "#10b981", "fillColor": "#10b981", "strokeWidth": 2.5, "clickTolerance": 14},
                "fields_config": initial_fields_config,
                "created_at": time.time(),
            }

            if feature_count <= 5000:
                set_layer_features(layer_id, list(sample_feats))

            STATE["vector_layers"].insert(0, new_layer)
            _set_upload_phase("completed", "completed", "Vector upload complete", phase_progress=100)
            shutil.rmtree(temp_dir, ignore_errors=True)
            STATE["pending_uploads"].pop(upload_id, None)
            _save_persistent_state(sync=True)
            return {**new_layer, "import_status": "complete"}
        except HTTPException:
            raise
        except Exception as proc_err:
            print(f"[KMC-BACKEND] Vector upload error for {upload_id}: {proc_err}")
            _set_upload_phase("failed", status="failed", error=str(proc_err))
            raise HTTPException(
                status_code=400,
                detail=f"फाइल प्रशोधन गर्दा समस्या भयो (Vector file processing failed): {str(proc_err)}"
            )


# ---- 2. Direct Multipart Upload Endpoints ----

async def _process_direct_tile_upload(
    file: UploadFile,
    name: Optional[str],
    description: Optional[str],
    is_global: bool,
    project_id: Optional[int],
) -> Dict[str, Any]:
    tileserver_dir = get_tileserver_dir()
    filename = _sanitize_upload_filename(file.filename or "", RASTER_UPLOAD_EXTENSIONS)
    dest_path = os.path.join(tileserver_dir, filename)
    staging_path = dest_path + ".uploading.tmp"
    try:
        with open(staging_path, "wb") as f:
            _stream_to_file_with_limit(file.file, f, _max_upload_bytes())
        os.replace(staging_path, dest_path)
    except BaseException:
        if os.path.exists(staging_path):
            os.remove(staging_path)
        raise

    parsed_bounds = [85.31, 27.68, 85.35, 27.70]
    min_zoom, max_zoom, tile_format = 10, 22, "png"
    stem = re.sub(r'[^a-zA-Z0-9_-]', '_', os.path.splitext(filename)[0]).lower()

    _invalidate_mbtiles_cache(dest_path, stem)

    if filename.lower().endswith(".mbtiles"):
        try:
            with sqlite3.connect(dest_path) as conn:
                cur = conn.cursor()
                cur.execute("SELECT name, value FROM metadata")
                m = dict(cur.fetchall())
                if "bounds" in m:
                    b_parts = [float(x.strip()) for x in m["bounds"].split(",")]
                    if len(b_parts) == 4:
                        parsed_bounds = b_parts
                if "minzoom" in m:
                    min_zoom = int(m["minzoom"])
                if "maxzoom" in m:
                    max_zoom = int(m["maxzoom"])
                if "format" in m:
                    tile_format = m["format"]
        except Exception:
            pass

        try:
            _update_tileserver_config_locked(
                tileserver_dir,
                lambda cfg: cfg.setdefault("data", {}).__setitem__(stem, {"mbtiles": filename}),
            )
        except Exception:
            pass

    tile_url = f"/api/tiles/data/{stem}/{{z}}/{{x}}/{{y}}.{tile_format}"
    new_tile = {
        "id": int(time.time() * 1000),
        "name": name or filename,
        "filename": filename,
        "type": "raster",
        "category": "ड्रोन तथा अर्थोफोटो (UAV Imagery)",
        "is_global": is_global,
        "project_id": project_id,
        "file_size": os.path.getsize(dest_path) if os.path.exists(dest_path) else 0,
        "min_zoom": min_zoom,
        "max_zoom": max_zoom,
        "access_level": "public",
        "bounds": parsed_bounds,
        "bbox": parsed_bounds,
        "image_data_url": None,
        "tile_url": tile_url,
        "created_at": time.time(),
    }
    STATE["raster_layers"] = [
        r for r in STATE["raster_layers"]
        if r.get("filename") != filename and str(r.get("id")) != stem
    ]
    STATE["raster_layers"].insert(0, new_tile)
    _save_persistent_state()
    return new_tile


@app.post("/api/tiles/upload")
async def upload_tile_direct(
    request: Request,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    is_global: bool = Form(True),
    project_id: Optional[int] = Form(None),
):
    user = _require_admin_user(request)
    if project_id not in (None, ""):
        _require_project(project_id)
        if not _user_can_access_project(user, project_id):
            raise HTTPException(status_code=403, detail="यो परियोजनामा इमेज्री अपलोड गर्न पहुँच छैन। (No access to this project.)")
        is_global = False
    elif not _is_super_user(user):
        raise HTTPException(
            status_code=403,
            detail="सार्वजनिक (Global) इमेज्री केवल मास्टर/सुपर प्रशासकले अपलोड गर्न सक्छ। "
                   "(Only a master/super administrator can upload global imagery.)",
        )
    return await _process_direct_tile_upload(file, name, description, is_global, project_id)


@app.post("/api/projects/{project_id}/tiles/upload")
async def upload_project_tile_direct(
    project_id: int,
    request: Request,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    is_global: bool = Form(False),
):
    user = _require_admin_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा इमेज्री अपलोड गर्न पहुँच छैन। (No access to this project.)")
    return await _process_direct_tile_upload(file, name, description, False, project_id)


@app.post("/api/layers/upload")
async def upload_layer_direct(
    request: Request,
    file: UploadFile = File(...),
    name: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    is_global: bool = Form(True),
    project_id: Optional[int] = Form(None),
    editable_by_collectors: bool = Form(False),
    allow_snapping: bool = Form(True),
):
    user = _require_admin_user(request)
    if project_id not in (None, ""):
        _require_project(project_id)
        if not _user_can_access_project(user, project_id):
            raise HTTPException(status_code=403, detail="यो परियोजनामा तह अपलोड गर्न पहुँच छैन। (No access to this project.)")
        is_global = False
    else:
        project_id = None
        if not _is_super_user(user):
            raise HTTPException(
                status_code=403,
                detail="सार्वजनिक (Global) तह केवल मास्टर/सुपर प्रशासकले अपलोड गर्न सक्छ। "
                       "(Only a master/super administrator can upload global layers.)",
            )
    max_bytes = _max_upload_bytes()
    content = await file.read(max_bytes + 1)
    if len(content) > max_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"Upload exceeds the {settings.max_upload_size_mb} MB limit.",
        )
    try:
        parsed_json = json.loads(content.decode("utf-8", errors="replace"))
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid GeoJSON format")

    raw_feats = []
    if isinstance(parsed_json, dict) and "features" in parsed_json and isinstance(parsed_json["features"], list):
        raw_feats = parsed_json["features"]
    elif isinstance(parsed_json, list):
        raw_feats = parsed_json
    elif isinstance(parsed_json, dict) and parsed_json.get("type") == "Feature":
        raw_feats = [parsed_json]

    min_x, min_y, max_x, max_y = float("inf"), float("inf"), float("-inf"), float("-inf")
    imported_features = []
    geom_type = "Polygon"

    def scan_coords(coords):
        nonlocal min_x, min_y, max_x, max_y
        if not coords or not isinstance(coords, (list, tuple)):
            return
        if len(coords) >= 2 and isinstance(coords[0], (int, float)) and isinstance(coords[1], (int, float)):
            x, y = float(coords[0]), float(coords[1])
            if not (math.isnan(x) or math.isnan(y)):
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
        else:
            for sub in coords:
                scan_coords(sub)

    for idx, f in enumerate(raw_feats):
        if not isinstance(f, dict):
            continue
        feat_id = f.get("id") or (int(time.time() * 1000) + idx)
        f["id"] = feat_id
        if "type" not in f:
            f["type"] = "Feature"
        geometry = f.get("geometry") or {}
        if geometry and "coordinates" in geometry:
            scan_coords(geometry["coordinates"])
        if idx == 0 and geometry.get("type"):
            geom_type = geometry["type"]
        feat_props = f.get("properties")
        if not isinstance(feat_props, dict):
            feat_props = {}
            f["properties"] = feat_props
        if "geometry" in feat_props:
            feat_props["geometry_prop"] = feat_props.pop("geometry")
        feat_props["_id"] = feat_id
        feat_props["_created_by"] = user.get("id")
        feat_props["_created_by_username"] = user.get("username") or ""

    imported_features = raw_feats

    calculated_bbox = [85.31, 27.682, 85.345, 27.702]
    if min_x != float("inf") and min_y != float("inf") and max_x != float("-inf") and max_y != float("-inf"):
        if min_x >= 100000 and max_x <= 900000 and min_y >= 2000000 and max_y <= 4000000:
            print(f"[KMC-BACKEND] Layer coordinates detected as UTM Zone 45N (Nepal). Auto-reprojecting to WGS84 EPSG:4326...")
            new_bounds = [float("inf"), float("inf"), float("-inf"), float("-inf")]
            for feat in imported_features:
                g = feat.get("geometry")
                if g and "coordinates" in g:
                    _convert_coords_utm_to_wgs84_inplace(g["coordinates"], new_bounds)
            calculated_bbox = [round(new_bounds[0], 6), round(new_bounds[1], 6), round(new_bounds[2], 6), round(new_bounds[3], 6)]
        else:
            calculated_bbox = [min_x, min_y, max_x, max_y]

    layer_id = int(time.time() * 1000)
    saved_filename = f"{layer_id}.geojson"
    try:
        layers_dir = os.path.join(get_uploads_dir(), "layers")
        os.makedirs(layers_dir, exist_ok=True)
        with open(os.path.join(layers_dir, saved_filename), "wb") as f:
            f.write(content)
    except Exception as save_err:
        print(f"[KMC-BACKEND] Notice saving direct vector upload file: {save_err}")

    new_layer = {
        "id": layer_id,
        "name": name or file.filename or "New Vector Layer",
        "filename": saved_filename,
        "description": description or "Uploaded GeoJSON Layer",
        "type": "vector",
        "geometry_type": geom_type,
        "creation_geometry_types": [geom_type],
        "category": "भू-स्थानिक तहहरू (Spatial Layers)",
        "is_global": bool(is_global) and project_id is None,
        "project_id": project_id,
        "allow_snapping": allow_snapping,
        "editable_by_collectors": editable_by_collectors is True,
        "published": True,
        "default_visible": True,
        "access_level": "public",
        "opacity": 1,
        "feature_count": len(imported_features),
        "bounds": calculated_bbox,
        "bbox": calculated_bbox,
        "style": {"strokeColor": "#10b981", "fillColor": "#10b981", "strokeWidth": 2.5, "clickTolerance": 14},
        "fields_config": [],
        "created_at": time.time(),
    }
    STATE["vector_layers"].insert(0, new_layer)
    if len(imported_features) <= 500:
        STATE["features_by_layer"][layer_id] = imported_features
    _save_persistent_state()
    return new_layer


# ---- 3. Raster Tiles Endpoints (High-Speed Native SQLite MBTiles Engine) ----

TRANSPARENT_1X1_PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01Haf\xa0\x00\x00\x00\x00IEND\xaeB`\x82'


def _find_mbtiles_path(slug: str) -> Optional[str]:
    tileserver_dir = get_tileserver_dir()
    slug_clean = str(slug).strip()
    slug_norm = re.sub(r'[^a-zA-Z0-9]', '', slug_clean).lower()

    # 1. Exact match
    direct = os.path.join(tileserver_dir, f"{slug_clean}.mbtiles")
    if os.path.exists(direct):
        return direct
    direct_exact = os.path.join(tileserver_dir, slug_clean)
    if os.path.exists(direct_exact) and direct_exact.endswith(".mbtiles"):
        return direct_exact

    # 2. Check config.json if available
    cfg_path = os.path.join(tileserver_dir, "config.json")
    if os.path.exists(cfg_path):
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            data_map = cfg.get("data", {})
            if slug_clean in data_map and "mbtiles" in data_map[slug_clean]:
                p = os.path.join(tileserver_dir, data_map[slug_clean]["mbtiles"])
                if os.path.exists(p):
                    return p
            for k, val in data_map.items():
                if k.lower() == slug_clean.lower() or re.sub(r'[^a-zA-Z0-9]', '', k).lower() == slug_norm:
                    if isinstance(val, dict) and "mbtiles" in val:
                        p = os.path.join(tileserver_dir, val["mbtiles"])
                        if os.path.exists(p):
                            return p
        except Exception as e:
            print(f"[MBTILES-CONFIG] Notice reading config.json: {e}")

    # 3. Check raster layers in STATE
    for r in STATE.get("raster_layers", []):
        if str(r.get("id")) == slug_clean:
            fname = r.get("filename")
            if fname:
                p = os.path.join(tileserver_dir, fname)
                if os.path.exists(p):
                    return p
        fname = r.get("filename") or ""
        r_stem = re.sub(r'[^a-zA-Z0-9]', '', os.path.splitext(fname)[0]).lower()
        if r_stem == slug_norm and fname:
            p = os.path.join(tileserver_dir, fname)
            if os.path.exists(p):
                return p

    # 4. Scan tileserver directory for matching mbtiles
    if os.path.exists(tileserver_dir):
        for entry in os.listdir(tileserver_dir):
            if entry.lower().endswith(".mbtiles"):
                e_stem = re.sub(r'[^a-zA-Z0-9]', '', os.path.splitext(entry)[0]).lower()
                if e_stem == slug_norm or slug_norm in e_stem or e_stem in slug_norm:
                    return os.path.join(tileserver_dir, entry)

    return None


def _fetch_tile_blob(mbtiles_path: str, z: int, x: int, y: int) -> Optional[tuple[bytes, str]]:
    cache_key = (mbtiles_path, z, x, y)
    with _TILE_CACHE_LOCK:
        if cache_key in _TILE_CACHE:
            _TILE_CACHE.move_to_end(cache_key)
            return _TILE_CACHE[cache_key]

    conn = _get_mbtiles_conn(mbtiles_path)
    if not conn:
        return None

    try:
        tms_y = (1 << z) - 1 - y
        cur = conn.cursor()

        # Try TMS convention (standard for MBTiles)
        cur.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            (z, x, tms_y),
        )
        row = cur.fetchone()

        # Try direct XYZ convention
        if not row:
            cur.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
                (z, x, y),
            )
            row = cur.fetchone()

        if row and row[0]:
            blob = row[0]
            media_type = "image/png"
            if blob.startswith(b'\x89PNG'):
                media_type = "image/png"
            elif blob.startswith(b'\xff\xd8\xff'):
                media_type = "image/jpeg"
            elif len(blob) > 12 and blob[:4] == b'RIFF' and blob[8:12] == b'WEBP':
                media_type = "image/webp"
            elif blob.startswith(b'\x1f\x8b'):
                media_type = "application/x-protobuf"

            res = (blob, media_type)
            with _TILE_CACHE_LOCK:
                _TILE_CACHE[cache_key] = res
                if len(_TILE_CACHE) > _TILE_CACHE_MAX:
                    _TILE_CACHE.popitem(last=False)
            return res
    except Exception as e:
        print(f"[MBTILES-TILE] Notice: could not read {mbtiles_path} at {z}/{x}/{y}: {e}")
    return None


from starlette.concurrency import run_in_threadpool


def _find_raster_layer_for_slug(slug: str) -> Optional[Dict[str, Any]]:
    slug_clean = str(slug).strip()
    slug_norm = re.sub(r'[^a-zA-Z0-9]', '', slug_clean).lower()
    for r in STATE.get("raster_layers", []):
        if r.get("deleted_at"):
            continue
        if str(r.get("id")) == slug_clean:
            return r
        fname = r.get("filename") or ""
        r_stem = re.sub(r'[^a-zA-Z0-9]', '', os.path.splitext(fname)[0]).lower()
        if fname and (fname == slug_clean or r_stem == slug_norm):
            return r
    return None


async def _handle_serve_mbtiles(slug: str, z: Any, x: Any, y_raw: str, request: Optional[Request] = None):
    raster = _find_raster_layer_for_slug(slug)
    user = resolve_request_user(request) if request is not None else None
    if raster is not None:
        if raster.get("project_id") not in (None, ""):
            if user is None:
                raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
            if not _user_can_access_project(user, raster.get("project_id")):
                raise HTTPException(status_code=403, detail="यो परियोजनाको टाइलमा पहुँच छैन। (No access to this project tile layer.)")
        else:
            if _is_public_viewer(user) and (raster.get("published") is False or raster.get("public_visible") is False):
                raise HTTPException(status_code=403, detail="यो टाइल तह हाल सार्वजनिक गरिएको छैन। (This tile layer is not published to public portal.)")
            if not _is_admin_user(user) and not _portal_access_allowed(raster, user):
                raise HTTPException(status_code=403, detail="यो टाइल तह हेर्न अनुमति छैन। (Access denied to this tile layer.)")

    y_clean = str(y_raw).strip().split(".")[0]
    try:
        y_int = int(y_clean)
        z_int = int(z)
        x_int = int(x)
    except Exception:
        return Response(content=TRANSPARENT_1X1_PNG, media_type="image/png", status_code=200)

    mbtiles_path = _find_mbtiles_path(slug)
    if mbtiles_path:
        ver = _TILE_CACHE_VERSIONS.get(os.path.abspath(mbtiles_path), _TILE_CACHE_VERSIONS.get(slug, 0))
        redis_key = f"kmc:tile:v{ver}:{slug}:{z_int}:{x_int}:{y_int}"
        tile_info = await _redis_tile_get(redis_key)
        if tile_info is None:
            tile_info = await run_in_threadpool(_fetch_tile_blob, mbtiles_path, z_int, x_int, y_int)
            if tile_info is not None:
                await _redis_tile_set(redis_key, tile_info[0], tile_info[1])
        if tile_info:
            blob, media_type = tile_info
            cache_ctrl = (
                "private, max-age=3600"
                if (raster is not None and raster.get("project_id") not in (None, ""))
                else "public, max-age=604800, immutable"
            )
            headers = {
                "Cache-Control": cache_ctrl,
                "Access-Control-Allow-Origin": "*",
            }
            if media_type == "application/x-protobuf":
                headers["Content-Encoding"] = "gzip"
            return Response(content=blob, media_type=media_type, headers=headers)

    return Response(
        content=TRANSPARENT_1X1_PNG,
        media_type="image/png",
        status_code=200,
        headers={
            "Cache-Control": "public, max-age=3600",
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.get("/api/tiles/data/{slug}/{z}/{x}/{y_raw:path}")
@app.head("/api/tiles/data/{slug}/{z}/{x}/{y_raw:path}")
@app.get("/tiles/data/{slug}/{z}/{x}/{y_raw:path}")
@app.head("/tiles/data/{slug}/{z}/{x}/{y_raw:path}")
async def serve_mbtiles_tile_data(slug: str, z: Any, x: Any, y_raw: str, request: Request):
    return await _handle_serve_mbtiles(slug, z, x, y_raw, request=request)


@app.get("/api/tiles/{slug}/{z}/{x}/{y_raw:path}")
@app.head("/api/tiles/{slug}/{z}/{x}/{y_raw:path}")
@app.get("/tiles/{slug}/{z}/{x}/{y_raw:path}")
@app.head("/tiles/{slug}/{z}/{x}/{y_raw:path}")
async def serve_mbtiles_tile_flexible(slug: str, z: Any, x: Any, y_raw: str, request: Request):
    if slug == "vector":
        parts = str(y_raw).strip().split("/")
        if len(parts) >= 2:
            return await serve_vector_tile_mvt(str(z), x, parts[0], parts[1], request=request)
    if slug == "raster":
        parts = str(y_raw).strip().split("/")
        if len(parts) >= 2:
            return await serve_raster_tile_endpoint(str(z), x, parts[0], parts[1], request=request)
    if slug == "data":
        parts = str(y_raw).strip().split("/")
        if len(parts) >= 2:
            return await _handle_serve_mbtiles(str(z), x, parts[0], parts[1], request=request)
    return await _handle_serve_mbtiles(slug, z, x, y_raw, request=request)


_TILE_INGEST_LOCK = asyncio.Lock()
_EMPTY_CHECKED_LAYERS: set = set()


@app.get("/api/tiles/vector/{layer_id}/{z}/{x}/{y_raw:path}")
@app.head("/api/tiles/vector/{layer_id}/{z}/{x}/{y_raw:path}")
@app.get("/tiles/vector/{layer_id}/{z}/{x}/{y_raw:path}")
@app.head("/tiles/vector/{layer_id}/{z}/{x}/{y_raw:path}")
async def serve_vector_tile_mvt(
    layer_id: str,
    z: Any,
    x: Any,
    y_raw: str,
    request: Request,
):
    """
    High-Speed Vector Tile Pipeline (MVT Protobuf v2.1).
    - Session/role resolution and layer visibility check.
    - Cascading field-level permissions.
    - Spatial query via SQLite R-Tree with zoom-adaptive LOD & 3% edge buffer.
    - Binary MVT v2.1 encoding (clamping [-2048, 6144], vertex deduplication, Douglas-Peucker simplification, winding order).
    - Returns HTTP 204 No Content immediately when a tile contains zero features.
    - Role-scoped LRU caching.
    """
    y_clean = str(y_raw).strip().split(".")[0]
    try:
        y_int = int(y_clean)
        z_int = int(z)
        x_int = int(x)
    except Exception:
        return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*"})

    user = resolve_request_user(request)
    role = _actor_role(user) if user else "PUBLIC_VIEWER"

    layer = _layer_by_id(layer_id)
    if not layer:
        lid_clean = str(layer_id).strip().lower()
        for l in STATE.get("vector_layers", []):
            if not l.get("deleted_at") and (
                str(l.get("id")) == str(layer_id)
                or str(l.get("name", "")).strip().lower() == lid_clean
                or re.sub(r"[^a-zA-Z0-9]", "", str(l.get("name", ""))).lower() == re.sub(r"[^a-zA-Z0-9]", "", lid_clean)
            ):
                layer = l
                break

    if layer is not None:
        if not _layer_visible_to_user(layer, user):
            if user is None:
                raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
            raise HTTPException(status_code=403, detail="यो तह हेर्न अनुमति छैन। (Access denied to this vector tile layer.)")

    permitted_field_names = None
    if layer and not _is_admin_user(user):
        allowed_fields = _portal_visible_fields(layer, user)
        if allowed_fields:
            permitted_field_names = [str(f.get("name")) for f in allowed_fields if f.get("name")]

    cached = get_cached_mvt_tile(layer_id, role, z_int, x_int, y_int)
    if cached is not None:
        return Response(
            content=cached,
            media_type="application/vnd.mapbox-vector-tile",
            headers={
                "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
                "Access-Control-Allow-Origin": "*",
            },
        )

    features = await run_in_threadpool(query_spatial_rtree_tile, layer_id, z_int, x_int, y_int)
    if not features and layer:
        lid_key = str(layer.get("id"))
        if lid_key not in _EMPTY_CHECKED_LAYERS and get_layer_feature_count(lid_key) == 0:
            async with _TILE_INGEST_LOCK:
                if lid_key not in _EMPTY_CHECKED_LAYERS and get_layer_feature_count(lid_key) == 0:
                    try:
                        from app.spatial_engine import iter_geojson_features, ingest_features_to_spatial_index
                        uploads_layers_dir = os.path.join(get_uploads_dir(), "layers")
                        cand_path = os.path.join(uploads_layers_dir, layer.get("filename") or "")
                        if os.path.exists(cand_path):
                            if os.path.getsize(cand_path) > 10 * 1024 * 1024:
                                _EMPTY_CHECKED_LAYERS.add(lid_key)
                                return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*"})
                            await run_in_threadpool(ingest_features_to_spatial_index, lid_key, iter_geojson_features(cand_path))
                            features = await run_in_threadpool(query_spatial_rtree_tile, layer_id, z_int, x_int, y_int)
                        else:
                            in_mem_feats = get_layer_features_list(layer.get("id"))
                            if in_mem_feats:
                                await run_in_threadpool(ingest_features_to_spatial_index, lid_key, in_mem_feats)
                                features = await run_in_threadpool(query_spatial_rtree_tile, layer_id, z_int, x_int, y_int)
                    except Exception as ing_err:
                        print(f"[SPATIAL-ENGINE] Ingestion notice for {lid_key}: {ing_err}")
                    finally:
                        _EMPTY_CHECKED_LAYERS.add(lid_key)

    if not features:
        return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*"})

    layer_name = (layer.get("name") if layer else layer_id) or "layer"
    mvt_bytes = await run_in_threadpool(
        encode_mvt_v2,
        layer_name=layer_name,
        features=features,
        z=z_int,
        x=x_int,
        y=y_int,
        permitted_fields=permitted_field_names,
        extent=4096,
    )

    if not mvt_bytes:
        return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*"})

    set_cached_mvt_tile(layer_id, role, z_int, x_int, y_int, mvt_bytes)
    return Response(
        content=mvt_bytes,
        media_type="application/vnd.mapbox-vector-tile",
        headers={
            "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
            "Access-Control-Allow-Origin": "*",
        },
    )


@app.get("/api/tiles/raster/{raster_id}/{z}/{x}/{y_raw:path}")
@app.head("/api/tiles/raster/{raster_id}/{z}/{x}/{y_raw:path}")
@app.get("/tiles/raster/{raster_id}/{z}/{x}/{y_raw:path}")
@app.head("/tiles/raster/{raster_id}/{z}/{x}/{y_raw:path}")
async def serve_raster_tile_endpoint(
    raster_id: str,
    z: Any,
    x: Any,
    y_raw: str,
    request: Request,
):
    """
    High-Speed Raster Tile Streaming (MBTiles B-Tree).
    - Access control & project isolation checks.
    - XYZ -> TMS row conversion.
    - Magic byte format sniffing (WEBP, PNG, JPEG).
    - Returns 204 No Content for missing tiles (never 404).
    """
    raster = _find_raster_layer_for_slug(raster_id)
    user = resolve_request_user(request)
    if raster is not None:
        if raster.get("project_id") not in (None, ""):
            if user is None:
                raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
            if not _user_can_access_project(user, raster.get("project_id")):
                raise HTTPException(status_code=403, detail="यो परियोजनाको टाइलमा पहुँच छैन। (No access to this project tile layer.)")
        else:
            if _is_public_viewer(user) and (raster.get("published") is False or raster.get("public_visible") is False):
                raise HTTPException(status_code=403, detail="यो टाइल तह हाल सार्वजनिक गरिएको छैन। (This tile layer is not published to public portal.)")
            if not _is_admin_user(user) and not _portal_access_allowed(raster, user):
                raise HTTPException(status_code=403, detail="यो टाइल तह हेर्न अनुमति छैन। (Access denied to this tile layer.)")

    y_clean = str(y_raw).strip().split(".")[0]
    try:
        y_int = int(y_clean)
        z_int = int(z)
        x_int = int(x)
    except Exception:
        return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*"})

    mbtiles_path = _find_mbtiles_path(raster_id)
    if not mbtiles_path:
        for cand in [
            "/tileserver-data/Whole_KMC_final.mbtiles",
            "./data/tileserver/Whole_KMC_final.mbtiles",
            os.path.join(get_tileserver_dir(), "Whole_KMC_final.mbtiles"),
        ]:
            if os.path.exists(cand):
                mbtiles_path = cand
                break

    if mbtiles_path:
        tile_info = await run_in_threadpool(fetch_raster_mbtiles_tile, mbtiles_path, z_int, x_int, y_int)
        if tile_info:
            blob, media_type = tile_info
            cache_ctrl = (
                "private, max-age=3600"
                if (raster is not None and raster.get("project_id") not in (None, ""))
                else "public, max-age=86400, immutable"
            )
            return Response(
                content=blob,
                media_type=media_type,
                headers={
                    "Cache-Control": cache_ctrl,
                    "Access-Control-Allow-Origin": "*",
                },
            )

    return Response(status_code=204, headers={"Access-Control-Allow-Origin": "*"})


@app.get("/api/analytics")
async def get_live_spatial_analytics_endpoint(
    request: Request,
    layerId: Optional[str] = None,
    layer_id: Optional[str] = None,
    bbox: Optional[str] = None,
):
    """Live R-Tree Spatial Analytics for viewport infographics without downloading raw GeoJSON."""
    lid = layerId or layer_id
    if not lid:
        raise HTTPException(status_code=400, detail="layerId parameter is required.")

    bbox_list = None
    if bbox:
        try:
            parts = [float(p.strip()) for p in bbox.split(",")]
            if len(parts) == 4:
                bbox_list = parts
        except Exception:
            pass

    return compute_live_spatial_analytics(str(lid), bbox_list)


@app.get("/api/features")
async def get_feature_by_query(
    request: Request,
    projectId: Optional[str] = None,
    project_id: Optional[str] = None,
    layerId: Optional[str] = None,
    layer_id: Optional[str] = None,
    featureUid: Optional[str] = None,
    feature_uid: Optional[str] = None,
    id: Optional[str] = None,
):
    """Fast feature attribute inspection by UID/ID with role-filtered attributes."""
    target_id = featureUid or feature_uid or id
    if not target_id:
        raise HTTPException(status_code=400, detail="featureUid or id parameter is required.")

    lid = layerId or layer_id
    user = resolve_request_user(request)

    # 1. Fast sub-millisecond lookup from spatial_features.db
    feat = get_feature_by_uid(target_id, str(lid) if lid else None)

    # 2. Fallback to in-memory / PostGIS
    if not feat:
        found = await _find_feature_across_layers_async(target_id, scope_layer_id=lid)
        if found:
            feat = _clean_feature_properties_for_geojson(found.get("feature"))

    if not feat:
        raise HTTPException(status_code=404, detail="फिचर भेटिएन। (Feature not found.)")

    actual_layer_id = lid or feat.get("_layer_id")
    layer = _layer_by_id(actual_layer_id) if actual_layer_id else None
    if layer and not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो फिचर हेर्न अनुमति छैन। (Access denied to this feature.)")

    if layer and not _is_admin_user(user):
        filtered = _portal_filter_feature_properties(layer, user, [feat])
        return filtered[0] if filtered else feat

    return feat


@app.get("/api/tiles")
async def list_tiles(request: Request, all_tiles: bool = False):
    _reload_state_if_modified()
    user = resolve_request_user(request)
    out = []
    for r in STATE["raster_layers"]:
        if r.get("deleted_at"):
            continue
        if r.get("project_id") not in (None, ""):
            if user is None or not _user_can_access_project(user, r.get("project_id")):
                continue
            if not all_tiles:
                # Global catalog only; project rasters require their project request.
                continue
        c = dict(r)
        c["validator_download_allowed"] = _layer_download_allowed(r, {"role": "Validator"})
        if c.get("tile_url") and c["tile_url"].startswith("/tiles/data/"):
            c["tile_url"] = "/api" + c["tile_url"]
        out.append(c)
    return out


@app.get("/api/projects/{project_id}/tiles")
async def list_project_tiles(project_id: int, request: Request):
    _reload_state_if_modified()
    user = resolve_request_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    rec = _get_or_create_project_assignment(project_id)
    assigned_tile_ids = {str(x) for x in (rec.get("assigned_mbtiles_ids") or [])}
    if isinstance(project.get("tile_ids"), list):
        assigned_tile_ids.update(str(x) for x in project["tile_ids"])

    out = []
    for r in STATE["raster_layers"]:
        if r.get("deleted_at"):
            continue
        is_owner = str(r.get("project_id")) == str(project_id)
        is_assigned = str(r.get("id")) in assigned_tile_ids
        if not (is_owner or is_assigned):
            continue
        c = dict(r)
        c["validator_download_allowed"] = _layer_download_allowed(r, {"role": "Validator"})
        if c.get("tile_url") and c["tile_url"].startswith("/tiles/data/"):
            c["tile_url"] = "/api" + c["tile_url"]
        out.append(c)
    return out


@app.get("/api/tiles/deleted")
async def list_deleted_tiles(request: Request):
    user = resolve_request_user(request)
    if not _is_admin_user(user):
        raise HTTPException(status_code=403, detail="रिसाइकल बिन हेर्न प्रशासक अधिकार आवश्यक छ। (Administrator role required.)")
    return [
        t
        for t in STATE["raster_layers"]
        if t.get("deleted_at") and _user_can_access_project(user, t.get("project_id"))
    ]


@app.get("/api/tiles/{tile_id}/download")
async def download_tile(tile_id: int, request: Request):
    """Raster/mbtiles download: administrators by default; validators only when granted."""
    user = _require_user(request)
    raster = next((x for x in STATE["raster_layers"] if str(x.get("id")) == str(tile_id)), None)
    if raster is None or raster.get("deleted_at"):
        raise HTTPException(status_code=404, detail="Raster layer not found")
    if not _user_can_access_project(user, raster.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    if not _layer_download_allowed(raster, user):
        raise HTTPException(status_code=403, detail="यो रास्टर डाउनलोड गर्न अनुमति छैन। (Download permission for this raster has not been granted.)")
    filename = str(raster.get("filename") or "").strip()
    path = os.path.join(get_tileserver_dir(), filename) if filename else ""
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="रास्टर फाइल सर्भरमा भेटिएन। (Raster file not found on the server.)")
    return FileResponse(path, media_type="application/octet-stream", filename=filename)


@app.delete("/api/tiles/{tile_id}")
async def delete_tile(tile_id: int, request: Request):
    user = _require_admin_user(request)
    t = next((x for x in STATE["raster_layers"] if x.get("id") == tile_id), None)
    if not t:
        raise HTTPException(status_code=404, detail="Raster layer not found")
    if not _user_can_access_project(user, t.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनाको इमेज्री मेटाउन पहुँच छैन। (You cannot delete this project's raster.)")
    t["deleted_at"] = time.time()
    t["deleted_by"] = user.get("id")
    t["deleted_by_username"] = user.get("username")
    t["deleted_by_role"] = _actor_role(user)
    _save_persistent_state(sync=True)
    return {"status": "soft_deleted", "id": tile_id}


@app.post("/api/tiles/{tile_id}/restore")
async def restore_tile(tile_id: int, request: Request):
    user = _require_admin_user(request)
    t = next((x for x in STATE["raster_layers"] if x.get("id") == tile_id), None)
    if not t:
        raise HTTPException(status_code=404, detail="Raster layer not found")
    if not _user_can_access_project(user, t.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनाको इमेज्री पुनर्स्थापना गर्न पहुँच छैन। (You cannot restore this project's raster.)")
    t["deleted_at"] = None
    t.pop("deleted_by", None)
    t.pop("deleted_by_username", None)
    t.pop("deleted_by_role", None)
    _save_persistent_state(sync=True)
    return {"status": "restored", "id": tile_id}


@app.delete("/api/tiles/{tile_id}/permanent")
async def permanent_delete_tile(tile_id: int, request: Request):
    # Irreversible tile-archive destruction is exclusive to the MasterAdmin.
    _require_master_user(request)
    raster = next((x for x in STATE["raster_layers"] if x.get("id") == tile_id), None)
    if raster is None:
        raise HTTPException(status_code=404, detail="Raster layer not found")
    released = _purge_raster_assets(raster)
    STATE["raster_layers"] = [x for x in STATE["raster_layers"] if str(x.get("id")) != str(tile_id)]
    _cleanup_raster_references(tile_id)
    _save_persistent_state(sync=True)
    return {"status": "permanently_deleted", "id": tile_id, "bytes_released": released}


@app.post("/api/system/recycle-bin/purge")
async def purge_recycle_bin(request: Request):
    """Master-only purge: permanently removes every recycled layer/tile and its files."""
    _require_master_user(request)
    released = 0
    deleted_layers = list(STATE.get("deleted_vector_layers") or [])
    for layer in list(STATE.get("vector_layers", [])):
        if layer.get("deleted_at"):
            deleted_layers.append(layer)
    for layer in deleted_layers:
        released += _purge_layer_assets(layer)
    deleted_tiles = [r for r in STATE.get("raster_layers", []) if r.get("deleted_at")]
    for raster in deleted_tiles:
        released += _purge_raster_assets(raster)

    deleted_layer_ids = {str(layer.get("id")) for layer in deleted_layers}
    deleted_tile_ids = {str(raster.get("id")) for raster in deleted_tiles}
    STATE["vector_layers"] = [
        l for l in STATE.get("vector_layers", []) if str(l.get("id")) not in deleted_layer_ids
    ]
    for lid in deleted_layer_ids:
        STATE["features_by_layer"].pop(lid, None)
        STATE["audit_edits_by_layer"].pop(lid, None)
        _drop_layer_feature_index(lid)
    STATE["raster_layers"] = [
        r for r in STATE.get("raster_layers", []) if str(r.get("id")) not in deleted_tile_ids
    ]
    for lid in deleted_layer_ids:
        _cleanup_layer_references(lid)
    for tid in deleted_tile_ids:
        _cleanup_raster_references(tid)
    STATE["deleted_vector_layers"] = []
    STATE["deleted_raster_layers"] = []
    _save_persistent_state(sync=True)
    return {
        "status": "purged",
        "layers_deleted": len(deleted_layer_ids),
        "tiles_deleted": len(deleted_tile_ids),
        "bytes_released": released,
    }


def _coords_bounds(coords: Any) -> Optional[tuple[float, float, float, float]]:
    """Recursively computes [min_x, min_y, max_x, max_y] for geometry coordinates."""
    min_x, min_y, max_x, max_y = float("inf"), float("inf"), float("-inf"), float("-inf")
    found = False

    def _walk(c):
        nonlocal min_x, min_y, max_x, max_y, found
        if not c or not isinstance(c, (list, tuple)):
            return
        if len(c) >= 2 and isinstance(c[0], (int, float)) and isinstance(c[1], (int, float)):
            x, y = float(c[0]), float(c[1])
            if not (math.isnan(x) or math.isnan(y)):
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
                found = True
        else:
            for sub in c:
                _walk(sub)

    _walk(coords)
    return (min_x, min_y, max_x, max_y) if found else None


def _feature_intersects_bbox(feat: Dict[str, Any], min_x: float, min_y: float, max_x: float, max_y: float) -> bool:
    """Combines coordinate vertex containment with bounding envelope overlap."""
    coords = feat.get("geometry", {}).get("coordinates")
    if not coords:
        return False
    if _coords_intersect_bbox(coords, min_x, min_y, max_x, max_y):
        return True
    bounds = _coords_bounds(coords)
    if not bounds:
        return False
    f_min_x, f_min_y, f_max_x, f_max_y = bounds
    return not (f_max_x < min_x or f_min_x > max_x or f_max_y < min_y or f_min_y > max_y)


def _feature_approx_area(feat: Dict[str, Any]) -> float:
    """Calculates approximate spatial surface area for TomTom-style LOD prioritization."""
    props = feat.get("properties") or {}
    for k in ("area", "shape_area", "st_area", "sqm", "area_sqm", "calc_area"):
        if k in props and isinstance(props[k], (int, float)):
            return float(props[k])
    coords = feat.get("geometry", {}).get("coordinates")
    b = _coords_bounds(coords)
    if not b:
        return 0.0
    return abs(b[2] - b[0]) * abs(b[3] - b[1])


_ESSENTIAL_VIEWPORT_KEYS = {
    "id", "_id", "gid", "__gid", "object_id", "objectid", "fid",
    "name", "roadname", "road_name", "nepali_nam", "title", "label",
    "roadclass", "road_class", "highway", "class", "type", "category",
    "bldg_code", "building_code", "house_no", "ward", "ward_no", "ward_number",
    "length", "shape_leng", "len", "width", "road_width", "row", "area", "shape_area",
    "status", "_created_by", "_created_by_username", "_updated_by", "_updated_by_username", "kmc_editor", "kmc_editor_id",
}


class SpatialGridIndex:
    """High-performance 2D spatial grid index for lightning-fast sub-millisecond bounding box queries.
    Replaces O(N) linear coordinate traversals with O(1) bucket lookups.
    Includes multi-tier LOD geometry simplification cache and adaptive viewport quota limits.
    """
    def __init__(self, layer_id: Any, features: list[dict], cell_size: float = 0.005):
        self.layer_id = layer_id
        self.features = features
        self.cell_size = cell_size
        self.grid: dict[tuple[int, int], list[int]] = {}
        self.bounds: list[tuple[float, float, float, float]] = []
        self.areas: list[float] = []
        self.is_line = False
        self._lod_cache: dict[tuple[int, int], dict] = {}
        self._build()

    def _build(self):
        cs = self.cell_size
        line_count = 0
        for idx, feat in enumerate(self.features):
            geom = feat.get("geometry") or {}
            gtype = (geom.get("type") or "").lower()
            if "line" in gtype:
                line_count += 1
            coords = geom.get("coordinates")
            b = _coords_bounds(coords) if coords else None
            if not b or any(math.isinf(v) or math.isnan(v) for v in b):
                self.bounds.append((0.0, 0.0, 0.0, 0.0))
                self.areas.append(0.0)
                continue

            f_min_x, f_min_y, f_max_x, f_max_y = b
            self.bounds.append(b)

            props = feat.get("properties") or {}
            importance = 0.0

            if "line" in gtype:
                # Road & Line hierarchy ranking
                rc = str(props.get("roadclass") or props.get("road_class") or props.get("highway") or props.get("class") or "").lower()
                if any(x in rc for x in ("nh", "national", "expressway", "freeway", "motorway", "trunk")):
                    importance += 1000000.0
                elif any(x in rc for x in ("district", "municipal", "primary", "arterial", "ring")):
                    importance += 100000.0
                elif any(x in rc for x in ("secondary", "collector", "c")):
                    importance += 10000.0
                elif any(x in rc for x in ("tertiary", "d", "residential")):
                    importance += 1000.0

                for k in ("length", "shape_leng", "length_int", "len", "distance"):
                    val = props.get(k)
                    if val is not None:
                        try:
                            importance += float(val)
                            break
                        except Exception:
                            pass

                for k in ("road_width", "row", "width", "foot_width"):
                    val = props.get(k)
                    if val is not None:
                        try:
                            importance += float(val) * 20.0
                            break
                        except Exception:
                            pass

                if importance < 1000.0:
                    importance += math.hypot(f_max_x - f_min_x, f_max_y - f_min_y) * 111000.0
            else:
                # Polygon surface area or point significance ranking
                for k in ("area", "shape_area", "st_area", "sqm", "area_sqm", "calc_area"):
                    val = props.get(k)
                    if val is not None:
                        try:
                            importance = float(val)
                            break
                        except Exception:
                            pass
                if importance == 0.0:
                    # Accurately compute footprint area in square meters from bounding coordinates
                    lat_mid = (f_min_y + f_max_y) * 0.5
                    lat_rad = math.radians(max(min(lat_mid, 89.0), -89.0))
                    dx_m = abs(f_max_x - f_min_x) * 111139.0 * math.cos(lat_rad)
                    dy_m = abs(f_max_y - f_min_y) * 111139.0
                    importance = dx_m * dy_m
                if importance <= 0.0:
                    importance = 1.0

            self.areas.append(importance)

            start_x = int(math.floor(f_min_x / cs))
            end_x = int(math.floor(f_max_x / cs))
            start_y = int(math.floor(f_min_y / cs))
            end_y = int(math.floor(f_max_y / cs))

            # Guard against invalid outlier coordinates spanning the planet
            if (end_x - start_x > 25) or (end_y - start_y > 25):
                start_x = max(start_x, end_x - 25)
                start_y = max(start_y, end_y - 25)

            for gx in range(start_x, end_x + 1):
                for gy in range(start_y, end_y + 1):
                    cell = (gx, gy)
                    if cell not in self.grid:
                        self.grid[cell] = []
                    self.grid[cell].append(idx)

        self.is_line = (line_count > len(self.features) * 0.5)

    def query(
        self,
        min_x: float,
        min_y: float,
        max_x: float,
        max_y: float,
        zoom: Optional[float] = None,
        limit: Optional[int] = None,
    ) -> list[dict]:
        # Normalize coordinate bounds and detect lat/lon reversal
        norm_min_x, norm_max_x = min(min_x, max_x), max(min_x, max_x)
        norm_min_y, norm_max_y = min(min_y, max_y), max(min_y, max_y)
        if norm_min_x < 45.0 and norm_min_y >= 45.0:
            norm_min_x, norm_min_y = norm_min_y, norm_min_x
            norm_max_x, norm_max_y = norm_max_y, norm_max_x
            norm_min_x, norm_max_x = min(norm_min_x, norm_max_x), max(norm_min_x, norm_max_x)
            norm_min_y, norm_max_y = min(norm_min_y, norm_max_y), max(norm_min_y, norm_max_y)
        min_x, max_x = norm_min_x, norm_max_x
        min_y, max_y = norm_min_y, norm_max_y

        cs = self.cell_size
        start_x = int(math.floor(min_x / cs))
        end_x = int(math.floor(max_x / cs))
        start_y = int(math.floor(min_y / cs))
        end_y = int(math.floor(max_y / cs))

        candidate_indices = set()
        for gx in range(start_x, end_x + 1):
            for gy in range(start_y, end_y + 1):
                bucket = self.grid.get((gx, gy))
                if bucket:
                    candidate_indices.update(bucket)

        if not candidate_indices:
            return []

        # Filter candidate indices against bounding envelope
        matched = []
        for idx in candidate_indices:
            f_min_x, f_min_y, f_max_x, f_max_y = self.bounds[idx]
            if not (f_max_x < min_x or f_min_x > max_x or f_max_y < min_y or f_min_y > max_y):
                matched.append(idx)

        if not matched:
            return []

        # Sort candidate indices by area descending (instant lookup into precalculated areas)
        if len(matched) > 50:
            areas = self.areas
            matched.sort(key=lambda i: areas[i], reverse=True)

        # Progressive Zoom LOD detail filtering for ALL vector layers:
        # Fewer in lower zoom levels, progressively higher in higher zoom levels!
        lod_level = 0
        simp_tol = 0.0
        if zoom is not None:
            z = float(zoom)
            if self.is_line:
                if z < 11.5:
                    max_quota = 300
                    lod_level = 3
                    simp_tol = 0.0004
                elif z < 13.0:
                    max_quota = 800
                    lod_level = 2
                    simp_tol = 0.00015
                elif z < 14.5:
                    max_quota = 1500
                    lod_level = 2
                    simp_tol = 0.00008
                elif z < 16.0:
                    max_quota = 3000
                    lod_level = 1
                    simp_tol = 0.00003
                else:
                    max_quota = 5000
                    lod_level = 0
                    simp_tol = 0.0
            else:
                if z < 11.5:
                    max_quota = 500
                    lod_level = 3
                    simp_tol = 0.00005
                elif z < 13.0:
                    max_quota = 1200
                    lod_level = 2
                    simp_tol = 0.00002
                elif z < 14.5:
                    max_quota = 2500
                    lod_level = 2
                    simp_tol = 0.00001
                elif z < 16.0:
                    max_quota = 4000
                    lod_level = 1
                    simp_tol = 0.000005
                else:
                    max_quota = 6000
                    lod_level = 0
                    simp_tol = 0.0

            if len(matched) > max_quota:
                matched = matched[:max_quota]

        max_limit = limit if (limit is not None and limit > 0) else 10000
        if len(matched) > max_limit:
            matched = matched[:max_limit]

        features = self.features
        if lod_level == 0:
            return [features[i] for i in matched]

        out = []
        for idx in matched:
            feat = features[idx]
            geom = self._lod_cache.get((idx, lod_level))
            if geom is None:
                orig_geom = feat.get("geometry")
                if orig_geom and orig_geom.get("coordinates") and simp_tol > 0:
                    try:
                        g = shape(orig_geom)
                        s = g.simplify(simp_tol, preserve_topology=True)
                        m = mapping(s)
                        coords = m.get("coordinates")
                        if not s.is_empty and coords and len(coords) > 0 and s.geom_type in ("Polygon", "MultiPolygon", "LineString", "MultiLineString", "Point", "MultiPoint"):
                            geom = m
                        else:
                            geom = orig_geom
                    except Exception:
                        geom = orig_geom
                else:
                    geom = orig_geom
                self._lod_cache[(idx, lod_level)] = geom

            props = feat.get("properties") or {}
            if isinstance(props, dict) and len(props) > 8:
                clean_props = {k: v for k, v in props.items() if k.lower() in _ESSENTIAL_VIEWPORT_KEYS}
                if "id" not in clean_props and "_id" not in clean_props:
                    clean_props["id"] = feat.get("id") or props.get("id") or idx
            else:
                clean_props = props

            out.append({
                "type": "Feature",
                "id": feat.get("id") or (props.get("id") if isinstance(props, dict) else idx),
                "geometry": geom,
                "properties": clean_props,
            })
        return out


def _drop_layer_feature_index(layer_id: Any) -> None:
    lid_str = str(layer_id)
    for key in [k for k, v in _FEATURE_ID_INDEX.items() if str(v[0]) == lid_str]:
        _FEATURE_ID_INDEX.pop(key, None)


def set_layer_features(layer_id: Any, features: list):
    """Sets features for a layer ensuring all key representations (int and str) stay 100% in sync."""
    clean = _sanitize_features_for_client(features) if isinstance(features, list) else features
    lid_str = str(layer_id)
    STATE["features_by_layer"][lid_str] = clean
    if lid_str.isdigit():
        STATE["features_by_layer"][int(lid_str)] = clean
    _drop_layer_feature_index(lid_str)
    if isinstance(clean, list) and len(clean) <= 10000:
        for f in clean:
            fid = f.get("id")
            if fid is not None:
                _FEATURE_ID_INDEX[str(fid)] = (layer_id, f)
            f_id = (f.get("properties") or {}).get("_id")
            if f_id is not None:
                _FEATURE_ID_INDEX[str(f_id)] = (layer_id, f)


def get_layer_features_list(layer_id: Any) -> list:
    """Gets features for a layer checking memory cache and loading on demand from dedicated layer files."""
    _reload_state_if_modified()
    lid_str = str(layer_id)
    feats = (
        STATE["features_by_layer"].get(lid_str)
        or (STATE["features_by_layer"].get(int(lid_str)) if lid_str.isdigit() else None)
        or STATE["features_by_layer"].get(layer_id)
    )
    if feats:
        return feats

    # Lazy-load on demand from dedicated layer files in uploads/layers
    uploads_layers_dir = os.path.join(get_uploads_dir(), "layers")
    candidate_paths = [
        os.path.join(uploads_layers_dir, f"{lid_str}_features.json"),
        os.path.join(uploads_layers_dir, f"{lid_str}.geojson"),
    ]
    for l in STATE.get("vector_layers", []):
        if str(l.get("id")) == lid_str and l.get("filename"):
            candidate_paths.append(os.path.join(uploads_layers_dir, l["filename"]))
            break

    for p in candidate_paths:
        if os.path.exists(p):
            if os.path.getsize(p) > 10 * 1024 * 1024:
                print(f"[KMC-BACKEND] Layer {lid_str} file {p} is {os.path.getsize(p)} bytes (>10MB); skipping direct in-memory JSON load to preserve memory.")
                continue
            try:
                with open(p, "r", encoding="utf-8", errors="replace") as f:
                    content = json.load(f)
                loaded_feats = []
                if isinstance(content, dict) and "features" in content and isinstance(content["features"], list):
                    loaded_feats = content["features"]
                elif isinstance(content, list):
                    loaded_feats = content
                elif isinstance(content, dict) and content.get("type") == "Feature":
                    loaded_feats = [content]

                clean = _sanitize_features_for_client(loaded_feats)
                set_layer_features(layer_id, clean)
                return clean
            except Exception as e:
                print(f"[KMC-BACKEND] Notice loading features for layer {lid_str} from {p}: {e}")
                break

    return []


def extend_linestring(line_geom: LineString, extension_distance: float) -> LineString:
    """Extends a 2D LineString at both endpoints along their tangents."""
    try:
        coords = list(line_geom.coords)
        if len(coords) < 2:
            return line_geom
        p0 = coords[0]
        p1 = coords[1]
        dx0 = p0[0] - p1[0]
        dy0 = p0[1] - p1[1]
        len0 = math.hypot(dx0, dy0)
        if len0 > 1e-9:
            scale0 = extension_distance / len0
            coords[0] = (p0[0] + dx0 * scale0, p0[1] + dy0 * scale0)

        pn = coords[-1]
        pn_prev = coords[-2]
        dxn = pn[0] - pn_prev[0]
        dyn = pn[1] - pn_prev[1]
        lenn = math.hypot(dxn, dyn)
        if lenn > 1e-9:
            scalen = extension_distance / lenn
            coords[-1] = (pn[0] + dxn * scalen, pn[1] + dyn * scalen)
        return LineString(coords)
    except Exception:
        return line_geom


SPATIAL_INDEXES: Dict[Any, SpatialGridIndex] = {}
_SPATIAL_INDEX_LOCK = threading.Lock()


def get_or_build_spatial_index(layer_id: Any) -> Optional[SpatialGridIndex]:
    with _SPATIAL_INDEX_LOCK:
        if layer_id in SPATIAL_INDEXES:
            return SPATIAL_INDEXES[layer_id]
        str_id = str(layer_id)
        if str_id in SPATIAL_INDEXES:
            return SPATIAL_INDEXES[str_id]

        feats = get_layer_features_list(layer_id)
        if not feats:
            return None

        idx = SpatialGridIndex(layer_id, feats)
        SPATIAL_INDEXES[layer_id] = idx
        SPATIAL_INDEXES[str_id] = idx
        return idx


def invalidate_spatial_index(layer_id: Any):
    with _SPATIAL_INDEX_LOCK:
        SPATIAL_INDEXES.pop(layer_id, None)
        SPATIAL_INDEXES.pop(str(layer_id), None)
    _EMPTY_CHECKED_LAYERS.discard(str(layer_id))
    try:
        invalidate_mvt_cache_for_layer(str(layer_id))
    except Exception:
        pass


def _preingest_vector_layers_to_spatial_db():
    """Pre-ingests small-to-medium active vector layers into spatial_features.db on startup."""
    try:
        layers = list(STATE.get("vector_layers", []))
        for l in layers:
            lid = l.get("id")
            if not lid:
                continue
            lid_str = str(lid)
            cnt = get_layer_feature_count(lid_str)
            if cnt == 0:
                feats = get_layer_features_list(lid)
                if feats and len(feats) < 10000:
                    try:
                        ingest_features_to_spatial_index(lid_str, feats)
                        print(f"[SPATIAL-DB] Pre-indexed vector layer {lid_str} ({len(feats)} features).")
                    except Exception as e:
                        print(f"[SPATIAL-DB] Pre-index notice for {lid_str}: {e}")
    except Exception as e:
        print(f"[SPATIAL-DB] Pre-ingest notice: {e}")


def _warm_spatial_indexes_background():
    """Builds spatial indexes for active vector layers asynchronously on startup."""
    def _worker():
        uploads_layers_dir = os.path.join(get_uploads_dir(), "layers")
        for l in list(STATE.get("vector_layers", [])):
            lid = l.get("id")
            fcount = l.get("feature_count") or 0
            fn = l.get("filename") or ""
            # Guard: only warm small-to-medium layers with known feature count (0 < fcount < 10000)
            # Never warm uncounted (0) or massive enterprise layers to prevent worker OOM crashes.
            if not lid or fcount <= 0 or fcount >= 10000:
                continue
            if fn:
                fp = os.path.join(uploads_layers_dir, fn)
                if os.path.exists(fp) and os.path.getsize(fp) > 5 * 1024 * 1024:
                    continue
            try:
                get_or_build_spatial_index(lid)
            except Exception as w_err:
                print(f"[SPATIAL-GRID] Notice warming layer {lid}: {w_err}")
        print("[SPATIAL-GRID] Background spatial grid indexing completed for active vector layers.")
    threading.Thread(target=_worker, daemon=True).start()


# ---- 4. Vector Layers Endpoints ----

def _is_public_viewer(user: Optional[Dict[str, Any]]) -> bool:
    """True for unauthenticated callers or BasicViewer/MunicipalUser (never Admins or project staff)."""
    if user is None:
        return True
    role = _actor_role(user)
    return role not in ADMIN_ROLES and role not in FIELD_ROLES


def _build_service_links(
    layer: Dict[str, Any],
    request_base: str,
    user: Optional[Dict[str, Any]],
) -> Optional[Dict[str, str]]:
    """Returns OGC/WMS/WFS/MVT/XYZ endpoint URLs for authorized GIS clients (QGIS)."""
    if not layer or _is_public_viewer(user):
        return None
    lid = layer.get("id")
    base = str(request_base or "").rstrip("/")
    slug = re.sub(r"[^a-zA-Z0-9_-]", "_", str(layer.get("name") or f"layer_{lid}")).strip("_").lower() or f"layer_{lid}"
    return {
        "ogc_features": f"{base}/api/ogc/collections/{lid}/items",
        "wms": f"{base}/api/geoserver/wms?service=WMS&version=1.3.0&request=GetCapabilities&layers=kmc:{slug}",
        "wfs": f"{base}/api/geoserver/wfs?service=WFS&version=2.0.0&request=GetCapabilities&typeNames=kmc:{slug}",
        "mvt": f"{base}/api/tiles/vector/{lid}/{{z}}/{{x}}/{{y}}.pbf",
        "xyz": f"{base}/api/tiles/data/{slug}/{{z}}/{{x}}/{{y}}.png",
    }


def _layer_visible_to_user(layer: Dict[str, Any], user: Optional[Dict[str, Any]]) -> bool:
    """Global layers are public; project layers are strictly scoped (DepartmentAdmin included). Public-enabled project layers are visible in public geoportal."""
    if _is_super_user(user):
        return True
    if layer.get("project_id") in (None, ""):
        return True
    if layer.get("published_in_geoportal") or (layer.get("published") and layer.get("access_level") == "public"):
        return True
    if user is None:
        return False
    return _user_can_access_project(user, layer.get("project_id"))


@app.get("/api/layers")
async def list_layers(request: Request, all_layers: bool = False, include_features: bool = False):
    """Ultra-fast layer metadata catalog (<5ms). Features are streamed on-demand or via viewport bbox."""
    _reload_state_if_modified()
    user = resolve_request_user(request)
    layers = []
    for l in STATE["vector_layers"]:
        if l.get("deleted_at"):
            continue
        if not _layer_visible_to_user(l, user):
            continue
        if not all_layers and not l.get("is_global") and l.get("project_id") not in (None, ""):
            # `all_layers=false` is the global catalog. Project-only layers require an
            # explicit project-scoped request. Global layers are always included.
            continue
        feats = STATE["features_by_layer"].get(l["id"], []) if include_features else []
        if include_features and not _is_admin_user(user):
            feats = _portal_filter_feature_properties(l, user, feats)
        service_links = _build_service_links(l, str(request.base_url), user)
        db_cnt = get_layer_feature_count(str(l["id"]))
        layer_fc = db_cnt if db_cnt > 0 else (l.get("feature_count") if l.get("feature_count") is not None else len(feats))
        raw_op = l.get("opacity")
        norm_op = 100 if (raw_op == 1 or raw_op == 1.0 or raw_op is None) else (int(raw_op * 100) if (isinstance(raw_op, (int, float)) and 0 < raw_op < 1) else raw_op)
        layer_dict = {
            **_layer_metadata_for_user(l, user),
            "feature_count": layer_fc,
            "opacity": norm_op,
            "validator_download_allowed": _layer_download_allowed(l, {"role": "Validator"}),
            "editable_by_collectors": _project_layer_is_editable(_find_project(l.get("project_id")), l, {"role": "DataCollector"}),
            "features": {"type": "FeatureCollection", "features": feats} if include_features else None,
            **({"service_links": service_links} if service_links else {}),
        }
        layers.append(layer_dict)
    return layers


@app.get("/api/projects/{project_id}/layers")
async def list_project_layers(project_id: int, request: Request, all_layers: bool = False, include_features: bool = False):
    _reload_state_if_modified()
    user = resolve_request_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    rec = _get_or_create_project_assignment(project_id)
    assigned_layer_ids = {str(x) for x in (rec.get("assigned_layer_ids") or [])}
    if isinstance(project.get("layer_ids"), list):
        assigned_layer_ids.update(str(x) for x in project["layer_ids"])
    hn_cfg = project.get("house_numbering_config") or {}
    for k in ("building_layer_id", "road_layer_id", "gate_layer_id"):
        if hn_cfg.get(k):
            assigned_layer_ids.add(str(hn_cfg[k]))
    if project.get("aoi_source_layer_id"):
        assigned_layer_ids.add(str(project["aoi_source_layer_id"]))
    for ol_id in (project.get("offline_layer_ids") or []):
        assigned_layer_ids.add(str(ol_id))

    layers = []
    for l in STATE["vector_layers"]:
        if l.get("deleted_at"):
            continue
        # Directly owned by the project OR explicitly linked/assigned to the project
        is_owner = str(l.get("project_id")) == str(project_id)
        is_assigned = str(l.get("id")) in assigned_layer_ids
        if not (is_owner or is_assigned):
            continue
        feats = (STATE["features_by_layer"].get(l["id"], []) or STATE["features_by_layer"].get(str(l["id"]), [])) if include_features else []
        if include_features and not _is_admin_user(user):
            feats = _portal_filter_feature_properties(l, user, feats)
        service_links = _build_service_links(l, str(request.base_url), user)
        layers.append({
            **_layer_metadata_for_user(l, user),
            "feature_count": l.get("feature_count") if l.get("feature_count") is not None else len(feats),
            "validator_download_allowed": _layer_download_allowed(l, {"role": "Validator"}),
            "editable_by_collectors": _project_layer_is_editable(project, l, {"role": "DataCollector"}),
            "features": {"type": "FeatureCollection", "features": feats} if include_features else None,
            **({"service_links": service_links} if service_links else {}),
        })
    return layers


@app.get("/api/layers/deleted")
async def list_deleted_layers(request: Request):
    user = resolve_request_user(request)
    if not _is_admin_user(user):
        raise HTTPException(status_code=403, detail="रिसाइकल बिन हेर्न प्रशासक अधिकार आवश्यक छ। (Administrator role required.)")
    return [
        l
        for l in STATE["vector_layers"]
        if l.get("deleted_at") and _user_can_access_project(user, l.get("project_id"))
    ]


@app.get("/api/layers/{layer_id}")
async def get_layer(layer_id: int, request: Request, include_features: bool = True):
    _reload_state_if_modified()
    user = resolve_request_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        _load_persistent_state()
        layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो तहमा पहुँच छैन। (You do not have access to this layer.)")
    feats = STATE["features_by_layer"].get(layer_id, []) or STATE["features_by_layer"].get(str(layer_id), [])
    if include_features and not _is_admin_user(user):
        feats = _portal_filter_feature_properties(layer, user, feats)
    service_links = _build_service_links(layer, str(request.base_url), user)
    return {
        **_layer_metadata_for_user(layer, user),
        "feature_count": len(feats),
        "features": {"type": "FeatureCollection", "features": feats} if include_features else None,
        **({"service_links": service_links} if service_links else {}),
    }


@app.get("/api/layers/{layer_id}/download")
async def download_layer(layer_id: int, request: Request, format: str = "geojson"):
    """Layer download: administrators by default; validators only on granted layers."""
    user = _require_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is None or layer.get("deleted_at"):
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if layer.get("project_id") is None:
        if not (_is_super_user(user) or _actor_role(user) == "GisAdmin"):
            raise HTTPException(
                status_code=403,
                detail="सार्वजनिक (Global) तह परिमार्जन गर्न मास्टर, सुपर वा GIS प्रशासक अधिकार आवश्यक छ। (Global layers can only be modified by Master, Super, or GIS administrators.)"
            )
    elif not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    if not _layer_download_allowed(layer, user):
        raise HTTPException(status_code=403, detail="यो तह डाउनलोड गर्न अनुमति छैन। (Download permission for this layer has not been granted.)")

    if await _is_postgis_layer(layer.get("id")):
        features = await _get_all_postgis_features(layer.get("id"))
    else:
        features = get_layer_features_list(layer.get("id"))
    if not _is_admin_user(user):
        features = _portal_filter_feature_properties(layer, user, features)
    safe_name = re.sub(r"[^A-Za-z0-9_-]+", "_", str(layer.get("name") or f"layer_{layer_id}")).strip("_") or f"layer_{layer_id}"
    if str(format).lower() == "csv":
        import csv
        import io

        field_names = []
        for feature in features:
            for key in (feature.get("properties") or {}):
                if not str(key).startswith("_") and key not in field_names:
                    field_names.append(key)
        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(["feature_id", "geometry"] + field_names)
        for feature in features:
            props = feature.get("properties") or {}
            writer.writerow([feature.get("id"), json.dumps(feature.get("geometry") or {})] + [props.get(key, "") for key in field_names])
        return Response(
            content=buffer.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": f'attachment; filename="{safe_name}.csv"'},
        )
    return Response(
        content=json.dumps({"type": "FeatureCollection", "features": features}, ensure_ascii=False),
        media_type="application/geo+json",
        headers={"Content-Disposition": f'attachment; filename="{safe_name}.geojson"'},
    )


@app.get("/api/layers/{layer_id}/features")
async def get_layer_features(
    layer_id: Any,
    request: Request,
    bbox: Optional[str] = None,
    zoom: Optional[float] = None,
    limit: Optional[int] = None,
    portal: bool = False,
):
    """TomTom-Style Progressive Sub-Millisecond Spatial LOD Viewport Streaming:
    - O(1) SpatialGridIndex bucket lookup with bounding envelope filtering (<3ms).
    - Features pre-sorted by footprint area.
    - Street/block zoom returns 100% of all features in the viewport.
    - Zero event-loop blocking.
    """
    _reload_state_if_modified()
    user = resolve_request_user(request)
    layer = next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो तहमा पहुँच छैन। (You do not have access to this layer.)")
    if portal and not _is_admin_user(user):
        if _is_public_viewer(user) and (layer.get("published") is False or layer.get("public_visible") is False):
            raise HTTPException(status_code=403, detail="यो तह हाल सार्वजनिक गरिएको छैन। (This layer is not published to public portal.)")
        if not _portal_access_allowed(layer, user):
            raise HTTPException(status_code=403, detail="यो तह हेर्न अनुमति छैन। (This layer is not published for your role.)")
    if not portal and user is None:
        # Raw feature streams are an internal (staff) contract; the public
        # portal must use portal=1 so field permissions stay enforced.
        raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")

    # 1. PostGIS-accelerated Spatial LOD Viewport Query
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
            check_q = text("SELECT EXISTS(SELECT 1 FROM vector_features WHERE layer_id = :lid LIMIT 1);")
            has_pg = (await conn.execute(check_q, {"lid": pg_lid})).scalar()
            if has_pg:
                max_features = limit if (limit and limit > 0) else (2500 if not bbox else 5000)
                geom_expr = "geom"
                if zoom is not None:
                    if zoom < 14:
                        geom_expr = "ST_SimplifyPreserveTopology(geom, 0.0001)"
                    elif zoom < 17:
                        geom_expr = "ST_SimplifyPreserveTopology(geom, 0.00002)"

                fc_text = None
                if bbox:
                    parts = [float(p.strip()) for p in bbox.split(",")]
                    if len(parts) == 4:
                        min_x, min_y, max_x, max_y = parts
                        q = text(f"""
                            SELECT json_build_object(
                                'type', 'FeatureCollection',
                                'features', COALESCE(json_agg(
                                    json_build_object(
                                        'type', 'Feature',
                                        'id', id,
                                        'geometry', ST_AsGeoJSON(geom)::json,
                                        'properties', properties || jsonb_build_object('_id', id)
                                    )
                                ), '[]'::json)
                            )::text
                            FROM (
                                SELECT id, {geom_expr} AS geom, properties
                                FROM vector_features
                                WHERE layer_id = :lid
                                  AND geom && ST_MakeEnvelope(:min_x, :min_y, :max_x, :max_y, 4326)
                                LIMIT :lim
                            ) sub;
                        """)
                        res = await conn.execute(q, {
                            "lid": pg_lid,
                            "min_x": min_x,
                            "min_y": min_y,
                            "max_x": max_x,
                            "max_y": max_y,
                            "lim": max_features,
                        })
                        fc_text = res.scalar()
                else:
                    q = text(f"""
                        SELECT json_build_object(
                            'type', 'FeatureCollection',
                            'features', COALESCE(json_agg(
                                json_build_object(
                                    'type', 'Feature',
                                    'id', id,
                                    'geometry', ST_AsGeoJSON(geom)::json,
                                    'properties', properties || jsonb_build_object('_id', id)
                                )
                            ), '[]'::json)
                        )::text
                        FROM (
                            SELECT id, {geom_expr} AS geom, properties
                            FROM vector_features
                            WHERE layer_id = :lid
                            LIMIT :lim
                        ) sub;
                    """)
                    res = await conn.execute(q, {
                        "lid": pg_lid,
                        "lim": max_features,
                    })
                    fc_text = res.scalar()
                if fc_text:
                    fc_obj = json.loads(fc_text)
                    pg_feats = fc_obj.get("features") or []
                    if portal or not _is_admin_user(user):
                        pg_feats = _portal_filter_feature_properties(layer, user, pg_feats)
                    return {"type": "FeatureCollection", "features": _sanitize_features_for_client(pg_feats)}
    except Exception as e:
        print(f"[POSTGIS-LAYER-QUERY] Warning querying layer {layer_id}: {e}")

    # 2. SQLite R-Tree Persistent Spatial Store (e.g. Roads 11k, Buildings 168k)
    db_cnt = get_layer_feature_count(str(layer_id))
    if db_cnt > 0:
        bbox_tuple = None
        if bbox:
            try:
                parts = [float(p.strip()) for p in bbox.split(",")]
                if len(parts) == 4:
                    bbox_tuple = (parts[0], parts[1], parts[2], parts[3])
            except Exception:
                pass
        sp_feats = query_spatial_features(str(layer_id), bbox=bbox_tuple, limit=limit or 2500)
        # Merge any newly created unindexed features
        in_mem = STATE.get("features_by_layer", {}).get(str(layer_id)) or []
        if in_mem:
            existing_ids = {str(f.get("id")) for f in sp_feats}
            for imf in in_mem:
                if str(imf.get("id")) not in existing_ids:
                    sp_feats.append(imf)
        if portal or not _is_admin_user(user):
            sp_feats = _portal_filter_feature_properties(layer, user, sp_feats)
        return {"type": "FeatureCollection", "features": _sanitize_features_for_client(sp_feats)}

    feats = get_layer_features_list(layer_id)

    if bbox:
        try:
            parts = [float(p.strip()) for p in bbox.split(",")]
            if len(parts) == 4:
                min_x, min_y, max_x, max_y = parts
                index = get_or_build_spatial_index(layer_id)
                if index:
                    target_feats = index.query(min_x, min_y, max_x, max_y, zoom=zoom, limit=limit)
                    if portal or not _is_admin_user(user):
                        target_feats = _portal_filter_feature_properties(layer, user, target_feats)
                    return {"type": "FeatureCollection", "features": _sanitize_features_for_client(target_feats)}
        except Exception as e:
            print(f"[SPATIAL-QUERY] Error in spatial index query for layer {layer_id}: {e}")

    target_feats = feats
    if limit is not None and limit > 0:
        target_feats = target_feats[:limit]
    elif not bbox and len(target_feats) > 10000:
        # Default safety ceiling for unbounded full-layer queries to prevent HTTP socket hang up / ECONNRESET
        target_feats = target_feats[:10000]

    if portal or not _is_admin_user(user):
        target_feats = _portal_filter_feature_properties(layer, user, target_feats)
    return {"type": "FeatureCollection", "features": _sanitize_features_for_client(target_feats)}


# ---- House Numbering & Addressing -----------------------------------------

HOUSE_NUMBER_SCHEMES = ("METRIC", "SEQUENTIAL")


def _house_number_editor(request: Request) -> Dict[str, Any]:
    user = _require_user(request)
    if _actor_role(user) not in ADMIN_ROLES and _actor_role(user) not in FIELD_ROLES:
        raise HTTPException(
            status_code=403,
            detail="घर नम्बर व्यवस्थापनका लागि आन्तरिक प्रयोगकर्ता अधिकार आवश्यक छ। (Internal staff role required.)",
        )
    return user


def _find_vector_layer(layer_id: Any) -> Optional[Dict[str, Any]]:
    _reload_state_if_modified()
    layer = next(
        (l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str(layer_id)),
        None,
    )
    if layer is None:
        _reload_state_if_modified(force=True)
        layer = next(
            (l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str(layer_id)),
            None,
        )
    if layer is None:
        _load_persistent_state()
        layer = next(
            (l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str(layer_id)),
            None,
        )
    if layer is None or layer.get("deleted_at"):
        return None
    return layer


def _house_number_ring(geometry: Any) -> list:
    """Returns the first coordinate ring of any GeoJSON geometry as (lng, lat) tuples."""
    if not isinstance(geometry, dict):
        return []
    gtype = geometry.get("type")
    coords = geometry.get("coordinates")
    if not coords:
        return []
    if gtype == "Point":
        ring = [coords]
    elif gtype == "Polygon":
        ring = coords[0] if coords else []
    elif gtype == "MultiPolygon":
        ring = coords[0][0] if coords and coords[0] else []
    elif gtype == "LineString":
        ring = coords
    elif gtype == "MultiLineString":
        ring = coords[0] if coords else []
    else:
        return []
    points = []
    for point in ring:
        try:
            points.append((float(point[0]), float(point[1])))
        except (TypeError, ValueError, IndexError):
            continue
    return points


def _house_number_centroid(geometry: Any) -> Optional[tuple]:
    points = _house_number_ring(geometry)
    if not points:
        return None
    return (
        sum(p[0] for p in points) / len(points),
        sum(p[1] for p in points) / len(points),
    )


def _house_number_lines(geometry: Any) -> list:
    if not isinstance(geometry, dict):
        return []
    gtype = geometry.get("type")
    coords = geometry.get("coordinates") or []
    raw_lines = [coords] if gtype == "LineString" else (coords if gtype == "MultiLineString" else [])
    lines = []
    for raw in raw_lines:
        line = []
        for point in raw:
            try:
                line.append((float(point[0]), float(point[1])))
            except (TypeError, ValueError, IndexError):
                continue
        if len(line) >= 2:
            lines.append(line)
    return lines


def _nearest_on_road(px: float, py: float, lines: list) -> Optional[tuple]:
    """Nearest point in local metres: (distance_m, chainage_m, side, nx, ny)."""
    best = None
    for line in lines:
        chainage = 0.0
        for (ax, ay), (bx, by) in zip(line, line[1:]):
            dx, dy = bx - ax, by - ay
            seg_len = math.hypot(dx, dy)
            if seg_len <= 0:
                continue
            t = ((px - ax) * dx + (py - ay) * dy) / (seg_len * seg_len)
            t = max(0.0, min(1.0, t))
            nx, ny = ax + t * dx, ay + t * dy
            distance = math.hypot(px - nx, py - ny)
            if best is None or distance < best[0]:
                side = "LEFT" if (dx * (py - ay) - dy * (px - ax)) > 0 else "RIGHT"
                best = (distance, chainage + t * seg_len, side, nx, ny)
            chainage += seg_len
    return best


def _house_number_feature(item: Dict[str, Any]) -> Dict[str, Any]:
    properties = {k: v for k, v in item.items() if k != "geometry"}
    geometry = item.get("geometry") or {
        "type": "Point",
        "coordinates": [item.get("longitude"), item.get("latitude")],
    }
    return {"type": "Feature", "id": item.get("id"), "geometry": geometry, "properties": properties}


def _house_number_matches(item: Dict[str, Any], search: str, ward: Optional[str]) -> bool:
    if ward not in (None, "") and str(item.get("ward_no", item.get("ward", ""))) != str(ward):
        return False
    if not search:
        return True
    needle = search.strip().lower()
    haystack = " ".join(
        str(item.get(key) or "")
        for key in ("house_number", "metric_house_no", "road_name", "owner_name", "building_code")
    ).lower()
    return needle in haystack


@app.get("/api/house-numbering/stats")
async def house_numbering_stats(request: Request):
    _require_user(request)
    items = STATE.get("house_numbers", []) or []
    left = sum(1 for h in items if str(h.get("side") or "").upper() == "LEFT")
    verified = sum(
        1 for h in items if h.get("qr_verified") or str(h.get("status") or "").upper() == "VERIFIED"
    )
    wards = {
        str(h.get("ward_no", h.get("ward")))
        for h in items
        if h.get("ward_no") not in (None, "") or h.get("ward") not in (None, "")
    }
    return {
        "total_house_numbers": len(items),
        "total_assigned": sum(1 for h in items if str(h.get("status") or "ASSIGNED").upper() == "ASSIGNED"),
        "verified_count": verified,
        "wards_covered": len(wards),
        "odd_left_count": left,
        "even_right_count": len(items) - left,
        "by_side": {"LEFT": left, "RIGHT": len(items) - left},
        "qr_plates_printed": sum(1 for h in items if h.get("qr_verified")),
    }


@app.get("/api/house-numbering/numbers")
async def list_house_numbers(request: Request, search: str = "", ward: Optional[str] = None):
    _require_user(request)
    items = [
        item
        for item in (STATE.get("house_numbers", []) or [])
        if _house_number_matches(item, search, ward)
    ]
    items.sort(key=lambda h: (str(h.get("road_name") or ""), float(h.get("chainage_m") or 0)))
    return {"type": "FeatureCollection", "features": [_house_number_feature(h) for h in items]}


@app.post("/api/house-numbering/generate")
async def generate_house_numbers(payload: Dict[str, Any], request: Request):
    _reload_state_if_modified()
    user = _house_number_editor(request)
    try:
        road_layer_id = payload.get("road_layer_id")
        building_layer_id = payload.get("building_layer_id")
        interval = max(1.0, float(payload.get("interval_m") or 5.0))
        start_number = max(1, int(payload.get("start_number") or 1))
        max_distance = max(1.0, float(payload.get("max_distance_from_road_m") or 60.0))
    except (TypeError, ValueError):
        raise HTTPException(status_code=400, detail="अमान्य घर नम्बर उत्पादन मापदण्ड। (Invalid numbering parameters.)")

    if road_layer_id in (None, "") or building_layer_id in (None, ""):
        raise HTTPException(status_code=400, detail="सडक र भवन तह दुवै आवश्यक छन्। (Road and building layers are required.)")
    road_layer = _find_vector_layer(road_layer_id)
    if road_layer is None:
        raise HTTPException(status_code=404, detail="सडक तह भेटिएन। (Road layer not found.)")
    building_layer = _find_vector_layer(building_layer_id)
    if building_layer is None:
        raise HTTPException(status_code=404, detail="भवन तह भेटिएन। (Building layer not found.)")
    for source_layer in (road_layer, building_layer):
        if not _user_can_access_project(user, source_layer.get("project_id")):
            raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")

    road_features = get_layer_features_list(road_layer.get("id"))
    road_feature = next(
        (f for f in road_features if str(f.get("id")) == str(payload.get("road_feature_id"))),
        None,
    )
    if road_feature is None:
        raise HTTPException(status_code=404, detail="लक्षित सडक भेटिएन। (Selected road feature not found.)")
    lines = _house_number_lines(road_feature.get("geometry"))
    if not lines:
        raise HTTPException(status_code=400, detail="छानिएको सडकमा मान्य लाइन ज्यामिति छैन। (Selected road has no valid line geometry.)")

    road_props = road_feature.get("properties") or {}
    road_name = str(payload.get("road_name") or road_props.get("name") or road_props.get("road_name") or f"Road-{road_feature.get('id')}")
    ward = str(payload.get("ward") or "10")
    try:
        ward_no = int(ward)
    except ValueError:
        ward_no = 0
    prefix = str(payload.get("prefix") or f"W{ward}-")
    scheme = str(payload.get("numbering_scheme") or "METRIC").upper()
    if scheme not in HOUSE_NUMBER_SCHEMES:
        raise HTTPException(status_code=400, detail="अमान्य नम्बरिङ विधि। (numbering_scheme must be METRIC or SEQUENTIAL.)")

    lon0, lat0 = lines[0][0]
    metres_x = 111320.0 * math.cos(math.radians(lat0))
    metres_y = 110540.0

    def to_local(lng: float, lat: float) -> tuple:
        return (lng - lon0) * metres_x, (lat - lat0) * metres_y

    local_lines = [[to_local(lng, lat) for lng, lat in line] for line in lines]

    candidates = []
    isolated_candidates = []
    for building in get_layer_features_list(building_layer.get("id")):
        centroid = _house_number_centroid(building.get("geometry"))
        if centroid is None:
            continue
        px, py = to_local(*centroid)
        nearest = _nearest_on_road(px, py, local_lines)
        if nearest is None or nearest[0] > max_distance:
            isolated_candidates.append(
                {
                    "building": building,
                    "centroid": centroid,
                    "distance_m": round(nearest[0], 1) if nearest else 999.0,
                    "chainage_m": 0.0,
                    "side": "ISOLATED",
                }
            )
            continue
        candidates.append(
            {
                "building": building,
                "centroid": centroid,
                "distance_m": round(nearest[0], 1),
                "chainage_m": round(nearest[1], 1),
                "side": nearest[2],
            }
        )
    candidates.sort(key=lambda c: (c["chainage_m"], str(c["building"].get("id"))))

    existing = STATE.get("house_numbers", []) or []
    used_numbers = {str(h.get("house_number")) for h in existing}
    def _building_key(building_id: Any, road: str, ward_value: Any) -> tuple:
        return (str(building_id), str(road), str(ward_value))

    existing_by_building = {
        _building_key(h.get("building_id"), h.get("road_name"), h.get("ward_no", h.get("ward"))): h
        for h in existing
    }
    used_buildings = set(existing_by_building)
    next_id = max(
        (int(h.get("id")) for h in existing if str(h.get("id") or "").isdigit()),
        default=0,
    ) + 1

    proposals = []
    for index, candidate in enumerate(candidates):
        building = candidate["building"]
        props = building.get("properties") or {}
        side = candidate["side"]
        assigned_key = _building_key(building.get("id"), road_name, ward_no)
        assigned = existing_by_building.get(assigned_key)
        if assigned is not None:
            house_number = assigned.get("house_number")
            side = assigned.get("side") or side
        else:
            if scheme == "METRIC":
                # Metric addressing: number follows chainage (snapped to the interval
                # grid), odd on the left side, even on the right.
                snapped = int(round(candidate["chainage_m"] / interval) * interval)
                metric_number = max(start_number, snapped)
                if side == "LEFT" and metric_number % 2 == 0:
                    metric_number += 1
                elif side == "RIGHT" and metric_number % 2 == 1:
                    metric_number += 1
            else:
                metric_number = start_number + index
            house_number = f"{prefix}{metric_number}"
            bump = 2 if scheme == "METRIC" else 1
            while house_number in used_numbers:
                metric_number += bump
                house_number = f"{prefix}{metric_number}"
            used_numbers.add(house_number)

        longitude, latitude = candidate["centroid"]
        proposal = {
            "id": next_id + len(proposals),
            "building_id": building.get("id"),
            "house_number": house_number,
            "metric_house_no": f"{house_number}{'L' if side == 'LEFT' else 'R'}",
            "building_code": props.get("bldg_code") or props.get("building_code") or f"KMC-BLD-{building.get('id')}",
            "owner_name": props.get("owner_name") or props.get("owner") or "",
            "road_name": road_name,
            "ward": ward,
            "ward_no": ward_no,
            "side": side,
            "chainage_m": candidate["chainage_m"],
            "metric_distance": candidate["chainage_m"],
            "distance_m": candidate["distance_m"],
            "latitude": round(latitude, 7),
            "longitude": round(longitude, 7),
            "status": "ASSIGNED",
            "qr_verified": False,
            "geometry": {"type": "Point", "coordinates": [round(longitude, 7), round(latitude, 7)]},
        }
        if assigned is not None:
            proposal["id"] = assigned.get("id", proposal["id"])
            proposal["status"] = assigned.get("status") or "ASSIGNED"
            proposal["qr_verified"] = bool(assigned.get("qr_verified"))
            proposal["owner_name"] = assigned.get("owner_name") or proposal["owner_name"]
        proposals.append(proposal)

    # Process isolated / off-road buildings (RNR: Road Not Required)
    rnr_counter = 1
    for candidate in isolated_candidates:
        building = candidate["building"]
        props = building.get("properties") or {}
        assigned_key = _building_key(building.get("id"), "RNR", ward_no)
        assigned = existing_by_building.get(assigned_key)
        if assigned is not None:
            house_number = assigned.get("house_number")
        else:
            house_number = f"{prefix}RNR-{rnr_counter}"
            while house_number in used_numbers:
                rnr_counter += 1
                house_number = f"{prefix}RNR-{rnr_counter}"
            used_numbers.add(house_number)
            rnr_counter += 1

        longitude, latitude = candidate["centroid"]
        proposal = {
            "id": next_id + len(proposals),
            "building_id": building.get("id"),
            "house_number": house_number,
            "metric_house_no": house_number,
            "building_code": props.get("bldg_code") or props.get("building_code") or f"KMC-BLD-{building.get('id')}",
            "owner_name": props.get("owner_name") or props.get("owner") or "",
            "road_name": "Non-Road / RNR",
            "ward": ward,
            "ward_no": ward_no,
            "side": "ISOLATED",
            "chainage_m": 0.0,
            "metric_distance": 0.0,
            "distance_m": candidate["distance_m"],
            "latitude": round(latitude, 7),
            "longitude": round(longitude, 7),
            "status": "ASSIGNED",
            "qr_verified": False,
            "geometry": {"type": "Point", "coordinates": [round(longitude, 7), round(latitude, 7)]},
        }
        if assigned is not None:
            proposal["id"] = assigned.get("id", proposal["id"])
            proposal["status"] = assigned.get("status") or "ASSIGNED"
            proposal["qr_verified"] = bool(assigned.get("qr_verified"))
            proposal["owner_name"] = assigned.get("owner_name") or proposal["owner_name"]
        proposals.append(proposal)

    saved_count = 0
    if payload.get("save_to_database"):
        for proposal in proposals:
            key = (str(proposal["building_id"]), str(proposal["road_name"]), str(proposal["ward_no"]))
            if key in used_buildings:
                continue
            used_buildings.add(key)
            existing.append(proposal)
            saved_count += 1
        STATE["house_numbers"] = existing

        # Write generated house numbers directly back into the designated attribute field in the Buildings layer
        b_id_map = {str(p["building_id"]): p["house_number"] for p in proposals}
        feats = get_layer_features_list(building_layer.get("id"))
        for b_feat in feats:
            b_fid = str(b_feat.get("id"))
            if b_fid in b_id_map:
                b_props = b_feat.setdefault("properties", {})
                b_props["house_number"] = b_id_map[b_fid]
                b_props["metric_house_no"] = b_id_map[b_fid]
        set_layer_features(building_layer.get("id"), feats)
        invalidate_spatial_index(building_layer.get("id"))

        # Synchronize into PostGIS if table is active
        try:
            engine = get_engine()
            async with engine.connect() as conn:
                for b_id_str, hn_val in b_id_map.items():
                    if b_id_str.isdigit():
                        await conn.execute(
                            text("UPDATE vector_features SET properties = properties || jsonb_build_object('house_number', :hn, 'metric_house_no', :hn) WHERE layer_id = :lid AND (id = :bid OR record_id = :brid);"),
                            {"hn": hn_val, "lid": int(building_layer["id"]), "bid": int(b_id_str), "brid": str(b_id_str)}
                        )
                await conn.commit()
        except Exception as pg_hn_err:
            print(f"[HOUSE-NUMBERING] Notice updating PostGIS properties: {pg_hn_err}")

        if saved_count:
            _save_persistent_state()

    left_count = sum(1 for p in proposals if p["side"] == "LEFT")
    isolated_count = len(isolated_candidates)
    return {
        "total_buildings_detected": len(candidates) + isolated_count,
        "road_connected_count": len(candidates),
        "isolated_rnr_count": isolated_count,
        "left_side_count": left_count,
        "right_side_count": len(candidates) - left_count,
        "saved_count": saved_count,
        "proposals": proposals,
    }


@app.put("/api/house-numbering/numbers/{number_id}")
async def update_house_number(number_id: int, payload: Dict[str, Any], request: Request):
    _house_number_editor(request)
    items = STATE.get("house_numbers", []) or []
    item = next((h for h in items if str(h.get("id")) == str(number_id)), None)
    if item is None:
        raise HTTPException(status_code=404, detail="घर नम्बर भेटिएन। (House number not found.)")
    editable = {
        "house_number", "metric_house_no", "owner_name", "road_name", "ward", "ward_no",
        "side", "chainage_m", "metric_distance", "distance_m", "latitude", "longitude",
        "status", "qr_verified", "building_code",
    }
    for key, value in payload.items():
        if key in editable:
            item[key] = value
    if str(payload.get("status") or "").upper() == "VERIFIED":
        item["qr_verified"] = True
    item["updated_at"] = time.time()
    if isinstance(item.get("latitude"), (int, float)) and isinstance(item.get("longitude"), (int, float)):
        item["geometry"] = {
            "type": "Point",
            "coordinates": [float(item["longitude"]), float(item["latitude"])],
        }
    _save_persistent_state(sync=True)
    return {"status": "updated", "id": number_id, "house_number": item.get("house_number")}


@app.delete("/api/house-numbering/numbers/{number_id}")
async def delete_house_number(number_id: int, request: Request):
    _require_admin_user(request)
    items = STATE.get("house_numbers", []) or []
    remaining = [h for h in items if str(h.get("id")) != str(number_id)]
    if len(remaining) == len(items):
        raise HTTPException(status_code=404, detail="घर नम्बर भेटिएन। (House number not found.)")
    STATE["house_numbers"] = remaining
    _save_persistent_state(sync=True)
    return {"status": "deleted", "id": number_id}


@app.get("/api/house-numbering/export")
async def export_house_numbers(request: Request, format: str = "geojson", ward: Optional[str] = None):
    _require_user(request)
    items = [h for h in (STATE.get("house_numbers", []) or []) if _house_number_matches(h, "", ward)]
    items.sort(key=lambda h: (str(h.get("road_name") or ""), float(h.get("chainage_m") or 0)))
    if str(format).lower() == "csv":
        import csv
        import io

        buffer = io.StringIO()
        writer = csv.writer(buffer)
        writer.writerow(
            ["id", "house_number", "road_name", "ward", "side", "chainage_m", "status", "latitude", "longitude"]
        )
        for item in items:
            writer.writerow(
                [
                    item.get("id"),
                    item.get("house_number") or item.get("metric_house_no"),
                    item.get("road_name"),
                    item.get("ward") or item.get("ward_no"),
                    item.get("side"),
                    item.get("chainage_m") or item.get("distance_m") or "",
                    item.get("status") or "ASSIGNED",
                    item.get("latitude"),
                    item.get("longitude"),
                ]
            )
        return Response(
            content=buffer.getvalue(),
            media_type="text/csv; charset=utf-8",
            headers={"Content-Disposition": 'attachment; filename="kmc_house_numbers.csv"'},
        )
    return {
        "type": "FeatureCollection",
        "features": [_house_number_feature(item) for item in items],
    }


_HOUSE_NUMBER_OUTPUT_FIELDS = [
    {"name": "house_number", "label": "House Number", "type": "text", "required": False, "visible_in_popup": True},
    {"name": "metric_number", "label": "Metric Number", "type": "number", "required": False, "visible_in_popup": True},
    {"name": "road_name", "label": "Road Name", "type": "text", "required": False, "visible_in_popup": True},
    {"name": "side", "label": "Road Side", "type": "text", "required": False, "visible_in_popup": True},
    {"name": "metric_distance_m", "label": "Metric Distance (m)", "type": "number", "required": False, "visible_in_popup": True},
    {"name": "distance_from_road_m", "label": "Distance from Road (m)", "type": "number", "required": False, "visible_in_popup": True},
]


def _register_house_numbering_fields(layer: Dict[str, Any], include_gate_ref: bool = False) -> None:
    fields = list(layer.get("fields_config") or [])
    existing = {str(f.get("name")) for f in fields if isinstance(f, dict)}
    extras = list(_HOUSE_NUMBER_OUTPUT_FIELDS)
    if include_gate_ref:
        extras.append(
            {"name": "gate_feature_id", "label": "Gate Feature ID", "type": "text", "required": False, "visible_in_popup": True}
        )
    changed = False
    for fdef in extras:
        if fdef["name"] not in existing:
            fields.append(dict(fdef))
            existing.add(fdef["name"])
            changed = True
    if changed:
        layer["fields_config"] = fields


def _run_metric_house_numbering_core(
    project: Dict[str, Any],
    building_layer: Dict[str, Any],
    gate_layer: Dict[str, Any],
    road_layer: Dict[str, Any],
    road_features: List[Dict[str, Any]],
    gate_features: List[Dict[str, Any]],
    building_features: List[Dict[str, Any]],
) -> Tuple[Dict[str, Any], List[Dict[str, Any]], List[Dict[str, Any]]]:
    """Core precision metric house-numbering engine shared by sync and PostGIS async paths."""
    cfg = project.get("house_numbering_config") or {}
    link_field = str(cfg.get("link_field") or "building_id").strip()
    road_name_field = str(cfg.get("road_name_field") or "name").strip()

    roads_data = []
    all_lngs, all_lats = [], []

    for rf in road_features:
        geom = rf.get("geometry") or {}
        lines = _house_number_lines(geom)
        valid_lines = [ln for ln in lines if len(ln) >= 2]
        if not valid_lines:
            continue
        props = rf.get("properties") or {}
        raw_rname = (
            props.get(road_name_field)
            or props.get("name")
            or props.get("road_name")
            or props.get("street_name")
            or props.get("name_en")
            or props.get("name_ne")
            or ""
        )
        rname = re.sub(r"/+", "-", str(raw_rname).strip()).strip() if raw_rname else "RNR"
        if not rname:
            rname = "RNR"
        roads_data.append({
            "road_feature": rf,
            "road_name": rname,
            "lines": valid_lines,
        })
        for ln in valid_lines:
            for pt in ln:
                all_lngs.append(pt[0])
                all_lats.append(pt[1])

    if not roads_data:
        raise HTTPException(status_code=400, detail="सडक तहमा कुनै पनि मान्य रेखा ज्यामिति भेटिएन। (No valid road lines found.)")

    clng = sum(all_lngs) / len(all_lngs)
    clat = sum(all_lats) / len(all_lats)
    phi = math.radians(clat)
    # WGS84 ellipsoidal meters-per-degree at exact latitude (or pyproj EPSG:32645 in Nepal zone)
    meters_y = 111132.92 - 559.82 * math.cos(2.0 * phi) + 1.175 * math.cos(4.0 * phi)
    meters_x = 111412.84 * math.cos(phi) - 93.5 * math.cos(3.0 * phi)

    pyproj_transformer = None
    if 84.0 <= clng <= 90.0 and 26.0 <= clat <= 31.0:
        try:
            from pyproj import Transformer
            pyproj_transformer = Transformer.from_crs("EPSG:4326", "EPSG:32645", always_xy=True)
            cx0, cy0 = pyproj_transformer.transform(clng, clat)
        except Exception:
            pyproj_transformer = None
            cx0, cy0 = 0.0, 0.0
    else:
        cx0, cy0 = 0.0, 0.0

    def to_m(lng: float, lat: float) -> tuple:
        if pyproj_transformer is not None:
            px, py = pyproj_transformer.transform(lng, lat)
            return px - cx0, py - cy0
        return (lng - clng) * meters_x, (lat - clat) * meters_y

    # Preserve continuous chainage across MultiLineString parts of the same road feature
    processed_roads = []
    for rd in roads_data:
        segments = []
        cum = 0.0
        for part_idx, line_coords in enumerate(rd["lines"]):
            pts_m = [to_m(lng, lat) for lng, lat in line_coords]
            for i in range(len(pts_m) - 1):
                p1 = pts_m[i]
                p2 = pts_m[i + 1]
                seg_len = math.hypot(p2[0] - p1[0], p2[1] - p1[1])
                segments.append({
                    "p1": p1,
                    "p2": p2,
                    "length": seg_len,
                    "cum_start": cum,
                    "part_idx": part_idx,
                })
                cum += seg_len
        processed_roads.append({
            "road_name": rd["road_name"],
            "segments": segments,
            "total_length": cum,
            "road_feature_id": rd["road_feature"].get("id"),
        })

    def get_point_coord(geometry: Any) -> Optional[tuple]:
        if not geometry:
            return None
        gtype = str(geometry.get("type", "")).upper()
        coords = geometry.get("coordinates")
        if gtype == "POINT" and isinstance(coords, (list, tuple)) and len(coords) >= 2:
            return float(coords[0]), float(coords[1])
        return _house_number_centroid(geometry)

    # Separate strict link_field lookup from fallback ID lookup (avoids ID/link collisions)
    building_by_explicit_link: Dict[str, Dict[str, Any]] = {}
    building_by_fallback_id: Dict[str, Dict[str, Any]] = {}
    for b in building_features:
        b_props = b.get("properties") or {}
        val = b_props.get(link_field)
        if val is not None and str(val).strip() != "":
            building_by_explicit_link[str(val).strip()] = b
        for fid_cand in (b.get("id"), b_props.get("_id"), b_props.get("id")):
            if fid_cand is not None and str(fid_cand).strip() != "":
                building_by_fallback_id.setdefault(str(fid_cand).strip(), b)

    def _resolve_linked_building(g_props: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        # Handle falsy 0 cleanly via explicit None/blank checks
        for key in (link_field, "target_id", "_target_feature_id", "building_id", "building_linked_id"):
            val = g_props.get(key)
            if val is not None and str(val).strip() != "":
                val_str = str(val).strip()
                matched = building_by_explicit_link.get(val_str)
                if matched is not None:
                    return matched
                matched = building_by_fallback_id.get(val_str)
                if matched is not None:
                    return matched
        return None

    left_count = 0
    right_count = 0
    numbered_gates = 0
    numbered_buildings = 0
    sample_numbers = []
    used_numbers: set = set()
    modified_gates: List[Dict[str, Any]] = []
    modified_buildings: List[Dict[str, Any]] = []

    for gate in gate_features:
        gate_pt = get_point_coord(gate.get("geometry"))
        if not gate_pt:
            continue
        gx, gy = to_m(gate_pt[0], gate_pt[1])

        min_dist = float("inf")
        best_road = None
        best_seg = None
        best_seg_idx = 0
        best_t = 0.0
        best_proj = (0.0, 0.0)

        for r_item in processed_roads:
            for seg_idx, seg in enumerate(r_item["segments"]):
                p1 = seg["p1"]
                p2 = seg["p2"]
                vx = p2[0] - p1[0]
                vy = p2[1] - p1[1]
                v_len_sq = vx * vx + vy * vy
                if v_len_sq == 0:
                    t = 0.0
                else:
                    t = max(0.0, min(1.0, ((gx - p1[0]) * vx + (gy - p1[1]) * vy) / v_len_sq))
                proj_x = p1[0] + t * vx
                proj_y = p1[1] + t * vy
                dist = math.hypot(gx - proj_x, gy - proj_y)
                if dist < min_dist:
                    min_dist = dist
                    best_road = r_item
                    best_seg = seg
                    best_seg_idx = seg_idx
                    best_t = t
                    best_proj = (proj_x, proj_y)

        if not best_road or not best_seg:
            continue

        chainage = best_seg["cum_start"] + best_t * best_seg["length"]

        # Road-bend vertex snapping: use tangent bisector of adjacent segments when snapped to a shared bend vertex
        segs = best_road["segments"]
        p1 = best_seg["p1"]
        p2 = best_seg["p2"]
        vx = p2[0] - p1[0]
        vy = p2[1] - p1[1]
        v_len = math.hypot(vx, vy)
        tx, ty = (vx / v_len, vy / v_len) if v_len > 1e-12 else (1.0, 0.0)

        adj_seg = None
        if best_t <= 1e-6 and best_seg_idx > 0 and segs[best_seg_idx - 1]["part_idx"] == best_seg["part_idx"]:
            adj_seg = segs[best_seg_idx - 1]
        elif best_t >= 1.0 - 1e-6 and best_seg_idx < len(segs) - 1 and segs[best_seg_idx + 1]["part_idx"] == best_seg["part_idx"]:
            adj_seg = segs[best_seg_idx + 1]
        if adj_seg is not None:
            avx = adj_seg["p2"][0] - adj_seg["p1"][0]
            avy = adj_seg["p2"][1] - adj_seg["p1"][1]
            av_len = math.hypot(avx, avy)
            if av_len > 1e-12:
                bx_sum = tx + (avx / av_len)
                by_sum = ty + (avy / av_len)
                b_len = math.hypot(bx_sum, by_sum)
                if b_len > 1e-9:
                    tx, ty = bx_sum / b_len, by_sum / b_len

        ux = gx - best_proj[0]
        uy = gy - best_proj[1]
        cross_product = tx * uy - ty * ux

        if "properties" not in gate or not isinstance(gate["properties"], dict):
            gate["properties"] = {}
        matched_b = _resolve_linked_building(gate["properties"])

        # Collinear gate fallback: use linked building centroid to determine road side
        if abs(cross_product) < 1e-9 and matched_b is not None:
            b_cent = _house_number_centroid(matched_b.get("geometry"))
            if b_cent is not None:
                bcx, bcy = to_m(b_cent[0], b_cent[1])
                cross_product = tx * (bcy - best_proj[1]) - ty * (bcx - best_proj[0])

        is_left = cross_product > 0
        if is_left:
            side_str = "LEFT"
            left_count += 1
            metric_num = max(1, 2 * int(round((chainage - 1.0) / 2.0)) + 1)
        else:
            side_str = "RIGHT"
            right_count += 1
            metric_num = max(2, 2 * int(round(chainage / 2.0)))

        rname = best_road["road_name"]
        while (rname, metric_num) in used_numbers:
            metric_num += 2
        used_numbers.add((rname, metric_num))

        house_no = f"{rname}/{metric_num}"
        gate["properties"]["house_number"] = house_no
        gate["properties"]["metric_number"] = metric_num
        gate["properties"]["road_name"] = rname
        gate["properties"]["side"] = side_str
        gate["properties"]["metric_distance_m"] = round(chainage, 1)
        gate["properties"]["distance_from_road_m"] = round(min_dist, 1)
        numbered_gates += 1
        modified_gates.append(gate)

        if len(sample_numbers) < 10:
            sample_numbers.append(house_no)

        if matched_b is not None:
            if "properties" not in matched_b or not isinstance(matched_b["properties"], dict):
                matched_b["properties"] = {}
            matched_b["properties"]["house_number"] = house_no
            matched_b["properties"]["metric_number"] = metric_num
            matched_b["properties"]["road_name"] = rname
            matched_b["properties"]["side"] = side_str
            matched_b["properties"]["metric_distance_m"] = round(chainage, 1)
            matched_b["properties"]["distance_from_road_m"] = round(min_dist, 1)
            matched_b["properties"]["gate_feature_id"] = gate.get("id")
            numbered_buildings += 1
            modified_buildings.append(matched_b)

    summary = {
        "status": "success",
        "house_numbering_enabled": True,
        "total_gates_processed": len(gate_features),
        "total_gates_numbered": numbered_gates,
        "total_buildings_numbered": numbered_buildings,
        "left_side_count": left_count,
        "right_side_count": right_count,
        "sample_house_numbers": sample_numbers,
    }
    return summary, modified_gates, modified_buildings


def _validate_house_numbering_project_layers(project: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, Any]]:
    if not project.get("house_numbering_enabled", False):
        raise HTTPException(
            status_code=400,
            detail="यस परियोजनामा स्वचालित घर नम्बर मोड सक्रिय गरिएको छैन। (House numbering mode is not enabled for this project.)",
        )
    cfg = project.get("house_numbering_config") or {}
    building_layer_id = cfg.get("building_layer_id")
    gate_layer_id = cfg.get("gate_layer_id")
    road_layer_id = cfg.get("road_layer_id")
    if not building_layer_id or not gate_layer_id or not road_layer_id:
        raise HTTPException(
            status_code=400,
            detail="घर नम्बरका लागि भवन (Building), गेट (Gate) र सडक (Road) तीनवटै तह छनोट गर्नुपर्छ। (Building, Gate, and Road layers must be configured.)",
        )
    building_layer = _find_vector_layer(building_layer_id)
    gate_layer = _find_vector_layer(gate_layer_id)
    road_layer = _find_vector_layer(road_layer_id)
    if not building_layer:
        raise HTTPException(status_code=404, detail=f"भवन तह #{building_layer_id} भेटिएन। (Building layer not found.)")
    if not gate_layer:
        raise HTTPException(status_code=404, detail=f"गेट तह #{gate_layer_id} भेटिएन। (Gate layer not found.)")
    if not road_layer:
        raise HTTPException(status_code=404, detail=f"सडक तह #{road_layer_id} भेटिएन। (Road layer not found.)")

    b_geom = str(building_layer.get("geometry_type") or "").upper()
    g_geom = str(gate_layer.get("geometry_type") or "").upper()
    r_geom = str(road_layer.get("geometry_type") or "").upper()
    if b_geom and b_geom not in ("POLYGON", "MULTIPOLYGON"):
        raise HTTPException(
            status_code=400,
            detail=f"घर नम्बरका लागि भवन तह (Building Layer) बहुभुज (Polygon) हुनुपर्दछ, तर '{building_layer.get('geometry_type')}' छ। (Building layer must be Polygon.)",
        )
    if g_geom and g_geom not in ("POINT", "MULTIPOINT"):
        raise HTTPException(
            status_code=400,
            detail=f"घर नम्बरका लागि गेट तह (Gate Layer) बिन्दु (Point) हुनुपर्दछ, तर '{gate_layer.get('geometry_type')}' छ। (Gate layer must be Point.)",
        )
    if r_geom and r_geom not in ("LINESTRING", "MULTILINESTRING", "LINE"):
        raise HTTPException(
            status_code=400,
            detail=f"घर नम्बरका लागि सडक तह (Road Layer) रेखा (LineString) हुनुपर्दछ, तर '{road_layer.get('geometry_type')}' छ। (Road layer must be LineString.)",
        )
    return building_layer, gate_layer, road_layer


def _calculate_project_metric_house_numbers(project: Dict[str, Any]) -> Dict[str, Any]:
    """Synchronous metric house numbering calculation for in-memory layers."""
    building_layer, gate_layer, road_layer = _validate_house_numbering_project_layers(project)
    road_features = list(get_layer_features_list(road_layer.get("id")))
    gate_features = list(get_layer_features_list(gate_layer.get("id")))
    building_features = list(get_layer_features_list(building_layer.get("id")))

    summary, _mod_gates, _mod_buildings = _run_metric_house_numbering_core(
        project, building_layer, gate_layer, road_layer,
        road_features, gate_features, building_features,
    )
    set_layer_features(gate_layer.get("id"), gate_features)
    set_layer_features(building_layer.get("id"), building_features)
    _register_house_numbering_fields(gate_layer, include_gate_ref=False)
    _register_house_numbering_fields(building_layer, include_gate_ref=True)
    invalidate_spatial_index(gate_layer.get("id"))
    invalidate_spatial_index(building_layer.get("id"))
    _save_persistent_state(sync=True)
    return summary


async def _calculate_project_metric_house_numbers_async(
    project: Dict[str, Any],
    user: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """PostGIS-aware async metric house numbering calculation with batch DB updates."""
    building_layer, gate_layer, road_layer = _validate_house_numbering_project_layers(project)
    road_pg = await _is_postgis_layer(road_layer.get("id"))
    gate_pg = await _is_postgis_layer(gate_layer.get("id"))
    bldg_pg = await _is_postgis_layer(building_layer.get("id"))

    road_features = await _get_all_postgis_features(road_layer.get("id")) if road_pg else list(get_layer_features_list(road_layer.get("id")))
    gate_features = await _get_all_postgis_features(gate_layer.get("id")) if gate_pg else list(get_layer_features_list(gate_layer.get("id")))
    building_features = await _get_all_postgis_features(building_layer.get("id")) if bldg_pg else list(get_layer_features_list(building_layer.get("id")))

    summary, mod_gates, mod_buildings = _run_metric_house_numbering_core(
        project, building_layer, gate_layer, road_layer,
        road_features, gate_features, building_features,
    )

    uid = (user or {}).get("id")
    if gate_pg and mod_gates:
        pg_glid = int(str(gate_layer.get("id"))) if str(gate_layer.get("id")).isdigit() else gate_layer.get("id")
        engine = get_engine()
        async with engine.begin() as conn:
            for gf in mod_gates:
                db_id = gf.get("_db_id") or (int(str(gf.get("id"))) if str(gf.get("id")).isdigit() else None)
                if db_id is not None:
                    await conn.execute(
                        text("""
                            UPDATE vector_features
                            SET properties = properties || CAST(:props AS jsonb),
                                updated_by = :uid,
                                version = version + 1
                            WHERE layer_id = :lid AND id = :db_id;
                        """),
                        {"props": json.dumps(gf.get("properties") or {}), "uid": uid, "lid": pg_glid, "db_id": db_id},
                    )
        _drop_layer_feature_index(gate_layer.get("id"))
    else:
        set_layer_features(gate_layer.get("id"), gate_features)

    if bldg_pg and mod_buildings:
        pg_blid = int(str(building_layer.get("id"))) if str(building_layer.get("id")).isdigit() else building_layer.get("id")
        engine = get_engine()
        async with engine.begin() as conn:
            for bf in mod_buildings:
                db_id = bf.get("_db_id") or (int(str(bf.get("id"))) if str(bf.get("id")).isdigit() else None)
                if db_id is not None:
                    await conn.execute(
                        text("""
                            UPDATE vector_features
                            SET properties = properties || CAST(:props AS jsonb),
                                updated_by = :uid,
                                version = version + 1
                            WHERE layer_id = :lid AND id = :db_id;
                        """),
                        {"props": json.dumps(bf.get("properties") or {}), "uid": uid, "lid": pg_blid, "db_id": db_id},
                    )
        _drop_layer_feature_index(building_layer.get("id"))
    else:
        set_layer_features(building_layer.get("id"), building_features)

    _register_house_numbering_fields(gate_layer, include_gate_ref=False)
    _register_house_numbering_fields(building_layer, include_gate_ref=True)
    invalidate_spatial_index(gate_layer.get("id"))
    invalidate_spatial_index(building_layer.get("id"))
    _save_persistent_state(sync=True)
    return summary


@app.get("/api/projects/{project_id}/house-numbering")
async def get_project_house_numbering(project_id: int, request: Request):
    user = resolve_request_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन।")
    cfg = project.get("house_numbering_config") or {}
    return {
        "house_numbering_enabled": bool(project.get("house_numbering_enabled", False)),
        "house_numbering_config": cfg,
    }


@app.post("/api/projects/{project_id}/house-numbering/generate")
async def generate_project_house_numbers_endpoint(project_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन।")

    if "house_numbering_config" in payload or "house_numbering_enabled" in payload or any(k.startswith("house_numbering_") for k in payload):
        _apply_project_fields(project, payload, user)
        _save_persistent_state(sync=True)

    return await _calculate_project_metric_house_numbers_async(project, user=user)


@app.post("/api/layers")
async def create_layer(payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    layer_id = int(time.time() * 1000)
    project_id = payload.get("project_id")
    if project_id in (None, ""):
        project_id = None
    if project_id is None and not _is_super_user(user):
        raise HTTPException(
            status_code=403,
            detail="सार्वजनिक (Global) तह केवल मास्टर/सुपर प्रशासकले सिर्जना गर्न सक्छ। "
                   "(Only a master/super administrator can create global layers.)",
        )
    if project_id is not None:
        _require_project(project_id)
        if not _user_can_access_project(user, project_id):
            raise HTTPException(
                status_code=403,
                detail="यो परियोजनामा तह सिर्जना गर्न पहुँच छैन। (You cannot create layers in this project.)",
            )

    geom_type = _canonical_geometry_type(payload.get("geometry_type") or "Polygon")
    creation_geoms = _canonical_geometry_list(payload.get("creation_geometry_types"))
    if not creation_geoms:
        if geom_type == "Mix":
            creation_geoms = ["Point", "LineString", "Polygon"]
        else:
            creation_geoms = [geom_type]

    is_global_val = payload.get("is_global")
    if is_global_val is None:
        is_global_val = project_id is None
    if project_id is not None:
        is_global_val = False

    questionnaire_id = payload.get("questionnaire_id")
    fields_config = payload.get("fields_config") or []
    if questionnaire_id is not None:
        linked_questionnaire = next(
            (q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(questionnaire_id)),
            None,
        )
        if linked_questionnaire is None:
            raise HTTPException(status_code=404, detail="प्रश्नावली भेटिएन। (Questionnaire not found.)")
        q_proj_id = linked_questionnaire.get("project_id")
        if q_proj_id is not None and not _user_can_access_project(user, q_proj_id):
            raise HTTPException(status_code=403, detail="यो प्रश्नावलीको परियोजनामा पहुँच छैन। (No access to the questionnaire's project.)")
        if (
            q_proj_id is not None
            and project_id is not None
            and str(q_proj_id) != str(project_id)
        ):
            raise HTTPException(
                status_code=400,
                detail="तह र प्रश्नावली एउटै परियोजनाको हुनुपर्छ। (The layer and questionnaire must belong to the same project.)",
            )
        fields_config = _merge_questionnaire_fields(linked_questionnaire, fields_config)

    new_layer = {
        "id": layer_id,
        "name": payload.get("name") or "नयाँ भेक्टर तह",
        "description": payload.get("description") or "",
        "type": "vector",
        "geometry_type": geom_type,
        "creation_geometry_types": creation_geoms,
        "category": payload.get("category") or "भू-स्थानिक तहहरू (Spatial Layers)",
        "is_global": bool(is_global_val),
        "project_id": project_id,
        "questionnaire_id": questionnaire_id,
        "allow_snapping": payload.get("allow_snapping") is not False,
        # Layers start locked (viewer mode) until an administrator explicitly
        # unlocks them for field editing.
        "editable_by_collectors": payload.get("editable_by_collectors") is True,
        "published": True,
        "default_visible": True,
        "access_level": "public",
        "opacity": 1,
        "feature_count": 0,
        "bounds": payload.get("bounds") or [85.31, 27.682, 85.345, 27.702],
        "bbox": payload.get("bbox") or [85.31, 27.682, 85.345, 27.702],
        "style": payload.get("style") or {"strokeColor": "#0447AF", "fillColor": "#0447AF", "strokeWidth": 2.5, "clickTolerance": 14},
        "fields_config": fields_config,
        "geometry_fields_config": payload.get("geometry_fields_config") or {},
        "created_at": time.time(),
    }
    STATE["vector_layers"].insert(0, new_layer)
    STATE["features_by_layer"][layer_id] = []
    _save_persistent_state(sync=True)
    return new_layer


@app.post("/api/projects/{project_id}/layers")
async def create_project_layer(project_id: int, payload: Dict[str, Any], request: Request):
    payload_copy = dict(payload)
    payload_copy["project_id"] = project_id
    payload_copy["is_global"] = False
    return await create_layer(payload_copy, request)


@app.put("/api/layers/{layer_id}")
async def update_layer(layer_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        _load_persistent_state()
        layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if layer.get("project_id") is None:
        if not (_is_super_user(user) or _actor_role(user) == "GisAdmin"):
            raise HTTPException(
                status_code=403,
                detail="सार्वजनिक (Global) तह परिमार्जन गर्न मास्टर, सुपर वा GIS प्रशासक अधिकार आवश्यक छ। (Global layers can only be modified by Master, Super, or GIS administrators.)"
            )
    elif not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")

    updates = dict(payload)
    if "project_id" in updates:
        next_project_id = updates.get("project_id")
        if next_project_id in (None, ""):
            next_project_id = None
        if str(next_project_id) != str(layer.get("project_id")):
            # Moving a layer between projects (or to the public global scope)
            # would break project isolation, so it stays a super-admin action.
            if not _is_super_user(user):
                raise HTTPException(
                    status_code=403,
                    detail="तह एक परियोजनाबाट अर्कोमा सार्न वा सार्वजनिक बनाउन मास्टर/सुपर प्रशासक अधिकार आवश्यक छ। "
                           "(Only a master/super administrator can move a layer between projects.)",
                )
        if next_project_id is not None and not _user_can_access_project(user, next_project_id):
            raise HTTPException(status_code=403, detail="यो परियोजनामा तह सार्न पहुँच छैन। (No access to the target project.)")
        updates["project_id"] = next_project_id
    if "geometry_type" in updates:
        updates["geometry_type"] = _canonical_geometry_type(updates.get("geometry_type"))
    if "creation_geometry_types" in updates:
        creation = _canonical_geometry_list(updates.get("creation_geometry_types"))
        updates["creation_geometry_types"] = creation or [updates.get("geometry_type") or layer.get("geometry_type") or "Point"]

    # Linking a questionnaire is a schema operation: keep the layer's editable
    # fields in sync with the questionnaire questions unless the admin supplied an
    # explicit fields_config in the same request.
    if "questionnaire_id" in updates:
        questionnaire_id = updates.get("questionnaire_id")
        if questionnaire_id is not None:
            questionnaire = next(
                (q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(questionnaire_id)),
                None,
            )
            if questionnaire is None:
                raise HTTPException(
                    status_code=404,
                    detail="प्रश्नावली भेटिएन। (Questionnaire not found.)",
                )
            q_proj_id = questionnaire.get("project_id")
            target_project_id = updates.get("project_id", layer.get("project_id"))
            if (
                q_proj_id is not None
                and target_project_id is not None
                and str(q_proj_id) != str(target_project_id)
            ):
                raise HTTPException(
                    status_code=400,
                    detail="तह र प्रश्नावली एउटै परियोजनाको हुनुपर्छ। (The layer and questionnaire must belong to the same project.)",
                )
            updates["fields_config"] = _merge_questionnaire_fields(
                questionnaire,
                updates.get("fields_config") or layer.get("fields_config"),
            )

    layer.update({k: v for k, v in updates.items() if k not in ("id", "type")})
    _save_persistent_state(sync=True)
    return layer


@app.delete("/api/layers/{layer_id}")
async def delete_layer(layer_id: int, request: Request):
    user = _require_admin_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        _load_persistent_state()
        layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनाको तह मेटाउन पहुँच छैन। (You cannot delete this project's layer.)")
    layer["deleted_at"] = time.time()
    layer["deleted_by"] = user.get("id")
    layer["deleted_by_username"] = user.get("username")
    layer["deleted_by_role"] = _actor_role(user)
    _save_persistent_state(sync=True)
    return {"status": "soft_deleted", "id": layer_id}


@app.post("/api/layers/{layer_id}/restore")
async def restore_layer(layer_id: int, request: Request):
    user = _require_admin_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        _load_persistent_state()
        layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनाको तह पुनर्स्थापना गर्न पहुँच छैन। (You cannot restore this project's layer.)")
    layer["deleted_at"] = None
    layer.pop("deleted_by", None)
    layer.pop("deleted_by_username", None)
    layer.pop("deleted_by_role", None)
    _save_persistent_state(sync=True)
    return {"status": "restored", "id": layer_id}


@app.delete("/api/layers/{layer_id}/permanent")
async def permanent_delete_layer(layer_id: int, request: Request):
    # Irreversible file + metadata destruction is exclusive to the MasterAdmin.
    _require_master_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        _load_persistent_state()
        layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        raise HTTPException(status_code=404, detail="Layer not found")
    removed_assets = _purge_layer_assets(layer)
    STATE["vector_layers"] = [l for l in STATE["vector_layers"] if str(l.get("id")) != str(layer_id)]
    STATE["features_by_layer"].pop(layer_id, None)
    STATE["features_by_layer"].pop(str(layer_id), None)
    STATE.get("audit_edits_by_layer", {}).pop(str(layer_id), None)
    STATE.get("audit_edits_by_layer", {}).pop(layer_id, None)
    _drop_layer_feature_index(layer_id)
    invalidate_spatial_index(layer_id)
    _cleanup_layer_references(layer_id)
    _save_persistent_state(sync=True)
    return {"status": "permanently_deleted", "id": layer_id, "removed_assets": removed_assets}


@app.get("/api/layers/{layer_id}/fields")
async def get_layer_fields(layer_id: int, request: Request, rescan: bool = False):
    user = resolve_request_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        _load_persistent_state()
        layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")
    if not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो तहमा पहुँच छैन। (You do not have access to this layer.)")

    fields = layer.get("fields_config")
    if not fields or rescan:
        feats = STATE["features_by_layer"].get(layer_id, []) or STATE["features_by_layer"].get(str(layer_id), [])
        if not feats:
            try:
                from app.spatial_engine import get_spatial_db_conn, resolve_layer_id_variants
                s_conn = get_spatial_db_conn()
                s_cur = s_conn.cursor()
                variants = resolve_layer_id_variants(str(layer_id))
                placeholders = ",".join("?" for _ in variants)
                s_cur.execute(f"SELECT properties_json FROM feature_records WHERE layer_id IN ({placeholders}) LIMIT 50", list(variants))
                rows = s_cur.fetchall()
                if rows:
                    feats = [{"properties": json.loads(r[0])} for r in rows if r[0]]
            except Exception as e:
                pass
        detected = {}
        for f in feats[:300]:
            props = f.get("properties") or {}
            for k, v in props.items():
                if k in ("geometry", "geom", "the_geom") or str(k).startswith("_"):
                    continue
                if k not in detected:
                    ftype = "text"
                    if isinstance(v, bool):
                        ftype = "checkbox"
                    elif isinstance(v, (int, float)):
                        ftype = "number"
                    detected[k] = {
                        "name": k,
                        "label": k.replace("_", " ").title(),
                        "type": ftype,
                        "required": False,
                        "is_unique": False,
                        "visible_in_popup": True,
                    }
        fields = list(detected.values())
        layer["fields_config"] = fields
        _save_persistent_state()

    visible_fields = _portal_visible_fields(layer, user, fields) if not _is_admin_user(user) else (fields or [])
    if not _is_admin_user(user):
        visible_fields = [
            field for field in visible_fields
            if not str(field.get("name") or "").startswith("_")
        ]
    role = _actor_role(user) or "BasicViewer"
    editable_fields = (
        visible_fields
        if _is_admin_user(user)
        else [field for field in visible_fields if _field_entry_allowed(field, role)]
    )
    geometry_fields_config = layer.get("geometry_fields_config", {}) or {}
    if not _is_admin_user(user) and isinstance(geometry_fields_config, dict):
        geometry_fields_config = {
            geometry_type: [
                field for field in (geometry_type_fields or [])
                if isinstance(field, dict)
                and _field_entry_allowed(field, role)
                and _field_read_allowed(field, role, layer.get("field_permissions") or {})
            ]
            for geometry_type, geometry_type_fields in geometry_fields_config.items()
        }
    return {
        "fields": visible_fields,
        "editable_fields": editable_fields,
        "geometry_fields_config": geometry_fields_config,
        "creation_geometry_types": layer.get("creation_geometry_types", []),
        "editable_by_collectors": layer.get("editable_by_collectors") is True,
        "field_permissions": layer.get("field_permissions", {}) if _is_admin_user(user) else {},
    }


@app.put("/api/layers/{layer_id}/fields")
async def update_layer_fields(layer_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if not layer:
        raise HTTPException(status_code=404, detail="Layer not found")

    user_role = _actor_role(user)
    if user_role == "DepartmentAdmin":
        user_dept = user.get("department") or user.get("department_name")
        layer_dept = layer.get("department") or layer.get("department_name")
        can_access = False
        if layer_dept and user_dept and str(layer_dept).strip().lower() == str(user_dept).strip().lower():
            can_access = True
        elif layer.get("project_id") and _user_can_access_project(user, layer.get("project_id")):
            can_access = True
        if not can_access:
            raise HTTPException(
                status_code=403,
                detail="तपाईंको विभागसँग सम्बन्धित तह मात्र सम्पादन गर्न सकिन्छ। (Only layers associated with your department can be edited.)",
            )
    elif not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनाको तह परिवर्तन गर्न पहुँच छैन। (You cannot modify this project's layer.)")

    fields = payload.get("fields")
    if fields is not None:
        layer["fields_config"] = fields
        # Synchronize unique field settings from fields configuration
        uniq_f = next((f for f in fields if f.get("is_unique")), None)
        if uniq_f:
            layer["unique_field"] = uniq_f.get("name")
            mode = uniq_f.get("id_mode") or uniq_f.get("unique_mode") or "manual"
            layer["unique_mode"] = "autogenerate" if mode in ("auto", "autogenerate") else "manual"
            layer["unique_prefix"] = uniq_f.get("id_prefix") or uniq_f.get("unique_prefix") or ""
        elif "unique_field" not in payload:
            layer["unique_field"] = None

    if "unique_field" in payload:
        layer["unique_field"] = payload.get("unique_field")
    if "unique_mode" in payload:
        layer["unique_mode"] = payload.get("unique_mode")
    if "unique_prefix" in payload:
        layer["unique_prefix"] = payload.get("unique_prefix")

    if "creation_geometry_types" in payload:
        layer["creation_geometry_types"] = _canonical_geometry_list(payload.get("creation_geometry_types"))
    if "geometry_fields_config" in payload:
        layer["geometry_fields_config"] = payload["geometry_fields_config"]
    if "field_permissions" in payload and isinstance(payload.get("field_permissions"), dict):
        layer["field_permissions"] = payload["field_permissions"]

    _save_persistent_state(sync=True)
    return {
        "status": "updated",
        "fields": layer.get("fields_config", []),
        "geometry_fields_config": layer.get("geometry_fields_config", {}),
        "field_permissions": layer.get("field_permissions", {}),
        "unique_field": layer.get("unique_field"),
        "unique_mode": layer.get("unique_mode", "manual"),
        "unique_prefix": layer.get("unique_prefix", ""),
    }


@app.get("/api/layers/{layer_id}/extent")
async def get_layer_extent(layer_id: int, request: Request):
    user = resolve_request_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is not None and not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो तहमा पहुँच छैन। (You do not have access to this layer.)")
    b = layer.get("bounds", [85.31, 27.682, 85.345, 27.702]) if layer else [85.31, 27.682, 85.345, 27.702]
    return {"bounds": b, "extent": b, "bbox": b}


@app.get("/api/layers/{layer_id}/next-id")
async def get_layer_next_id(layer_id: int, request: Request, geom_type: Optional[str] = None):
    user = resolve_request_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो तहमा पहुँच छैन। (You do not have access to this layer.)")
    feats = STATE["features_by_layer"].get(layer_id, []) or STATE["features_by_layer"].get(str(layer_id), [])
    return {"next_id": len(feats) + 1, "total": len(feats)}


@app.get("/api/layers/{layer_id}/audit-edits")
async def get_layer_audit_edits(layer_id: int, request: Request, limit: int = 100):
    user = _require_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो तहको अडिट लग हेर्ने पहुँच छैन। (No access to this layer's audit log.)")
    log = STATE.get("audit_edits_by_layer", {}).get(str(layer_id))
    if log is None:
        log = STATE.get("audit_edits_by_layer", {}).get(layer_id, [])
    return list(log or [])[:max(1, min(limit, 5000))]


@app.post("/api/layers/{layer_id}/primary-key")
async def set_layer_primary_key(layer_id: Any, payload: Dict[str, Any], request: Request):
    """
    Enforces a designated field as the Layer Primary Key / Unique ID.
    If values of the primary key are empty, null, or duplicate,
    auto-generates guaranteed unique IDs and returns audit stats with detailed records.
    """
    user = _require_admin_user(request)
    layer = _find_vector_layer(layer_id)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    _enforce_layer_write_access(layer, user)

    pk_field = str(payload.get("primary_key_field") or "").strip()
    if not pk_field:
        raise HTTPException(status_code=400, detail="प्राथमिक कुञ्जी फिल्ड (primary_key_field) नाम आवश्यक छ।")

    prefix = str(payload.get("prefix") or "").strip()
    autogenerate = bool(payload.get("autogenerate_missing", True))

    # 1. Apply primary key in SQLite spatial database
    res = apply_layer_primary_key_sqlite(
        layer_id=layer_id,
        primary_key_field=pk_field,
        autogenerate_missing=autogenerate,
        prefix=prefix,
    )

    # 2. Synchronize in PostGIS if layer exists in PostGIS
    is_pg = await _is_postgis_layer(layer_id)
    if is_pg:
        try:
            engine = get_engine()
            async with engine.begin() as conn:
                pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
                q_sel = text("SELECT id, record_id, properties FROM vector_features WHERE layer_id = :lid ORDER BY id ASC;")
                rows = (await conn.execute(q_sel, {"lid": pg_lid})).fetchall()
                pg_seen = set()
                pg_updates = []
                pg_seq = 1
                pg_prefix = res.get("prefix") or (prefix or f"KMC-{pk_field[:4].upper()}-")

                for r in rows:
                    props = dict(r.properties or {})
                    val = props.get(pk_field)
                    needs_gen = False
                    if val is None or str(val).strip().lower() in ("", "null", "none", "nan", "undefined"):
                        needs_gen = True
                    else:
                        s_val = str(val).strip()
                        if s_val in pg_seen:
                            needs_gen = True
                        else:
                            pg_seen.add(s_val)

                    if needs_gen and autogenerate:
                        cand = f"{pg_prefix}{pg_seq:05d}"
                        while cand in pg_seen:
                            pg_seq += 1
                            cand = f"{pg_prefix}{pg_seq:05d}"
                        pg_seen.add(cand)
                        pg_seq += 1
                        props[pk_field] = cand
                        props["_id"] = cand
                        pg_updates.append({"id": r.id, "props": json.dumps(props), "rec_id": cand})

                for pu in pg_updates:
                    await conn.execute(
                        text("UPDATE vector_features SET properties = CAST(:props AS jsonb), record_id = :rec_id WHERE id = :id;"),
                        pu,
                    )
        except Exception as pg_err:
            print(f"[KMC-BACKEND] Notice during PostGIS PK sync: {pg_err}")

    # 3. Synchronize in-memory features if present
    feats = get_layer_features_list(layer_id)
    if feats:
        mem_seen = set()
        mem_seq = 1
        mem_prefix = res.get("prefix") or (prefix or f"KMC-{pk_field[:4].upper()}-")
        for f in feats:
            props = f.setdefault("properties", {})
            val = props.get(pk_field)
            needs_gen = False
            if val is None or str(val).strip().lower() in ("", "null", "none", "nan", "undefined"):
                needs_gen = True
            else:
                s_val = str(val).strip()
                if s_val in mem_seen:
                    needs_gen = True
                else:
                    mem_seen.add(s_val)

            if needs_gen and autogenerate:
                cand = f"{mem_prefix}{mem_seq:05d}"
                while cand in mem_seen:
                    mem_seq += 1
                    cand = f"{mem_prefix}{mem_seq:05d}"
                mem_seen.add(cand)
                mem_seq += 1
                props[pk_field] = cand
                props["_id"] = cand
                f["id"] = cand

        set_layer_features(layer_id, feats)
        uploads_dir = get_uploads_dir()
        layers_dir = os.path.join(uploads_dir, "layers")
        f_path = os.path.join(layers_dir, f"{layer_id}_features.json")
        try:
            with open(f_path, "w", encoding="utf-8") as out_f:
                json.dump(feats, out_f)
        except Exception:
            pass

    # 4. Update layer metadata and fields_config
    layer["primary_key_field"] = pk_field
    layer["unique_field"] = pk_field
    layer["unique_mode"] = "autogenerate"
    layer["unique_prefix"] = res.get("prefix") or prefix

    fields = layer.setdefault("fields_config", [])
    found_field = next((f for f in fields if f.get("name") == pk_field), None)
    if found_field:
        found_field["is_unique"] = True
        found_field["id_mode"] = "auto"
        found_field["id_prefix"] = res.get("prefix") or prefix
    else:
        fields.insert(0, {
            "name": pk_field,
            "label": pk_field.replace("_", " ").title(),
            "type": "text",
            "required": True,
            "is_unique": True,
            "id_mode": "auto",
            "id_prefix": res.get("prefix") or prefix,
            "visible_in_popup": True,
        })

    audit_data = {
        "timestamp": time.time(),
        "primary_key_field": pk_field,
        "prefix": res.get("prefix") or prefix,
        "total_features": res.get("total_features", len(feats)),
        "total_autogenerated": res.get("total_autogenerated", 0),
        "audit_samples": res.get("audit_samples", []),
    }
    STATE.setdefault("pk_audits", {})[str(layer_id)] = res.get("all_audit_records", [])
    layer["primary_key_audit"] = audit_data
    layer["tile_version"] = (layer.get("tile_version") or 0) + 1
    invalidate_spatial_index(layer_id)

    _save_persistent_state(sync=True)

    return {
        "status": "success",
        "layer_id": layer_id,
        "primary_key_field": pk_field,
        "prefix": res.get("prefix") or prefix,
        "total_features": res.get("total_features", len(feats)),
        "total_autogenerated": res.get("total_autogenerated", 0),
        "autogenerated_samples": res.get("audit_samples", []),
        "all_audit_records": res.get("all_audit_records", []),
    }


@app.get("/api/layers/{layer_id}/primary-key/audit")
async def get_layer_primary_key_audit(
    layer_id: Any,
    request: Request,
    page: int = 1,
    limit: int = 50,
    search: str = "",
    reason: Optional[str] = None,
):
    """Retrieves paginated audit log for auto-generated primary key IDs."""
    user = _require_admin_user(request)
    layer = _find_vector_layer(layer_id)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")

    all_records = STATE.get("pk_audits", {}).get(str(layer_id), [])
    filtered = all_records

    if reason:
        filtered = [r for r in filtered if reason.lower() in str(r.get("reason", "")).lower()]

    if search:
        s = search.lower()
        filtered = [
            r for r in filtered
            if s in str(r.get("feature_id", "")).lower()
            or s in str(r.get("old_value", "")).lower()
            or s in str(r.get("generated_value", "")).lower()
        ]

    total = len(filtered)
    start = max(0, (page - 1) * limit)
    paged = filtered[start : start + limit]

    return {
        "layer_id": layer_id,
        "primary_key_field": layer.get("primary_key_field") or layer.get("unique_field"),
        "total": total,
        "page": page,
        "limit": limit,
        "items": paged,
        "audit_summary": layer.get("primary_key_audit", {}),
    }


# ---- 5. Feature Operations Endpoints ----

@app.post("/api/features")
async def create_feature(payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    raw_lid = payload.get("layer_id")
    layer = _find_vector_layer(raw_lid) if raw_lid is not None else None
    if layer is None:
        # A feature must belong to a real layer: guessing "any layer" corrupts data.
        raise HTTPException(
            status_code=400,
            detail="वैध भेक्टर तह (layer_id) आवश्यक छ। (A valid vector layer is required.)",
        )
    layer_id = layer.get("id")
    _enforce_layer_write_access(layer, user)

    feat_id = payload.get("id") or int(time.time() * 1000)
    feat_geom = payload.get("geometry") or payload.get("geom_geojson") or {}

    task, grid_error = _resolve_collector_grid(layer.get("project_id"), user, feat_geom, layer_id)
    if grid_error:
        raise HTTPException(status_code=403, detail=grid_error)
    _enforce_vertex_grid_rules(layer.get("project_id"), user, layer_id, {}, feat_geom)
    _enforce_layer_scope_for_grid(layer.get("project_id"), user, layer_id, feat_geom)

    raw_props = payload.get("properties") or {}
    clean_props = _clean_record_answers(raw_props)
    if "_status" in raw_props:
        clean_props["_status"] = raw_props["_status"]
    if "_record_id" in raw_props:
        clean_props["_record_id"] = raw_props["_record_id"]
    if "_questionnaire_id" in raw_props:
        clean_props["_questionnaire_id"] = raw_props["_questionnaire_id"]
    _enforce_field_entry_permissions(layer, user, clean_props, feat_geom, reject_unknown=True)

    # Unique field enforcement and autogeneration
    unique_field = layer.get("unique_field") or layer.get("primary_key_field")
    unique_mode = layer.get("unique_mode", "autogenerate")
    unique_prefix = layer.get("unique_prefix", "")

    if unique_field:
        user_val = clean_props.get(unique_field)
        is_empty_or_null = user_val is None or str(user_val).strip().lower() in ("", "null", "none", "nan", "undefined")
        
        # If autogenerate mode OR empty/null value:
        if is_empty_or_null or unique_mode in ("autogenerate", "auto"):
            if is_empty_or_null or check_unique_field_value_exists(layer_id, unique_field, user_val):
                current_cnt = (layer.get("feature_count") or 0) + 1
                prefix_cand = unique_prefix or (str(layer.get("name") or "FEAT")[:4].upper().replace(" ", "") + "-")
                cand_val = f"{prefix_cand}{current_cnt:05d}"
                while check_unique_field_value_exists(layer_id, unique_field, cand_val):
                    current_cnt += 1
                    cand_val = f"{prefix_cand}{current_cnt:05d}"
                clean_props[unique_field] = cand_val
                if feat_id is None or str(feat_id).isdigit():
                    feat_id = cand_val
        else:  # manual mode with provided value
            if check_unique_field_value_exists(layer_id, unique_field, user_val):
                # Auto-generate suffix rather than failing
                current_cnt = (layer.get("feature_count") or 0) + 1
                cand_val = f"{str(user_val).strip()}-{current_cnt}"
                while check_unique_field_value_exists(layer_id, unique_field, cand_val):
                    current_cnt += 1
                    cand_val = f"{str(user_val).strip()}-{current_cnt}"
                clean_props[unique_field] = cand_val

    feat = {
        "type": "Feature",
        "id": feat_id,
        "geometry": feat_geom,
        "properties": {
            **clean_props,
            "_id": feat_id,
            "_layer_id": layer_id,
            "_status": raw_props.get("_status", "SUBMITTED"),
            "_task_grid_id": task.get("id") if task else None,
            "_created_by": user.get("id"),
            "_created_by_username": user.get("username") or "unknown",
            "_created_at": time.time(),
        }
    }

    link_info = payload.get("link_to") or payload.get("linked_to")
    prepared_link = None
    if link_info:
        prepared_link = await _prepare_feature_link_async(feat, layer_id, link_info, user)

    is_pg = await _is_postgis_layer(layer_id)
    if is_pg:
        pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
        rec_id = f"feat_{feat_id}_{secrets.token_hex(4)}"[:64]
        geom_json = json.dumps(feat_geom)
        props_json = json.dumps(feat["properties"])
        engine = get_engine()
        async with engine.begin() as conn:
            insert_q = text("""
                INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
                VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), :uid)
                RETURNING id;
            """)
            ins_res = await conn.execute(insert_q, {
                "rec_id": rec_id,
                "lid": pg_lid,
                "geom_json": geom_json,
                "props": props_json,
                "uid": user.get("id"),
            })
            new_db_id = ins_res.scalar()
            feat["id"] = new_db_id
            feat["properties"]["_id"] = new_db_id
            feat["properties"]["_record_id"] = rec_id

            count_res = await conn.execute(
                text("SELECT count(*) FROM vector_features WHERE layer_id = :lid;"),
                {"lid": pg_lid},
            )
            if layer:
                layer["feature_count"] = count_res.scalar() or 0
        if prepared_link:
            prepared_link["link"]["source_feature_id"] = new_db_id
            _apply_prepared_feature_link(feat, prepared_link)
            await _update_postgis_feature(layer_id, new_db_id, None, feat["properties"], user=user)
            if prepared_link.get("target_is_postgis") and prepared_link.get("target_db_id"):
                await _update_postgis_feature(
                    prepared_link["link"]["target_layer_id"],
                    prepared_link["target_db_id"],
                    None,
                    prepared_link["target_feature"].get("properties") or {},
                    user=user,
                )
    else:
        if prepared_link:
            _apply_prepared_feature_link(feat, prepared_link)
            if prepared_link.get("target_is_postgis") and prepared_link.get("target_db_id"):
                await _update_postgis_feature(
                    prepared_link["link"]["target_layer_id"],
                    prepared_link["target_db_id"],
                    None,
                    prepared_link["target_feature"].get("properties") or {},
                    user=user,
                )

        # Atomic insert into SQLite R-Tree spatial index (< 2ms) without wiping or rebuilding
        sp_feat = add_feature_to_spatial_index(str(layer_id), feat)
        feat["id"] = sp_feat.get("id") or feat.get("id")
        feat["properties"]["_id"] = sp_feat.get("id") or feat["properties"].get("_id")

        lid_key = str(layer_id)
        if lid_key in STATE.get("features_by_layer", {}):
            if isinstance(STATE["features_by_layer"][lid_key], list):
                STATE["features_by_layer"][lid_key].append(sp_feat)
        if lid_key.isdigit():
            int_k = int(lid_key)
            if int_k in STATE.get("features_by_layer", {}):
                if isinstance(STATE["features_by_layer"][int_k], list) and sp_feat not in STATE["features_by_layer"][int_k]:
                    STATE["features_by_layer"][int_k].append(sp_feat)

        # Write to disk cache
        try:
            uploads_dir = get_uploads_dir()
            layers_dir = os.path.join(uploads_dir, "layers")
            f_path = os.path.join(layers_dir, f"{layer_id}_features.json")
            in_mem = STATE.get("features_by_layer", {}).get(lid_key) or []
            if in_mem and len(in_mem) <= 5000:
                with open(f_path, "w", encoding="utf-8") as out_f:
                    json.dump(in_mem, out_f)
        except Exception:
            pass

        if layer:
            db_cnt = get_layer_feature_count(str(layer_id))
            layer["feature_count"] = db_cnt if db_cnt > 0 else ((layer.get("feature_count") or 0) + 1)
            g_type = (feat_geom or {}).get("type")
            if g_type and layer.get("geometry_type") and layer.get("geometry_type") != g_type:
                layer["geometry_type"] = "Mix"
                layer["creation_geometry_types"] = ["Point", "LineString", "Polygon"]

        _FEATURE_ID_INDEX[str(feat["id"])] = (layer_id, feat)
        _FEATURE_ID_INDEX[str(feat["properties"]["_id"])] = (layer_id, feat)
        _save_persistent_state(sync=False)

    _record_audit_entry(
        layer_id,
        "CREATE",
        user,
        feature_id=feat_id,
        details={"geometry_type": (feat_geom or {}).get("type"), "task_grid_id": task.get("id") if task else None},
    )
    return feat


@app.get("/api/features/{feature_id}")
async def get_feature(feature_id: Any, request: Request):
    """Retrieves full, un-trimmed GeoJSON feature by ID with 100% of its properties."""
    user = resolve_request_user(request)
    found = await _find_feature_across_layers_async(feature_id)
    if not found:
        raise HTTPException(status_code=404, detail="फिचर भेटिएन। (Feature not found.)")
    layer = _layer_by_id(found.get("layer_id"))
    if layer and not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो फिचर हेर्न अनुमति छैन। (Access denied to this feature.)")
    raw_feature = _clean_feature_properties_for_geojson(found.get("feature"))
    if layer and not _is_admin_user(user):
        filtered = _portal_filter_feature_properties(layer, user, [raw_feature])
        return filtered[0] if filtered else raw_feature
    return raw_feature


@app.put("/api/features/{feature_id}")
async def update_feature(feature_id: Any, payload: Dict[str, Any], request: Request):
    """Persists spatial edits AND attribute edits for an existing feature."""
    user = _require_user(request)
    scope_layer_id = payload.get("layer_id")
    found = await _find_feature_across_layers_async(feature_id, scope_layer_id=scope_layer_id)
    if not found:
        raise HTTPException(status_code=404, detail="फिचर भेटिएन। (Feature not found.)")

    lid = found["layer_id"]
    layer = _layer_by_id(lid)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    _enforce_layer_write_access(layer, user)

    f = found["feature"]
    f_props = f.get("properties") or {}

    new_geometry = payload.get("geometry") or payload.get("geom_geojson")
    cleaned_props = None
    if "properties" in payload:
        raw_props = payload.get("properties") or {}
        cleaned_props = _clean_record_answers(raw_props)
        if "_status" in raw_props:
            cleaned_props["_status"] = raw_props["_status"]
        if "_record_id" in raw_props:
            cleaned_props["_record_id"] = raw_props["_record_id"]
        if "_questionnaire_id" in raw_props:
            cleaned_props["_questionnaire_id"] = raw_props["_questionnaire_id"]
        _enforce_field_entry_permissions(
            layer,
            user,
            cleaned_props,
            new_geometry or f.get("geometry"),
            existing=f.get("properties", {}),
        )

    geometry_changed = bool(new_geometry) and new_geometry != f.get("geometry")
    if geometry_changed:
        old_geometry = f.get("geometry")
        task, grid_error = _resolve_collector_grid(
            layer.get("project_id"), user, new_geometry, layer.get("id")
        )
        if grid_error:
            raise HTTPException(status_code=403, detail=grid_error)
        _enforce_vertex_grid_rules(layer.get("project_id"), user, layer.get("id"), old_geometry, new_geometry)
        _enforce_layer_scope_for_grid(layer.get("project_id"), user, layer.get("id"), new_geometry)
        f["geometry"] = new_geometry
        if "properties" not in f:
            f["properties"] = {}
        f["properties"]["_task_grid_id"] = (
            task.get("id") if task else f_props.get("_task_grid_id")
        )
    elif f.get("geometry"):
        _task, grid_error = _resolve_collector_grid(
            layer.get("project_id"), user, f.get("geometry"), layer.get("id")
        )
        if grid_error:
            raise HTTPException(status_code=403, detail=grid_error)
        _enforce_layer_scope_for_grid(layer.get("project_id"), user, layer.get("id"), f.get("geometry"))

    changed_fields = []
    if cleaned_props is not None:
        for key, value in cleaned_props.items():
            if f.get("properties", {}).get(key) != value:
                changed_fields.append(key)
        f.setdefault("properties", {}).update(cleaned_props)

    f.setdefault("properties", {})["_updated_by"] = user.get("id")
    f["properties"]["_updated_by_username"] = user.get("username")
    f["properties"]["_updated_at"] = time.time()

    if found.get("is_postgis"):
        db_id = found.get("db_id") or (int(str(feature_id)) if str(feature_id).isdigit() else None)
        await _update_postgis_feature(lid, db_id, new_geometry if geometry_changed else None, f["properties"], user=user)
    else:
        update_feature_in_spatial_index(
            str(lid),
            feature_id,
            geom=new_geometry if geometry_changed else None,
            props=f.get("properties"),
        )
        _save_persistent_state(sync=False)

    _record_audit_entry(
        lid,
        "UPDATE",
        user,
        feature_id=feature_id,
        details={"geometry_changed": geometry_changed, "changed_fields": changed_fields},
    )
    return f


@app.delete("/api/features/{feature_id}")
async def delete_feature(feature_id: Any, request: Request, layer_id: Any = None):
    user = _require_user(request)
    found = await _find_feature_across_layers_async(feature_id, scope_layer_id=layer_id)
    if not found:
        raise HTTPException(status_code=404, detail="फिचर भेटिएन। (Feature not found.)")

    lid = found["layer_id"]
    layer = _layer_by_id(lid)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    _enforce_layer_write_access(layer, user)

    target = found["feature"]
    _task, grid_error = _resolve_collector_grid(
        layer.get("project_id"), user, target.get("geometry"), layer.get("id")
    )
    if grid_error:
        raise HTTPException(status_code=403, detail=grid_error)

    if found.get("is_postgis"):
        db_id = found.get("db_id") or (int(str(feature_id)) if str(feature_id).isdigit() else None)
        await _delete_postgis_feature(lid, db_id)
    else:
        # 1. Atomically delete from SQLite R-Tree (< 2ms)
        del_ok = delete_feature_from_spatial_index(str(lid), feature_id)
        if not del_ok:
            for alt_id in [target.get("id"), target.get("properties", {}).get("_id"), target.get("properties", {}).get("gid")]:
                if alt_id and str(alt_id) != str(feature_id):
                    if delete_feature_from_spatial_index(str(lid), alt_id):
                        break

        # 2. Update in-memory list if present
        lid_key = str(lid)
        if lid_key in STATE.get("features_by_layer", {}):
            if isinstance(STATE["features_by_layer"][lid_key], list):
                STATE["features_by_layer"][lid_key] = [
                    f for f in STATE["features_by_layer"][lid_key]
                    if str(f.get("id")) != str(feature_id) and str(f.get("properties", {}).get("_id")) != str(feature_id)
                ]

        if layer:
            db_cnt = get_layer_feature_count(str(lid))
            layer["feature_count"] = db_cnt if db_cnt >= 0 else max(0, (layer.get("feature_count") or 1) - 1)
            layer["tile_version"] = (layer.get("tile_version") or 0) + 1
        invalidate_spatial_index(lid)
        _save_persistent_state(sync=False)

    _FEATURE_ID_INDEX.pop(str(feature_id), None)

    _record_audit_entry(lid, "DELETE", user, feature_id=feature_id, details={})
    return {"status": "deleted", "id": feature_id, "layer_id": lid}


_FEATURE_ID_INDEX: Dict[str, Tuple[Any, dict]] = {}


def _find_feature_across_layers(feature_id: Any) -> Optional[Dict[str, Any]]:
    f_str = str(feature_id)
    cached = _FEATURE_ID_INDEX.get(f_str)
    if cached:
        lid, f = cached
        layer = _layer_by_id(lid)
        if layer:
            layer_name = layer.get("name") if layer else f"Layer {lid}"
            return {"feature": f, "layer_id": lid, "layer_name": layer_name}
        _FEATURE_ID_INDEX.pop(f_str, None)

    for lid, feats in STATE.get("features_by_layer", {}).items():
        if not isinstance(feats, list):
            continue
        layer = _layer_by_id(lid)
        if not layer:
            continue
        for f in feats:
            fid = str(f.get("id"))
            f_id = str((f.get("properties") or {}).get("_id", ""))
            if fid == f_str or f_id == f_str:
                _FEATURE_ID_INDEX[fid] = (lid, f)
                if f_id:
                    _FEATURE_ID_INDEX[f_id] = (lid, f)
                layer_name = layer.get("name") if layer else f"Layer {lid}"
                return {"feature": f, "layer_id": lid, "layer_name": layer_name}

    # Also check SQLite persistent spatial index
    try:
        sp_feat = get_feature_by_uid(f_str)
        if sp_feat:
            lid = sp_feat.get("_layer_id") or sp_feat.get("layer_id")
            layer = _layer_by_id(lid)
            layer_name = layer.get("name") if layer else f"Layer {lid}"
            if lid:
                _FEATURE_ID_INDEX[f_str] = (lid, sp_feat)
            return {"feature": sp_feat, "layer_id": lid, "layer_name": layer_name}
    except Exception:
        pass

    return None


def _layer_by_id(layer_id: Any) -> Optional[Dict[str, Any]]:
    if layer_id is None:
        return None
    str_id = str(layer_id)
    l = next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str_id), None)
    if l is not None:
        return l
    _reload_state_if_modified()
    l = next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str_id), None)
    if l is not None:
        return l
    _load_persistent_state()
    return next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str_id), None)


# ---- PostGIS Feature Data Access Layer (DAL) -------------------------------

_POSTGIS_LAYERS_CACHE: set = set()


async def _get_all_postgis_features(layer_id: Any) -> List[dict]:
    """Fetches all GeoJSON features for a PostGIS-backed layer."""
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    features: List[dict] = []
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            q = text("""
                SELECT id, record_id, ST_AsGeoJSON(geom) AS geom_json, properties
                FROM vector_features
                WHERE layer_id = :lid
                ORDER BY id ASC;
            """)
            res = await conn.execute(q, {"lid": pg_lid})
            for r in res.fetchall():
                geom_obj = json.loads(r.geom_json) if isinstance(r.geom_json, str) else r.geom_json
                props = dict(r.properties or {})
                props["_id"] = r.id
                props["_record_id"] = r.record_id
                features.append({
                    "type": "Feature",
                    "id": r.id,
                    "geometry": geom_obj,
                    "properties": props,
                    "_db_id": r.id,
                })
    except Exception as e:
        print(f"[POSTGIS-DAL] Error fetching all features for layer {layer_id}: {e}")
    return features


async def _is_postgis_layer(layer_id: Any) -> bool:
    """Checks whether a vector layer is backed by PostgreSQL/PostGIS vector_features table."""
    if not layer_id:
        return False
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    if pg_lid in _POSTGIS_LAYERS_CACHE or str(layer_id) in _POSTGIS_LAYERS_CACHE:
        return True
    try:
        engine = get_engine()
        async with engine.connect() as conn:
            check_q = text("SELECT EXISTS(SELECT 1 FROM vector_features WHERE layer_id = :lid LIMIT 1);")
            res = await conn.execute(check_q, {"lid": pg_lid})
            exists = bool(res.scalar())
            if exists:
                _POSTGIS_LAYERS_CACHE.add(pg_lid)
                _POSTGIS_LAYERS_CACHE.add(str(layer_id))
            return exists
    except Exception as e:
        print(f"[POSTGIS-DAL] Error checking postgis layer {layer_id}: {e}")
        return False


async def _get_postgis_features_by_ids(layer_id: Any, feature_ids: List[Any]) -> List[dict]:
    """Fetches full GeoJSON features from PostGIS vector_features by any matching ID representation."""
    if not feature_ids:
        return []
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    id_strs = [str(x).strip() for x in feature_ids if str(x).strip()]
    int_ids = [int(x) for x in id_strs if x.isdigit()]
    if not int_ids and not id_strs:
        return []

    try:
        engine = get_engine()
        async with engine.connect() as conn:
            # 1. Primary lookup: match by exact database primary key, record_id, or _id
            q = text("""
                SELECT id, record_id, ST_AsGeoJSON(geom) AS geom_json, properties
                FROM vector_features
                WHERE layer_id = :lid
                  AND (
                     (id = ANY(:int_ids))
                     OR (record_id = ANY(:str_ids))
                     OR (properties->>'_id' = ANY(:str_ids))
                  );
            """)
            res = await conn.execute(q, {
                "lid": pg_lid,
                "int_ids": int_ids if int_ids else [-1],
                "str_ids": id_strs,
            })
            rows = list(res.fetchall())
            # 2. Fallback lookup: if fewer rows matched than requested, search legacy field names
            if len(rows) < len(feature_ids):
                q_fallback = text("""
                    SELECT id, record_id, ST_AsGeoJSON(geom) AS geom_json, properties
                    FROM vector_features
                    WHERE layer_id = :lid
                      AND (
                         (properties->>'id' = ANY(:str_ids))
                         OR (properties->>'objectid' = ANY(:str_ids))
                         OR (properties->>'OBJECTID' = ANY(:str_ids))
                         OR (properties->>'fid' = ANY(:str_ids))
                      );
                """)
                res_fb = await conn.execute(q_fallback, {
                    "lid": pg_lid,
                    "str_ids": id_strs,
                })
                existing_ids = {r.id for r in rows}
                for r in res_fb.fetchall():
                    if r.id not in existing_ids:
                        rows.append(r)
            features = []
            for r in rows:
                try:
                    geom_obj = json.loads(r.geom_json) if isinstance(r.geom_json, str) else r.geom_json
                    props = dict(r.properties or {})
                    props["_id"] = r.id
                    props["_record_id"] = r.record_id
                    features.append({
                        "type": "Feature",
                        "id": r.id,
                        "geometry": geom_obj,
                        "properties": props,
                        "_db_id": r.id,
                    })
                except Exception as err:
                    print(f"[POSTGIS-DAL] Error parsing row {r.id}: {err}")
            return features
    except Exception as e:
        print(f"[POSTGIS-DAL] Error fetching features for layer {layer_id}: {e}")
        return []


async def _find_feature_across_layers_async(feature_id: Any, scope_layer_id: Any = None) -> Optional[Dict[str, Any]]:
    """Locates a feature across in-memory layers and PostGIS vector_features table."""
    f_str = str(feature_id).strip()
    if not f_str:
        return None

    if scope_layer_id is not None:
        scope_str = str(scope_layer_id)
        feats = (
            STATE.get("features_by_layer", {}).get(scope_layer_id)
            or STATE.get("features_by_layer", {}).get(scope_str)
            or (STATE.get("features_by_layer", {}).get(int(scope_str)) if scope_str.isdigit() else None)
            or []
        )
        for f in feats:
            fid = str(f.get("id"))
            f_id = str((f.get("properties") or {}).get("_id", ""))
            if fid == f_str or f_id == f_str:
                layer = _layer_by_id(scope_layer_id)
                layer_name = layer.get("name") if layer else f"Layer {scope_layer_id}"
                return {"feature": f, "layer_id": scope_layer_id, "layer_name": layer_name}

    found = _find_feature_across_layers(feature_id)
    if found and (scope_layer_id is None or str(found.get("layer_id")) == str(scope_layer_id)):
        return found

    # Sub-millisecond lookup from persistent SQLite spatial index (e.g. UnetRaw, 188k buildings)
    try:
        sp_feat = get_feature_by_uid(f_str, str(scope_layer_id) if scope_layer_id is not None else None)
        if sp_feat:
            lid = sp_feat.get("_layer_id") or scope_layer_id
            layer = _layer_by_id(lid)
            layer_name = layer.get("name") if layer else f"Layer {lid}"
            return {
                "feature": sp_feat,
                "layer_id": lid,
                "layer_name": layer_name,
            }
    except Exception as e:
        pass

    int_id = int(f_str) if f_str.isdigit() else -1

    try:
        engine = get_engine()
        async with engine.connect() as conn:
            pg_lid = int(str(scope_layer_id)) if (scope_layer_id and str(scope_layer_id).isdigit()) else scope_layer_id
            lid_clause = "AND layer_id = :lid" if pg_lid is not None else ""
            q = text(f"""
                SELECT id, record_id, layer_id, ST_AsGeoJSON(geom) AS geom_json, properties
                FROM vector_features
                WHERE ((id = :int_id)
                   OR (record_id = :f_str)
                   OR (properties->>'_id' = :f_str)
                   OR (properties->>'id' = :f_str)
                   OR (properties->>'objectid' = :f_str)
                   OR (properties->>'OBJECTID' = :f_str)
                   OR (properties->>'fid' = :f_str))
                   {lid_clause}
                LIMIT 1;
            """)
            params: Dict[str, Any] = {"int_id": int_id, "f_str": f_str}
            if pg_lid is not None:
                params["lid"] = pg_lid
            row = (await conn.execute(q, params)).fetchone()
            if row:
                layer = _layer_by_id(row.layer_id)
                if layer:
                    geom_obj = json.loads(row.geom_json) if isinstance(row.geom_json, str) else row.geom_json
                    props = dict(row.properties or {})
                    props["_id"] = row.id
                    props["_record_id"] = row.record_id
                    layer_name = layer.get("name") if layer else f"Layer {row.layer_id}"
                    feat_obj = {
                        "type": "Feature",
                        "id": row.id,
                        "geometry": geom_obj,
                        "properties": props,
                    }
                    return {
                        "feature": feat_obj,
                        "layer_id": row.layer_id,
                        "layer_name": layer_name,
                        "is_postgis": True,
                        "db_id": row.id,
                    }
    except Exception as e:
        print(f"[POSTGIS-DAL] Error finding feature across layers {feature_id}: {e}")

    return None


async def _save_postgis_merged_feature(
    layer_id: Any,
    picked_features: List[dict],
    merged_feature: dict,
    user: Optional[Dict[str, Any]] = None,
) -> int:
    """Atomically commits a feature merge to PostGIS: deletes merged source rows, inserts merged polygon, updates layer count."""
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    del_ids = []
    for f in picked_features:
        if f.get("_db_id"):
            del_ids.append(int(f["_db_id"]))
        elif str(f.get("id", "")).isdigit():
            del_ids.append(int(f["id"]))
        elif str(f.get("properties", {}).get("_id", "")).isdigit():
            del_ids.append(int(f["properties"]["_id"]))

    rec_id = f"mrg_{pg_lid}_{secrets.token_hex(6)}"[:64]
    geom_json = json.dumps(merged_feature.get("geometry") or {})
    props = dict(merged_feature.get("properties") or {})
    props_json = json.dumps(props)
    uid = user.get("id") if user else None

    engine = get_engine()
    async with engine.begin() as conn:
        if del_ids:
            await conn.execute(
                text("DELETE FROM vector_features WHERE layer_id = :lid AND id = ANY(:del_ids);"),
                {"lid": pg_lid, "del_ids": del_ids},
            )
        insert_q = text("""
            INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
            VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), :uid)
            RETURNING id;
        """)
        ins_res = await conn.execute(insert_q, {
            "rec_id": rec_id,
            "lid": pg_lid,
            "geom_json": geom_json,
            "props": props_json,
            "uid": uid,
        })
        new_db_id = ins_res.scalar()
        merged_feature["id"] = new_db_id
        merged_feature.setdefault("properties", {})["_id"] = new_db_id
        merged_feature["properties"]["_record_id"] = rec_id

        count_res = await conn.execute(
            text("SELECT count(*) FROM vector_features WHERE layer_id = :lid;"),
            {"lid": pg_lid},
        )
        new_count = count_res.scalar() or 0

    layer = _layer_by_id(layer_id)
    if layer:
        layer["feature_count"] = new_count
    STATE.get("features_by_layer", {}).pop(layer_id, None)
    STATE.get("features_by_layer", {}).pop(str(layer_id), None)
    _drop_layer_feature_index(layer_id)
    invalidate_spatial_index(layer_id)
    _save_persistent_state()
    return new_count


async def _save_postgis_split_features(
    layer_id: Any,
    orig_db_id: int,
    new_features: List[dict],
    user: Optional[Dict[str, Any]] = None,
) -> int:
    """Atomically commits split features to PostGIS: deletes parent row, inserts child parts, updates layer count."""
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    uid = user.get("id") if user else None

    engine = get_engine()
    async with engine.begin() as conn:
        if orig_db_id:
            await conn.execute(
                text("DELETE FROM vector_features WHERE layer_id = :lid AND id = :orig_id;"),
                {"lid": pg_lid, "orig_id": orig_db_id},
            )
        for idx, feat in enumerate(new_features):
            rec_id = f"splt_{pg_lid}_{idx}_{secrets.token_hex(4)}"[:64]
            geom_json = json.dumps(feat.get("geometry") or {})
            props = dict(feat.get("properties") or {})
            props_json = json.dumps(props)
            insert_q = text("""
                INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
                VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), :uid)
                RETURNING id;
            """)
            ins_res = await conn.execute(insert_q, {
                "rec_id": rec_id,
                "lid": pg_lid,
                "geom_json": geom_json,
                "props": props_json,
                "uid": uid,
            })
            new_id = ins_res.scalar()
            feat["id"] = new_id
            feat.setdefault("properties", {})["_id"] = new_id
            feat["properties"]["_record_id"] = rec_id

        count_res = await conn.execute(
            text("SELECT count(*) FROM vector_features WHERE layer_id = :lid;"),
            {"lid": pg_lid},
        )
        new_count = count_res.scalar() or 0

    layer = _layer_by_id(layer_id)
    if layer:
        layer["feature_count"] = new_count
    STATE.get("features_by_layer", {}).pop(layer_id, None)
    STATE.get("features_by_layer", {}).pop(str(layer_id), None)
    _drop_layer_feature_index(layer_id)
    invalidate_spatial_index(layer_id)
    _save_persistent_state()
    return new_count


async def _update_postgis_feature(
    layer_id: Any,
    db_id: int,
    new_geometry: Optional[dict],
    cleaned_props: Optional[dict],
    user: Optional[Dict[str, Any]] = None,
) -> None:
    """Updates geometry and/or attributes for a single feature in PostGIS."""
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    uid = user.get("id") if user else None

    engine = get_engine()
    async with engine.begin() as conn:
        if new_geometry and cleaned_props is not None:
            geom_json = json.dumps(new_geometry)
            props_json = json.dumps(cleaned_props)
            q = text("""
                UPDATE vector_features
                SET geom = ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326),
                    properties = properties || CAST(:props AS jsonb),
                    updated_by = :uid,
                    version = version + 1
                WHERE layer_id = :lid AND id = :db_id;
            """)
            await conn.execute(q, {
                "geom_json": geom_json,
                "props": props_json,
                "uid": uid,
                "lid": pg_lid,
                "db_id": db_id,
            })
        elif new_geometry:
            geom_json = json.dumps(new_geometry)
            q = text("""
                UPDATE vector_features
                SET geom = ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326),
                    updated_by = :uid,
                    version = version + 1
                WHERE layer_id = :lid AND id = :db_id;
            """)
            await conn.execute(q, {
                "geom_json": geom_json,
                "uid": uid,
                "lid": pg_lid,
                "db_id": db_id,
            })
        elif cleaned_props is not None:
            props_json = json.dumps(cleaned_props)
            q = text("""
                UPDATE vector_features
                SET properties = properties || CAST(:props AS jsonb),
                    updated_by = :uid,
                    version = version + 1
                WHERE layer_id = :lid AND id = :db_id;
            """)
            await conn.execute(q, {
                "props": props_json,
                "uid": uid,
                "lid": pg_lid,
                "db_id": db_id,
            })
    _drop_layer_feature_index(layer_id)
    invalidate_spatial_index(layer_id)


async def _delete_postgis_feature(layer_id: Any, db_id: int) -> int:
    """Deletes a feature from PostGIS and updates layer feature count."""
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    engine = get_engine()
    async with engine.begin() as conn:
        await conn.execute(
            text("DELETE FROM vector_features WHERE layer_id = :lid AND id = :db_id;"),
            {"lid": pg_lid, "db_id": db_id},
        )
        count_res = await conn.execute(
            text("SELECT count(*) FROM vector_features WHERE layer_id = :lid;"),
            {"lid": pg_lid},
        )
        new_count = count_res.scalar() or 0

    layer = _layer_by_id(layer_id)
    if layer:
        layer["feature_count"] = new_count
    _drop_layer_feature_index(layer_id)
    invalidate_spatial_index(layer_id)
    _save_persistent_state()
    return new_count


async def _prepare_feature_link_async(
    feat: Dict[str, Any],
    layer_id: Any,
    link_info: Dict[str, Any],
    user: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """PostGIS-aware async version of _prepare_feature_link."""
    if not isinstance(link_info, dict) or not link_info.get("target_feature_id"):
        return None
    target_fid = link_info.get("target_feature_id")
    feat_id = feat.get("id")
    if str(target_fid) == str(feat_id):
        raise HTTPException(
            status_code=400,
            detail="एउटै फिचरलाई आफैंसँग जोड्न मिल्दैन। (A feature cannot be linked to itself.)",
        )
    target_found = await _find_feature_across_layers_async(target_fid)
    if not target_found:
        raise HTTPException(
            status_code=400,
            detail="जोड्ने लक्षित फिचर भेटिएन। (The target feature to link was not found.)",
        )
    target_layer = _layer_by_id(target_found["layer_id"])
    if target_layer is None:
        raise HTTPException(status_code=404, detail="लक्षित भेक्टर तह भेटिएन। (Target layer not found.)")
    if not _layer_visible_to_user(target_layer, user):
        raise HTTPException(status_code=403, detail="लक्षित तह पढ्ने पहुँच छैन। (You cannot read the target layer.)")
    _enforce_layer_write_access(target_layer, user)
    _t_task, t_grid_err = _resolve_collector_grid(
        target_layer.get("project_id"), user, target_found["feature"].get("geometry"), target_layer.get("id")
    )
    if t_grid_err:
        raise HTTPException(status_code=403, detail=t_grid_err)

    source_field = link_info.get("source_link_attribute") or link_info.get("link_attribute")
    target_field = link_info.get("target_link_attribute") or source_field
    if bool(source_field) != bool(target_field):
        raise HTTPException(
            status_code=400,
            detail="जोड्ने फिल्ड स्रोत र लक्षित दुवैतर्फ उल्लेख गर्नुपर्छ। (Both link fields are required.)",
        )

    shared_val = None
    if source_field:
        source_value = _link_prop_value(feat, source_field)
        target_value = _link_prop_value(target_found["feature"], target_field)
        source_norm = _link_normalize(source_value)
        target_norm = _link_normalize(target_value)
        is_id_field = str(source_field) in ("_id", "id") or str(target_field) in ("_id", "id")
        if (
            not is_id_field
            and source_norm is not None
            and target_norm is not None
            and source_norm != target_norm
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"जोड्ने फिल्डको मान मिलेन ('{source_norm}' ≠ '{target_norm}')। "
                    "(The selected link field values do not match on both features.)"
                ),
            )
        shared_val = source_value if source_norm is not None else target_value
        if source_norm is None and target_norm is None and not is_id_field:
            raise HTTPException(
                status_code=400,
                detail="जोड्ने फिल्डमा दुवै फिचरमा मान छैन। (Both features are missing a value for the link field.)",
            )

    target_props = target_found["feature"].get("properties") or {}
    target_label = (
        target_props.get("bldg_code") or target_props.get("road_code") or target_props.get("kitta_no")
        or target_props.get("asset_code") or target_props.get("road_name") or target_props.get("owner_name")
        or f"#{target_fid}"
    )
    new_link = {
        "id": int(time.time() * 1000),
        "source_feature_id": feat_id,
        "source_layer_id": layer_id,
        "target_feature_id": target_fid,
        "target_layer_id": target_layer.get("id"),
        "relationship_type": link_info.get("relationship_type") or "connected_to",
        "link_attribute": source_field or target_field,
        "link_value": shared_val,
        "source_link_attribute": source_field,
        "target_link_attribute": target_field,
        "notes": link_info.get("notes", ""),
        "created_at": datetime.utcnow().isoformat(),
    }
    return {
        "link": new_link,
        "target_feature": target_found["feature"],
        "target_is_postgis": bool(target_found.get("is_postgis")),
        "target_db_id": target_found.get("db_id"),
        "source_field": source_field,
        "target_field": target_field,
        "shared_val": shared_val,
        "linked_feature_ref": f"{target_found['layer_name']}: {target_label}",
    }


def _prepare_feature_link(
    feat: Dict[str, Any],
    layer_id: Any,
    link_info: Dict[str, Any],
    user: Optional[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    """Validates a `link_to` request against an unsaved feature.

    Every check (self link, missing target, permissions, matching values) runs
    before the feature is persisted, so a rejected link never leaves an orphan
    feature behind. `_apply_prepared_feature_link` performs the actual mutation.
    """
    if not isinstance(link_info, dict) or not link_info.get("target_feature_id"):
        return None
    target_fid = link_info.get("target_feature_id")
    feat_id = feat.get("id")
    if str(target_fid) == str(feat_id):
        raise HTTPException(
            status_code=400,
            detail="एउटै फिचरलाई आफैंसँग जोड्न मिल्दैन। (A feature cannot be linked to itself.)",
        )
    target_found = _find_feature_across_layers(target_fid)
    if not target_found:
        raise HTTPException(
            status_code=400,
            detail="जोड्ने लक्षित फिचर भेटिएन। (The target feature to link was not found.)",
        )
    target_layer = _layer_by_id(target_found["layer_id"])
    if target_layer is None:
        raise HTTPException(status_code=404, detail="लक्षित भेक्टर तह भेटिएन। (Target layer not found.)")
    if not _layer_visible_to_user(target_layer, user):
        raise HTTPException(status_code=403, detail="लक्षित तह पढ्ने पहुँच छैन। (You cannot read the target layer.)")
    _enforce_layer_write_access(target_layer, user)

    source_field = link_info.get("source_link_attribute") or link_info.get("link_attribute")
    target_field = link_info.get("target_link_attribute") or source_field
    if bool(source_field) != bool(target_field):
        raise HTTPException(
            status_code=400,
            detail="जोड्ने फिल्ड स्रोत र लक्षित दुवैतर्फ उल्लेख गर्नुपर्छ। (Both link fields are required.)",
        )

    shared_val = None
    if source_field:
        source_value = _link_prop_value(feat, source_field)
        target_value = _link_prop_value(target_found["feature"], target_field)
        source_norm = _link_normalize(source_value)
        target_norm = _link_normalize(target_value)
        is_id_field = str(source_field) in ("_id", "id") or str(target_field) in ("_id", "id")
        if (
            not is_id_field
            and source_norm is not None
            and target_norm is not None
            and source_norm != target_norm
        ):
            raise HTTPException(
                status_code=409,
                detail=(
                    f"जोड्ने फिल्डको मान मिलेन ('{source_norm}' ≠ '{target_norm}')। "
                    "(The selected link field values do not match on both features.)"
                ),
            )
        shared_val = source_value if source_norm is not None else target_value
        if source_norm is None and target_norm is None and not is_id_field:
            raise HTTPException(
                status_code=400,
                detail="जोड्ने फिल्डमा दुवै फिचरमा मान छैन। (Both features are missing a value for the link field.)",
            )

    target_props = target_found["feature"].get("properties") or {}
    target_label = (
        target_props.get("bldg_code") or target_props.get("road_code") or target_props.get("kitta_no")
        or target_props.get("asset_code") or target_props.get("road_name") or target_props.get("owner_name")
        or f"#{target_fid}"
    )
    new_link = {
        "id": int(time.time() * 1000),
        "source_feature_id": feat_id,
        "source_layer_id": layer_id,
        "target_feature_id": target_fid,
        "target_layer_id": target_layer.get("id"),
        "relationship_type": link_info.get("relationship_type") or "connected_to",
        "link_attribute": source_field or target_field,
        "link_value": shared_val,
        "source_link_attribute": source_field,
        "target_link_attribute": target_field,
        "notes": link_info.get("notes", ""),
        "created_at": datetime.utcnow().isoformat(),
    }
    return {
        "link": new_link,
        "target_feature": target_found["feature"],
        "source_field": source_field,
        "target_field": target_field,
        "shared_val": shared_val,
        "linked_feature_ref": f"{target_found['layer_name']}: {target_label}",
    }


def _apply_prepared_feature_link(
    feat: Dict[str, Any], prepared: Optional[Dict[str, Any]]
) -> Optional[Dict[str, Any]]:
    if not prepared:
        return None
    feat_id = feat.get("id")
    source_field = prepared["source_field"]
    target_field = prepared["target_field"]
    shared_val = prepared["shared_val"]
    s_props = feat.setdefault("properties", {})
    t_props = prepared["target_feature"].setdefault("properties", {})
    if source_field and shared_val is not None:
        if str(source_field) not in ("_id", "id"):
            s_props[str(source_field)] = shared_val
        if str(target_field) not in ("_id", "id"):
            t_props[str(target_field)] = shared_val
    s_props["linked_feature_id"] = prepared["link"]["target_feature_id"]
    t_props["linked_feature_id"] = feat_id
    if source_field:
        s_props["link_attribute"] = source_field
        t_props["link_attribute"] = target_field
    s_props["linked_feature_ref"] = prepared["linked_feature_ref"]
    links = STATE.setdefault("feature_links", [])
    already_linked = any(
        str(link.get("source_feature_id")) == str(prepared["link"]["source_feature_id"])
        and str(link.get("target_feature_id")) == str(prepared["link"]["target_feature_id"])
        for link in links
    )
    if not already_linked:
        links.append(prepared["link"])
    return prepared["link"]


def _feature_layer_readable(found: Optional[Dict[str, Any]], user: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The layer of a found feature, only when the user may read it."""
    if not found:
        return None
    layer = _layer_by_id(found.get("layer_id"))
    if layer is None or layer.get("deleted_at"):
        return None
    if not _layer_visible_to_user(layer, user):
        return None
    return layer


def _readable_feature_properties(found: Optional[Dict[str, Any]], user: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Feature properties trimmed to what the caller's role may read."""
    props = dict((found or {}).get("feature", {}).get("properties") or {})
    layer = _layer_by_id((found or {}).get("layer_id"))
    if layer is not None and not _is_admin_user(user):
        filtered = _portal_filter_feature_properties(layer, user, [{"properties": props}])
        if filtered:
            props = dict(filtered[0].get("properties") or {})
    return props


@app.get("/api/features/{feature_id}/linked")
async def get_feature_linked(feature_id: Any, request: Request):
    user = _require_user(request)
    src_feat = await _find_feature_across_layers_async(feature_id)
    if not src_feat or _feature_layer_readable(src_feat, user) is None:
        return {"feature_id": feature_id, "linked_features": [], "links": []}
    f_str = str(feature_id)
    all_links = STATE.setdefault("feature_links", [])
    resolved = []
    seen_fids = set()

    for lnk in all_links:
        src = str(lnk.get("source_feature_id"))
        tgt = str(lnk.get("target_feature_id"))
        if src == f_str:
            is_source = True
            other_fid = tgt
        elif tgt == f_str:
            is_source = False
            other_fid = src
        else:
            continue
        if other_fid in seen_fids:
            continue
        found = await _find_feature_across_layers_async(other_fid)
        if not found or _feature_layer_readable(found, user) is None:
            continue
        seen_fids.add(other_fid)
        f_obj = found["feature"]
        resolved.append({
            "link_id": lnk.get("id"),
            "direction": "outgoing" if is_source else "incoming",
            "relationship_type": lnk.get("relationship_type", "base_layer_link"),
            "link_attribute": lnk.get("link_attribute"),
            "link_value": lnk.get("link_value"),
            "source_link_attribute": lnk.get("source_link_attribute") or lnk.get("link_attribute"),
            "target_link_attribute": lnk.get("target_link_attribute") or lnk.get("link_attribute"),
            "source_link_value": lnk.get("source_link_value"),
            "target_link_value": lnk.get("target_link_value"),
            "notes": lnk.get("notes", ""),
            "created_at": lnk.get("created_at"),
            "feature_id": f_obj.get("id"),
            "layer_id": found["layer_id"],
            "layer_name": found["layer_name"],
            "geometry_type": f_obj.get("geometry", {}).get("type", "Geometry"),
            "geometry": f_obj.get("geometry"),
            "properties": _readable_feature_properties(found, user),
        })

    # Also resolve any linked_feature_id stored directly on feature properties (e.g. from creation form)
    src_found = src_feat
    if src_found:
        s_props = src_found["feature"].get("properties", {})
        direct_ids = []
        if s_props.get("linked_feature_id"):
            direct_ids.append(str(s_props["linked_feature_id"]))
        if isinstance(s_props.get("linked_feature_ids"), list):
            direct_ids.extend([str(x) for x in s_props["linked_feature_ids"]])
        for did in direct_ids:
            if did and did not in seen_fids and did != f_str:
                df = await _find_feature_across_layers_async(did)
                if df and _feature_layer_readable(df, user) is not None:
                    seen_fids.add(did)
                    f_obj = df["feature"]
                    resolved.append({
                        "link_id": int(time.time() * 1000),
                        "direction": "outgoing",
                        "relationship_type": "base_layer_link",
                        "link_attribute": s_props.get("link_attribute"),
                        "link_value": s_props.get(s_props.get("link_attribute", "")),
                        "source_link_attribute": s_props.get("link_attribute"),
                        "target_link_attribute": s_props.get("link_attribute"),
                        "notes": "",
                        "created_at": None,
                        "feature_id": f_obj.get("id"),
                        "layer_id": df["layer_id"],
                        "layer_name": df["layer_name"],
                        "geometry_type": f_obj.get("geometry", {}).get("type", "Geometry"),
                        "geometry": f_obj.get("geometry"),
                        "properties": _readable_feature_properties(df, user),
                    })
    return {"feature_id": feature_id, "linked_features": resolved, "links": resolved}


@app.post("/api/features/{feature_id}/link")
async def link_feature(feature_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    all_links = STATE.setdefault("feature_links", [])
    target_fid = payload.get("target_feature_id")
    source_found = await _find_feature_across_layers_async(feature_id, scope_layer_id=payload.get("source_layer_id"))
    target_found = await _find_feature_across_layers_async(target_fid, scope_layer_id=payload.get("target_layer_id"))
    if not source_found or not target_found:
        raise HTTPException(status_code=404, detail="Source or target feature not found")
    source_layer = _layer_by_id(source_found["layer_id"])
    target_layer = _layer_by_id(target_found["layer_id"])
    # Linking mutates both features, so the actor needs write access and grid scope on both layers.
    _enforce_layer_write_access(source_layer, user)
    _enforce_layer_write_access(target_layer, user)
    if source_layer and source_found["feature"].get("geometry"):
        _st, s_err = _resolve_collector_grid(source_layer.get("project_id"), user, source_found["feature"].get("geometry"), source_layer.get("id"))
        if s_err:
            raise HTTPException(status_code=403, detail=s_err)
    if target_layer and target_found["feature"].get("geometry"):
        _tt, t_err = _resolve_collector_grid(target_layer.get("project_id"), user, target_found["feature"].get("geometry"), target_layer.get("id"))
        if t_err:
            raise HTTPException(status_code=403, detail=t_err)

    if str(target_fid) == str(feature_id) and str(source_found["layer_id"]) == str(target_found["layer_id"]):
        raise HTTPException(
            status_code=400,
            detail="एउटै फिचरलाई आफैंसँग जोड्न मिल्दैन। (A feature cannot be linked to itself.)",
        )

    link_attr = payload.get("link_attribute")
    source_link_attr = payload.get("source_link_attribute") or link_attr
    target_link_attr = payload.get("target_link_attribute") or link_attr
    if bool(source_link_attr) != bool(target_link_attr):
        raise HTTPException(
            status_code=400,
            detail="जोड्ने फिल्ड स्रोत र लक्षित दुवैतर्फ उल्लेख गर्नुपर्छ। (Both link fields are required.)",
        )

    t_props = target_found["feature"].setdefault("properties", {})
    s_props = source_found["feature"].setdefault("properties", {})

    # Both features carry the chosen field; the shared value is the link contract.
    shared_val = None
    source_value = None
    target_value = None
    if source_link_attr:
        source_value = _link_prop_value(source_found["feature"], source_link_attr)
        target_value = _link_prop_value(target_found["feature"], target_link_attr)
        source_norm = _link_normalize(source_value)
        target_norm = _link_normalize(target_value)
        is_id_field = str(source_link_attr) in ("_id", "id") or str(target_link_attr) in ("_id", "id")
        if (
            not is_id_field
            and source_norm is not None
            and target_norm is not None
            and source_norm != target_norm
        ):
            # Synchronize link attribute value from source to target (or target to source)
            shared_val = source_value or target_value
            if str(target_link_attr) not in ("_id", "id"):
                t_props[str(target_link_attr)] = shared_val
            if str(source_link_attr) not in ("_id", "id"):
                s_props[str(source_link_attr)] = shared_val
        else:
            shared_val = source_value if source_norm is not None else target_value

        if source_norm is None and target_norm is None:
            shared_val = str(feature_id)
            if not is_id_field:
                s_props[str(source_link_attr)] = shared_val
                t_props[str(target_link_attr)] = shared_val

        if shared_val is not None:
            if str(source_link_attr) not in ("_id", "id"):
                s_props[str(source_link_attr)] = shared_val
            if str(target_link_attr) not in ("_id", "id"):
                t_props[str(target_link_attr)] = shared_val

    # Record reciprocal link references
    s_props["linked_feature_id"] = target_fid
    t_props["linked_feature_id"] = feature_id
    if source_link_attr:
        s_props["link_attribute"] = source_link_attr
        t_props["link_attribute"] = target_link_attr

    t_label = (
        t_props.get("bldg_code") or t_props.get("road_code") or t_props.get("kitta_no")
        or t_props.get("asset_code") or t_props.get("road_name") or t_props.get("owner_name")
        or f"#{target_fid}"
    )
    s_props["linked_feature_ref"] = f"{target_found['layer_name']}: {t_label}"

    existing = next(
        (lnk for lnk in all_links if
         (str(lnk.get("source_feature_id")) == str(feature_id) and str(lnk.get("target_feature_id")) == str(target_fid)) or
         (str(lnk.get("source_feature_id")) == str(target_fid) and str(lnk.get("target_feature_id")) == str(feature_id))),
        None
    )

    link_fields = {
        "link_attribute": source_link_attr or target_link_attr,
        "link_value": shared_val,
        "source_link_attribute": source_link_attr,
        "target_link_attribute": target_link_attr,
        "source_link_value": source_value,
        "target_link_value": target_value,
    }

    if source_found.get("is_postgis") and source_found.get("db_id"):
        await _update_postgis_feature(source_found["layer_id"], source_found["db_id"], None, s_props, user=user)
    else:
        try:
            update_feature_in_spatial_index(
                str(source_found["layer_id"]),
                feature_id,
                geom=source_found["feature"].get("geometry"),
                props=s_props,
            )
        except Exception:
            pass

    if target_found.get("is_postgis") and target_found.get("db_id"):
        await _update_postgis_feature(target_found["layer_id"], target_found["db_id"], None, t_props, user=user)
    else:
        try:
            update_feature_in_spatial_index(
                str(target_found["layer_id"]),
                target_fid,
                geom=target_found["feature"].get("geometry"),
                props=t_props,
            )
        except Exception:
            pass

    if existing:
        existing.update({key: value for key, value in link_fields.items() if value is not None})
        _save_persistent_state()
        return {"status": "linked", "link": existing}

    new_link = {
        "id": int(time.time() * 1000),
        "source_feature_id": feature_id,
        "source_layer_id": payload.get("source_layer_id") or source_found["layer_id"],
        "target_feature_id": target_fid,
        "target_layer_id": payload.get("target_layer_id") or target_found["layer_id"],
        "relationship_type": payload.get("relationship_type") or "base_layer_link",
        "notes": payload.get("notes", ""),
        "created_at": datetime.utcnow().isoformat(),
        **link_fields,
    }
    all_links.append(new_link)
    _save_persistent_state()

    return {"status": "linked", "link": new_link}


@app.delete("/api/features/{feature_id}/link")
async def unlink_feature(feature_id: Any, request: Request, target_feature_id: Optional[str] = None, link_id: Optional[int] = None):
    user = _require_user(request)
    source_found = await _find_feature_across_layers_async(feature_id)
    if not source_found:
        raise HTTPException(status_code=404, detail="फिचर भेटिएन। (Feature not found.)")
    source_layer = _layer_by_id(source_found["layer_id"])
    _enforce_layer_write_access(source_layer, user)
    if source_layer and source_found["feature"].get("geometry"):
        _st, s_err = _resolve_collector_grid(source_layer.get("project_id"), user, source_found["feature"].get("geometry"), source_layer.get("id"))
        if s_err:
            raise HTTPException(status_code=403, detail=s_err)

    all_links = STATE.setdefault("feature_links", [])
    f_str = str(feature_id)
    t_str = str(target_feature_id) if target_feature_id is not None else None
    target_found = await _find_feature_across_layers_async(t_str) if t_str else None
    if target_found:
        target_layer = _layer_by_id(target_found["layer_id"])
        _enforce_layer_write_access(target_layer, user)

    new_links = []
    removed_peer_ids = set()
    for lnk in all_links:
        src_id = str(lnk.get("source_feature_id"))
        tgt_id = str(lnk.get("target_feature_id"))
        if link_id is not None and str(lnk.get("id")) == str(link_id):
            if src_id == f_str:
                removed_peer_ids.add(tgt_id)
            elif tgt_id == f_str:
                removed_peer_ids.add(src_id)
            continue
        if t_str is not None and (
            (src_id == f_str and tgt_id == t_str) or (src_id == t_str and tgt_id == f_str)
        ):
            removed_peer_ids.add(t_str)
            continue
        if link_id is None and t_str is None and (src_id == f_str or tgt_id == f_str):
            removed_peer_ids.add(tgt_id if src_id == f_str else src_id)
            continue
        new_links.append(lnk)
    STATE["feature_links"] = new_links

    # Clear direct property links on source and affected peers
    s_props = source_found["feature"].setdefault("properties", {})
    s_props.pop("linked_feature_id", None)
    s_props.pop("linked_feature_ref", None)
    s_props.pop("link_attribute", None)
    if source_found.get("is_postgis") and source_found.get("db_id"):
        await _update_postgis_feature(
            source_found["layer_id"],
            source_found["db_id"],
            None,
            {"linked_feature_id": None, "linked_feature_ref": None, "link_attribute": None},
            user=user,
        )
    else:
        try:
            update_feature_in_spatial_index(
                str(source_found["layer_id"]),
                feature_id,
                geom=source_found["feature"].get("geometry"),
                props=s_props,
            )
        except Exception:
            pass

    for peer_id in removed_peer_ids:
        peer_found = target_found if (target_found and peer_id == t_str) else await _find_feature_across_layers_async(peer_id)
        if peer_found:
            p_props = peer_found["feature"].setdefault("properties", {})
            if str(p_props.get("linked_feature_id")) == f_str:
                p_props.pop("linked_feature_id", None)
                p_props.pop("linked_feature_ref", None)
                p_props.pop("link_attribute", None)
                if peer_found.get("is_postgis") and peer_found.get("db_id"):
                    await _update_postgis_feature(
                        peer_found["layer_id"],
                        peer_found["db_id"],
                        None,
                        {"linked_feature_id": None, "linked_feature_ref": None, "link_attribute": None},
                        user=user,
                    )
                else:
                    try:
                        update_feature_in_spatial_index(
                            str(peer_found["layer_id"]),
                            peer_id,
                            geom=peer_found["feature"].get("geometry"),
                            props=p_props,
                        )
                    except Exception:
                        pass

    _save_persistent_state(sync=True)
    return {"status": "unlinked", "feature_id": feature_id}


def _calculate_geodesic_metrics(geom):
    """Calculates geodesic area in m┬▓ and length in m for a Shapely geometry in EPSG:4326."""
    try:
        if geom.geom_type in ("Polygon", "MultiPolygon"):
            centroid_y = geom.centroid.y
            cos_lat = math.cos(math.radians(centroid_y))
            area_m2 = abs(geom.area) * (111320.0 * cos_lat) * 110574.0
            length_m = geom.length * 111139.0
            return round(area_m2, 2), round(length_m, 2)
        elif geom.geom_type in ("LineString", "MultiLineString"):
            length_m = geom.length * 111139.0
            return 0.0, round(length_m, 2)
        else:
            return 0.0, 0.0
    except Exception:
        return 0.0, 0.0


def _extract_polygon_parts(geom) -> List[Any]:
    """Recursively flattens any Polygons from MultiPolygons or GeometryCollections."""
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "Polygon":
        return [geom]
    parts = []
    if hasattr(geom, "geoms"):
        for sub in geom.geoms:
            parts.extend(_extract_polygon_parts(sub))
    return parts


def _extract_line_parts(geom) -> List[Any]:
    """Recursively flattens any LineStrings from MultiLineStrings or GeometryCollections."""
    if geom is None or geom.is_empty:
        return []
    if geom.geom_type == "LineString":
        return [geom]
    parts = []
    if hasattr(geom, "geoms"):
        for sub in geom.geoms:
            parts.extend(_extract_line_parts(sub))
    return parts


def _split_part_label(idx: int) -> str:
    """Clean alphabetical/numeric part suffix supporting idx >= 26 without invalid chr() codes."""
    if idx < 26:
        return chr(65 + idx)
    q, r = divmod(idx, 26)
    return f"{chr(64 + q)}{chr(65 + r)}" if q <= 26 else str(idx + 1)


def _split_single_linestring(line: LineString, blade: Any, ext_blade: Any) -> List[LineString]:
    """Splits a LineString into all segments cleanly across 2+ or 3+ blade crossings."""
    # 1. Try unextended blade directly first
    parts = _extract_line_parts(shapely_split(line, blade))
    if len(parts) >= 2:
        return parts
    # 2. Try capped extended blade
    parts = _extract_line_parts(shapely_split(line, ext_blade))
    if len(parts) >= 2:
        return parts
    # 3. Exact multi-division fallback using sorted projected intersection distances + shapely substring
    from shapely.ops import substring as shapely_substring
    inter = line.intersection(blade)
    if inter.is_empty:
        inter = line.intersection(ext_blade)
    if inter.is_empty:
        return [line]
    pts: List[Point] = []
    if inter.geom_type == "Point":
        pts = [inter]
    elif inter.geom_type == "MultiPoint":
        pts = list(inter.geoms)
    elif hasattr(inter, "geoms"):
        for g in inter.geoms:
            if g.geom_type == "Point":
                pts.append(g)
            elif g.geom_type == "LineString" and not g.is_empty:
                pts.append(Point(g.coords[0]))
                pts.append(Point(g.coords[-1]))
    line_len = line.length
    if not pts or line_len <= 0:
        return [line]
    dists = sorted({
        round(line.project(pt), 10)
        for pt in pts
        if 1e-9 < line.project(pt) < line_len - 1e-9
    })
    if not dists:
        return [line]
    cut_positions = [0.0] + dists + [line_len]
    segments: List[LineString] = []
    for i in range(len(cut_positions) - 1):
        d0, d1 = cut_positions[i], cut_positions[i + 1]
        if d1 - d0 <= 1e-9:
            continue
        seg = shapely_substring(line, d0, d1)
        if seg.geom_type == "LineString" and not seg.is_empty and seg.length > 0:
            segments.append(seg)
    return segments if len(segments) >= 2 else [line]


def _split_geometry_with_blade(target_shapely: Any, blade_shapely: Any) -> List[Any]:
    """Shared precision split engine for LineString/MultiLineString and Polygon/MultiPolygon."""
    b = target_shapely.bounds
    diag = math.hypot(b[2] - b[0], b[3] - b[1]) if len(b) == 4 else 0.001
    # Cap extension distance to a small epsilon so unrelated folds aren't sliced
    ext_dist = min(max(diag * 0.05, 1e-6), 0.0005)
    ext_blade = extend_linestring(blade_shapely, ext_dist)

    if not target_shapely.intersects(blade_shapely) and not target_shapely.intersects(ext_blade):
        raise HTTPException(
            status_code=400,
            detail="विभाजन रेखा (Blade) ले छानिएको ज्यामितिलाई काटेको छैन। कृपया ज्यामिति वारपार हुने गरी रेखा खिच्नुहोस्।",
        )

    if "Line" in target_shapely.geom_type:
        lines = _extract_line_parts(target_shapely)
        all_parts: List[Any] = []
        has_cut = False
        for line in lines:
            if line.intersects(blade_shapely) or line.intersects(ext_blade):
                sub_parts = _split_single_linestring(line, blade_shapely, ext_blade)
                if len(sub_parts) >= 2:
                    all_parts.extend(sub_parts)
                    has_cut = True
                else:
                    all_parts.append(line)
            else:
                all_parts.append(line)
        return all_parts if has_cut else []

    # Polygon / MultiPolygon: try unextended blade first, then small capped extension
    if hasattr(target_shapely, "geoms") and len(target_shapely.geoms) > 1:
        all_poly_parts: List[Any] = []
        has_cut = False
        for sub_poly in target_shapely.geoms:
            if sub_poly.intersects(blade_shapely) or sub_poly.intersects(ext_blade):
                extracted = _extract_polygon_parts(shapely_split(sub_poly, blade_shapely))
                if len(extracted) < 2:
                    extracted = _extract_polygon_parts(shapely_split(sub_poly, ext_blade))
                if len(extracted) >= 2:
                    all_poly_parts.extend(extracted)
                    has_cut = True
                else:
                    all_poly_parts.append(sub_poly)
            else:
                all_poly_parts.append(sub_poly)
        return all_poly_parts if has_cut else []

    extracted = _extract_polygon_parts(shapely_split(target_shapely, blade_shapely))
    if len(extracted) < 2:
        extracted = _extract_polygon_parts(shapely_split(target_shapely, ext_blade))
    return extracted


@app.post("/api/features/{feature_id}/split-preview")
async def split_feature_preview(feature_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    found = await _find_feature_across_layers_async(feature_id, scope_layer_id=payload.get("layer_id"))
    if not found or _feature_layer_readable(found, user) is None:
        raise HTTPException(status_code=404, detail="विभाजन गर्न छानिएको फिचर फेला परेन (Feature not found)")

    target_feat = found["feature"]
    lid = found["layer_id"]
    geom_data = target_feat.get("geometry")
    if not geom_data or not geom_data.get("coordinates"):
        raise HTTPException(status_code=400, detail="फिचरमा मान्य ज्यामिति फेला परेन")

    geom_type = geom_data.get("type", "")
    if "Point" in geom_type:
        raise HTTPException(
            status_code=400,
            detail="बिन्दु (Point) ज्यामितिलाई विभाजन (Split) गर्न मिल्दैन। केवल रेखा (Line) वा बहुभुज (Polygon) लाई मात्र विभाजन गर्न सकिन्छ।"
        )

    try:
        from shapely.validation import make_valid
        target_shapely = make_valid(shape(geom_data))
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"ज्यामिति पार्स गर्दा त्रुटि: {str(e)}")

    is_multipart = hasattr(target_shapely, "geoms") and len(target_shapely.geoms) > 1
    blade_data = payload.get("blade")
    split_multipart = payload.get("split_multipart", False)

    # In case of multipart features, splitting can be done automatically without a blade line ("Multipart to Singleparts")
    if (split_multipart or not blade_data or not blade_data.get("coordinates")) and is_multipart:
        geoms = [g for g in target_shapely.geoms if g.geom_type in ("Polygon", "LineString", "MultiPolygon", "MultiLineString")]
    else:
        if not blade_data or not blade_data.get("coordinates"):
            raise HTTPException(status_code=400, detail="काट्ने रेखा (Blade LineString) प्राप्त भएन।")

        try:
            blade_shapely = make_valid(shape(blade_data))
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"ब्लेड रेखा पार्स गर्दा त्रुटि: {str(e)}")

        try:
            geoms = _split_geometry_with_blade(target_shapely, blade_shapely)
        except HTTPException:
            raise
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"विभाजन गर्दा प्राविधिक त्रुटि: {str(e)}")

        if len(geoms) < 2:
            raise HTTPException(
                status_code=400,
                detail="विभाजन रेखाले ज्यामितिलाई पूर्ण २ भागमा विभाजन गर्न सकेन। कृपया ज्यामितिको बाहिरी सिमाना वारपार हुने गरी लामो रेखा खिच्नुहोस्।"
            )

    orig_props = dict(target_feat.get("properties", {}))
    orig_id = target_feat.get("id") or feature_id

    # Collect existing IDs in this layer to prevent collisions
    layer_feats = get_layer_features_list(lid)
    existing_ids = set()
    for f in layer_feats:
        fid = f.get("id")
        if fid is not None:
            existing_ids.add(str(fid))
        pfid = f.get("properties", {}).get("_id")
        if pfid is not None:
            existing_ids.add(str(pfid))

    base_id = str(orig_id)
    parts_preview = []
    used_suggested = set()
    for idx, g in enumerate(geoms):
        area_m2, length_m = _calculate_geodesic_metrics(g)
        if idx == 0:
            suggested_id = str(orig_id)
        else:
            letter_idx = idx
            candidate_id = f"{base_id}_{_split_part_label(letter_idx)}"
            while candidate_id in existing_ids or candidate_id in used_suggested:
                letter_idx += 1
                candidate_id = f"{base_id}_{_split_part_label(letter_idx)}"
            suggested_id = candidate_id

        used_suggested.add(suggested_id)
        parts_preview.append({
            "part_index": idx,
            "suggested_id": suggested_id,
            "geometry": mapping(g),
            "area_sqm": area_m2,
            "length_m": length_m,
            "is_original_id_candidate": (idx == 0),
        })

    return {
        "status": "preview_ok",
        "feature_id": orig_id,
        "layer_id": lid,
        "layer_name": found["layer_name"],
        "geometry_type": geom_type,
        "is_multipart": is_multipart,
        "part_count": len(geoms),
        "original_properties": orig_props,
        "parts": parts_preview,
    }


@app.post("/api/features/{feature_id}/split-confirm")
async def split_feature_confirm(feature_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    found = await _find_feature_across_layers_async(feature_id, scope_layer_id=payload.get("layer_id"))
    if not found:
        raise HTTPException(status_code=404, detail="विभाजन गर्न छानिएको फिचर फेला परेन")
    layer_obj = _layer_by_id(found["layer_id"])
    _enforce_layer_write_access(layer_obj, user)
    if layer_obj and found["feature"].get("geometry"):
        _t, grid_err = _resolve_collector_grid(layer_obj.get("project_id"), user, found["feature"].get("geometry"), layer_obj.get("id"))
        if grid_err:
            raise HTTPException(status_code=403, detail=grid_err)

    lid = found["layer_id"]
    parts_payload = payload.get("parts") if isinstance(payload.get("parts"), list) else (payload if isinstance(payload, list) else [])
    if len(parts_payload) < 2:
        raise HTTPException(status_code=400, detail="कम्तीमा २ विभाजन भागहरू आवश्यक छन्")

    is_pg = found.get("is_postgis") or (await _is_postgis_layer(lid))

    created_features = []
    for idx, p in enumerate(parts_payload):
        raw_part_id = p.get("id") or f"{feature_id}_{idx + 1}"
        part_id = str(raw_part_id)
        geom = p.get("geometry")
        props = dict(p.get("properties") or {})
        props["_id"] = part_id
        props["_split_from"] = feature_id
        props["_split_at"] = datetime.utcnow().isoformat()
        new_feat = {
            "type": "Feature",
            "id": part_id,
            "geometry": geom,
            "properties": props,
        }
        created_features.append(new_feat)

    if is_pg:
        orig_db_id = found.get("db_id") or (int(str(feature_id)) if str(feature_id).isdigit() else None)
        new_count = await _save_postgis_split_features(lid, orig_db_id, created_features, user=user)
    else:
        # Atomic split in SQLite: remove original and add parts
        delete_feature_from_spatial_index(str(lid), feature_id)
        for cf in created_features:
            add_feature_to_spatial_index(str(lid), cf)

        feats = get_layer_features_list(lid)
        f_str = str(feature_id)
        if feats and len(feats) <= 5000:
            new_feats_list = [f for f in feats if str(f.get("id")) != f_str and str(f.get("properties", {}).get("_id")) != f_str]
            new_feats_list.extend(created_features)
            set_layer_features(lid, new_feats_list)
            try:
                uploads_dir = get_uploads_dir()
                layers_dir = os.path.join(uploads_dir, "layers")
                f_path = os.path.join(layers_dir, f"{lid}_features.json")
                with open(f_path, "w", encoding="utf-8") as out_f:
                    json.dump(new_feats_list, out_f)
            except Exception:
                pass

        layer = _layer_by_id(lid)
        if layer:
            db_cnt = get_layer_feature_count(str(lid))
            layer["feature_count"] = db_cnt if db_cnt > 0 else ((layer.get("feature_count") or 1) + len(created_features) - 1)
            layer["tile_version"] = (layer.get("tile_version") or 0) + 1
        invalidate_spatial_index(lid)
        _save_persistent_state(sync=False)

    return {
        "status": "split_confirmed",
        "layer_id": lid,
        "original_feature_id": feature_id,
        "new_features": created_features,
    }


@app.post("/api/features/{feature_id}/split")
async def split_feature(feature_id: Any, payload: Dict[str, Any], request: Request):
    """Direct split endpoint sharing the precision split engine with PostGIS & grid enforcement."""
    user = _require_user(request)
    found = await _find_feature_across_layers_async(feature_id, scope_layer_id=payload.get("layer_id"))
    if not found:
        raise HTTPException(status_code=404, detail="Feature not found to split")
    layer = _layer_by_id(found["layer_id"])
    _enforce_layer_write_access(layer, user)

    target_feat = found["feature"]
    lid = found["layer_id"]
    if layer and target_feat.get("geometry"):
        _t, grid_err = _resolve_collector_grid(layer.get("project_id"), user, target_feat.get("geometry"), layer.get("id"))
        if grid_err:
            raise HTTPException(status_code=403, detail=grid_err)

    blade_data = payload.get("blade")
    if not blade_data or not blade_data.get("coordinates"):
        raise HTTPException(status_code=400, detail="काट्ने रेखा (Blade LineString) प्राप्त भएन। (A valid blade geometry is required.)")

    try:
        from shapely.validation import make_valid
        target_shapely = make_valid(shape(target_feat["geometry"]))
        blade_shapely = make_valid(shape(blade_data))
        geoms = _split_geometry_with_blade(target_shapely, blade_shapely)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"विभाजन गर्दा प्राविधिक त्रुटि: {str(e)}")

    if len(geoms) < 2:
        raise HTTPException(
            status_code=400,
            detail="विभाजन रेखाले ज्यामितिलाई कम्तीमा २ भागमा विभाजन गर्न सकेन। (Blade did not split the feature into at least 2 parts.)",
        )

    is_pg = found.get("is_postgis") or (await _is_postgis_layer(lid))
    t_props = dict(target_feat.get("properties", {}))
    created_features = []
    new_ids = []

    if is_pg:
        for idx, g in enumerate(geoms):
            label = _split_part_label(idx)
            part_id = feature_id if idx == 0 else f"{feature_id}_{label}"
            p_props = dict(t_props)
            p_props["_id"] = part_id
            p_props["_split_from"] = feature_id
            p_props["_split_at"] = datetime.utcnow().isoformat()
            if idx > 0 and p_props.get("bldg_code"):
                p_props["bldg_code"] = f"{p_props['bldg_code']}-{label}"
            created_features.append({"type": "Feature", "id": part_id, "geometry": mapping(g), "properties": p_props})
        orig_db_id = found.get("db_id") or (int(str(feature_id)) if str(feature_id).isdigit() else None)
        await _save_postgis_split_features(lid, orig_db_id, created_features, user=user)
        new_ids = [cf["id"] for cf in created_features]
    else:
        feats = get_layer_features_list(lid)
        f_str = str(feature_id)
        new_feats_list = [f for f in feats if str(f.get("id")) != f_str and str(f.get("properties", {}).get("_id")) != f_str]
        used_ids = set()
        for f in new_feats_list:
            if f.get("id") is not None:
                used_ids.add(str(f.get("id")))
            if f.get("properties", {}).get("_id") is not None:
                used_ids.add(str(f.get("properties", {}).get("_id")))

        for idx, g in enumerate(geoms):
            label = _split_part_label(idx)
            if idx == 0:
                part_id = feature_id
            else:
                cand = f"{feature_id}_{label}"
                c = 1
                while cand in used_ids:
                    cand = f"{feature_id}_{label}_{c}"
                    c += 1
                part_id = cand
            used_ids.add(str(part_id))
            new_ids.append(part_id)

            p_props = dict(t_props)
            p_props["_id"] = part_id
            p_props["_split_from"] = feature_id
            p_props["_split_at"] = datetime.utcnow().isoformat()
            if idx > 0 and p_props.get("bldg_code"):
                p_props["bldg_code"] = f"{p_props['bldg_code']}-{label}"

            f_part = {"type": "Feature", "id": part_id, "geometry": mapping(g), "properties": p_props}
            new_feats_list.append(f_part)
            created_features.append(f_part)

        # Atomic split in SQLite R-Tree: remove original and add parts
        delete_feature_from_spatial_index(str(lid), feature_id)
        for f_part in created_features:
            add_feature_to_spatial_index(str(lid), f_part)

        if layer:
            db_cnt = get_layer_feature_count(str(lid))
            layer["feature_count"] = db_cnt if db_cnt > 0 else ((layer.get("feature_count") or 1) + len(created_features) - 1)
            layer["tile_version"] = (layer.get("tile_version") or 0) + 1
        invalidate_spatial_index(lid)
        _save_persistent_state(sync=False)

    return {"status": "split_ok", "feature_id": feature_id, "part_count": len(created_features), "new_feature_ids": new_ids}


@app.post("/api/layers/{layer_id}/merge")
@app.post("/api/layers/{layer_id}/features/merge")
async def merge_layer_features(layer_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    layer = _layer_by_id(layer_id)
    if not layer:
        raise HTTPException(status_code=404, detail="भेक्टर तह फेला परेन। (Vector layer not found.)")
    _enforce_layer_write_access(layer, user)
    feature_ids = [str(x).strip() for x in (payload.get("feature_ids") or []) if str(x).strip()]
    if len(feature_ids) < 2:
        raise HTTPException(status_code=400, detail="एकीकरण (Merge) का लागि कम्तीमा २ फिचरहरू छान्न आवश्यक छ")

    is_pg = await _is_postgis_layer(layer_id)
    picked = []
    if is_pg:
        picked = await _get_postgis_features_by_ids(layer_id, feature_ids)

    if len(picked) < 2:
        f_id_set = set(feature_ids)
        for x in list(f_id_set):
            if x.isdigit():
                f_id_set.add(str(int(x)))

        feats = get_layer_features_list(layer_id)

        def match_feature(f):
            f_id = str(f.get("id") or "").strip()
            props = f.get("properties") or {}
            p_id = str(props.get("_id") or "").strip()
            p_oid = str(props.get("objectid") or props.get("OBJECTID") or props.get("fid") or props.get("id") or "").strip()
            return (f_id and f_id in f_id_set) or (p_id and p_id in f_id_set) or (p_oid and p_oid in f_id_set)

        for f in feats:
            if match_feature(f) and f not in picked:
                picked.append(f)

    if len(picked) < len(feature_ids):
        picked_ids = {str(p.get("id")) for p in picked} | {str(p.get("properties", {}).get("_id")) for p in picked}
        for fid in feature_ids:
            if str(fid) not in picked_ids:
                try:
                    sp_feat = get_feature_by_uid(str(fid), str(layer_id))
                    if sp_feat:
                        picked.append(sp_feat)
                        picked_ids.add(str(sp_feat.get("id")))
                        picked_ids.add(str(sp_feat.get("properties", {}).get("_id")))
                except Exception:
                    pass

        client_feats = payload.get("features") or []
        for cf in client_feats:
            cf_id = str(cf.get("id") or cf.get("properties", {}).get("_id") or "")
            if cf_id and (cf_id in feature_ids or (f_id_set and cf_id in f_id_set)) and cf_id not in picked_ids:
                picked.append(cf)
                picked_ids.add(cf_id)

    if len(picked) < 2:
        raise HTTPException(status_code=400, detail="छानिएका फिचरहरू यस तहमा फेला परेनन् (Features not found in this layer)")

    # Enforce task-grid & layer-scope rules for every feature being merged
    for pf in picked:
        if pf.get("geometry"):
            _t, grid_err = _resolve_collector_grid(layer.get("project_id"), user, pf.get("geometry"), layer.get("id"))
            if grid_err:
                raise HTTPException(status_code=403, detail=grid_err)
            _enforce_layer_scope_for_grid(layer.get("project_id"), user, layer.get("id"), pf.get("geometry"))

    merge_mode = payload.get("merge_mode") or "union"
    primary_id = str(payload.get("primary_feature_id") or picked[0].get("id"))
    custom_id = str(payload.get("custom_id") or "").strip()
    final_id = custom_id if custom_id else primary_id

    primary_feat = next((f for f in picked if str(f.get("id")) == primary_id or str(f.get("properties", {}).get("_id")) == primary_id), picked[0])

    user_attrs = payload.get("attributes")
    if user_attrs is not None:
        cleaned_attrs = _clean_record_answers(user_attrs)
        _enforce_field_entry_permissions(
            layer,
            user,
            cleaned_attrs,
            primary_feat.get("geometry"),
            existing=primary_feat.get("properties", {}),
        )
        merged_props = {**dict(primary_feat.get("properties", {})), **cleaned_attrs}
    else:
        merged_props = dict(primary_feat.get("properties", {}))

    try:
        from shapely.validation import make_valid
        shapely_geoms = [
            make_valid(shape(f.get("geometry")))
            for f in picked
            if f.get("geometry") and f.get("geometry", {}).get("coordinates")
        ]
        if not shapely_geoms:
            raise HTTPException(status_code=400, detail="मान्य ज्यामिति फेला परेन")

        warning_msg = None
        is_multipart_fallback = False
        from shapely.geometry import MultiPolygon, MultiLineString

        first_type = (picked[0].get("geometry") or {}).get("type", "Polygon")
        if "Polygon" in first_type:
            # First attempt: Dissolve polygons with unary_union
            union_poly = make_valid(shapely_unary_union(shapely_geoms))
            if union_poly.geom_type == "Polygon":
                merged_shapely = union_poly
            elif union_poly.geom_type == "MultiPolygon":
                # Precision micro-snap (~1cm mitre buffer) to close floating-point slivers without bridging gaps
                snapped_fused = make_valid(union_poly.buffer(1e-7, join_style=2).buffer(-1e-7, join_style=2))
                if snapped_fused.geom_type == "Polygon":
                    merged_shapely = snapped_fused
                else:
                    # Polygons are separated / disjoint (> 5m apart)!
                    # Fall back to MultiPolygon to preserve ALL parts without deleting any feature!
                    merged_shapely = union_poly
                    is_multipart_fallback = True
                    warning_msg = (
                        "फिचरहरू एक आपसमा नजोडिएका (Disjoint/टाढा) हुनाले एकल बहुभुज (Singlepart) बनाउन सकिएन। "
                        "कुनै पनि भाग नहटाई सबै भागहरूलाई सुरक्षित रूपमा मल्टिपार्ट (MultiPolygon) को रूपमा एकीकरण गरिएको छ।"
                    )
            elif union_poly.geom_type == "GeometryCollection":
                polys = [g for g in union_poly.geoms if "Polygon" in g.geom_type]
                if len(polys) == 1:
                    merged_shapely = polys[0]
                elif len(polys) > 1:
                    merged_shapely = MultiPolygon(polys)
                    is_multipart_fallback = True
                    warning_msg = "फिचरहरू छुट्टाछुट्टै रहेकाले मल्टिपार्ट (MultiPolygon) को रूपमा सुरक्षित एकीकरण गरिएको छ।"
                else:
                    merged_shapely = shapely_geoms[0]
            else:
                merged_shapely = union_poly
        elif "Line" in first_type:
            # Dissolve and linemerge into a singlepart LineString if lines touch
            from shapely.ops import linemerge
            unioned_lines = make_valid(shapely_unary_union(shapely_geoms))
            if unioned_lines.geom_type == "MultiLineString":
                merged_lines = make_valid(linemerge(unioned_lines))
            elif unioned_lines.geom_type == "GeometryCollection":
                extracted_lines = _extract_line_parts(unioned_lines)
                merged_lines = make_valid(linemerge(extracted_lines)) if len(extracted_lines) > 1 else (extracted_lines[0] if extracted_lines else unioned_lines)
            else:
                merged_lines = unioned_lines
            if merged_lines.geom_type == "LineString":
                merged_shapely = merged_lines
            elif merged_lines.geom_type == "MultiLineString":
                # Lines are disconnected: preserve ALL lines as MultiLineString without dropping any!
                merged_shapely = merged_lines
                is_multipart_fallback = True
                warning_msg = (
                    "रेखाहरू एक आपसमा नछोइएकाले निरन्तर एकल रेखा बनाउन सकिएन। "
                    "कुनै पनि भाग नहटाई सबै खण्डहरूलाई सुरक्षित रूपमा मल्टिपार्ट (MultiLineString) को रूपमा एकीकरण गरिएको छ।"
                )
            elif merged_lines.geom_type == "GeometryCollection":
                lines = [g for g in merged_lines.geoms if "Line" in g.geom_type]
                if len(lines) == 1:
                    merged_shapely = lines[0]
                elif len(lines) > 1:
                    merged_shapely = MultiLineString(lines)
                    is_multipart_fallback = True
                    warning_msg = "रेखाहरू मल्टिपार्ट (MultiLineString) को रूपमा एकीकरण गरियो।"
                else:
                    merged_shapely = shapely_geoms[0]
            else:
                merged_shapely = merged_lines
        elif "Point" in first_type:
            pts_list: List[Point] = []
            for g in shapely_geoms:
                if g.geom_type == "Point":
                    pts_list.append(g)
                elif g.geom_type == "MultiPoint":
                    pts_list.extend(list(g.geoms))
                elif hasattr(g, "geoms"):
                    pts_list.extend(sub for sub in g.geoms if sub.geom_type == "Point")
            merged_shapely = MultiPoint(pts_list) if len(pts_list) > 1 else (pts_list[0] if pts_list else shapely_geoms[0])
            if len(pts_list) > 1:
                is_multipart_fallback = True
        else:
            merged_shapely = shapely_unary_union(shapely_geoms)

        merged_geom = mapping(merged_shapely)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"भौगोलिक एकीकरण गर्दा त्रुटि: {str(e)}")

    merged_props["_id"] = final_id
    merged_props["_merge_mode"] = "multifeature" if is_multipart_fallback else merge_mode
    merged_props["_merged_feature_count"] = len(picked)
    merged_props["_merged_source_ids"] = [f.get("id") for f in picked]
    merged_props["_is_multipart_fallback"] = is_multipart_fallback
    merged_props["_updated_at"] = datetime.utcnow().isoformat()

    merged_feature = {
        "type": "Feature",
        "id": final_id,
        "geometry": merged_geom,
        "properties": merged_props,
    }

    if is_pg:
        new_count = await _save_postgis_merged_feature(layer_id, picked, merged_feature, user=user)
    else:
        # Atomic merge in SQLite R-Tree: remove picked features and add merged feature
        for pf in picked:
            delete_feature_from_spatial_index(str(layer_id), pf.get("id") or pf.get("properties", {}).get("_id"))
        add_feature_to_spatial_index(str(layer_id), merged_feature)

        # Synchronize in-memory features and disk cache
        picked_ids = {str(pf.get("id")) for pf in picked} | {str(pf.get("properties", {}).get("_id")) for pf in picked}
        current_feats = get_layer_features_list(layer_id)
        if current_feats:
            new_feats = [f for f in current_feats if str(f.get("id")) not in picked_ids and str(f.get("properties", {}).get("_id")) not in picked_ids]
            new_feats.append(merged_feature)
            set_layer_features(layer_id, new_feats)
            try:
                uploads_dir = get_uploads_dir()
                layers_dir = os.path.join(uploads_dir, "layers")
                f_path = os.path.join(layers_dir, f"{layer_id}_features.json")
                with open(f_path, "w", encoding="utf-8") as out_f:
                    json.dump(new_feats, out_f)
            except Exception:
                pass

        if layer:
            db_cnt = get_layer_feature_count(str(layer_id))
            layer["feature_count"] = db_cnt if db_cnt > 0 else max(1, (layer.get("feature_count") or len(picked)) - (len(picked) - 1))
            layer["tile_version"] = (layer.get("tile_version") or 0) + 1
        invalidate_spatial_index(layer_id)
        _save_persistent_state(sync=False)
        new_count = layer.get("feature_count", 1) if layer else 1

    return {
        "status": "merged_ok",
        "merge_mode": "multifeature" if is_multipart_fallback else merge_mode,
        "is_multipart_fallback": is_multipart_fallback,
        "warning": warning_msg,
        "feature_id": merged_feature["id"],
        "geometry_type": merged_geom.get("type"),
        "merged_count": len(picked),
        "feature_count": new_count,
        "feature": merged_feature,
        "merged_feature": merged_feature,
    }


# ---- Cross-Layer Attribute Linking -----------------------------------------

LINK_METHODS = ("attribute", "spatial", "direct")
LINK_SPATIAL_PREDICATES = ("intersects", "within", "contains", "nearest")


def _link_field_name(target_layer_name: Any, custom_name: Any) -> str:
    raw = str(custom_name or "").strip()
    if raw:
        name = re.sub(r"[^a-zA-Z0-9_]+", "_", raw).strip("_")
    else:
        clean = re.sub(r"[^a-zA-Z0-9_]+", "_", str(target_layer_name or "").strip())
        clean = re.sub(r"_+", "_", clean).strip("_")
        name = f"{clean or 'target'}_linked_id"
    return name or "target_linked_id"


def _link_prop_value(feature: Dict[str, Any], field: Any) -> Any:
    if not isinstance(feature, dict):
        return None
    props = feature.get("properties") or {}
    if str(field) in ("_id", "id"):
        return props.get("_id", feature.get("id"))
    return props.get(field)


def _link_normalize(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, float) and value.is_integer():
        value = int(value)
    text = str(value).strip()
    return text or None


def _link_geometry(feature: Dict[str, Any]):
    geom = feature.get("geometry") if isinstance(feature, dict) else None
    if not isinstance(geom, dict) or not geom.get("coordinates"):
        return None
    try:
        from shapely.validation import make_valid
        return make_valid(shape(geom))
    except Exception:
        try:
            return shape(geom)
        except Exception:
            return None


@app.post("/api/layers/{layer_id}/link")
async def link_layer_features(layer_id: Any, payload: Dict[str, Any], request: Request):
    """Materialises a cross-layer relationship as a new attribute on the source
    layer and records feature-to-feature links (LinkLayersModal contract)."""
    user = _require_user(request)
    source_layer = _layer_by_id(layer_id)
    if source_layer is None or source_layer.get("deleted_at"):
        raise HTTPException(status_code=404, detail="स्रोत भेक्टर तह भेटिएन। (Source layer not found.)")
    _enforce_layer_write_access(source_layer, user)

    target_layer_id = payload.get("target_layer_id")
    target_layer = _layer_by_id(target_layer_id)
    if target_layer is None or target_layer.get("deleted_at"):
        raise HTTPException(status_code=404, detail="लक्षित भेक्टर तह भेटिएन। (Target layer not found.)")
    if not _layer_visible_to_user(target_layer, user):
        raise HTTPException(status_code=403, detail="लक्षित तह पढ्ने पहुँच छैन। (You cannot read the target layer.)")

    link_method = str(payload.get("link_method") or "attribute").strip().lower()
    if link_method not in LINK_METHODS:
        raise HTTPException(
            status_code=400,
            detail=f"अवैध सम्बन्ध विधि '{link_method}'। (link_method must be one of: {', '.join(LINK_METHODS)}.)",
        )

    source_match_field = payload.get("source_match_field")
    target_match_field = payload.get("target_match_field")
    spatial_predicate = str(payload.get("spatial_predicate") or "intersects").strip().lower()
    if link_method == "attribute" and (not source_match_field or not target_match_field):
        raise HTTPException(
            status_code=400,
            detail="विशेषता मिलानका लागि स्रोत र लक्षित दुवै फिल्ड आवश्यक छ। (Both match fields are required.)",
        )
    if link_method == "spatial" and spatial_predicate not in LINK_SPATIAL_PREDICATES:
        raise HTTPException(
            status_code=400,
            detail="अवैध भौगोलिक सम्बन्ध प्रकार। (Invalid spatial predicate.)",
        )

    target_id_field = payload.get("target_id_field") or "_id"
    overwrite_existing = bool(payload.get("overwrite_existing", True))
    out_field = _link_field_name(target_layer.get("name"), payload.get("custom_field_name"))

    source_feats = list(get_layer_features_list(source_layer.get("id")))
    target_feats = list(get_layer_features_list(target_layer.get("id")))

    target_by_attr: Dict[str, Dict[str, Any]] = {}
    if link_method == "attribute":
        for tf in target_feats:
            key = _link_normalize(_link_prop_value(tf, target_match_field))
            if key is not None and key not in target_by_attr:
                target_by_attr[key] = tf

    spatial_tree = None
    spatial_geoms = None
    if link_method == "spatial" and target_feats:
        spatial_geoms = [_link_geometry(tf) for tf in target_feats]
        valid_pairs = [(idx, geom) for idx, geom in enumerate(spatial_geoms) if geom is not None]
        if valid_pairs:
            try:
                from shapely.strtree import STRtree
                spatial_tree = STRtree([geom for _, geom in valid_pairs])
                spatial_geoms = [idx for idx, _ in valid_pairs]
            except Exception:
                spatial_tree = None
                spatial_geoms = [idx for idx, geom in enumerate(spatial_geoms) if geom is not None]

    def pick_target(index: int, source_feat: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        if not target_feats:
            return None
        if link_method == "attribute":
            key = _link_normalize(_link_prop_value(source_feat, source_match_field))
            return target_by_attr.get(key) if key is not None else None
        if link_method == "direct":
            return target_feats[index % len(target_feats)]
        # spatial
        src_geom = _link_geometry(source_feat)
        if src_geom is None or not target_feats:
            return None
        if spatial_tree is not None:
            try:
                if spatial_predicate == "nearest":
                    nearest_pos = spatial_tree.nearest(src_geom)
                    return target_feats[spatial_geoms[int(nearest_pos)]] if nearest_pos is not None else None
                candidate_positions = spatial_tree.query(src_geom, predicate="intersects")
                for pos in list(candidate_positions):
                    target_feat = target_feats[spatial_geoms[int(pos)]]
                    target_geom = _link_geometry(target_feat)
                    if target_geom is None:
                        continue
                    if spatial_predicate == "intersects" and src_geom.intersects(target_geom):
                        return target_feat
                    if spatial_predicate == "within" and src_geom.within(target_geom):
                        return target_feat
                    if spatial_predicate == "contains" and src_geom.contains(target_geom):
                        return target_feat
                return None
            except Exception:
                pass
        best_feat = None
        best_distance = None
        for tf in target_feats:
            target_geom = _link_geometry(tf)
            if target_geom is None:
                continue
            if spatial_predicate == "intersects" and src_geom.intersects(target_geom):
                return tf
            if spatial_predicate == "within" and src_geom.within(target_geom):
                return tf
            if spatial_predicate == "contains" and src_geom.contains(target_geom):
                return tf
            if spatial_predicate == "nearest":
                distance = src_geom.distance(target_geom)
                if best_distance is None or distance < best_distance:
                    best_distance = distance
                    best_feat = tf
        return best_feat if spatial_predicate == "nearest" else None

    linked_count = 0
    matched_count = 0
    existing_links = STATE.setdefault("feature_links", [])
    existing_keys = {
        (str(link.get("source_feature_id")), str(link.get("target_feature_id")))
        for link in existing_links
    }
    relationship_type = "attribute_match" if link_method == "attribute" else ("spatial_join" if link_method == "spatial" else "direct_link")

    for index, source_feat in enumerate(source_feats):
        target_feat = pick_target(index, source_feat)
        if target_feat is None:
            continue
        matched_count += 1
        props = source_feat.setdefault("properties", {})
        if not overwrite_existing and _link_normalize(props.get(out_field)) is not None:
            continue
        value = _link_prop_value(target_feat, target_id_field)
        if value is None:
            continue
        props[out_field] = value
        linked_count += 1

        source_id = source_feat.get("id", props.get("_id"))
        target_id = target_feat.get("id", (target_feat.get("properties") or {}).get("_id"))
        link_key = (str(source_id), str(target_id))
        if source_id is not None and target_id is not None and link_key not in existing_keys:
            existing_keys.add(link_key)
            existing_links.append({
                "id": int(time.time() * 1000) + index,
                "source_feature_id": source_id,
                "source_layer_id": source_layer.get("id"),
                "target_feature_id": target_id,
                "target_layer_id": target_layer.get("id"),
                "relationship_type": relationship_type,
                "notes": f"{out_field}: {value}",
                "created_at": datetime.utcnow().isoformat(),
            })

    set_layer_features(source_layer.get("id"), source_feats)

    fields_config = source_layer.get("fields_config")
    if isinstance(fields_config, list):
        if not any(str(field.get("name")) == out_field for field in fields_config if isinstance(field, dict)):
            fields_config.append({
                "name": out_field,
                "label": out_field.replace("_", " ").title(),
                "type": "text",
                "required": False,
                "is_unique": False,
                "visible_in_popup": True,
            })
    all_fields = source_layer.get("all_fields_config")
    if isinstance(all_fields, list):
        if not any(str(field.get("name")) == out_field for field in all_fields if isinstance(field, dict)):
            all_fields.append({"name": out_field, "label": out_field.replace("_", " ").title(), "type": "text"})

    source_layer["feature_count"] = len(source_feats)
    _record_audit_entry(
        source_layer.get("id"),
        "LINK",
        user,
        details={
            "target_layer_id": target_layer.get("id"),
            "link_method": link_method,
            "spatial_predicate": spatial_predicate if link_method == "spatial" else None,
            "field": out_field,
            "linked_count": linked_count,
        },
    )
    invalidate_spatial_index(source_layer.get("id"))
    _save_persistent_state()

    total_source_features = len(source_feats)
    return {
        "status": "linked_ok",
        "source_layer_name": source_layer.get("name") or f"Layer #{source_layer.get('id')}",
        "target_layer_name": target_layer.get("name") or f"Layer #{target_layer.get('id')}",
        "linked_attribute_name": out_field,
        "linked_count": linked_count,
        "matched_count": matched_count,
        "total_source_features": total_source_features,
        "matched_percentage": round((linked_count / total_source_features) * 100, 1) if total_source_features else 0.0,
    }


# ---- 6. Projects & GeoPortal Endpoints ----

@app.get("/api/projects")
async def list_projects(request: Request):
    user = resolve_request_user(request)
    if user is None:
        # Project metadata is never exposed anonymously; the public GeoPortal
        # uses its own catalog endpoints.
        return []
    if _actor_role(user) in SUPER_ROLES:
        return STATE["projects"]
    return [p for p in STATE["projects"] if _user_can_access_project(user, p.get("id"))]


def _validated_project_mode(value: Any) -> str:
    mode = str(value or "STANDARD").strip().upper()
    if mode not in PROJECT_MODES:
        raise HTTPException(
            status_code=400,
            detail=f"अवैध परियोजना मोड '{value}'. (Project mode must be one of: {', '.join(PROJECT_MODES)}.)",
        )
    return mode


def _validated_geometry_config(value: Any) -> Dict[str, Any]:
    if isinstance(value, str):
        geometry_type = value
    elif isinstance(value, dict):
        geometry_type = value.get("type") or value.get("geometry_type")
    else:
        geometry_type = None
    geometry_type = _canonical_geometry_type(geometry_type)
    if geometry_type not in PROJECT_GEOMETRY_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"अवैध ज्यामिति प्रकार '{geometry_type}'. (Geometry type must be one of: {', '.join(PROJECT_GEOMETRY_TYPES)}.)",
        )
    return {"type": geometry_type}


def _apply_project_fields(project: Dict[str, Any], payload: Dict[str, Any], actor: Optional[Dict[str, Any]] = None) -> None:
    """Applies whitelisted, validated project settings (mode, geometry, grid defaults, AOI)."""
    if "department_admin_ids" in payload:
        if not _is_super_user(actor):
            raise HTTPException(
                status_code=403,
                detail="परियोजनामा विभागीय प्रशासक तोक्न मास्टर वा सुपर प्रशासक अधिकार आवश्यक छ। "
                       "(Only a master/super administrator can link department admins to a project.)",
            )
        raw = payload.get("department_admin_ids")
        if raw is None:
            raw = []
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail="department_admin_ids must be a list of user ids.")
        linked: List[Any] = []
        for raw_id in raw:
            member = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(raw_id)), None)
            if member is None:
                raise HTTPException(status_code=404, detail=f"प्रयोगकर्ता #{raw_id} भेटिएन। (User not found.)")
            if _actor_role(member) not in DEPARTMENT_ADMIN_ROLES:
                raise HTTPException(
                    status_code=400,
                    detail=f"'{member.get('username')}' विभागीय प्रशासक होइन। (User is not a DepartmentAdmin.)",
                )
            linked.append(member.get("id"))
        project["department_admin_ids"] = linked
    if "name" in payload:
        name = str(payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="परियोजनाको नाम आवश्यक छ। (Project name is required.)")
        project["name"] = name
    if "name_ne" in payload:
        project["name_ne"] = payload.get("name_ne") or ""
    if "description" in payload:
        project["description"] = payload.get("description") or ""
    if "status" in payload:
        project["status"] = payload.get("status") or project.get("status") or "active"
    if "project_mode" in payload or "mode" in payload:
        project["project_mode"] = _validated_project_mode(payload.get("project_mode") or payload.get("mode"))
    if "geometry_config" in payload or "geometry_type" in payload:
        project["geometry_config"] = _validated_geometry_config(
            payload.get("geometry_config", payload.get("geometry_type"))
        )
    if "grid_type" in payload:
        try:
            project["grid_type"] = normalize_grid_mode(payload.get("grid_type"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if "grid_size_m" in payload:
        try:
            project["grid_size_m"] = validate_cell_size(payload.get("grid_size_m"))
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
    if payload.get("boundary_geojson") or payload.get("aoi_geojson"):
        boundary = _boundary_as_geojson(payload.get("boundary_geojson") or payload.get("aoi_geojson"))
        project["boundary_geojson"] = boundary
        project["aoi_area_sqm"] = round(geometry_area_sqm(boundary), 2)
        project["aoi_mode"] = payload.get("aoi_mode") or "drawn_polygon"
    elif "aoi_mode" in payload:
        project["aoi_mode"] = payload.get("aoi_mode")
    if "house_numbering_enabled" in payload:
        project["house_numbering_enabled"] = bool(payload.get("house_numbering_enabled"))
    if "house_numbering_config" in payload or any(k.startswith("house_numbering_") for k in payload):
        cfg = project.get("house_numbering_config") or {}
        if isinstance(payload.get("house_numbering_config"), dict):
            cfg.update(payload["house_numbering_config"])
        for k in ("building_layer_id", "gate_layer_id", "road_layer_id", "link_field", "road_name_field"):
            if k in payload:
                cfg[k] = payload[k]
            pref_k = f"house_numbering_{k}"
            if pref_k in payload:
                cfg[k] = payload[pref_k]
        project["house_numbering_config"] = cfg

    for list_key in ("editable_layer_ids", "download_layer_ids"):
        if list_key not in payload:
            continue
        raw = payload.get(list_key)
        if not isinstance(raw, list):
            raise HTTPException(status_code=400, detail=f"{list_key} must be a list of layer ids.")
        project[list_key] = [value for value in raw if value not in (None, "")]
    # Collector editability and validator download permissions are stored strictly per
    # (project_id, layer_id) on the project record — never mutate shared layers' global flags.


def _layer_download_allowed(layer: Dict[str, Any], user: Optional[Dict[str, Any]]) -> bool:
    """Admins download everything; validators only layers the admin granted."""
    if _is_admin_user(user):
        return True
    if _actor_role(user) != "Validator":
        return False
    if layer.get("validator_download_allowed") is True:
        return True
    project = _find_project(layer.get("project_id")) if layer.get("project_id") is not None else None
    if project and isinstance(project.get("download_layer_ids"), list):
        if str(layer.get("id")) in {str(value) for value in project.get("download_layer_ids")}:
            return True
    for p in STATE.get("projects", []):
        if _user_can_access_project(user, p.get("id")):
            if str(layer.get("id")) in {str(value) for value in (p.get("download_layer_ids") or [])}:
                return True
    return False


@app.post("/api/projects")
async def create_project(payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    is_org_admin = _is_super_user(actor)
    if not is_org_admin and not _is_department_admin_user(actor):
        raise HTTPException(
            status_code=403,
            detail="परियोजना सिर्जना गर्न प्रशासक अधिकार आवश्यक छ। (Administrator role required to create a project.)",
        )
    if not is_org_admin:
        # A DepartmentAdmin owns the projects they create; they may not grant
        # other departments access during creation.
        payload = {k: v for k, v in payload.items() if k != "department_admin_ids"}
    p_id = int(time.time() * 1000)
    new_proj = {
        "id": p_id,
        "name": "New Project",
        "name_ne": "",
        "description": "",
        "status": payload.get("status") or "active",
        "project_mode": "STANDARD",
        "geometry_config": {"type": "Point"},
        "grid_type": "HEXAGON",
        "grid_size_m": 200,
        "aoi_mode": None,
        "boundary_geojson": None,
        "editable_layer_ids": [],
        "download_layer_ids": [],
        "department_admin_ids": [],
        "house_numbering_enabled": bool(payload.get("house_numbering_enabled", False)),
        "house_numbering_config": payload.get("house_numbering_config") or {},
        "task_count": 0,
        "created_at": time.time(),
        "updated_at": time.time(),
    }
    _apply_project_fields(new_proj, payload, actor)
    if not is_org_admin:
        new_proj["department_admin_ids"] = [actor.get("id")]
    STATE["projects"].append(new_proj)
    _save_persistent_state(sync=True)
    return new_proj


@app.put("/api/projects/{project_id}")
async def update_project(project_id: int, payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(actor, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजना परिवर्तन गर्न पहुँच छैन। (You cannot modify this project.)")
    _apply_project_fields(project, payload, actor)
    project["updated_at"] = time.time()
    _save_persistent_state(sync=True)
    return project


@app.get("/api/projects/{project_id}")
async def get_project(project_id: int, request: Request):
    user = resolve_request_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    return project


@app.delete("/api/projects/{project_id}")
async def delete_project(project_id: int, request: Request, db: AsyncSession = Depends(get_db)):
    actor = _require_super_user(request)
    target = _require_project(project_id)
    STATE["projects"] = [p for p in STATE["projects"] if str(p.get("id")) != str(project_id)]
    STATE["project_assignments"].pop(project_id, None)
    STATE["project_assignments"].pop(str(project_id), None)
    STATE["project_collectors"].pop(project_id, None)
    STATE["project_collectors"].pop(str(project_id), None)
    # Task grids belong to the project: remove them (tasking is not spatial data).
    STATE.setdefault("tasks_by_project", {}).pop(project_id, None)
    STATE["tasks_by_project"].pop(str(project_id), None)
    # Layers are never promoted to public scope on project deletion: that would
    # leak project data. They move to the recycle bin, still bound to the project.
    now = time.time()
    for l in STATE["vector_layers"]:
        if str(l.get("project_id")) == str(project_id) and not l.get("deleted_at"):
            l["deleted_at"] = now
            l["deleted_by"] = actor.get("id")
            l["deleted_by_username"] = actor.get("username")
            l["deleted_by_role"] = _actor_role(actor)
    for r in STATE["raster_layers"]:
        if str(r.get("project_id")) == str(project_id) and not r.get("deleted_at"):
            r["deleted_at"] = now
            r["deleted_by"] = actor.get("id")
            r["deleted_by_username"] = actor.get("username")
            r["deleted_by_role"] = _actor_role(actor)
    try:
        await db.execute(text("DELETE FROM task_grids WHERE project_id = :pid"), {"pid": int(project_id)})
        await db.execute(text("DELETE FROM vector_features WHERE layer_id IN (SELECT id FROM vector_layers WHERE project_id = :pid)"), {"pid": int(project_id)})
        await db.execute(text("DELETE FROM vector_layers WHERE project_id = :pid"), {"pid": int(project_id)})
        await db.execute(text("DELETE FROM survey_projects WHERE id = :pid"), {"pid": int(project_id)})
        await db.commit()
    except Exception as exc:  # noqa: BLE001 - DB is a best-effort mirror
        try:
            await db.rollback()
        except Exception:
            pass
        print(f"[KMC-PROJECTS] DB delete skipped: {exc}")
    _save_persistent_state(sync=True)
    return {"status": "deleted", "id": project_id, "name": target.get("name")}


def _get_or_create_project_assignment(project_id: int) -> dict:
    if project_id in STATE["project_assignments"]:
        rec = STATE["project_assignments"][project_id]
    elif str(project_id) in STATE["project_assignments"]:
        rec = STATE["project_assignments"][str(project_id)]
    else:
        rec = {"assigned_layer_ids": [], "assigned_mbtiles_ids": []}
        STATE["project_assignments"][project_id] = rec
    if "assigned_layer_ids" not in rec:
        rec["assigned_layer_ids"] = []
    if "assigned_mbtiles_ids" not in rec:
        rec["assigned_mbtiles_ids"] = []
    return rec


@app.get("/api/projects/{project_id}/assignments")
async def get_project_assignments(project_id: int, request: Request):
    user = resolve_request_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    rec = STATE.get("project_assignments", {}).get(project_id) or STATE.get("project_assignments", {}).get(str(project_id))
    if not rec:
        return {"assigned_layer_ids": [], "assigned_mbtiles_ids": []}
    return rec


@app.post("/api/projects/{project_id}/assign-layer")
async def assign_project_layer(project_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    layer_id = payload.get("layer_id")
    if not layer_id:
        raise HTTPException(status_code=400, detail="layer_id is required")
    layer = next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    owner_project_id = layer.get("project_id")
    if owner_project_id not in (None, "") and str(owner_project_id) != str(project_id):
        raise HTTPException(
            status_code=400,
            detail="अर्को परियोजनाको तह यहाँ लिङ्क गर्न मिल्दैन। (A layer owned by another project cannot be linked here.)",
        )
    rec = _get_or_create_project_assignment(project_id)
    curr = rec["assigned_layer_ids"]
    if layer_id not in curr and str(layer_id) not in [str(x) for x in curr]:
        curr.append(layer_id)
    _save_persistent_state(sync=True)
    return {"status": "ok", "project_id": project_id, "assignments": rec}


@app.delete("/api/projects/{project_id}/unassign-layer/{layer_id}")
async def unassign_project_layer(project_id: int, layer_id: str, request: Request):
    user = _require_admin_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    rec = _get_or_create_project_assignment(project_id)
    curr = rec.get("assigned_layer_ids", [])
    rec["assigned_layer_ids"] = [x for x in curr if str(x) != str(layer_id)]
    _save_persistent_state(sync=True)
    return {"status": "ok", "project_id": project_id, "assignments": rec}


@app.post("/api/projects/{project_id}/assign-tiles")
async def assign_project_tiles(project_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    mbtiles_id = payload.get("mbtiles_id")
    if not mbtiles_id:
        raise HTTPException(status_code=400, detail="mbtiles_id is required")
    raster = next((r for r in STATE.get("raster_layers", []) if str(r.get("id")) == str(mbtiles_id)), None)
    if raster is None:
        raise HTTPException(status_code=404, detail="इमेज्री भेटिएन। (Raster layer not found.)")
    owner_project_id = raster.get("project_id")
    if owner_project_id not in (None, "") and str(owner_project_id) != str(project_id):
        raise HTTPException(
            status_code=400,
            detail="अर्को परियोजनाको इमेज्री यहाँ लिङ्क गर्न मिल्दैन। (A raster owned by another project cannot be linked here.)",
        )
    rec = _get_or_create_project_assignment(project_id)
    curr = rec["assigned_mbtiles_ids"]
    if mbtiles_id not in curr and str(mbtiles_id) not in [str(x) for x in curr]:
        curr.append(mbtiles_id)
    _save_persistent_state(sync=True)
    return {"status": "ok", "project_id": project_id, "assignments": rec}


@app.delete("/api/projects/{project_id}/unassign-tiles/{mbtiles_id}")
async def unassign_project_tiles(project_id: int, mbtiles_id: str, request: Request):
    user = _require_admin_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    rec = _get_or_create_project_assignment(project_id)
    curr = rec.get("assigned_mbtiles_ids", [])
    rec["assigned_mbtiles_ids"] = [x for x in curr if str(x) != str(mbtiles_id)]
    _save_persistent_state(sync=True)
    return {"status": "ok", "project_id": project_id, "assignments": rec}


COLLECTOR_ROLES = ("DataCollector", "Validator")
REVIEWER_ROLES = ("MasterAdmin", "SuperAdmin", "GisAdmin", "Validator", "DepartmentAdmin")

TASK_TRANSITIONS = {
    "lock": {"from": ("READY", "INVALIDATED"), "to": "LOCKED_FOR_MAPPING"},
    "unlock": {"from": ("LOCKED_FOR_MAPPING", "INVALIDATED"), "to": "READY"},
    "submit": {"from": ("LOCKED_FOR_MAPPING",), "to": "MAPPED"},
    "validate": {"from": ("MAPPED",), "to": "VALIDATED"},
    "invalidate": {"from": ("MAPPED",), "to": "INVALIDATED"},
}


def _geometry_bbox(geometry: Any) -> List[float]:
    """Bounding box [minLng, minLat, maxLng, maxLat] of any GeoJSON geometry."""
    xs: List[float] = []
    ys: List[float] = []

    def collect(node):
        if isinstance(node, (list, tuple)) and len(node) >= 2 and all(isinstance(value, (int, float)) for value in node[:2]):
            xs.append(float(node[0]))
            ys.append(float(node[1]))
        elif isinstance(node, (list, tuple)):
            for child in node:
                collect(child)

    collect((geometry or {}).get("coordinates"))
    if not xs or not ys:
        return [0.0, 0.0, 0.0, 0.0]
    return [min(xs), min(ys), max(xs), max(ys)]


def _project_collector_summary(project_id: Any) -> List[Dict[str, Any]]:
    tasks = STATE.get("tasks_by_project", {}).get(project_id) or []
    summary = []
    for user_id in _project_collector_ids(project_id):
        user = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(user_id)), None)
        if user is None:
            continue
        assigned = sum(1 for task in tasks if str(user_id) in _task_assignee_ids(task))
        summary.append({
            "user_id": user.get("id"),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "email": user.get("email"),
            "role": user.get("role"),
            "assigned_tasks_count": assigned,
        })
    return summary


def _find_task_anywhere(task_id: Any) -> Optional[Tuple[Any, Dict[str, Any]]]:
    for project_id, tasks in STATE.setdefault("tasks_by_project", {}).items():
        for task in tasks or []:
            if str(task.get("id")) == str(task_id):
                return project_id, task
    return None


def _enrich_task_assignment(task: Dict[str, Any]) -> None:
    user = next(
        (u for u in STATE.get("users", []) if str(u.get("id")) == str(task.get("assigned_to"))),
        None,
    )
    task["assigned_username"] = user.get("username") if user else task.get("assigned_username")
    task["assigned_full_name"] = user.get("full_name") if user else task.get("assigned_full_name")


async def _load_tasks_from_postgis(db: AsyncSession, project_id: Any) -> List[Dict[str, Any]]:
    """Reads persisted task grids using only columns that exist in the schema."""
    try:
        result = await db.execute(
            text("""
                SELECT id, project_id, grid_index, name, grid_shape, status,
                       assigned_to, locked_by, validated_by, properties,
                       ST_AsGeoJSON(geom) AS geom_json,
                       ST_XMin(geom) AS xmin, ST_YMin(geom) AS ymin,
                       ST_XMax(geom) AS xmax, ST_YMax(geom) AS ymax
                FROM task_grids
                WHERE project_id = :pid
                ORDER BY grid_index ASC
            """),
            {"pid": int(project_id)},
        )
        rows = result.fetchall()
    except Exception as exc:  # noqa: BLE001 - DB is optional
        print(f"[KMC-TASKS] PostGIS task query skipped: {exc}")
        return []

    tasks = []
    for row in rows:
        props = row.properties or {}
        if isinstance(props, str):
            try:
                props = json.loads(props)
            except json.JSONDecodeError:
                props = {}
        status = row.status
        status = getattr(status, "value", status) or "READY"
        tasks.append({
            "id": props.get("task_id") or _grid_task_id(row.project_id, row.grid_index or 0),
            "project_id": row.project_id,
            "grid_index": row.grid_index,
            "grid_code": props.get("grid_code") or f"G-{int(row.grid_index or 0):03d}",
            "name": row.name or f"कार्यक्षेत्र #{row.grid_index}",
            "grid_shape": row.grid_shape or "HEXAGON",
            "status": status,
            "assigned_to": row.assigned_to,
            "locked_by": row.locked_by,
            "validated_by": row.validated_by,
            "geometry": json.loads(row.geom_json) if row.geom_json else None,
            "bbox": props.get("bbox") or ([row.xmin, row.ymin, row.xmax, row.ymax] if row.xmin is not None else None),
            "centroid": props.get("centroid"),
            "area_sqm": props.get("area_sqm"),
            "feature_count": 0,
            "invalidation_comment": props.get("invalidation_comment"),
        })
    for task in tasks:
        _enrich_task_assignment(task)
    return tasks


@app.get("/api/projects/{project_id}/collectors")
async def get_project_collectors(project_id: int, request: Request):
    user = resolve_request_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    return _project_collector_summary(project_id)


@app.post("/api/projects/{project_id}/collectors")
async def assign_project_collectors(project_id: int, payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(actor, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    raw_ids = payload.get("user_ids")
    if raw_ids is None:
        raw_ids = payload.get("collector_ids")
    if raw_ids is None:
        raw_ids = payload.get("user_id")
    if raw_ids is None:
        raise HTTPException(status_code=400, detail="user_ids आवश्यक छ। (user_ids is required.)")
    if not isinstance(raw_ids, list):
        raw_ids = [raw_ids]

    existing = _project_collector_ids(project_id)
    for raw_id in raw_ids:
        user = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(raw_id)), None)
        if user is None:
            raise HTTPException(status_code=404, detail=f"प्रयोगकर्ता #{raw_id} भेटिएन। (User not found.)")
        if str(user.get("role")) not in COLLECTOR_ROLES:
            raise HTTPException(
                status_code=400,
                detail=f"'{user.get('username')}' लाई कार्यक्षेत्र तोक्न मिल्दैन (भूमिका: {user.get('role')}). "
                       "(Only DataCollector/Validator accounts can be assigned field grids.)",
            )
        if _is_department_admin_user(actor):
            # A department admin may only add accounts that are free or already
            # inside the projects they control — never another department's staff.
            own_projects = {str(pid) for pid in _department_admin_project_ids(actor)}
            memberships = {
                str(pid)
                for pid, members in (STATE.get("project_collectors") or {}).items()
                if str(raw_id) in {str(member) for member in (members or [])}
            }
            if memberships - own_projects:
                raise HTTPException(
                    status_code=403,
                    detail=f"'{user.get('username')}' अर्को विभागीय परियोजनाको प्रयोगकर्ता हो। "
                           "(This user already belongs to another department's project.)",
                )
        if not any(str(item) == str(user.get("id")) for item in existing):
            existing.append(user.get("id"))

    STATE.setdefault("project_collectors", {})[project_id] = existing
    project["collector_ids"] = existing
    project["updated_at"] = time.time()
    _save_persistent_state()
    return _project_collector_summary(project_id)


@app.delete("/api/projects/{project_id}/collectors/{user_id}")
async def unassign_project_collector(project_id: int, user_id: int, request: Request):
    actor = _require_admin_user(request)
    project = _find_project(project_id)
    if project is None:
        raise HTTPException(status_code=404, detail="परियोजना भेटिएन। (Project not found.)")
    if not _user_can_access_project(actor, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    remaining = [item for item in _project_collector_ids(project_id) if str(item) != str(user_id)]
    STATE.setdefault("project_collectors", {})[project_id] = remaining
    if project is not None:
        project["collector_ids"] = remaining
        project["updated_at"] = time.time()

    # Release this collector's grids so the work returns to the READY pool.
    for task in STATE.get("tasks_by_project", {}).get(project_id) or []:
        assignments = task.get("assignments")
        if isinstance(assignments, list):
            remaining_assignments = [
                item for item in assignments
                if not isinstance(item, dict) or str(item.get("user_id")) != str(user_id)
            ]
            if len(remaining_assignments) != len(assignments):
                _apply_task_assignments(task, remaining_assignments)
        elif str(task.get("assigned_to")) == str(user_id):
            _apply_task_assignments(task, [])

    _save_persistent_state()
    return _project_collector_summary(project_id)


@app.get("/api/projects/{project_id}/tasks")
async def list_project_tasks(
    project_id: int,
    request: Request,
    status: Optional[str] = None,
    status_filter: Optional[str] = None,
    collector_id: Optional[Any] = None,
    collector_filter: Optional[Any] = None,
    db: AsyncSession = Depends(get_db),
):
    user = resolve_request_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")

    tasks_by_project = STATE.setdefault("tasks_by_project", {})
    tasks = tasks_by_project.get(project_id)
    if tasks is None:
        tasks = tasks_by_project.get(str(project_id))
    if tasks is None:
        _load_persistent_state()
        tasks = STATE.get("tasks_by_project", {}).get(project_id) or STATE.get("tasks_by_project", {}).get(str(project_id))
    if tasks is None:
        tasks = await _load_tasks_from_postgis(db, project_id)
        tasks_by_project[project_id] = tasks

    tasks = list(tasks or [])

    # Grid isolation: collectors only ever see grids assigned to them. A
    # validator with assigned grids is limited to those grids as well; a
    # validator without grid assignments validates across the whole project.
    role = _actor_role(user)
    if role in FIELD_ROLES and user is not None:
        user_id = user.get("id")
        assigned_tasks = [task for task in tasks if str(user_id) in _task_assignee_ids(task)]
        if role == "DataCollector" or assigned_tasks:
            tasks = assigned_tasks

    status_value = status_filter or status
    if status_value and status_value != "ALL":
        tasks = [task for task in tasks if task.get("status") == status_value]

    collector_value = collector_filter if collector_filter not in (None, "", "ALL") else collector_id
    if collector_value and collector_value != "ALL":
        if collector_value == "UNASSIGNED":
            tasks = [task for task in tasks if not _task_assignee_ids(task)]
        else:
            tasks = [task for task in tasks if str(collector_value) in _task_assignee_ids(task)]

    feature_counts = _task_feature_counts(project_id, tasks)
    features = []
    for index, task in enumerate(tasks):
        grid_index = task.get("grid_index") or index + 1
        name = task.get("name") or (
            f"कार्यक्षेत्र #{grid_index} ({task.get('grid_code')})" if task.get("grid_code") else f"कार्यक्षेत्र #{grid_index}"
        )
        _enrich_task_assignment(task)
        live_count = feature_counts.get(str(task.get("id")), 0)
        task["feature_count"] = live_count
        features.append({
            "type": "Feature",
            "id": task.get("id"),
            "geometry": task.get("geometry"),
            "properties": {
                "id": task.get("id"),
                "task_id": task.get("id"),
                "project_id": task.get("project_id", project_id),
                "task_number": grid_index,
                "grid_index": grid_index,
                "grid_code": task.get("grid_code"),
                "grid_shape": task.get("grid_shape"),
                "name": name,
                "status": task.get("status", "READY"),
                "assigned_to": task.get("assigned_to"),
                "assigned_username": task.get("assigned_username"),
                "assigned_full_name": task.get("assigned_full_name"),
                "assigned_to_name": task.get("assigned_full_name") or task.get("assigned_username"),
                "assignments": task.get("assignments") or [],
                "assigned_collectors": task.get("assignments") or [],
                "validator_id": task.get("validator_id"),
                "validator_ids": task.get("validator_ids") or [],
                "locked_by": task.get("locked_by"),
                "validated_by": task.get("validated_by"),
                "invalidation_comment": task.get("invalidation_comment"),
                "feature_count": live_count,
                "area_sqm": task.get("area_sqm"),
                "centroid": task.get("centroid"),
                "bbox": task.get("bbox") or _geometry_bbox(task.get("geometry")),
            }
        })

    return {"type": "FeatureCollection", "features": features}


def _normalize_multi_assignments(project_id: Any, raw_assignments: Any) -> List[Dict[str, Any]]:
    """Validates per-grid collector/validator assignments and their layer scopes.

    A Validator and a DataCollector may independently share the same grid and layer
    without conflict; two DataCollectors cannot share the same layer in one grid.
    """
    if not isinstance(raw_assignments, list):
        raise HTTPException(status_code=400, detail="assignments must be a list.")
    normalized = []
    seen_users = set()
    layer_owner_by_role: Dict[str, Dict[str, str]] = {"DataCollector": {}, "Validator": {}}
    collector_entries = []
    for item in raw_assignments:
        if not isinstance(item, dict):
            raise HTTPException(status_code=400, detail="Each assignment must be an object.")
        raw_user_id = item.get("user_id") or item.get("collector_id")
        user = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(raw_user_id)), None)
        if user is None:
            raise HTTPException(status_code=404, detail=f"प्रयोगकर्ता #{raw_user_id} भेटिएन। (User not found.)")
        role_str = str(user.get("role") or "")
        if role_str not in COLLECTOR_ROLES:
            raise HTTPException(status_code=400, detail="केवल DataCollector/Validator खाता तोक्न सकिन्छ। (Only DataCollector/Validator accounts can be assigned.)")
        if str(user.get("id")) in seen_users:
            raise HTTPException(status_code=400, detail="एउटै संकलक दुई पटक तोक्न मिल्दैन। (A collector cannot be assigned twice to one grid.)")
        if not any(str(member) == str(user.get("id")) for member in _project_collector_ids(project_id)):
            raise HTTPException(
                status_code=400,
                detail=f"'{user.get('username')}' यो परियोजनासँग जोडिएको छैन। पहिले परियोजनामा जोड्नुहोस्। "
                       "(Link the collector to the project before assigning grids.)",
            )
        seen_users.add(str(user.get("id")))
        raw_layers = item.get("layer_ids")
        if raw_layers is None:
            raw_layers = []
        if not isinstance(raw_layers, list):
            raise HTTPException(status_code=400, detail="layer_ids must be a list.")
        layer_ids = [value for value in raw_layers if value not in (None, "")]
        role_bucket = layer_owner_by_role.setdefault(role_str, {})
        for layer_id in layer_ids:
            key = str(layer_id)
            if key in role_bucket and role_bucket[key] != str(user.get("id")):
                raise HTTPException(
                    status_code=409,
                    detail="एउटै ग्रिडमा दुई संकलकलाई एउटै तह तोक्न मिल्दैन। (Two collectors cannot share the same layer in one grid.)",
                )
            role_bucket[key] = str(user.get("id"))
        entry = {
            "user_id": user.get("id"),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "role": role_str,
            "layer_ids": layer_ids,
        }
        normalized.append(entry)
        if role_str == "DataCollector":
            collector_entries.append(entry)
    if len(collector_entries) > 1 and any(not item["layer_ids"] for item in collector_entries):
        raise HTTPException(
            status_code=400,
            detail="धेरै संकलक तोक्दा प्रत्येकको तह-सीमा (layer_ids) अनिवार्य छ। "
                   "(When several collectors share a grid, each must have an explicit layer scope.)",
        )
    return normalized


def _apply_task_assignments(task: Dict[str, Any], assignments: List[Dict[str, Any]]) -> None:
    task["assignments"] = list(assignments)
    primary = assignments[0] if assignments else None
    task["assigned_to"] = primary.get("user_id") if primary else None
    task["assigned_username"] = primary.get("username") if primary else None
    task["assigned_full_name"] = primary.get("full_name") if primary else None
    if not assignments and task.get("status") in ("LOCKED", "LOCKED_FOR_MAPPING"):
        task["status"] = "READY"
        task["locked_by"] = None
        task["locked_at"] = None


@app.post("/api/projects/{project_id}/tasks/assign")
async def assign_project_tasks(project_id: int, payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(actor, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    task_ids = {str(item) for item in (payload.get("task_ids") or [])}

    def _ensure_project_member(uid: Any) -> None:
        if uid in (None, ""):
            return
        rec = _get_or_create_project_assignment(project_id)
        rec.setdefault("assigned_collector_ids", [])
        if not any(str(x) == str(uid) for x in rec["assigned_collector_ids"]):
            rec["assigned_collector_ids"].append(uid)
        members = _project_collector_ids(project_id)
        if not any(str(x) == str(uid) for x in members):
            members.append(uid)
        STATE.setdefault("project_collectors", {})[project_id] = members
        project["collector_ids"] = members

    has_validator_update = "validator_id" in payload or "validator_ids" in payload
    validator_ids_resolved: Optional[List[Any]] = None
    if has_validator_update:
        raw_vids = payload.get("validator_ids")
        if raw_vids is None:
            single_vid = payload.get("validator_id")
            raw_vids = [] if single_vid in (None, "", 0, "0") else [single_vid]
        if not isinstance(raw_vids, list):
            raise HTTPException(status_code=400, detail="validator_ids must be a list.")
        validator_ids_resolved = []
        for raw_vid in raw_vids:
            if raw_vid in (None, "", 0, "0"):
                continue
            v_user = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(raw_vid)), None)
            if v_user is None:
                raise HTTPException(status_code=404, detail=f"प्रमाणक #{raw_vid} भेटिएन। (Validator not found.)")
            if str(v_user.get("role")) not in ("Validator",) + ADMIN_ROLES:
                raise HTTPException(status_code=400, detail="validator_id का लागि Validator खाता आवश्यक छ। (A Validator account is required.)")
            _ensure_project_member(v_user.get("id"))
            if not any(str(x) == str(v_user.get("id")) for x in validator_ids_resolved):
                validator_ids_resolved.append(v_user.get("id"))

    has_collector_update = (
        payload.get("assignments") is not None
        or "user_id" in payload
        or "collector_id" in payload
        or not has_validator_update
    )
    assignments: List[Dict[str, Any]] = []
    unassigned = False
    if has_collector_update:
        raw_assignments = payload.get("assignments")
        if raw_assignments is not None:
            assignments = _normalize_multi_assignments(project_id, raw_assignments)
            for item in assignments:
                _ensure_project_member(item.get("user_id"))
            unassigned = not assignments
        else:
            raw_user_id = payload.get("user_id") or payload.get("collector_id")
            user = None
            if raw_user_id not in (None, "", 0, "0"):
                user = next((u for u in STATE.get("users", []) if str(u.get("id")) == str(raw_user_id)), None)
                if user is None:
                    raise HTTPException(status_code=404, detail="प्रयोगकर्ता भेटिएन। (User not found.)")
                if str(user.get("role")) not in COLLECTOR_ROLES:
                    raise HTTPException(status_code=400, detail="कार्यक्षेत्र तोक्न केवल संकलक/प्रमाणक खाता प्रयोग गर्नुहोस्।")
                _ensure_project_member(user.get("id"))
            raw_scope = payload.get("layer_ids") or []
            if not isinstance(raw_scope, list):
                raise HTTPException(status_code=400, detail="layer_ids must be a list.")
            assignments = [{
                "user_id": user.get("id"),
                "username": user.get("username"),
                "full_name": user.get("full_name"),
                "role": user.get("role"),
                "layer_ids": [value for value in raw_scope if value not in (None, "")],
            }] if user else []
            unassigned = user is None

    tasks = STATE.setdefault("tasks_by_project", {}).get(project_id)
    if tasks is None:
        tasks = STATE["tasks_by_project"].get(str(project_id)) or []
        STATE["tasks_by_project"][project_id] = tasks
    assigned_count = 0
    for task in tasks:
        if str(task.get("id")) not in task_ids:
            continue
        assigned_count += 1
        if has_collector_update:
            _apply_task_assignments(task, assignments)
        if has_validator_update and validator_ids_resolved is not None:
            task["validator_ids"] = list(validator_ids_resolved)
            task["validator_id"] = validator_ids_resolved[0] if validator_ids_resolved else None

    _save_persistent_state(sync=True)
    return {
        "status": "success",
        "assigned_count": assigned_count,
        "unassigned": unassigned,
        "assignments": assignments,
        **({"validator_ids": validator_ids_resolved} if has_validator_update else {}),
    }


@app.post("/api/projects/{project_id}/tasks/auto-distribute")
async def auto_distribute_tasks(project_id: int, payload: Dict[str, Any], request: Request):
    actor = _require_admin_user(request)
    _require_project(project_id)
    if not _user_can_access_project(actor, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    tasks = STATE.setdefault("tasks_by_project", {}).get(project_id) or []

    requested_ids = payload.get("user_ids")
    if requested_ids:
        candidates = [
            u for u in STATE.get("users", [])
            if str(u.get("id")) in {str(item) for item in requested_ids}
            and str(u.get("role")) in COLLECTOR_ROLES
            and any(str(cid) == str(u.get("id")) for cid in _project_collector_ids(project_id))
        ]
    else:
        candidates = [
            u for u in STATE.get("users", [])
            if str(u.get("role")) == "DataCollector" and u.get("is_active", True)
            and any(str(cid) == str(u.get("id")) for cid in _project_collector_ids(project_id))
        ]

    if not candidates:
        raise HTTPException(
            status_code=400,
            detail="वितरण गर्न कुनै सक्रिय संकलक (DataCollector) भेटिएन। पहिले परियोजनामा संकलक जोड्नुहोस्। "
                   "(No active DataCollector is linked to this project; link collectors to the project first.)",
        )

    distributable = [
        task for task in tasks if not task.get("assigned_to") and task.get("status") in ("READY", "INVALIDATED")
    ]
    for index, task in enumerate(distributable):
        collector = candidates[index % len(candidates)]
        _apply_task_assignments(task, [{
            "user_id": collector.get("id"),
            "username": collector.get("username"),
            "full_name": collector.get("full_name"),
            "layer_ids": [],
        }])

    _save_persistent_state(sync=True)
    return {
        "status": "success",
        "total_tasks_distributed": len(distributable),
        "collectors_count": len(candidates),
    }


@app.delete("/api/projects/{project_id}/tasks/reset")
async def reset_project_tasks(project_id: int, request: Request, db: AsyncSession = Depends(get_db)):
    actor = _require_admin_user(request)
    project = _require_project(project_id)
    if not _user_can_access_project(actor, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    STATE.setdefault("tasks_by_project", {})[project_id] = []
    project["task_count"] = 0
    project["updated_at"] = time.time()
    try:
        await db.execute(text("DELETE FROM task_grids WHERE project_id = :pid"), {"pid": int(project_id)})
        await db.commit()
    except Exception as exc:  # noqa: BLE001 - DB is optional
        print(f"[KMC-TASKS] DB task reset skipped: {exc}")
    _save_persistent_state(sync=True)
    return {"status": "success", "tasks_created": 0}


@app.post("/api/tasks/{task_id}/{action}")
async def handle_task_action(
    task_id: str,
    action: str,
    request: Request,
    payload: Optional[Dict[str, Any]] = None,
):
    """Field-task lifecycle (HOT/FMTM finite state machine).

    Enforced server-side so task state cannot be advanced by an unauthorised role
    or from an impossible status.
    """
    # `/tasks/{id}/validate?action=invalidate` carries the real action in the query.
    query_action = (request.query_params.get("action") or "").strip().lower()
    effective_action = query_action or str(action or "").strip().lower()

    located = _find_task_anywhere(task_id)
    if located is None:
        raise HTTPException(status_code=404, detail="कार्यक्षेत्र भेटिएन। (Task grid not found.)")
    project_id, task = located

    transition = TASK_TRANSITIONS.get(effective_action)
    if transition is None:
        raise HTTPException(
            status_code=400,
            detail=f"अवैध कार्य '{action}'. (Unknown task action; expected {', '.join(TASK_TRANSITIONS)}.)",
        )

    current_status = task.get("status") or "READY"
    if current_status not in transition["from"]:
        raise HTTPException(
            status_code=409,
            detail=(
                f"कार्यक्षेत्र अहिले '{current_status}' अवस्थामा छ — '{effective_action}' सम्भव छैन। "
                f"(Cannot {effective_action} a task in status {current_status}.)"
            ),
        )

    user = _require_user(request)
    role = str((user or {}).get("role") or "")
    user_id = (user or {}).get("id")
    assigned_to = task.get("assigned_to")

    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")

    # Grid isolation applies to task actions too: a field user may only act on a
    # grid that is assigned to them (computers can call the API directly).
    if role in FIELD_ROLES:
        grids = _project_task_grids(project_id)
        if grids:
            assigned_any = [item for item in grids if str(user_id) in _task_assignee_ids(item)]
            if role == "DataCollector" or assigned_any:
                if str(user_id) not in _task_assignee_ids(task):
                    raise HTTPException(
                        status_code=403,
                        detail="यो कार्यक्षेत्र तपाईंलाई तोकिएको छैन। (This task grid is not assigned to you.)",
                    )

    if effective_action == "lock":
        if role not in ("MasterAdmin", "SuperAdmin", "DepartmentAdmin", "GisAdmin", "DataCollector", "Validator"):
            raise HTTPException(status_code=403, detail="यो कार्यক্ষেত্র लक गर्न अधिकार छैन। (You cannot lock this task.)")
        if role == "DataCollector" and assigned_to not in (None, "") and str(assigned_to) != str(user_id) and str(user_id) not in _task_assignee_ids(task):
            raise HTTPException(status_code=403, detail="यो कार्यक्षेत्र अर्को संकलकलाई तोकिएको छ। (This grid is assigned to another collector.)")

        collector_lat = payload.get("collector_lat") if payload else None
        collector_lng = payload.get("collector_lng") if payload else None
        if collector_lat is not None and collector_lng is not None and role == "DataCollector":
            point = {"type": "Point", "coordinates": [float(collector_lng), float(collector_lat)]}
            if not _geometry_within_task_grid(task.get("geometry"), point):
                raise HTTPException(
                    status_code=403,
                    detail="तपाईं यो कार्यक्षेत्र भित्र हुनुहुन्न — लक गर्न ग्रिडभित्र पुग्नुहोस्। (You must be inside the grid to lock it.)",
                )

        task["locked_by"] = user_id
        task["locked_at"] = time.time()
        if user is not None and assigned_to in (None, ""):
            task["assigned_to"] = user_id
            task["assigned_username"] = user.get("username")
            task["assigned_full_name"] = user.get("full_name")

    elif effective_action == "unlock":
        if role not in ADMIN_ROLES and str(task.get("locked_by")) != str(user_id) and str(user_id) not in _task_assignee_ids(task):
            raise HTTPException(status_code=403, detail="यो कार्यक्षेत्र अनलक गर्न अधिकार छैन। (You cannot unlock this task.)")
        task["locked_by"] = None
        task["locked_at"] = None

    elif effective_action == "submit":
        if role not in ADMIN_ROLES and str(task.get("locked_by")) != str(user_id) and str(user_id) not in _task_assignee_ids(task):
            raise HTTPException(status_code=403, detail="यो कार्यक्षेत्र पेश गर्न अधिकार छैन। (You cannot submit this task.)")
        task["mapped_by"] = user_id
        task["locked_by"] = None
        task["locked_at"] = None

    elif effective_action in ("validate", "invalidate"):
        if role not in REVIEWER_ROLES:
            raise HTTPException(status_code=403, detail="प्रमाणीकरणका लागि Validator/प्रशासक अधिकार आवश्यक छ। (Validator/admin role required.)")
        comment = ""
        if payload:
            comment = str(payload.get("comment") or payload.get("validator_comment") or payload.get("invalidation_comment") or "").strip()
        comment = comment or (request.query_params.get("comment") or "").strip()
        if effective_action == "invalidate":
            if not comment:
                raise HTTPException(
                    status_code=400,
                    detail="अस्वीकृत गर्न कारण (comment) अनिवार्य छ। (An invalidation reason is required.)",
                )
            task["invalidation_comment"] = comment
            STATE.setdefault("task_invalidation_history", []).append({
                "id": int(time.time() * 1000),
                "task_grid_id": task.get("id"),
                "validator_id": user_id,
                "collector_id": task.get("assigned_to"),
                "issue_categories": (payload or {}).get("issue_categories") or [],
                "validator_comment": comment,
                "created_at": time.time(),
            })
        else:
            task["invalidation_comment"] = None
        task["validated_by"] = user_id

    task["status"] = transition["to"]
    task["updated_at"] = time.time()
    task["project_id"] = task.get("project_id") or project_id
    _save_persistent_state(sync=True)
    return {"status": "success", "task_id": task.get("id"), "action": effective_action, "task": task}


@app.get("/api/geoportal/catalog")
async def get_geoportal_catalog(request: Request):
    # The public portal only ever publishes global layers: project layers stay
    # private to their project members.
    _reload_state_if_modified()
    user = resolve_request_user(request)
    is_admin = _is_admin_user(user)
    is_public = _is_public_viewer(user)
    active_layers = [
        l for l in STATE["vector_layers"]
        if not l.get("deleted_at")
        and (l.get("project_id") in (None, "") or l.get("published_in_geoportal") or (l.get("published") and l.get("access_level") == "public"))
        and (not is_public or (l.get("published", True) and l.get("public_visible", True)))
        and (is_admin or _portal_access_allowed(l, user))
    ]
    active_rasters = [
        r for r in STATE["raster_layers"]
        if not r.get("deleted_at")
        and (r.get("project_id") in (None, "") or r.get("published_in_geoportal") or (r.get("published") and r.get("access_level") == "public"))
        and (not is_public or (r.get("published", True) and r.get("public_visible", True)))
        and (is_admin or _portal_access_allowed(r, user))
    ]
    categories: Dict[str, list] = {}
    vector_payload = []
    for layer in active_layers:
        features = (
            STATE["features_by_layer"].get(layer["id"])
            or STATE["features_by_layer"].get(str(layer["id"]))
            or []
        )
        all_fields = list(layer.get("fields_config") or [])
        item = {
            **layer,
            "type": "vector",
            "tile_url": f"/api/tiles/vector/{layer['id']}/{{z}}/{{x}}/{{y}}.pbf",
            "feature_count": layer.get("feature_count") if layer.get("feature_count") is not None else (get_layer_feature_count(str(layer['id'])) or len(features)),
            "feature_url": f"/api/layers/{layer['id']}/features?portal=1",
            "fields_config": _portal_visible_fields(layer, user, all_fields),
        }
        if is_admin:
            item["all_fields_config"] = all_fields
        vector_payload.append(item)
        categories.setdefault(layer.get("category") or PORTAL_VECTOR_CATEGORY, []).append(item)
    raster_payload = []
    for raster in active_rasters:
        item = {
            **raster,
            "type": "raster",
            "tile_url": f"/api/tiles/raster/{raster['id']}/{{z}}/{{x}}/{{y}}.webp",
        }
        raster_payload.append(item)
        categories.setdefault(raster.get("category") or PORTAL_RASTER_CATEGORY, []).append(item)
    return {
        "municipality": "काठमाडौँ महानगरपालिका (Kathmandu Metropolitan City)",
        "is_admin": _is_admin_user(user),
        "categories": [
            {"id": name, "name": name, "layers": layers}
            for name, layers in categories.items()
        ],
        "total_vector_layers": len(active_layers),
        "total_raster_packages": len(active_rasters),
        # Legacy keys kept for older portal builds.
        "layers": vector_payload,
        "rasters": raster_payload,
        "stats": {
            "total_layers": len(active_layers),
            "total_rasters": len(active_rasters),
            "total_features": sum(item["feature_count"] for item in vector_payload),
        },
    }


@app.get("/api/geoportal/landing-stats")
async def get_geoportal_landing_stats():
    active_layers = [
        l for l in STATE["vector_layers"]
        if not l.get("deleted_at")
        and l.get("project_id") in (None, "")
        and l.get("published", True)
        and l.get("access_level", "public") == "public"
    ]
    active_rasters = [
        r for r in STATE["raster_layers"]
        if not r.get("deleted_at")
        and r.get("project_id") in (None, "")
        and r.get("published", True)
        and r.get("access_level", "public") == "public"
    ]
    total_feats = 0
    wards = set()
    category_counts: Dict[str, int] = {}
    for layer in active_layers:
        feats = STATE["features_by_layer"].get(layer["id"], []) or STATE["features_by_layer"].get(str(layer["id"]), [])
        total_feats += len(feats)
        category = layer.get("category") or "अन्य (Other)"
        category_counts[category] = category_counts.get(category, 0) + 1
        for feature in feats[:2000]:
            props = feature.get("properties") or {}
            ward = props.get("ward") or props.get("ward_no") or props.get("WARD") or props.get("ward_number")
            if ward not in (None, ""):
                wards.add(str(ward))
    categories = sorted(
        ({"name": name, "layers": count} for name, count in category_counts.items()),
        key=lambda item: item["layers"],
        reverse=True,
    )
    return {
        "vector_layers": len(active_layers),
        "total_features": total_feats,
        "raster_packages": len(active_rasters),
        "wards_covered": len(wards) or None,
        "categories": categories,
        # Legacy keys kept for older portal builds.
        "features_count": total_feats,
        "layers_count": len(active_layers),
        "imagery_count": len(active_rasters),
    }


# ============================================================
# Public GeoPortal layer analytics & per-layer publishing config
# ============================================================
PORTAL_ACCESS_LEVELS = ("public", "validator", "admin_only")
PORTAL_VECTOR_CATEGORY = "भू-स्थानिक तहहरू (Spatial Layers)"
PORTAL_RASTER_CATEGORY = "ड्रोन तथा अर्थोफोटो (UAV Imagery)"


def _portal_access_level(record: Dict[str, Any]) -> str:
    level = str(record.get("access_level") or "")
    if level in PORTAL_ACCESS_LEVELS:
        return level
    basic = (record.get("role_permissions") or {}).get("BasicViewer") or {}
    if basic.get("can_view") is False:
        return "validator"
    return "public"


def _portal_access_allowed(record: Dict[str, Any], user: Optional[Dict[str, Any]]) -> bool:
    level = _portal_access_level(record)
    if level == "public":
        return True
    role = _actor_role(user)
    if not role:
        return False
    if level == "validator":
        return role == "Validator" or role in ADMIN_ROLES
    return role in ADMIN_ROLES


def _field_read_allowed(field: Dict[str, Any], role: str, permissions: Dict[str, Any]) -> bool:
    """Role check shared by portal visibility and staff feature filtering."""
    name = str(field.get("name") or "")
    allowed = permissions.get(name)
    # Municipal staff read what the public baseline viewer may read; the legacy
    # permission map predates that role, so normalise before the list check.
    read_role = "BasicViewer" if role == "MunicipalUser" else role
    if isinstance(allowed, list):
        return read_role in {str(item) for item in allowed}
    level = str(field.get("access_level") or "public")
    if level in ("admin", "admin_only"):
        return read_role in ADMIN_ROLES
    if level == "validator":
        return read_role == "Validator" or read_role in ADMIN_ROLES
    return True


def _portal_visible_fields(
    layer: Dict[str, Any],
    user: Optional[Dict[str, Any]],
    fields: Optional[list] = None,
) -> list:
    fields = list(fields if fields is not None else (layer.get("fields_config") or []))
    if _is_admin_user(user):
        return fields
    permissions = layer.get("field_permissions") or {}
    role = _actor_role(user) or "BasicViewer"
    public_hidden = (
        {str(name) for name in (layer.get("public_hidden_fields") or []) if name}
        if _is_public_viewer(user)
        else set()
    )
    return [
        field for field in fields
        if _field_read_allowed(field, role, permissions)
        and str(field.get("name") or "") not in public_hidden
    ]


def _filter_geometry_field_config(layer: Dict[str, Any], user: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    config = layer.get("geometry_fields_config")
    if not isinstance(config, dict):
        return config or {}
    if _is_admin_user(user):
        return config
    role = _actor_role(user) or "BasicViewer"
    permissions = layer.get("field_permissions") or {}
    return {
        geometry_type: [
            field for field in (geometry_type_fields or [])
            if isinstance(field, dict)
            and not str(field.get("name") or "").startswith("_")
            and _field_read_allowed(field, role, permissions)
            and _field_entry_allowed(field, role)
        ]
        for geometry_type, geometry_type_fields in config.items()
    }


def _layer_metadata_for_user(layer: Dict[str, Any], user: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """Layer metadata trimmed to the role's readable/enterable fields."""
    if _is_admin_user(user):
        return layer
    sanitized = {**layer}
    role = _actor_role(user) or "BasicViewer"
    if isinstance(sanitized.get("fields_config"), list):
        visible = [
            field for field in _portal_visible_fields(layer, user, sanitized["fields_config"])
            if not str(field.get("name") or "").startswith("_")
        ]
        sanitized["fields_config"] = visible
        sanitized["editable_fields"] = [
            field for field in visible
            if _field_entry_allowed(field, role)
        ]
    sanitized["geometry_fields_config"] = _filter_geometry_field_config(layer, user)
    sanitized["field_permissions"] = {}
    return sanitized


def _portal_filter_feature_properties(
    layer: Dict[str, Any],
    user: Optional[Dict[str, Any]],
    features: list,
) -> list:
    """Drops properties the caller's role may not read from portal feature streams."""
    if _is_admin_user(user):
        return features
    permissions = layer.get("field_permissions") or {}
    role = _actor_role(user) or "BasicViewer"
    restricted = {
        str(field.get("name"))
        for field in (layer.get("fields_config") or [])
        if field.get("name") and not _field_read_allowed(field, role, permissions)
    }
    restricted.update(
        str(name)
        for name, allowed in permissions.items()
        if isinstance(allowed, list) and role not in allowed
    )
    if _is_public_viewer(user):
        restricted.update(str(name) for name in (layer.get("public_hidden_fields") or []) if name)
    if not restricted:
        return features
    filtered_features = []
    for feature in features:
        props = feature.get("properties") or {}
        if restricted.isdisjoint(props.keys()):
            filtered_features.append(feature)
            continue
        filtered = dict(feature)
        filtered["properties"] = {key: value for key, value in props.items() if key not in restricted}
        filtered_features.append(filtered)
    return filtered_features


def _portal_field_labels(layer: Dict[str, Any]) -> Dict[str, str]:
    labels: Dict[str, str] = {}
    for field in layer.get("fields_config") or []:
        name = str(field.get("name") or "").strip()
        if name:
            labels[name] = str(field.get("label") or name)
    return labels


def _apply_portal_config(target: Dict[str, Any], payload: Dict[str, Any]) -> None:
    """Map the portal config payload onto the layer/raster record the catalog reads."""
    if "published_in_geoportal" in payload:
        target["published"] = bool(payload.get("published_in_geoportal"))
    if "public_visible" in payload:
        target["public_visible"] = bool(payload.get("public_visible"))
    if "public_hidden_fields" in payload and isinstance(payload.get("public_hidden_fields"), list):
        target["public_hidden_fields"] = [str(f) for f in payload["public_hidden_fields"] if f]
    if "default_visible_in_geoportal" in payload:
        target["default_visible"] = bool(payload.get("default_visible_in_geoportal"))
    if "opacity" in payload:
        try:
            target["opacity"] = max(0.0, min(1.0, float(payload.get("opacity"))))
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="`opacity` must be a number between 0 and 1.")
    role_permissions = payload.get("role_permissions")
    if isinstance(role_permissions, dict):
        target["role_permissions"] = role_permissions
        requested = role_permissions.get("access_level")
        if requested in PORTAL_ACCESS_LEVELS:
            target["access_level"] = requested
    if payload.get("access_level") in PORTAL_ACCESS_LEVELS:
        target["access_level"] = payload.get("access_level")
    if isinstance(payload.get("field_permissions"), dict):
        target["field_permissions"] = payload.get("field_permissions")
    if isinstance(payload.get("dashboard_config"), dict):
        target["dashboard_config"] = payload.get("dashboard_config")


@app.put("/api/geoportal/layers/{layer_id}/config")
async def update_geoportal_layer_config(layer_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    layer = next((l for l in STATE["vector_layers"] if str(l.get("id")) == str(layer_id)), None)
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if layer.get("project_id") is None:
        if not (_is_super_user(user) or _actor_role(user) == "GisAdmin"):
            raise HTTPException(
                status_code=403,
                detail="सार्वजनिक (Global) तह परिमार्जन गर्न मास्टर, सुपर वा GIS प्रशासक अधिकार आवश्यक छ। (Global layers can only be modified by Master, Super, or GIS administrators.)"
            )
    elif not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    _apply_portal_config(layer, payload)
    layer["portal_config_updated_at"] = time.time()
    layer["portal_config_updated_by"] = (user or {}).get("username") or ""
    _save_persistent_state()
    return layer


@app.put("/api/geoportal/mbtiles/{mbtiles_id}/config")
async def update_geoportal_mbtiles_config(mbtiles_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    raster = next((r for r in STATE["raster_layers"] if str(r.get("id")) == str(mbtiles_id)), None)
    if raster is None:
        raise HTTPException(status_code=404, detail="र्यास्टर प्याकेज भेटिएन। (Raster package not found.)")
    if not _user_can_access_project(user, raster.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    _apply_portal_config(raster, payload)
    raster["portal_config_updated_at"] = time.time()
    raster["portal_config_updated_by"] = (user or {}).get("username") or ""
    _save_persistent_state()
    return raster


@app.get("/api/analytics/layer/{layer_id}")
async def get_layer_analytics(
    layer_id: Any,
    request: Request,
    bbox: Optional[str] = None,
    ward: Optional[str] = None,
):
    """Aggregate live infographics for a public vector layer (optionally by viewport)."""
    user = resolve_request_user(request)
    layer = next(
        (l for l in STATE["vector_layers"] if (str(l.get("id")) == str(layer_id) or str(l.get("name", "")).strip().lower() == str(layer_id).strip().lower()) and not l.get("deleted_at")),
        None,
    )
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if not _layer_visible_to_user(layer, user):
        raise HTTPException(status_code=403, detail="यो तहमा पहुँच छैन। (You do not have access to this layer.)")
    if not _is_admin_user(user):
        if not layer.get("published", True):
            raise HTTPException(status_code=403, detail="यो तह हाल सार्वजनिक गरिएको छैन। (This layer is not published to public portal.)")
        if not _portal_access_allowed(layer, user):
            raise HTTPException(status_code=403, detail="यो तह हेर्न अनुमति छैन। (This layer is not published for your role.)")

    parts = []
    if bbox:
        try:
            parts = [float(part.strip()) for part in bbox.split(",")]
        except (TypeError, ValueError):
            raise HTTPException(status_code=400, detail="`bbox` must be minx,miny,maxx,maxy.")

    # High-performance spatial engine path for indexed vector layers (e.g. UnetRaw, 188k buildings)
    sp_count = get_layer_feature_count(str(layer_id))
    if sp_count > 0:
        sp_analytics = compute_live_spatial_analytics(str(layer_id), parts if bbox and len(parts) == 4 else None)
        total_f = sp_analytics["total_features"]
        total_a = sp_analytics["total_area_m2"]
        kpis = [
            {"id": "features", "title": "कुल विशेषताहरू (Total Features)", "value": total_f, "unit": ""},
        ]
        if total_a > 0:
            kpis.append({"id": "area_total", "title": "कुल क्षेत्रफल (Total Area)", "value": round(total_a / 10000, 2), "unit": "हेक्टर (ha)"})
            kpis.append({"id": "area_avg", "title": "औसत क्षेत्रफल (Average Area)", "value": round(total_a / max(total_f, 1), 2), "unit": "m²"})
        cats = []
        if sp_analytics.get("type_breakdown"):
            cats.append({
                "field": "building_type",
                "title": "प्रकार (Type)",
                "data": [{"name": k, "value": v} for k, v in list(sp_analytics["type_breakdown"].items())[:6]]
            })
        return {
            "layer_id": layer.get("id"),
            "layer_name": layer.get("name"),
            "geometry_type": layer.get("geometry_type") or "Polygon",
            "feature_count": total_f,
            "kpi_cards": kpis,
            "charts": {
                "categories": cats,
                "numeric_summaries": [],
            },
        }

    features = get_layer_features_list(layer_id)
    if bbox and len(parts) == 4:
        index = get_or_build_spatial_index(layer_id)
        if index:
            features = index.query(*parts)

    ward_keys = ("ward", "ward_no", "WARD", "ward_number")
    if ward not in (None, ""):
        features = [
            feature for feature in features
            if str(
                next(
                    ((feature.get("properties") or {}).get(key) for key in ward_keys
                     if (feature.get("properties") or {}).get(key) not in (None, "")),
                    "",
                )
            ) == str(ward)
        ]

    labels = _portal_field_labels(layer)
    properties = [feature.get("properties") or {} for feature in features]
    allowed_field_names = {
        str(field.get("name")) for field in _portal_visible_fields(layer, user) if field.get("name")
    }
    restrict_fields = bool(allowed_field_names) and not _is_admin_user(user)

    key_coverage: Dict[str, int] = {}
    for props in properties:
        for key, value in props.items():
            if key.startswith("_") or value in (None, ""):
                continue
            key_coverage[key] = key_coverage.get(key, 0) + 1
    ordered_keys = sorted(key_coverage, key=lambda key: key_coverage[key], reverse=True)

    categories = []
    for key in ordered_keys:
        if len(categories) >= 3:
            break
        if restrict_fields and key not in allowed_field_names:
            continue
        if key.lower() in ("id", "fid", "gid", "objectid"):
            continue
        values = [props.get(key) for props in properties if props.get(key) not in (None, "")]
        if not all(isinstance(value, (str, bool)) for value in values):
            continue
        distinct = {str(value) for value in values}
        if not 1 < len(distinct) <= 25:
            continue
        counts: Dict[str, int] = {}
        for value in values:
            name = str(value)
            counts[name] = counts.get(name, 0) + 1
        ranked = sorted(counts.items(), key=lambda item: item[1], reverse=True)[:12]
        categories.append({
            "field": key,
            "title": labels.get(key, key.replace("_", " ")),
            "data": [{"name": name, "value": count} for name, count in ranked],
        })

    numeric_summaries = []
    for key in ordered_keys:
        if len(numeric_summaries) >= 3:
            break
        if restrict_fields and key not in allowed_field_names:
            continue
        if key.startswith("_") or key.lower() in ("id", "fid", "gid", "objectid"):
            continue
        values = [
            props.get(key) for props in properties
            if isinstance(props.get(key), (int, float)) and not isinstance(props.get(key), bool)
        ]
        if not values or len({float(value) for value in values}) < 2:
            continue
        numeric_summaries.append({
            "field": key,
            "title": labels.get(key, key.replace("_", " ")),
            "avg": round(sum(values) / len(values), 2),
            "sum": round(sum(values), 2),
            "min": min(values),
            "max": max(values),
        })

    kpi_cards = [{
        "id": "features",
        "title": "कुल विशेषताहरू (Total Features)",
        "value": len(features),
        "unit": "",
    }]
    area_values = [
        props.get("area") for props in properties
        if isinstance(props.get("area"), (int, float)) and not isinstance(props.get("area"), bool)
    ]
    if area_values and (not restrict_fields or "area" in allowed_field_names):
        kpi_cards.append({
            "id": "area_total",
            "title": "कुल क्षेत्रफल (Total Area)",
            "value": round(sum(area_values), 2),
            "unit": "m²",
        })
        kpi_cards.append({
            "id": "area_avg",
            "title": "औसत क्षेत्रफल (Average Area)",
            "value": round(sum(area_values) / len(area_values), 2),
            "unit": "m²",
        })
    wards = {
        str(next((props.get(key) for key in ward_keys if props.get(key) not in (None, "")), ""))
        for props in properties
    } - {""}
    if wards:
        kpi_cards.append({
            "id": "wards",
            "title": "समेटिएका वडाहरू (Wards Covered)",
            "value": len(wards),
            "unit": "",
        })

    return {
        "layer_id": layer.get("id"),
        "layer_name": layer.get("name"),
        "geometry_type": layer.get("geometry_type"),
        "feature_count": len(features),
        "kpi_cards": kpi_cards,
        "charts": {
            "categories": categories,
            "numeric_summaries": numeric_summaries,
        },
    }


# ---- 7. Collector Tracking Endpoints ----

TRACKING_ONLINE_WINDOW_SECONDS = 90


def _tracking_user_project_ids(user_id: Any) -> List[Any]:
    project_ids = []
    for project in STATE.get("projects", []):
        if any(str(member) == str(user_id) for member in _project_collector_ids(project.get("id"))):
            project_ids.append(project.get("id"))
    return project_ids


def _tracking_entry_for(user: Dict[str, Any]) -> Dict[str, Any]:
    entry = next(
        (item for item in STATE.get("collectors", []) if str(item.get("user_id")) == str(user.get("id"))),
        None,
    )
    if entry is None:
        entry = {"user_id": user.get("id")}
        STATE.setdefault("collectors", []).append(entry)
    entry.update({
        "username": user.get("username"),
        "full_name": user.get("full_name") or user.get("username"),
        "role": user.get("role"),
        "project_ids": _tracking_user_project_ids(user.get("id")),
    })
    return entry


def _tracking_visible_user_ids(user: Dict[str, Any], project_id: Any = None) -> Optional[set]:
    """None = no restriction (master/super administrators)."""
    role = _actor_role(user)
    if _is_super_user(user):
        return None
    if _is_department_admin_user(user):
        linked_projects = [p.get("id") for p in STATE.get("projects", []) if any(
            str(member) == str(user.get("id")) for member in (p.get("department_admin_ids") or [])
        )]
    else:
        linked_projects = [p.get("id") for p in STATE.get("projects", []) if any(
            str(member) == str(user.get("id")) for member in _project_collector_ids(p.get("id"))
        )]
    if project_id not in (None, ""):
        if str(project_id) not in {str(value) for value in linked_projects}:
            raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
        linked_projects = [project_id]
    visible = set()
    for candidate in STATE.get("users", []):
        if str(candidate.get("role")) not in ("DataCollector", "Validator"):
            continue
        if role == "DataCollector" and str(candidate.get("id")) != str(user.get("id")):
            continue
        if any(str(candidate.get("id")) in {str(m) for m in _project_collector_ids(pid)} for pid in linked_projects):
            visible.add(str(candidate.get("id")))
    return visible


@app.get("/api/tracking/collectors")
async def get_tracking_collectors(request: Request, project_id: Optional[int] = None, online_only: bool = False):
    user = _require_user(request)
    visible = _tracking_visible_user_ids(user, project_id)
    now = time.time()
    result = []
    for entry in STATE.get("collectors", []):
        user_id = entry.get("user_id")
        if visible is not None and str(user_id) not in visible:
            continue
        project_ids = entry.get("project_ids")
        if project_id not in (None, "") and project_ids is not None:
            if str(project_id) not in {str(value) for value in project_ids}:
                continue
        last_seen = float(entry.get("last_seen") or 0)
        is_online = bool(entry.get("is_online")) and (now - last_seen) <= TRACKING_ONLINE_WINDOW_SECONDS
        latest = {**entry, "is_online": is_online, "seconds_since_ping": round(now - last_seen, 1) if last_seen else None}
        if online_only and not is_online:
            continue
        result.append(latest)
    return result


@app.get("/api/tracking/collectors/geojson")
async def get_tracking_collectors_geojson(request: Request, project_id: Optional[int] = None):
    user = _require_user(request)
    collectors = await get_tracking_collectors(request, project_id, online_only=False)
    return {
        "type": "FeatureCollection",
        "features": [
            {
                "type": "Feature",
                "id": item.get("user_id"),
                "geometry": {"type": "Point", "coordinates": [item.get("longitude"), item.get("latitude")]},
                "properties": {
                    "user_id": item.get("user_id"),
                    "username": item.get("username"),
                    "full_name": item.get("full_name"),
                    "role": item.get("role"),
                    "is_online": item.get("is_online"),
                    "last_seen": item.get("last_seen"),
                    "accuracy": item.get("accuracy"),
                    "speed": item.get("speed"),
                    "app_state": item.get("app_state"),
                },
            }
            for item in collectors
            if item.get("latitude") is not None and item.get("longitude") is not None
        ],
    }


def _tracking_float(value: Any) -> Optional[float]:
    try:
        return float(value) if value not in (None, "") else None
    except (TypeError, ValueError):
        return None


@app.post("/api/tracking/ping")
async def tracking_ping(payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    entry = _tracking_entry_for(user)
    latitude = _tracking_float(payload.get("latitude"))
    longitude = _tracking_float(payload.get("longitude"))
    now = time.time()
    if latitude is not None and longitude is not None:
        entry["latitude"] = latitude
        entry["longitude"] = longitude
    for field in ("accuracy", "altitude", "heading", "speed", "battery_level", "app_state"):
        if payload.get(field) is not None:
            entry[field] = payload.get(field)
    entry["is_online"] = payload.get("is_online") is not False
    entry["last_seen"] = now
    entry["last_ping_at"] = now
    if latitude is not None and longitude is not None:
        history = STATE.setdefault("tracking_history", [])
        history.append({
            "user_id": user.get("id"),
            "username": user.get("username"),
            "full_name": user.get("full_name"),
            "role": user.get("role"),
            "latitude": latitude,
            "longitude": longitude,
            "accuracy": entry.get("accuracy"),
            "altitude": payload.get("altitude"),
            "heading": payload.get("heading"),
            "speed": payload.get("speed"),
            "battery_level": payload.get("battery_level"),
            "app_state": entry.get("app_state"),
            "project_ids": entry.get("project_ids") or [],
            "timestamp": now,
        })
        del history[:-50000]
    _save_persistent_state(sync=False)
    return {"status": "ok", "timestamp": now}


@app.post("/api/tracking/status")
async def tracking_status(payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    entry = _tracking_entry_for(user)
    now = time.time()
    previous_online = entry.get("is_online")
    entry["is_online"] = payload.get("is_online") is not False
    if payload.get("app_state") is not None:
        entry["app_state"] = payload.get("app_state")
    latitude = _tracking_float(payload.get("latitude"))
    longitude = _tracking_float(payload.get("longitude"))
    if latitude is not None and longitude is not None:
        entry["latitude"] = latitude
        entry["longitude"] = longitude
    entry["last_seen"] = now
    STATE.setdefault("tracking_events", []).append({
        "user_id": user.get("id"),
        "username": user.get("username"),
        "full_name": user.get("full_name"),
        "role": user.get("role"),
        "is_online": entry.get("is_online"),
        "app_state": entry.get("app_state"),
        "latitude": entry.get("latitude"),
        "longitude": entry.get("longitude"),
        "changed": previous_online != entry.get("is_online"),
        "timestamp": now,
    })
    del STATE["tracking_events"][:-20000]
    _save_persistent_state(sync=False)
    return {"status": "ok", "is_online": entry.get("is_online")}


@app.get("/api/tracking/collectors/{user_id}/history")
async def get_tracking_history(user_id: int, request: Request, limit: int = 200, project_id: Optional[int] = None):
    actor = _require_user(request)
    visible = _tracking_visible_user_ids(actor, project_id)
    if visible is not None and str(user_id) not in visible:
        raise HTTPException(status_code=403, detail="यो संकलकको इतिहास हेर्न अधिकार छैन। (You cannot view this collector's tracking history.)")
    points = [
        item for item in STATE.get("tracking_history", [])
        if str(item.get("user_id")) == str(user_id)
        and (project_id in (None, "") or str(project_id) in {str(p) for p in (item.get("project_ids") or [])})
    ]
    return points[-max(1, min(limit, 5000)):]


@app.get("/api/tracking/admin/logs/events")
async def get_tracking_admin_events(request: Request, project_id: Optional[int] = None, limit: int = 1000):
    actor = _require_user(request)
    visible = _tracking_visible_user_ids(actor, project_id)
    events = [
        item for item in STATE.get("tracking_events", [])
        if visible is None or str(item.get("user_id")) in visible
    ]
    return events[-max(1, min(limit, 5000)):]


@app.get("/api/tracking/admin/logs/collector-routes")
async def get_tracking_admin_collector_routes(request: Request, project_id: Optional[int] = None):
    actor = _require_user(request)
    visible = _tracking_visible_user_ids(actor, project_id)
    grouped = {}
    for item in STATE.get("tracking_history", []):
        uid = str(item.get("user_id"))
        if visible is not None and uid not in visible:
            continue
        if project_id not in (None, "") and str(project_id) not in {str(p) for p in (item.get("project_ids") or [])}:
            continue
        if uid not in grouped:
            grouped[uid] = {
                "user_id": item.get("user_id"),
                "username": item.get("username"),
                "full_name": item.get("full_name"),
                "role": item.get("role"),
                "points": [],
            }
        grouped[uid]["points"].append({
            "longitude": item.get("longitude"),
            "timestamp": item.get("timestamp"),
            "speed": item.get("speed"),
            "accuracy": item.get("accuracy"),
        })
    return list(grouped.values())


@app.get("/api/tracking/admin/logs/download")
async def download_tracking_admin_logs(request: Request, project_id: Optional[int] = None):
    """CSV tracking log (time + coordinates per collector) for administrators."""
    _require_admin_user(request)
    import csv
    import io

    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "timestamp_utc", "user_id", "username", "full_name", "role",
        "latitude", "longitude", "accuracy_m", "altitude_m", "heading_deg",
        "speed_mps", "app_state", "project_ids",
    ])
    for item in STATE.get("tracking_history", []):
        if project_id not in (None, "") and str(project_id) not in {str(p) for p in (item.get("project_ids") or [])}:
            continue
        writer.writerow([
            time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(item.get("timestamp") or 0)),
            item.get("user_id"), item.get("username") or "", item.get("full_name") or "", item.get("role") or "",
            item.get("latitude"), item.get("longitude"), item.get("accuracy"), item.get("altitude"),
            item.get("heading"), item.get("speed"), item.get("app_state") or "",
            ";".join(str(p) for p in (item.get("project_ids") or [])),
        ])
    filename = f"kmc_collector_tracking_{time.strftime('%Y%m%d_%H%M%S')}.csv"
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


# ============================================================
# Questionnaire Template Endpoints (Empty by Default)
# ============================================================
def _normalise_questionnaire_schema(questionnaire: Dict[str, Any]) -> None:
    """Flattens section-nested questions into the canonical top-level list.

    The bundled default survey (and older templates) store questions inside each
    section, while the form renderer, field sync and validator read
    `schema_definition.questions`. Without this the survey opens with no fields.
    """
    schema = questionnaire.get("schema_definition")
    if not isinstance(schema, dict):
        schema = {}
        questionnaire["schema_definition"] = schema

    sections_list = schema.get("sections") or questionnaire.get("sections") or []
    changed = False
    if not schema.get("sections") and questionnaire.get("sections"):
        schema["sections"] = questionnaire.get("sections")
        changed = True

    questions = schema.get("questions")
    if not isinstance(questions, list):
        questions = []
    seen = {str(q.get("id") or q.get("name")) for q in questions if isinstance(q, dict)}
    if "questions" not in schema or len(questions) == 0:
        changed = True

    for section in sections_list:
        if not isinstance(section, dict):
            continue
        for question in section.get("questions") or []:
            if not isinstance(question, dict):
                continue
            if not question.get("section_id") and section.get("id"):
                question = {**question, "section_id": section.get("id")}
            key = str(question.get("id") or question.get("name"))
            if key in seen:
                continue
            questions.append(question)
            seen.add(key)
            changed = True
    if changed:
        schema["questions"] = questions


def _normalise_all_questionnaires() -> None:
    for questionnaire in STATE.get("questionnaires", []) or []:
        if isinstance(questionnaire, dict):
            _normalise_questionnaire_schema(questionnaire)


def _validate_questionnaire_template(q_obj: Dict[str, Any]) -> Dict[str, Any]:
    title = str(q_obj.get("title") or "").strip()
    normalised = {"schema_definition": json.loads(json.dumps(q_obj.get("schema_definition") or {}))}
    _normalise_questionnaire_schema(normalised)
    schema = normalised.get("schema_definition") or {}
    sections = schema.get("sections") or []
    questions = schema.get("questions") or []
    errors = []
    warnings = []
    issues = []

    if not title:
        err = "प्रश्नावलीको शीर्षक (Questionnaire Title) खाली छ। कृपया शीर्षक भर्नुहोस्।"
        errors.append(err)
        issues.append({"type": "error", "message": err, "target_type": "header", "field": "title"})

    section_index_map: Dict[str, int] = {}
    if not sections:
        err = "प्रश्नावलीमा कम्तीमा एक खण्ड (Section) आवश्यक छ।"
        errors.append(err)
        issues.append({"type": "error", "message": err, "target_type": "section", "section_index": 0, "field": "sections"})
    else:
        for idx, sec in enumerate(sections):
            sec_id = sec.get("id") or f"sec_{idx + 1}"
            section_index_map[str(sec_id)] = idx
            has_title = bool(str(sec.get("title_ne") or "").strip() or str(sec.get("title") or "").strip())
            if not has_title:
                err = f"खण्ड #{idx + 1} को शीर्षक (Section Title) खाली छ।"
                errors.append(err)
                issues.append({
                    "type": "error", "message": err, "target_type": "section",
                    "section_id": sec_id, "section_index": idx, "field": "title",
                })

    if not questions:
        err = "प्रश्नावलीमा कम्तीमा एक प्रश्न (Question) आवश्यक छ।"
        errors.append(err)
        issues.append({"type": "error", "message": err, "target_type": "question", "question_index": 0, "field": "questions"})
    else:
        seen_keys = set()
        choice_types = {"single_choice", "multiple_choice", "dropdown", "select", "multiselect", "ranking", "likert"}
        known_refs: Dict[str, str] = {}
        for idx, q in enumerate(questions):
            q_id = str(q.get("id") or f"q_{idx + 1}")
            q_name = str(q.get("name") or "").strip()
            known_refs[q_id] = q_id
            if q_name:
                known_refs[q_name] = q_id

        dep_graph: Dict[str, set] = {}
        for idx, q in enumerate(questions):
            q_num = idx + 1
            q_id = q.get("id") or f"q_{idx + 1}"
            sec_id = q.get("section_id")
            sec_idx = section_index_map.get(str(sec_id), 0) if sec_id is not None else 0
            has_label = bool(str(q.get("label_ne") or "").strip() or str(q.get("label") or "").strip())
            if not has_label:
                err = f"प्रश्न #{q_num} को प्रश्न शीर्षक (Question Label) खाली छ।"
                errors.append(err)
                issues.append({
                    "type": "error", "message": err, "target_type": "question",
                    "section_id": sec_id, "section_index": sec_idx,
                    "question_id": q_id, "question_index": idx, "field": "label",
                })
            key_name = str(q.get("name") or "").strip()
            if not key_name:
                err = f"प्रश्न #{q_num} को आन्तरिक कुञ्जी (Internal Key / PostGIS Column) खाली छ।"
                errors.append(err)
                issues.append({
                    "type": "error", "message": err, "target_type": "question",
                    "section_id": sec_id, "section_index": sec_idx,
                    "question_id": q_id, "question_index": idx, "field": "name",
                })
            elif key_name in seen_keys:
                err = f"प्रश्न #{q_num} को आन्तरिक कुञ्जी '{key_name}' दोहोरिएको छ (Duplicate Key)।"
                errors.append(err)
                issues.append({
                    "type": "error", "message": err, "target_type": "question",
                    "section_id": sec_id, "section_index": sec_idx,
                    "question_id": q_id, "question_index": idx, "field": "name",
                })
            else:
                seen_keys.add(key_name)

            if q.get("type") in choice_types:
                opts = q.get("options") or []
                if not opts:
                    err = f"प्रश्न #{q_num} मा कम्तीमा एक छनोट विकल्प (Choice Option) आवश्यक छ।"
                    errors.append(err)
                    issues.append({
                        "type": "error", "message": err, "target_type": "question",
                        "section_id": sec_id, "section_index": sec_idx,
                        "question_id": q_id, "question_index": idx, "field": "options",
                    })
                else:
                    for o_idx, opt in enumerate(opts):
                        has_val = bool(str(opt.get("value") or "").strip())
                        has_opt_lbl = bool(str(opt.get("label_ne") or "").strip() or str(opt.get("label") or "").strip())
                        if not has_val or not has_opt_lbl:
                            err = f"प्रश्न #{q_num} को विकल्प #{o_idx + 1} मा विकल्प Key वा नाम खाली छ।"
                            errors.append(err)
                            issues.append({
                                "type": "error", "message": err, "target_type": "question",
                                "section_id": sec_id, "section_index": sec_idx,
                                "question_id": q_id, "question_index": idx, "field": "options",
                            })

            # Validate conditional skip-logic references & build dependency graph for cycle check
            raw_conds = q.get("conditions") or []
            if isinstance(raw_conds, dict):
                raw_conds = raw_conds.get("rules") or [raw_conds]
            for cond in raw_conds if isinstance(raw_conds, list) else []:
                if not isinstance(cond, dict):
                    continue
                ref = str(
                    cond.get("source_question_id")
                    or cond.get("question_id")
                    or cond.get("field")
                    or cond.get("source_field")
                    or ""
                ).strip()
                if not ref:
                    continue
                target_qid = known_refs.get(ref)
                if target_qid is None:
                    err = f"प्रश्न #{q_num} को सर्त (Condition) मा अमान्य प्रश्न सन्दर्भ '{ref}' छ।"
                    errors.append(err)
                    issues.append({
                        "type": "error", "message": err, "target_type": "question",
                        "section_id": sec_id, "section_index": sec_idx,
                        "question_id": q_id, "question_index": idx, "field": "conditions",
                    })
                elif target_qid == str(q_id):
                    err = f"प्रश्न #{q_num} को सर्त (Condition) ले आफैंलाई सन्दर्भ गर्न मिल्दैन।"
                    errors.append(err)
                    issues.append({
                        "type": "error", "message": err, "target_type": "question",
                        "section_id": sec_id, "section_index": sec_idx,
                        "question_id": q_id, "question_index": idx, "field": "conditions",
                    })
                else:
                    dep_graph.setdefault(str(q_id), set()).add(target_qid)

        # Detect cyclic conditional dependencies via DFS
        visiting: set = set()
        visited: set = set()
        cycle_nodes: set = set()

        def _dfs(node: str) -> bool:
            visiting.add(node)
            for nxt in dep_graph.get(node, ()):
                if nxt in visiting:
                    cycle_nodes.add(node)
                    cycle_nodes.add(nxt)
                    return True
                if nxt not in visited and _dfs(nxt):
                    cycle_nodes.add(node)
                    return True
            visiting.discard(node)
            visited.add(node)
            return False

        for node in list(dep_graph.keys()):
            if node not in visited:
                _dfs(node)
        if cycle_nodes:
            for idx, q in enumerate(questions):
                q_id = str(q.get("id") or f"q_{idx + 1}")
                if q_id in cycle_nodes:
                    sec_id = q.get("section_id")
                    sec_idx = section_index_map.get(str(sec_id), 0) if sec_id is not None else 0
                    err = f"प्रश्न #{idx + 1} मा चक्रीय सर्त (Circular condition dependency) भेटियो।"
                    errors.append(err)
                    issues.append({
                        "type": "error", "message": err, "target_type": "question",
                        "section_id": sec_id, "section_index": sec_idx,
                        "question_id": q_id, "question_index": idx, "field": "conditions",
                    })
                    break

    valid = len(errors) == 0
    return {
        "valid": valid,
        "is_valid": valid,
        "errors": errors,
        "warnings": warnings,
        "issues": issues,
        "total_sections": len(sections),
        "total_questions": len(questions),
        "conditional_rules_count": sum(1 for item in questions if item.get("conditions")),
        "repeat_groups_count": sum(1 for item in questions if item.get("type") == "repeat_group"),
    }


def _require_questionnaire_access(questionnaire_id: Any, request: Request, admin_only: bool = False) -> Dict[str, Any]:
    user = _require_admin_user(request) if admin_only else _require_user(request)
    target = next((q for q in STATE["questionnaires"] if str(q.get("id")) == str(questionnaire_id)), None)
    if target is None:
        _load_persistent_state()
        target = next((q for q in STATE["questionnaires"] if str(q.get("id")) == str(questionnaire_id)), None)
    if target is None:
        raise HTTPException(status_code=404, detail="प्रश्नावली भेटिएन। (Questionnaire not found.)")
    if not _user_can_access_project(user, target.get("project_id")):
        raise HTTPException(status_code=403, detail="यो प्रश्नावलीको परियोजनामा पहुँच छैन। (You do not have access to this questionnaire's project.)")
    return target


def _sync_questionnaire_layer_fields(questionnaire: Dict[str, Any]) -> None:
    """Questionnaire attributes become the linked layer's editable fields.

    Layer-specific attributes already configured by an administrator are kept:
    a feature carries both the survey answers and the layer's own columns.
    """
    for layer in STATE.get("vector_layers", []):
        if str(layer.get("questionnaire_id")) != str(questionnaire.get("id")):
            continue
        layer["fields_config"] = _merge_questionnaire_fields(
            questionnaire, layer.get("fields_config")
        )


@app.get("/api/questionnaires")
async def list_all_questionnaires(request: Request):
    user = _require_user(request)
    if _is_super_user(user):
        return STATE.get("questionnaires", [])
    return [
        q for q in STATE.get("questionnaires", [])
        if q.get("project_id") in (None, "", 0, "0") or q.get("is_global") is True or _user_can_access_project(user, q.get("project_id"))
    ]


@app.post("/api/questionnaires")
async def create_global_questionnaire(payload: Dict[str, Any], request: Request):
    return await create_questionnaire_draft(0, {**payload, "is_global": True}, request)


@app.get("/api/projects/{project_id}/questionnaires/active")
async def get_active_questionnaire(project_id: int, request: Request):
    user = _require_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    active = next(
        (
            q for q in STATE["questionnaires"]
            if str(q.get("project_id")) == str(project_id)
            and q.get("status") == "PUBLISHED"
            and q.get("is_active")
        ),
        None,
    )
    if not active:
        active = next(
            (
                q for q in STATE["questionnaires"]
                if (q.get("project_id") in (None, "", 0, "0") or q.get("is_global") is True)
                and q.get("status") == "PUBLISHED"
                and q.get("is_active")
            ),
            None,
        )
    return active


@app.get("/api/projects/{project_id}/questionnaires")
async def list_project_questionnaires(project_id: int, request: Request):
    user = _require_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    return [
        q for q in STATE["questionnaires"]
        if str(q.get("project_id")) == str(project_id) or q.get("project_id") in (None, "", 0, "0") or q.get("is_global") is True
    ]


@app.post("/api/projects/{project_id}/questionnaires")
async def create_questionnaire_draft(project_id: int, payload: Dict[str, Any], request: Request):
    user = _require_admin_user(request)
    is_global = payload.get("is_global") is True or str(project_id) in ("0", "global")
    if is_global and not _is_super_user(user):
        raise HTTPException(
            status_code=403,
            detail="सार्वभौमिक (Global) प्रश्नावली केवल मास्टर/सुपर प्रशासकले सिर्जना गर्न सक्छ। "
                   "(Only a master/super administrator can create a global questionnaire.)",
        )
    if not is_global:
        _require_project(project_id)
        if not _user_can_access_project(user, project_id):
            raise HTTPException(
                status_code=403,
                detail="यो परियोजनाको प्रश्नावली सिर्जना गर्न पहुँच छैन। (You cannot create questionnaires for this project.)",
            )
    new_q = {
        "id": int(time.time() * 1000),
        "project_id": None if is_global else project_id,
        "is_global": is_global,
        "title": payload.get("title") or "",
        "description": payload.get("description") or "",
        "version": "v1.0",
        "status": "DRAFT",
        "is_active": False,
        "created_by": user.get("id"),
        "created_by_username": user.get("username"),
        "schema_definition": payload.get("schema_definition") or {"sections": [], "questions": [], "settings": {}},
    }
    _normalise_questionnaire_schema(new_q)
    STATE["questionnaires"].insert(0, new_q)

    # Optional explicit layer_id binding or auto_create_layer
    req_layer_id = payload.get("layer_id")
    if req_layer_id not in (None, ""):
        target_layer = _find_vector_layer(req_layer_id)
        if target_layer is None:
            raise HTTPException(status_code=404, detail="जोड्ने भेक्टर तह भेटिएन। (Target vector layer not found.)")
        target_layer["questionnaire_id"] = new_q["id"]
        new_q["layer_id"] = target_layer["id"]
        _sync_questionnaire_layer_fields(new_q)
    elif payload.get("auto_create_layer") is True:
        geom_type = _canonical_geometry_type(payload.get("geometry_type"), default="Point")
        auto_layer_id = int(time.time() * 1000) + 1
        auto_layer = {
            "id": auto_layer_id,
            "name": (new_q["title"] or f"Survey Layer {new_q['id']}").strip(),
            "description": new_q["description"] or "Auto-created questionnaire survey layer",
            "type": "vector",
            "geometry_type": geom_type,
            "creation_geometry_types": [geom_type],
            "category": PORTAL_VECTOR_CATEGORY,
            "is_global": is_global,
            "project_id": None if is_global else project_id,
            "questionnaire_id": new_q["id"],
            "allow_snapping": True,
            "editable_by_collectors": True,
            "published": False,
            "public_visible": False,
            "default_visible": True,
            "access_level": "public",
            "opacity": 1,
            "feature_count": 0,
            "style": {"strokeColor": "#10b981", "fillColor": "#10b981", "strokeWidth": 2.5, "clickTolerance": 14},
            "fields_config": _questionnaire_fields_config(new_q),
            "created_at": time.time(),
        }
        STATE["vector_layers"].insert(0, auto_layer)
        STATE["features_by_layer"][auto_layer_id] = []
        new_q["layer_id"] = auto_layer_id
        if not is_global:
            proj = _find_project(project_id)
            if proj is not None:
                rec = _get_or_create_project_assignment(project_id)
                rec.setdefault("assigned_layer_ids", [])
                if auto_layer_id not in rec["assigned_layer_ids"]:
                    rec["assigned_layer_ids"].append(auto_layer_id)
                if isinstance(proj.get("editable_layer_ids"), list) and auto_layer_id not in proj["editable_layer_ids"]:
                    proj["editable_layer_ids"].append(auto_layer_id)

    _save_persistent_state(sync=True)
    return new_q


@app.get("/api/questionnaires/{questionnaire_id}")
async def get_questionnaire_detail(questionnaire_id: int, request: Request):
    return _require_questionnaire_access(questionnaire_id, request)


@app.put("/api/questionnaires/{questionnaire_id}")
async def update_questionnaire_draft(questionnaire_id: int, payload: Dict[str, Any], request: Request):
    target = _require_questionnaire_access(questionnaire_id, request, admin_only=True)
    if "title" in payload:
        target["title"] = payload["title"]
    if "description" in payload:
        target["description"] = payload["description"]
    if "schema_definition" in payload:
        target["schema_definition"] = payload["schema_definition"]
    _normalise_questionnaire_schema(target)
    _sync_questionnaire_layer_fields(target)
    _save_persistent_state()
    return target


@app.post("/api/questionnaires/{questionnaire_id}/validate")
async def validate_questionnaire(questionnaire_id: int, request: Request):
    target = _require_questionnaire_access(questionnaire_id, request, admin_only=True)
    return _validate_questionnaire_template(target)


@app.post("/api/questionnaires/{questionnaire_id}/publish")
async def publish_questionnaire(questionnaire_id: int, response: Response, request: Request):
    target = _require_questionnaire_access(questionnaire_id, request, admin_only=True)
    validation = _validate_questionnaire_template(target)
    if not validation["valid"]:
        response.status_code = 400
        return {
            "detail": validation["errors"][0] if validation["errors"] else "प्रश्नावलीका खाली टेम्प्लेट फिल्डहरू पूरा भर्नुहोस्।",
            "errors": validation["errors"],
            "issues": validation["issues"],
        }
    target["status"] = "PUBLISHED"
    target["is_active"] = True
    # Only one active questionnaire per project: a collector must never receive an
    # ambiguous "active" survey form.
    for other in STATE.get("questionnaires", []):
        if other is not target and str(other.get("project_id")) == str(target.get("project_id")):
            other["is_active"] = False
    # Publishing is the moment the survey becomes authoritative: push every
    # question into the linked layer's attribute schema.
    _sync_questionnaire_layer_fields(target)
    _save_persistent_state()
    return target


@app.post("/api/questionnaires/{questionnaire_id}/duplicate")
async def duplicate_questionnaire(questionnaire_id: int, request: Request):
    source = _require_questionnaire_access(questionnaire_id, request, admin_only=True)

    copy = json.loads(json.dumps(source))
    copy["id"] = int(time.time() * 1000)
    copy["title"] = f"{source.get('title') or 'प्रश्नावली'} (प्रतिलिपि)"
    copy["status"] = "DRAFT"
    copy["is_active"] = False
    copy["version"] = "v1.0"
    copy["created_at"] = time.time()
    STATE["questionnaires"].insert(0, copy)
    _save_persistent_state()
    return copy


# ============================================================
# Field-Collection Integrity Helpers
#   identity attribution, task-grid containment and strict
#   questionnaire <-> vector-layer binding
# ============================================================

RESERVED_RECORD_KEYS = {
    "_id", "_record_id", "_questionnaire_id", "_status", "_task_grid_id",
    "_layer_id", "_created_by", "_created_by_username", "_created_at",
    "_updated_at", "geometry", "geom", "the_geom",
}

FIELD_TYPE_MAP = {
    "integer": "number",
    "decimal": "number",
    "number": "number",
    "calculated": "number",
    "date": "date",
    "time": "time",
    "datetime": "datetime",
    "date_time": "datetime",
    "yes_no": "boolean",
    "single_choice": "select",
    "dropdown": "select",
    "select": "select",
    "multiple_choice": "multiselect",
    "multiselect": "multiselect",
    "photo": "image",
    "camera_photo": "image",
    "signature": "signature",
    "gps_coordinate": "gps_coordinate",
}


FIELD_ROLES = ("DataCollector", "Validator")
DEPARTMENT_ADMIN_ROLES = ("DepartmentAdmin", "GisAdmin")
ADMIN_ROLES = ("MasterAdmin", "SuperAdmin", "DepartmentAdmin", "GisAdmin")
REVIEW_ADMIN_ROLES = ("MasterAdmin", "SuperAdmin", "DepartmentAdmin", "GisAdmin")
MASTER_ROLE = "MasterAdmin"
SUPER_ROLES = ("MasterAdmin", "SuperAdmin")


def _bearer_token_from_request(request: Optional[Request]) -> str:
    if request is None:
        return ""
    header = request.headers.get("authorization") or ""
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    # navigator.sendBeacon and browser EventSource cannot set custom HTTP headers,
    # so the unload status ping and SSE event streams carry the token as a query parameter.
    token_param = str(request.query_params.get("token") or "").strip()
    if token_param:
        path = request.url.path
        if (
            path == "/api/tracking/status"
            or "/events" in path
            or path.startswith("/api/uploads/")
        ):
            return token_param
    return ""


def resolve_request_user(request: Optional[Request]) -> Optional[Dict[str, Any]]:
    """Resolve the caller from the HMAC-signed bearer token issued by /api/auth/login.

    Token format: `kmc-jwt-<user_id>-<issued_at>-<hmac>`. Unsigned/legacy tokens are
    rejected so project linkage and the master-only secret console cannot be bypassed
    by fabricating a token for another user id.
    """
    token = _bearer_token_from_request(request)
    if not token:
        return None
    match = re.match(r"^kmc-jwt-(\d+)-(\d+)-([0-9a-f]{32})$", token)
    if not match:
        return None
    user_id, issued_at, signature = int(match.group(1)), int(match.group(2)), match.group(3)
    if not hmac.compare_digest(signature, _sign_token(user_id, issued_at, "access")):
        return None
    max_age = max(60, int(settings.access_token_expire_minutes) * 60)
    if issued_at > int(time.time()) + 120 or int(time.time()) - issued_at > max_age:
        return None
    if not STATE.get("users"):
        _init_runtime_users()
    user = next((user for user in STATE.get("users", []) if int(user.get("id", 0)) == user_id), None)
    if user is not None and user.get("is_active") is False:
        return None
    if user is not None:
        pw_changed_at = int(user.get("password_changed_at") or 0)
        if pw_changed_at and issued_at < pw_changed_at:
            return None
    return user


def _actor_role(user: Optional[Dict[str, Any]]) -> str:
    return str((user or {}).get("role") or "")


def _is_master_user(user: Optional[Dict[str, Any]]) -> bool:
    return _actor_role(user) == MASTER_ROLE


def _is_admin_user(user: Optional[Dict[str, Any]]) -> bool:
    return _actor_role(user) in ADMIN_ROLES


def _is_department_admin_user(user: Optional[Dict[str, Any]]) -> bool:
    return _actor_role(user) in DEPARTMENT_ADMIN_ROLES


def _is_super_user(user: Optional[Dict[str, Any]]) -> bool:
    return _actor_role(user) in SUPER_ROLES


def _require_user(request: Optional[Request]) -> Dict[str, Any]:
    user = resolve_request_user(request)
    if user is None:
        raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
    return user


def _require_admin_user(request: Optional[Request]) -> Dict[str, Any]:
    user = _require_user(request)
    if not _is_admin_user(user):
        raise HTTPException(status_code=403, detail="प्रशासक अधिकार आवश्यक छ। (Administrator role required.)")
    return user


def _require_master_user(request: Optional[Request]) -> Dict[str, Any]:
    user = _require_user(request)
    if not _is_master_user(user):
        raise HTTPException(
            status_code=403,
            detail="यो सुविधा केवल निजी मास्टर प्रयोगकर्ताका लागि हो। (This resource is restricted to the private master user.)",
        )
    return user


def _require_super_user(request: Optional[Request]) -> Dict[str, Any]:
    user = _require_user(request)
    if not _is_super_user(user):
        raise HTTPException(
            status_code=403,
            detail="यो सुविधा मास्टर वा सुपर प्रशासकका लागि मात्र हो। (This resource requires a master or super administrator.)",
        )
    return user


def _project_collector_ids(project_id: Any) -> List[Any]:
    """All collector ids linked to a project (int/str keys are both honoured)."""
    res = set()
    collectors = STATE.get("project_collectors", {}) or {}
    for key in (project_id, str(project_id)):
        if key in collectors:
            for item in (collectors.get(key) or []):
                res.add(str(item))
    for key, value in collectors.items():
        if str(key) == str(project_id):
            for item in (value or []):
                res.add(str(item))
    project = _find_project(project_id)
    if project:
        for cid in (project.get("collector_ids") or []):
            res.add(str(cid))
        for vid in (project.get("validator_ids") or []):
            res.add(str(vid))
        for aid in (project.get("assigned_collectors") or []):
            res.add(str(aid))
        for avid in (project.get("assigned_validators") or []):
            res.add(str(avid))
    assignments = STATE.get("project_assignments", {}) or {}
    rec = assignments.get(str(project_id)) or assignments.get(project_id)
    if isinstance(rec, dict):
        for cid in (rec.get("assigned_collector_ids") or []):
            res.add(str(cid))
        for vid in (rec.get("assigned_validator_ids") or []):
            res.add(str(vid))
    return list(res)


def _project_department_admin_ids(project_id: Any) -> List[Any]:
    """Department administrators explicitly linked to a project."""
    project = _find_project(project_id)
    if not project:
        return []
    return list(project.get("department_admin_ids") or [])


def _department_admin_project_ids(user: Optional[Dict[str, Any]]) -> set:
    if user is None:
        return set()
    user_id = str(user.get("id"))
    return {
        str(project.get("id"))
        for project in STATE.get("projects", [])
        if any(str(member) == user_id for member in (project.get("department_admin_ids") or []))
    }


def _department_admin_can_manage_user(actor: Optional[Dict[str, Any]], target: Dict[str, Any]) -> bool:
    """A department admin manages collectors/validators inside their projects only."""
    if _actor_role(target) not in COLLECTOR_ROLES:
        return False
    project_ids = _department_admin_project_ids(actor)
    if not project_ids:
        return False
    target_id = str(target.get("id"))
    return any(
        target_id in {str(member) for member in _project_collector_ids(project_id)}
        for project_id in project_ids
    )


def _user_can_access_project(user: Optional[Dict[str, Any]], project_id: Any) -> bool:
    """Strict project-isolation rule.

    * Master/Super administrators reach every project.
    * Department admins (and legacy GisAdmin) reach only linked projects.
    * Validators/DataCollectors reach only projects they are assigned to.
    * Global layers (no project) remain reachable for authenticated users.
    """
    if user is None:
        return False
    role = _actor_role(user)
    if role in SUPER_ROLES:
        return True
    if project_id in (None, ""):
        return True
    assigned_pids = user.get("assigned_projects") or user.get("assigned_project_ids") or []
    if isinstance(assigned_pids, list) and any(str(p) == str(project_id) for p in assigned_pids):
        return True
    if role in DEPARTMENT_ADMIN_ROLES:
        return any(
            str(member) == str(user.get("id")) for member in _project_department_admin_ids(project_id)
        )
    if role in FIELD_ROLES:
        return any(
            str(member) == str(user.get("id")) for member in _project_collector_ids(project_id)
        )
    # BasicViewer (and any unknown/legacy role) is limited to the public global
    # scope: project data stays visible only to the people linked to the project.
    return False


def _task_assignee_ids(task: Dict[str, Any]) -> set:
    """All collectors and validators assigned to a grid."""
    ids = {str(task.get("assigned_to"))} if task.get("assigned_to") not in (None, "") else set()
    if task.get("validator_id") not in (None, ""):
        ids.add(str(task.get("validator_id")))
    for vid in task.get("validator_ids") or []:
        if vid not in (None, ""):
            ids.add(str(vid))
    for item in task.get("assignments") or []:
        if isinstance(item, dict) and item.get("user_id") not in (None, ""):
            ids.add(str(item.get("user_id")))
    return ids


def _task_layer_scope(task: Dict[str, Any], user_id: Any) -> Optional[set]:
    """Layer ids a collector may write in a multi-assignee grid (None = no restriction)."""
    if user_id in (None, ""):
        return None
    for item in task.get("assignments") or []:
        if not isinstance(item, dict) or str(item.get("user_id")) != str(user_id):
            continue
        raw = item.get("layer_ids")
        if raw:
            return {str(value) for value in raw}
        return None
    raw_scope = task.get("assigned_layer_ids")
    if raw_scope and str(task.get("assigned_to")) == str(user_id):
        return {str(value) for value in raw_scope}
    return None


def _project_layer_is_editable(project: Optional[Dict[str, Any]], layer: Dict[str, Any], user: Optional[Dict[str, Any]]) -> bool:
    """Field editing is closed by default; strictly scoped per (project_id, layer_id).

    When a project context is present, collector editability is governed strictly by
    `project["editable_layer_ids"]` so a global `layer["editable_by_collectors"]` flag
    never leaks across projects.
    """
    if _is_admin_user(user):
        return True
    if project:
        allowed = project.get("editable_layer_ids")
        if isinstance(allowed, list):
            return any(str(layer_id) == str(layer.get("id")) for layer_id in allowed)
        if str(layer.get("project_id")) == str(project.get("id")):
            return layer.get("editable_by_collectors") is True
        return False
    return layer.get("editable_by_collectors") is True


FIELD_ENTRY_EXEMPT_KEYS = {
    "Kmc_Editor",
    "target_id",
    "link_attribute",
    "linked_feature_id",
    "linked_feature_ref",
}


def _layer_field_schema(layer: Dict[str, Any], geometry: Any = None) -> list:
    """Field definitions that govern attribute entry for this layer/geometry."""
    geometry_type = geometry.get("type") if isinstance(geometry, dict) else None
    geom_fields = layer.get("geometry_fields_config")
    base_fields = []
    if (
        geometry_type
        and isinstance(geom_fields, dict)
        and isinstance(geom_fields.get(geometry_type), list)
        and geom_fields.get(geometry_type)
    ):
        base_fields = [field for field in geom_fields[geometry_type] if isinstance(field, dict)]
    elif isinstance(layer.get("fields_config"), list):
        base_fields = [field for field in layer["fields_config"] if isinstance(field, dict)]

    # If layer has an associated questionnaire, also include questionnaire questions as allowed fields
    qid = layer.get("questionnaire_id")
    if qid:
        q_obj = next((q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(qid)), None)
        if q_obj and isinstance(q_obj.get("schema_definition"), dict):
            existing_names = {str(f.get("name")) for f in base_fields if f.get("name")}
            for q in q_obj["schema_definition"].get("questions", []):
                if isinstance(q, dict) and q.get("name") and str(q.get("name")) not in existing_names:
                    base_fields.append({
                        "name": str(q.get("name")),
                        "label": q.get("label_ne") or q.get("label") or q.get("name"),
                        "type": q.get("type", "text"),
                        "required": q.get("required", False),
                    })
    return base_fields


def _field_entry_allowed(field: Dict[str, Any], role: str) -> bool:
    """Admins may pin a field to specific roles; an unset list means all writers.

    The admin panel's ``access_level`` (public/validator/admin) also acts as an
    entry restriction so a value staff cannot read can never be injected.
    """
    role = str(role)
    roles = field.get("editable_roles")
    if isinstance(roles, list) and roles:
        return role in {str(item) for item in roles}
    access_level = str(field.get("access_level") or "").lower()
    if access_level in ("admin", "admin_only"):
        return role in ADMIN_ROLES
    if access_level == "validator":
        return role in ("Validator",) + ADMIN_ROLES
    return True


def _same_field_value(left: Any, right: Any) -> bool:
    try:
        return json.dumps(left, sort_keys=True, default=str) == json.dumps(right, sort_keys=True, default=str)
    except Exception:
        return left == right


def _enforce_field_entry_permissions(
    layer: Dict[str, Any],
    user: Optional[Dict[str, Any]],
    properties: Dict[str, Any],
    geometry: Any = None,
    existing: Optional[Dict[str, Any]] = None,
    reject_unknown: bool = False,
) -> None:
    """Server-side mirror of the admin field-entry configuration.

    ``editable_roles`` on a field pins which roles may change its value, and the
    layer schema is the only source of attributes a non-admin may add through the
    direct feature endpoints.
    """
    if not isinstance(properties, dict) or not properties:
        return
    # Administrators configure the permissions, so they retain full entry access.
    if _is_admin_user(user):
        return
    schema = _layer_field_schema(layer, geometry)
    if not schema:
        return
    schema_by_name = {str(field.get("name")): field for field in schema if field.get("name")}
    role = _actor_role(user)
    existing = existing if isinstance(existing, dict) else {}
    denied: list = []
    unknown: list = []
    for raw_key, value in properties.items():
        key = str(raw_key)
        if (
            key in RESERVED_RECORD_KEYS
            or key in FIELD_ENTRY_EXEMPT_KEYS
            or key.startswith("_")
            or key.startswith("linked_")
            or key.endswith("_linked_id")
        ):
            continue
        field = schema_by_name.get(key)
        if field is None:
            if reject_unknown and not _is_admin_user(user):
                unknown.append(key)
            continue
        if not _field_entry_allowed(field, role):
            unchanged = key in existing and _same_field_value(existing.get(key), value)
            if not unchanged:
                denied.append(str(field.get("label") or key))
    if denied:
        raise HTTPException(
            status_code=403,
            detail=(
                "तपाईंको भूमिकाले यी फिल्डहरूमा मान प्रविष्ट गर्न पाउँदैन: "
                f"{', '.join(sorted(set(denied)))}. (Your role may not enter these fields.)"
            ),
        )
    if unknown:
        raise HTTPException(
            status_code=403,
            detail=(
                "यी विशेषताहरू यस तहको स्किमामा परिभाषित छैनन्: "
                f"{', '.join(sorted(set(unknown)))}. (These attributes are not defined in the layer schema.)"
            ),
        )


def _enforce_layer_write_access(layer: Dict[str, Any], user: Optional[Dict[str, Any]], request: Optional[Request] = None) -> None:
    if layer is None:
        raise HTTPException(status_code=404, detail="भेक्टर तह भेटिएन। (Vector layer not found.)")
    if user is None:
        raise HTTPException(status_code=401, detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)")
    if not _is_admin_user(user) and _actor_role(user) not in FIELD_ROLES:
        raise HTTPException(
            status_code=403,
            detail="यो भूमिकाले विशेषता सम्पादन गर्न पाउँदैन। (This role cannot edit features.)",
        )
    project = _find_project(layer.get("project_id")) if layer.get("project_id") is not None else None
    if not _project_layer_is_editable(project, layer, user):
        raise HTTPException(
            status_code=403,
            detail="यो तह सम्पादनका लागि खुला गरिएको छैन। (This layer is not open for editing in this project.)",
        )
    if layer.get("project_id") is None:
        if not (_is_super_user(user) or _actor_role(user) == "GisAdmin"):
            raise HTTPException(
                status_code=403,
                detail="सार्वजनिक (Global) तह परिमार्जन गर्न मास्टर, सुपर वा GIS प्रशासक अधिकार आवश्यक छ। (Global layers can only be modified by Master, Super, or GIS administrators.)"
            )
    elif not _user_can_access_project(user, layer.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")


def _record_audit_entry(layer_id: Any, action: str, user: Optional[Dict[str, Any]], feature_id: Any = None, details: Optional[Dict[str, Any]] = None) -> None:
    """Append-only per-layer edit/collection log (who, what, when)."""
    entry = {
        "id": int(time.time() * 1000),
        "layer_id": layer_id,
        "feature_id": feature_id,
        "action": action,
        "user_id": (user or {}).get("id"),
        "username": (user or {}).get("username") or "unknown",
        "full_name": (user or {}).get("full_name"),
        "role": _actor_role(user) or "unknown",
        "timestamp": time.time(),
        "details": details or {},
    }
    log = STATE.setdefault("audit_edits_by_layer", {}).setdefault(str(layer_id), [])
    log.insert(0, entry)
    del log[5000:]


def _project_id_for_request_path(request: Request) -> Optional[Any]:
    """Best-effort project resolution for project-scoped API paths."""
    path = request.url.path
    match = re.match(r"^/api/projects/([^/]+)(?:/|$)", path)
    if match and match.group(1) not in ("deleted",):
        return match.group(1)
    match = re.match(r"^/api/layers/([^/]+)(?:/|$)", path)
    if match:
        layer = next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == match.group(1)), None)
        return (layer or {}).get("project_id")
    match = re.match(r"^/api/tasks/([^/]+)(?:/|$)", path)
    if match:
        located = _find_task_anywhere(match.group(1))
        if located:
            return located[0]
    match = re.match(r"^/api/questionnaires/([^/]+)(?:/|$)", path)
    if match:
        questionnaire = next(
            (q for q in STATE.get("questionnaires", []) if str(q.get("id")) == match.group(1)),
            None,
        )
        return (questionnaire or {}).get("project_id")
    match = re.match(r"^/api/records/([^/]+)(?:/|$)", path)
    if match:
        record = _find_record(match.group(1))
        return (record or {}).get("project_id")
    match = re.match(r"^/api/features/([^/]+)(?:/|$)", path)
    if match:
        found = _find_feature_across_layers(match.group(1))
        if found:
            layer = next((l for l in STATE.get("vector_layers", []) if str(l.get("id")) == str(found["layer_id"])), None)
            return (layer or {}).get("project_id")
    if path.startswith("/api/tracking/"):
        value = request.query_params.get("project_id")
        return value or None
    return None


@app.middleware("http")
async def enforce_project_linkage_and_auth(request: Request, call_next):
    """Server-side access gate for authenticated APIs.

    * A presented-but-invalid bearer token is rejected (401) instead of silently
      downgrading to anonymous.
    * Unsafe (write) API calls always require a valid authenticated user.
    * DataCollector/Validator may only reach projects linked to them.
    """
    path = request.url.path
    if request.method == "OPTIONS" or not path.startswith("/api/"):
        return await call_next(request)
    if path in ("/api/auth/login", "/api/auth/refresh", "/api/health", "/api/runtime-config"):
        return await call_next(request)
    if path.startswith("/api/geo/") or path.startswith("/api/geo-access/"):
        return await call_next(request)
    if not _geoportal_enabled():
        is_portal_api = path.startswith("/api/geoportal/") or path.startswith("/api/analytics/")
        is_shared_map_data = path.startswith("/api/tiles") or (
            path.startswith("/api/layers/") and request.query_params.get("portal") in ("1", "true")
        )
        if is_portal_api or is_shared_map_data:
            user = resolve_request_user(request)
            # Authenticated staff keep their internal dashboard maps; the public
            # portal surface is fully halted for anonymous callers.
            staff = user is not None and _actor_role(user) in ADMIN_ROLES + FIELD_ROLES
            allowed = _is_master_user(user) or (is_shared_map_data and staff)
            if not allowed:
                return JSONResponse(
                    status_code=503,
                    content={"detail": GEOPORTAL_MAINTENANCE_DETAIL, "geoportal_enabled": False},
                )

    raw_token = _bearer_token_from_request(request)
    user = resolve_request_user(request)
    if raw_token and user is None:
        return JSONResponse(status_code=401, content={"detail": "टोकन अवैध वा म्याद सकिएको छ। (Invalid or expired token.)"})
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and user is None:
        return JSONResponse(status_code=401, content={"detail": "प्रमाणीकरण आवश्यक छ। (Authentication required.)"})
    if user is None:
        return await call_next(request)

    role = _actor_role(user)
    if role not in FIELD_ROLES and role not in DEPARTMENT_ADMIN_ROLES:
        return await call_next(request)

    project_id = _project_id_for_request_path(request)
    if project_id not in (None, "") and not _user_can_access_project(user, project_id):
        return JSONResponse(
            status_code=403,
            content={"detail": "यो परियोजना तपाईंसँग जोडिएको छैन। (This project is not linked to your account.)"},
        )
    return await call_next(request)



def _clean_record_answers(answers: Any) -> Dict[str, Any]:
    """Keeps only real field answers; system properties can never be forged by a payload."""
    if not isinstance(answers, dict):
        return {}
    return {
        str(key): value
        for key, value in answers.items()
        if key and not str(key).startswith("_") and str(key) not in RESERVED_RECORD_KEYS
    }


def _geometry_rings(geometry: Any) -> list:
    """Returns every linear ring of a GeoJSON Polygon / MultiPolygon (outer + holes)."""
    if not isinstance(geometry, dict):
        return []
    g_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if g_type == "Polygon" and isinstance(coords, (list, tuple)):
        return [ring for ring in coords if isinstance(ring, (list, tuple))]
    if g_type == "MultiPolygon" and isinstance(coords, (list, tuple)):
        rings = []
        for polygon in coords:
            if isinstance(polygon, (list, tuple)):
                rings.extend(ring for ring in polygon if isinstance(ring, (list, tuple)))
        return rings
    return []


def _point_in_ring(lng: float, lat: float, ring: list) -> bool:
    """Ray-casting point-in-ring test for GeoJSON order ([lng, lat])."""
    count = len(ring)
    if count < 3:
        return False
    inside = False
    j = count - 1
    for i in range(count):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if ((yi > lat) != (yj > lat)) and (lng < (xj - xi) * (lat - yi) / ((yj - yi) or 1e-12) + xi):
            inside = not inside
        j = i
    return inside


def _representative_point(geometry: Any) -> Optional[tuple]:
    """Stable centre point used for containment tests (bbox centre of every vertex)."""
    if not isinstance(geometry, dict):
        return None
    if geometry.get("type") == "Point":
        coords = geometry.get("coordinates")
        if isinstance(coords, (list, tuple)) and len(coords) >= 2:
            return (float(coords[0]), float(coords[1]))
        return None

    xs, ys = [], []

    def collect(node):
        if (
            isinstance(node, (list, tuple))
            and len(node) >= 2
            and all(isinstance(value, (int, float)) for value in node[:2])
        ):
            xs.append(float(node[0]))
            ys.append(float(node[1]))
        elif isinstance(node, (list, tuple)):
            for child in node:
                collect(child)

    collect(geometry.get("coordinates"))
    if not xs or not ys:
        return None
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def _geometry_polygon_rings(geometry: Any) -> list:
    """Returns polygons as ring lists: `[[outer, hole, ...], ...]` (MultiPolygon aware)."""
    if not isinstance(geometry, dict):
        return []
    g_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if g_type == "Polygon" and isinstance(coords, (list, tuple)):
        return [coords]
    if g_type == "MultiPolygon" and isinstance(coords, (list, tuple)):
        return [polygon for polygon in coords if isinstance(polygon, (list, tuple)) and polygon]
    return []


def _point_in_task_geometry(x: float, y: float, task_geometry: Any) -> bool:
    if isinstance(task_geometry, dict):
        try:
            task_shape = shape(task_geometry)
            if not task_shape.is_empty:
                return bool(task_shape.covers(Point(float(x), float(y))))
        except Exception:
            pass
    for rings in _geometry_polygon_rings(task_geometry):
        if not rings:
            continue
        if _point_in_ring(x, y, rings[0]) and not any(
            _point_in_ring(x, y, hole) for hole in rings[1:]
        ):
            return True
    return False


def _geometry_within_task_grid(task_geometry: Any, geometry: Any) -> bool:
    """True when the geometry's representative interior point is covered by the task grid."""
    if isinstance(task_geometry, dict) and isinstance(geometry, dict):
        try:
            task_shape = shape(task_geometry)
            geom_shape = shape(geometry)
            if not task_shape.is_empty and not geom_shape.is_empty:
                rep_pt = geom_shape.representative_point()
                return bool(task_shape.covers(rep_pt))
        except Exception:
            pass
    point = _representative_point(geometry)
    if point is None:
        return False
    return _point_in_task_geometry(point[0], point[1], task_geometry)


def _project_task_grids(project_id: Any) -> list:
    tasks = STATE.get("tasks_by_project", {}).get(project_id)
    if tasks is None:
        tasks = STATE.get("tasks_by_project", {}).get(str(project_id))
    return [task for task in (tasks or []) if isinstance(task, dict) and task.get("geometry")]


def _assigned_grid_geometries(project_id: Any, user: Optional[Dict[str, Any]]) -> Optional[list]:
    """Grid geometries a field user is restricted to.

    `None` means "no grid restriction" (admins, or a validator with no assigned
    grids). An empty list means the user has no usable grid access.
    """
    role = _actor_role(user)
    if role not in FIELD_ROLES or user is None:
        return None
    grids = _project_task_grids(project_id)
    if not grids:
        return None
    user_id = user.get("id")
    assigned = [task for task in grids if str(user_id) in _task_assignee_ids(task)]
    if role == "DataCollector":
        return [task.get("geometry") for task in assigned]
    # Validators are project-wide unless grids are explicitly assigned to them.
    if not assigned:
        return None
    return [task.get("geometry") for task in assigned]


def _record_within_grids(record: Dict[str, Any], grid_geometries: list) -> bool:
    if not grid_geometries:
        return False
    geometry = record.get("geom_geojson") or record.get("geometry")
    if not geometry:
        return False
    return any(_geometry_within_task_grid(grid, geometry) for grid in grid_geometries)


def _flatten_positions(geometry: Any) -> list:
    positions = []

    def walk(node):
        if (
            isinstance(node, (list, tuple))
            and len(node) >= 2
            and isinstance(node[0], (int, float))
            and isinstance(node[1], (int, float))
        ):
            positions.append((round(float(node[0]), 9), round(float(node[1]), 9)))
        elif isinstance(node, (list, tuple)):
            for child in node:
                walk(child)

    walk((geometry or {}).get("coordinates"))
    return positions


def _changed_vertices_outside_grids(new_geometry: Any, old_geometry: Any, grid_geometries: list) -> list:
    """Vertices added or moved must lie inside one of the collector's assigned grids.

    Unchanged vertices keep their position even when the feature straddles two grids:
    a collector editing the part inside their grid may not move vertices that belong
    to the neighbour's grid.
    """
    from collections import Counter

    old_counter = Counter(_flatten_positions(old_geometry))
    outside = []
    for x, y in _flatten_positions(new_geometry):
        key = (x, y)
        if old_counter.get(key):
            old_counter[key] -= 1
            continue
        if not any(_point_in_task_geometry(x, y, grid) for grid in grid_geometries):
            outside.append([x, y])
    return outside


def _resolve_collector_grid(
    project_id: Any,
    user: Optional[Dict[str, Any]],
    geometry: Any,
    layer_id: Any = None,
):
    """Enforces the field rules for a DataCollector's assigned grid(s).

    Returns `(task, error_message)`. Admins/validators are never grid-restricted, and
    a project without task grids yet stays open (surveying before tasking). A grid may
    hold several collectors; each collector is restricted to their assigned layer
    scope, so two collectors never write the same layer in the same grid.
    """
    role = str((user or {}).get("role") or "")
    grids = _project_task_grids(project_id)

    if role not in FIELD_ROLES:
        for task in grids:
            if _geometry_within_task_grid(task.get("geometry"), geometry):
                return task, None
        return None, None

    if not grids:
        return None, None

    user_id = (user or {}).get("id")
    assigned = [task for task in grids if str(user_id) in _task_assignee_ids(task)]
    if role == "Validator" and not assigned:
        # A validator without grid assignments validates across the project.
        for task in grids:
            if _geometry_within_task_grid(task.get("geometry"), geometry):
                return task, None
        return None, None
    if not assigned:
        return None, (
            "तपाईंलाई यो परियोजनामा कुनै कार्यक्षेत्र (ग्रिड) तोकिएको छैन। "
            "(No task grid is assigned to you in this project.)"
        )

    for task in assigned:
        scope = _task_layer_scope(task, user_id)
        if layer_id is not None and scope is not None and str(layer_id) not in scope:
            continue
        if _geometry_within_task_grid(task.get("geometry"), geometry):
            return task, None
    return None, (
        "यो फिचर तपाईंको तोकिएको कार्यक्षेत्र (ग्रिड) र तह-सीमा भित्र पर्दैन। "
        "(The submitted geometry is outside your assigned task grid or layer scope.)"
    )


def _enforce_vertex_grid_rules(
    project_id: Any,
    user: Optional[Dict[str, Any]],
    layer_id: Any,
    old_geometry: Any,
    new_geometry: Any,
) -> None:
    """Only vertices inside the collector's assigned grid(s) may be added/moved."""
    role = _actor_role(user)
    if role not in FIELD_ROLES:
        return
    grids = _project_task_grids(project_id)
    if not grids:
        return
    user_id = (user or {}).get("id")
    all_assigned_tasks = [task for task in grids if str(user_id) in _task_assignee_ids(task)]
    if role == "Validator" and not all_assigned_tasks:
        # Project-wide validator with no grid assignments
        return
    assigned_geoms = []
    for task in all_assigned_tasks:
        scope = _task_layer_scope(task, user_id)
        if scope is not None and str(layer_id) not in scope:
            continue
        assigned_geoms.append(task.get("geometry"))
    if not assigned_geoms:
        raise HTTPException(
            status_code=403,
            detail="यो तह तपाईंको तोकिएको ग्रिड/तह-सीमामा छैन। (This layer is outside your assigned grid scope.)",
        )
    outside = _changed_vertices_outside_grids(new_geometry, old_geometry, assigned_geoms)
    if outside:
        sample = ", ".join(f"({x}, {y})" for x, y in outside[:3])
        raise HTTPException(
            status_code=403,
            detail=(
                f"तपाईंले आफ्नो ग्रिडभित्रका शीर्षबिन्दु मात्र सम्पादन गर्न सक्नुहुन्छ — {len(outside)} शीर्षबिन्दु बाहिर छन्। "
                f"(You may only edit vertices inside your assigned grid; {len(outside)} changed vertex/vertices are outside: {sample}.)"
            ),
        )


def _enforce_layer_scope_for_grid(project_id: Any, user: Optional[Dict[str, Any]], layer_id: Any, geometry: Any) -> None:
    role = _actor_role(user)
    if role not in FIELD_ROLES:
        return
    grids = _project_task_grids(project_id)
    if not grids:
        return
    user_id = (user or {}).get("id")
    assigned = [task for task in grids if str(user_id) in _task_assignee_ids(task)]
    if role == "Validator" and not assigned:
        return
    for task in grids:
        if str(user_id) not in _task_assignee_ids(task) or not _geometry_within_task_grid(task.get("geometry"), geometry):
            continue
        scope = _task_layer_scope(task, user_id)
        if scope is not None and str(layer_id) not in scope:
            raise HTTPException(
                status_code=403,
                detail="यो ग्रिडमा तपाईंलाई यो तह संकलन/सम्पादन गर्न तोकिएको छैन। "
                       "(You are not assigned to collect this layer in this grid.)",
            )
        return


def _resolve_record_layer(project_id: Any, payload: Dict[str, Any], questionnaire_id: Any) -> Dict[str, Any]:
    """Resolves the vector layer a survey record belongs to — never guesses a fallback."""
    layers = [layer for layer in STATE.get("vector_layers", []) if not layer.get("deleted_at")]
    raw_layer_id = payload.get("layer_id")

    if raw_layer_id is not None:
        layer = next((item for item in layers if str(item.get("id")) == str(raw_layer_id)), None)
        if layer is None:
            _load_persistent_state()
            layers = [item for item in STATE.get("vector_layers", []) if not item.get("deleted_at")]
            layer = next((item for item in layers if str(item.get("id")) == str(raw_layer_id)), None)
        if layer is None:
            raise HTTPException(
                status_code=400,
                detail="चयन गरिएको भेक्टर तह भेटिएन। (The selected vector layer was not found.)",
            )
        layer_project_id = layer.get("project_id")
        rec = _get_or_create_project_assignment(project_id) if project_id is not None else {}
        assigned_ids = {str(x) for x in (rec.get("assigned_layer_ids") or [])}
        is_assigned = str(layer.get("id")) in assigned_ids
        if layer_project_id not in (None, "") and str(layer_project_id) != str(project_id) and not is_assigned:
            raise HTTPException(
                status_code=400,
                detail="यो भेक्टर तह अर्को परियोजनाको हो। (This vector layer belongs to another project.)",
            )
        linked_questionnaire = layer.get("questionnaire_id")
        if questionnaire_id is not None and linked_questionnaire not in (None, questionnaire_id):
            raise HTTPException(
                status_code=400,
                detail="यो भेक्टर तह अर्को प्रश्नावलीसँग जोडिएको छ। (This layer is linked to a different questionnaire.)",
            )
        return layer

    if questionnaire_id is not None:
        questionnaire = next(
            (q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(questionnaire_id)),
            None,
        )
        if questionnaire is None:
            _load_persistent_state()
            questionnaire = next(
                (q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(questionnaire_id)),
                None,
            )
        if questionnaire is None:
            raise HTTPException(status_code=400, detail="प्रश्नावली भेटिएन। (Questionnaire not found.)")
        q_proj = questionnaire.get("project_id")
        if q_proj not in (None, "", 0, "0") and str(q_proj) != str(project_id):
            raise HTTPException(
                status_code=400,
                detail="यो प्रश्नावली अर्को परियोजनाको हो। (This questionnaire belongs to another project.)",
            )
        layer = next(
            (item for item in layers if str(item.get("questionnaire_id")) == str(questionnaire_id)),
            None,
        )
        if layer is not None:
            return layer
        raise HTTPException(
            status_code=400,
            detail="यो प्रश्नावली कुनै भेक्टर तहसँग जोडिएको छैन। पहिले तह जोड्नुहोस्। "
                   "(This questionnaire is not linked to a vector layer — link one first.)",
        )

    raise HTTPException(
        status_code=400,
        detail="प्रश्नावली वा भेक्टर तह निर्दिष्ट गर्नुहोस्। (A questionnaire or vector layer is required.)",
    )


def _questionnaire_fields_config(questionnaire: Dict[str, Any], existing_fields: Any = None) -> list:
    """Derives a layer field schema from the questionnaire questions (link-time sync)."""
    schema = questionnaire.get("schema_definition") or {}
    questions = schema.get("questions") or []
    existing_by_name = {
        str(field.get("name")): field
        for field in (existing_fields or [])
        if isinstance(field, dict) and field.get("name")
    }
    fields = []
    for index, question in enumerate(questions):
        if not isinstance(question, dict):
            continue
        name = question.get("name") or question.get("id")
        if not name:
            continue
        previous = existing_by_name.get(str(name)) or {}
        fields.append({
            "name": str(name),
            "label": question.get("label") or question.get("label_en") or str(name),
            "label_ne": question.get("label_ne") or "",
            "type": FIELD_TYPE_MAP.get(str(question.get("type") or ""), "text"),
            "required": bool(question.get("required")),
            "options": question.get("options") or [],
            "section_id": question.get("section_id"),
            "order": index,
            "visible_in_popup": previous.get("visible_in_popup", True),
            **(
                {"editable_roles": previous["editable_roles"]}
                if isinstance(previous.get("editable_roles"), list)
                else {}
            ),
            **(
                {"access_level": previous["access_level"]}
                if previous.get("access_level") in PORTAL_ACCESS_LEVELS
                else {}
            ),
        })
    return fields


def _merge_questionnaire_fields(questionnaire: Dict[str, Any], existing_fields: Any = None) -> list:
    """Questionnaire questions first, then the layer's own extra attributes."""
    previous = [field for field in (existing_fields or []) if isinstance(field, dict)]
    derived = _questionnaire_fields_config(questionnaire, previous)
    derived_names = {str(field.get("name")) for field in derived}
    return derived + [
        field for field in previous
        if str(field.get("name")) not in derived_names
    ]


def _upsert_record_feature(
    layer: Dict[str, Any],
    record: Dict[str, Any],
    answers: Dict[str, Any],
    geometry: Any,
    user: Optional[Dict[str, Any]],
    task: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Creates or updates the vector feature that carries a submitted survey (idempotent)."""
    layer_id = layer.get("id")
    record_code = record.get("record_id")
    features = list(get_layer_features_list(layer_id))

    existing = next(
        (
            feature
            for feature in features
            if str((feature.get("properties") or {}).get("_record_id")) == str(record_code)
        ),
        None,
    )

    properties = {
        **answers,
        "_record_id": record_code,
        "_questionnaire_id": record.get("questionnaire_id"),
        "_layer_id": layer_id,
        "_status": record.get("status", "SUBMITTED"),
        "_task_grid_id": task.get("id") if task else None,
        "_created_by": (user or {}).get("id") if existing is None else (existing.get("properties") or {}).get("_created_by"),
        "_created_by_username": (
            (user or {}).get("username")
            if existing is None
            else (existing.get("properties") or {}).get("_created_by_username")
        ) or "unknown",
        "_updated_by": (user or {}).get("id"),
        "_updated_by_username": (user or {}).get("username") or "unknown",
        "_updated_at": time.time(),
    }

    if existing is None:
        feature = {
            "type": "Feature",
            "id": record_code,
            "geometry": geometry,
            "properties": {**properties, "_id": record_code, "_created_at": time.time()},
        }
        try:
            add_feature_to_spatial_index(str(layer_id), feature)
            current_count = layer.get("feature_count")
            if current_count is not None and isinstance(current_count, int):
                layer["feature_count"] = current_count + 1
            else:
                layer["feature_count"] = get_layer_feature_count(str(layer_id))
        except Exception as add_err:
            print(f"[SPATIAL-ENGINE] Error adding survey record feature to spatial index: {add_err}")
    else:
        existing["geometry"] = geometry
        existing["properties"] = {**(existing.get("properties") or {}), **properties}
        feature = existing
        try:
            update_feature_in_spatial_index(str(layer_id), record_code, geometry, feature["properties"])
        except Exception as upd_err:
            print(f"[SPATIAL-ENGINE] Error updating survey record feature in spatial index: {upd_err}")

    # Maintain in-memory feature list only if already loaded in memory
    in_mem = STATE.get("features_by_layer", {}).get(layer_id) or STATE.get("features_by_layer", {}).get(str(layer_id))
    if in_mem is not None and isinstance(in_mem, list) and len(in_mem) > 0:
        if existing is None:
            in_mem.append(feature)
        else:
            for idx, f in enumerate(in_mem):
                if str(f.get("id") or (f.get("properties") or {}).get("_record_id")) == str(record_code):
                    in_mem[idx] = feature
                    break

    invalidate_mvt_cache_for_layer(str(layer_id))
    _save_persistent_state()
    return feature


async def _sync_record_feature_to_postgis(
    layer: Dict[str, Any],
    feature: Dict[str, Any],
    user: Optional[Dict[str, Any]],
) -> None:
    """Persists a survey record's GeoJSON feature into PostGIS vector_features when layer is PostGIS-backed."""
    layer_id = layer.get("id")
    if not await _is_postgis_layer(layer_id):
        return
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    props = dict(feature.get("properties") or {})
    rec_code = str(props.get("_record_id") or feature.get("id") or "")[:64]
    geom_json = json.dumps(feature.get("geometry") or {})
    props_json = json.dumps(props)
    uid = (user or {}).get("id")
    engine = get_engine()
    async with engine.begin() as conn:
        existing_row = (
            await conn.execute(
                text("SELECT id FROM vector_features WHERE layer_id = :lid AND record_id = :rec_id LIMIT 1;"),
                {"lid": pg_lid, "rec_id": rec_code},
            )
        ).fetchone()
        if existing_row:
            await conn.execute(
                text("""
                    UPDATE vector_features
                    SET geom = ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326),
                        properties = properties || CAST(:props AS jsonb),
                        updated_by = :uid,
                        version = version + 1
                    WHERE id = :db_id;
                """),
                {"geom_json": geom_json, "props": props_json, "uid": uid, "db_id": existing_row.id},
            )
            db_id = existing_row.id
        else:
            db_id = (
                await conn.execute(
                    text("""
                        INSERT INTO vector_features (record_id, layer_id, geom, properties, version, valid_from, created_by)
                        VALUES (:rec_id, :lid, ST_SetSRID(ST_GeomFromGeoJSON(:geom_json), 4326), CAST(:props AS jsonb), 1, NOW(), :uid)
                        RETURNING id;
                    """),
                    {"rec_id": rec_code, "lid": pg_lid, "geom_json": geom_json, "props": props_json, "uid": uid},
                )
            ).scalar()
        count_res = await conn.execute(
            text("SELECT count(*) FROM vector_features WHERE layer_id = :lid;"),
            {"lid": pg_lid},
        )
        layer["feature_count"] = count_res.scalar() or 0
    if db_id is not None:
        feature["id"] = db_id
        feature.setdefault("properties", {})["_id"] = db_id
    _drop_layer_feature_index(layer_id)
    invalidate_spatial_index(layer_id)


def _evaluate_skip_condition(cond: Dict[str, Any], answers: Dict[str, Any], q_id_to_name: Dict[str, str]) -> bool:
    if not isinstance(cond, dict):
        return True
    ref = str(
        cond.get("source_question_id")
        or cond.get("question_id")
        or cond.get("field")
        or cond.get("source_field")
        or ""
    ).strip()
    if not ref:
        return True
    key = q_id_to_name.get(ref, ref)
    actual = answers.get(key)
    if actual is None and ref != key:
        actual = answers.get(ref)
    op = str(cond.get("operator") or cond.get("op") or "equals").strip().lower()
    expected = cond.get("value")

    if op in ("is_empty", "empty"):
        return actual in (None, "", [], {})
    if op in ("is_not_empty", "not_empty"):
        return actual not in (None, "", [], {})
    if op in ("equals", "==", "eq"):
        if isinstance(actual, list):
            return str(expected) in {str(x) for x in actual}
        return str(actual).strip().lower() == str(expected).strip().lower() if actual is not None else False
    if op in ("not_equals", "!=", "neq"):
        if isinstance(actual, list):
            return str(expected) not in {str(x) for x in actual}
        return str(actual).strip().lower() != str(expected).strip().lower() if actual is not None else True
    if op == "in":
        vals = expected if isinstance(expected, list) else [expected]
        norm_vals = {str(v).strip().lower() for v in vals}
        if isinstance(actual, list):
            return any(str(a).strip().lower() in norm_vals for a in actual)
        return actual is not None and str(actual).strip().lower() in norm_vals
    if op == "not_in":
        vals = expected if isinstance(expected, list) else [expected]
        norm_vals = {str(v).strip().lower() for v in vals}
        if isinstance(actual, list):
            return all(str(a).strip().lower() not in norm_vals for a in actual)
        return actual is None or str(actual).strip().lower() not in norm_vals
    if op == "contains":
        if isinstance(actual, list):
            return str(expected) in {str(x) for x in actual}
        return actual is not None and str(expected).lower() in str(actual).lower()
    try:
        a_num = float(actual)
        e_num = float(expected)
        if op in ("gt", ">"):
            return a_num > e_num
        if op in ("gte", ">="):
            return a_num >= e_num
        if op in ("lt", "<"):
            return a_num < e_num
        if op in ("lte", "<="):
            return a_num <= e_num
    except (TypeError, ValueError):
        return False
    return True


def _validate_record_answers_against_questionnaire(
    questionnaire: Optional[Dict[str, Any]],
    answers: Dict[str, Any],
) -> List[Dict[str, Any]]:
    """Evaluates conditional skip logic (show/hide/require) and required/type rules server-side."""
    if not isinstance(questionnaire, dict):
        return []
    schema = questionnaire.get("schema_definition") or {}
    sections = schema.get("sections") or []
    questions = schema.get("questions") or []
    section_index_map = {
        str(sec.get("id") or f"sec_{i + 1}"): i
        for i, sec in enumerate(sections)
        if isinstance(sec, dict)
    }
    q_id_to_name = {}
    for i, q in enumerate(questions):
        if isinstance(q, dict):
            qid = str(q.get("id") or f"q_{i + 1}")
            qname = str(q.get("name") or qid).strip()
            q_id_to_name[qid] = qname

    issues: List[Dict[str, Any]] = []
    for q_idx, q in enumerate(questions):
        if not isinstance(q, dict):
            continue
        q_id = q.get("id") or f"q_{q_idx + 1}"
        sec_id = q.get("section_id")
        sec_idx = section_index_map.get(str(sec_id), 0) if sec_id is not None else 0
        key_name = str(q.get("name") or q_id).strip()
        label = str(q.get("label_ne") or q.get("label") or key_name)

        raw_conds = q.get("conditions") or []
        if isinstance(raw_conds, dict):
            raw_conds = raw_conds.get("rules") or [raw_conds]
        conds = [c for c in raw_conds if isinstance(c, dict)] if isinstance(raw_conds, list) else []

        show_conds = [c for c in conds if str(c.get("action") or "show").lower() == "show"]
        hide_conds = [c for c in conds if str(c.get("action") or "").lower() == "hide"]
        require_conds = [c for c in conds if str(c.get("action") or "").lower() == "require"]

        visible = True
        if show_conds:
            visible = all(_evaluate_skip_condition(c, answers, q_id_to_name) for c in show_conds)
        if visible and hide_conds:
            if any(_evaluate_skip_condition(c, answers, q_id_to_name) for c in hide_conds):
                visible = False
        if not visible:
            continue

        is_required = bool(q.get("required"))
        if require_conds and any(_evaluate_skip_condition(c, answers, q_id_to_name) for c in require_conds):
            is_required = True

        val = answers.get(key_name)
        is_missing = val is None or (isinstance(val, str) and val.strip() == "") or (isinstance(val, list) and len(val) == 0)
        if is_required and is_missing:
            issues.append({
                "question_id": q_id,
                "question_index": q_idx,
                "section_id": sec_id,
                "section_index": sec_idx,
                "field": key_name,
                "message": f"'{label}' अनिवार्य फिल्ड हो। (Required field '{key_name}' is missing.)",
            })
            continue

        if is_missing:
            continue

        q_type = str(q.get("type") or "").lower()
        if q_type == "integer":
            try:
                if isinstance(val, bool) or int(str(val).strip()) != float(str(val).strip()):
                    raise ValueError("not integer")
            except (TypeError, ValueError):
                issues.append({
                    "question_id": q_id, "question_index": q_idx,
                    "section_id": sec_id, "section_index": sec_idx,
                    "field": key_name,
                    "message": f"'{label}' मा पूर्ण संख्या (integer) हुनुपर्छ। (Field '{key_name}' must be an integer.)",
                })
        elif q_type in ("decimal", "number"):
            try:
                if isinstance(val, bool):
                    raise ValueError("bool")
                float(str(val).strip())
            except (TypeError, ValueError):
                issues.append({
                    "question_id": q_id, "question_index": q_idx,
                    "section_id": sec_id, "section_index": sec_idx,
                    "field": key_name,
                    "message": f"'{label}' मा संख्या (number) हुनुपर्छ। (Field '{key_name}' must be numeric.)",
                })
        elif q_type in ("single_choice", "dropdown", "select"):
            opts = [str(o.get("value")) for o in (q.get("options") or []) if isinstance(o, dict) and o.get("value") is not None]
            if opts and str(val) not in opts:
                issues.append({
                    "question_id": q_id, "question_index": q_idx,
                    "section_id": sec_id, "section_index": sec_idx,
                    "field": key_name,
                    "message": f"'{label}' मा अवैध विकल्प '{val}' छ। (Invalid option for '{key_name}'.)",
                })
        elif q_type in ("multiple_choice", "multiselect"):
            opts = {str(o.get("value")) for o in (q.get("options") or []) if isinstance(o, dict) and o.get("value") is not None}
            vals = val if isinstance(val, list) else [val]
            if opts and any(str(v) not in opts for v in vals):
                issues.append({
                    "question_id": q_id, "question_index": q_idx,
                    "section_id": sec_id, "section_index": sec_idx,
                    "field": key_name,
                    "message": f"'{label}' मा अवैध विकल्प छ। (Invalid selection for '{key_name}'.)",
                })
    return issues


def _record_visible_in_grid_scope(record: Dict[str, Any], grid_scope: list, user: Dict[str, Any]) -> bool:
    """Allow users to view/resume their own geometry-less DRAFT records even when grid-scoped."""
    if (
        record.get("status") == "DRAFT"
        and str(record.get("created_by")) == str(user.get("id"))
        and not (record.get("geom_geojson") or record.get("geometry"))
    ):
        return True
    return _record_within_grids(record, grid_scope)


# ============================================================
# Survey Records & Feature Population Endpoints
# ============================================================

@app.get("/api/projects/{project_id}/records")
@app.get("/api/projects/{project_id}/records/my")
async def list_project_records(
    project_id: int,
    request: Request,
    status_filter: Optional[str] = None,
    collector_id: Optional[str] = None,
):
    user = _require_user(request)
    _require_project(project_id)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    records = [record for record in STATE.get("records", []) if str(record.get("project_id")) == str(project_id)]
    if request.url.path.endswith("/records/my"):
        records = [record for record in records if str(record.get("created_by")) == str(user.get("id"))]
    elif _actor_role(user) == "DataCollector":
        # A collector only sees their own submissions.
        records = [record for record in records if str(record.get("created_by")) == str(user.get("id"))]

    # Validators/collectors with explicit grid assignments see records inside them + own geometry-less drafts.
    grid_scope = _assigned_grid_geometries(project_id, user)
    if grid_scope is not None:
        records = [record for record in records if _record_visible_in_grid_scope(record, grid_scope, user)]
    if status_filter and status_filter != "ALL":
        records = [record for record in records if record.get("status") == status_filter]
    if collector_id and collector_id != "ALL":
        records = [record for record in records if str(record.get("created_by")) == str(collector_id)]
    return records


def _find_record(record_id: Any) -> Optional[Dict[str, Any]]:
    key = str(record_id)
    return next(
        (
            record
            for record in STATE.get("records", [])
            if str(record.get("id")) == key or str(record.get("record_id")) == key
        ),
        None,
    )


@app.get("/api/records/{record_id}")
async def get_record(record_id: Any, request: Request):
    user = _require_user(request)
    record = _find_record(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="रेकर्ड भेटिएन। (Record not found.)")
    if not _user_can_access_project(user, record.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")
    if _actor_role(user) == "DataCollector" and str(record.get("created_by")) != str(user.get("id")):
        raise HTTPException(status_code=403, detail="यो रेकर्ड तपाईंको होइन। (This record does not belong to you.)")
    grid_scope = _assigned_grid_geometries(record.get("project_id"), user)
    if grid_scope is not None and not _record_visible_in_grid_scope(record, grid_scope, user):
        raise HTTPException(status_code=403, detail="यो रेकर्ड तपाईंको तोकिएको ग्रिडभित्र छैन। (This record is outside your assigned grid.)")
    return record


@app.put("/api/records/{record_id}")
async def update_record(record_id: Any, payload: Dict[str, Any], request: Request):
    user = _require_user(request)
    record = _find_record(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="रेकर्ड भेटिएन। (Record not found.)")
    project_id = record.get("project_id")
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजनामा पहुँच छैन। (You do not have access to this project.)")

    role = _actor_role(user)
    is_owner = str(record.get("created_by")) == str(user.get("id"))
    if not _is_admin_user(user):
        if role == "DataCollector" and not is_owner:
            raise HTTPException(status_code=403, detail="अर्को संकलकको रेकर्ड परिमार्जन गर्न अधिकार छैन। (You cannot edit another collector's record.)")
        if role not in ("DataCollector", "Validator"):
            raise HTTPException(status_code=403, detail="यो रेकर्ड परिमार्जन गर्न अधिकार छैन। (Not authorized to edit this record.)")

    requested_status = str(payload.get("status") or record.get("status") or "DRAFT").upper()
    current_status = str(record.get("status") or "DRAFT").upper()
    if current_status in ("SUBMITTED", "APPROVED") and requested_status == "DRAFT":
        raise HTTPException(
            status_code=409,
            detail="पेश भइसकेको वा स्वीकृत रेकर्डलाई DRAFT मा फर्काउन मिल्दैन। (Cannot downgrade a SUBMITTED or APPROVED record to DRAFT.)",
        )

    layer = _find_vector_layer(record.get("layer_id"))
    if layer is not None:
        _enforce_layer_write_access(layer, user)

    new_geometry = payload.get("geom_geojson") if "geom_geojson" in payload else payload.get("geometry")
    effective_geometry = new_geometry if new_geometry is not None else (record.get("geom_geojson") or record.get("geometry"))
    task = None
    if effective_geometry:
        task, grid_error = _resolve_collector_grid(project_id, user, effective_geometry, record.get("layer_id"))
        if grid_error:
            raise HTTPException(status_code=403, detail=grid_error)
        if new_geometry is not None:
            _enforce_vertex_grid_rules(project_id, user, record.get("layer_id"), record.get("geom_geojson") or {}, new_geometry)
            _enforce_layer_scope_for_grid(project_id, user, record.get("layer_id"), new_geometry)

    answers = dict(record.get("answers") or {})
    if "answers" in payload and isinstance(payload.get("answers"), dict):
        cleaned = _clean_record_answers(payload.get("answers"))
        if layer is not None:
            _enforce_field_entry_permissions(layer, user, cleaned, effective_geometry, existing=answers)
        answers.update(cleaned)

    if requested_status == "SUBMITTED" and record.get("questionnaire_id") is not None:
        q_obj = next((q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(record.get("questionnaire_id"))), None)
        issues = _validate_record_answers_against_questionnaire(q_obj, answers)
        if issues:
            return JSONResponse(status_code=422, content={"detail": issues[0]["message"], "issues": issues})

    record["answers"] = answers
    if new_geometry is not None:
        record["geom_geojson"] = new_geometry
    record["status"] = requested_status
    if task:
        record["task_grid_id"] = task.get("id")
    record["updated_at"] = time.time()
    record["updated_by"] = user.get("id")

    feature = None
    if layer is not None and effective_geometry and requested_status != "DRAFT":
        feature = _upsert_record_feature(layer, record, answers, effective_geometry, user, task)
        await _sync_record_feature_to_postgis(layer, feature, user)

    _record_audit_entry(
        record.get("layer_id"),
        "RECORD_UPDATE",
        user,
        feature_id=feature.get("id") if feature else record.get("feature_id"),
        details={"record_id": record.get("record_id"), "status": requested_status},
    )
    _save_persistent_state(sync=True)
    return {**record, "feature_id": feature.get("id") if feature else record.get("feature_id")}


@app.put("/api/records/{record_id}/review")
async def review_record(record_id: Any, payload: Dict[str, Any], request: Request):
    """Validator QA decision: keeps the survey record and its spatial feature in sync."""
    user = _require_user(request)
    record = _find_record(record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="रेकर्ड भेटिएन। (Record not found.)")

    status = str(payload.get("status") or "").upper()
    if status in ("VALIDATED", "ACCEPTED", "APPROVE"):
        status = "APPROVED"
    elif status in ("INVALIDATED", "REJECTED", "RETURN"):
        status = "RETURNED"
    if status not in ("APPROVED", "RETURNED"):
        raise HTTPException(
            status_code=400,
            detail="समीक्षा स्थिति APPROVED वा RETURNED हुनुपर्छ। (Review status must be APPROVED or RETURNED.)",
        )

    user = _require_user(request)
    if _actor_role(user) not in REVIEW_ADMIN_ROLES + ("Validator",):
        raise HTTPException(
            status_code=403,
            detail="समीक्षा गर्न Validator वा प्रशासक अधिकार आवश्यक छ। (Only a Validator or administrator can review records.)",
        )
    if not _user_can_access_project(user, record.get("project_id")):
        raise HTTPException(status_code=403, detail="यो परियोजना तपाईंसँग जोडिएको छैन। (This project is not linked to your account.)")

    review_layer = next(
        (item for item in STATE.get("vector_layers", []) if str(item.get("id")) == str(record.get("layer_id"))),
        None,
    )
    if review_layer is None:
        raise HTTPException(status_code=400, detail="रेकर्डसँग जोडिएको तह भेटिएन। (The record's linked layer was not found.)")
    review_project = _find_project(record.get("project_id"))
    if _actor_role(user) == "Validator" and not _project_layer_is_editable(review_project, review_layer, user):
        raise HTTPException(
            status_code=403,
            detail="यो तह प्रमाणीकरण/सम्पादनका लागि खुला गरिएको छैन। (This layer is not unlocked for validation/editing.)",
        )
    grid_scope = _assigned_grid_geometries(record.get("project_id"), user)
    if grid_scope is not None and not _record_within_grids(record, grid_scope):
        raise HTTPException(status_code=403, detail="यो रेकर्ड तपाईंको तोकिएको ग्रिडभित्र छैन। (This record is outside your assigned grid.)")

    record["status"] = status
    record["review_status"] = status
    record["reviewer_notes"] = payload.get("reviewer_notes") or payload.get("comment") or ""
    record["reviewed_by"] = user.get("id")
    record["reviewed_by_username"] = user.get("username") or "unknown"
    record["reviewed_at"] = time.time()

    # Keep the linked vector feature's QA status visible on the map.
    layer = next(
        (item for item in STATE.get("vector_layers", []) if str(item.get("id")) == str(record.get("layer_id"))),
        None,
    )
    if layer is not None:
        for feature in get_layer_features_list(layer.get("id")):
            if str((feature.get("properties") or {}).get("_record_id")) == str(record.get("record_id")):
                feature["properties"]["_status"] = status
                feature["properties"]["_review_notes"] = record["reviewer_notes"]
                invalidate_spatial_index(layer.get("id"))
                break

    _record_audit_entry(
        record.get("layer_id"),
        f"REVIEW_{status}",
        user,
        feature_id=record.get("feature_id"),
        details={"record_id": record.get("record_id"), "notes": record["reviewer_notes"]},
    )
    _save_persistent_state()
    return record


@app.get("/api/projects/{project_id}/records/export")
async def export_project_records(project_id: int, request: Request, include_drafts: bool = False):
    user = _require_user(request)
    if _actor_role(user) == "DataCollector":
        raise HTTPException(status_code=403, detail="डाउनलोड गर्न प्रमाणक वा प्रशासक अधिकार आवश्यक छ। (Validator or administrator role required to export.)")
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजना तपाईंसँग जोडिएको छैन। (This project is not linked to your account.)")
    recs = [
        r for r in STATE.get("records", [])
        if str(r.get("project_id")) == str(project_id)
        and (include_drafts or str(r.get("status") or "").upper() != "DRAFT")
    ]
    grid_scope = _assigned_grid_geometries(project_id, user)
    if grid_scope is not None:
        recs = [r for r in recs if _record_within_grids(r, grid_scope)]
    features = []
    for r in recs:
        geom = r.get("geom_geojson") or r.get("geometry") or {}
        if geom:
            features.append({
                "type": "Feature",
                "id": r.get("id"),
                "geometry": geom,
                "properties": {
                    **(r.get("answers") or {}),
                    "_record_id": r.get("record_id"),
                    "_status": r.get("status", "SUBMITTED"),
                },
            })
    return {"type": "FeatureCollection", "features": features}


@app.post("/api/projects/{project_id}/records/submit")
@app.post("/api/projects/{project_id}/records/draft")
async def submit_or_draft_record(project_id: int, payload: Dict[str, Any], request: Request):
    """Persists a survey record and, on submit, the linked vector feature.

    Field-collection rules enforced here (not only in the browser):
      1. The questionnaire must be bound to a concrete vector layer — no silent
         fallback to "some layer of the project" or the first layer in the database.
      2. A DataCollector may only submit inside a task grid assigned to them; the
         grid id is stamped onto both the record and the feature.
      3. Identity comes from the bearer token, so records/features are attributed to
         the real collector instead of the bootstrap administrator.
      4. Draft -> submit is idempotent: one record per `record_id`, one feature per
         record, so autosave and re-submission never duplicate municipal data.
    """
    is_submit = request.url.path.endswith("/submit")
    user = _require_user(request)
    if not _user_can_access_project(user, project_id):
        raise HTTPException(status_code=403, detail="यो परियोजना तपाईंसँग जोडिएको छैन। (This project is not linked to your account.)")
    questionnaire_id = payload.get("questionnaire_id")
    layer = _resolve_record_layer(project_id, payload, questionnaire_id)
    if (
        project_id is not None
        and layer.get("project_id") is not None
        and str(layer.get("project_id")) != str(project_id)
    ):
        raise HTTPException(status_code=400, detail="यो तह छानिएको परियोजनासँग जोडिएको छैन। (This layer does not belong to the selected project.)")
    _enforce_layer_write_access(layer, user)

    geometry = payload.get("geom_geojson") or payload.get("geometry")
    answers = _clean_record_answers(payload.get("answers"))

    project_scope = project_id if project_id is not None else "GLOBAL"
    record_code = payload.get("record_id") or f"KMC-REC-{project_scope}-{int(time.time() * 1000)}"
    existing_feature = next(
        (
            feature
            for feature in get_layer_features_list(layer.get("id"))
            if str((feature.get("properties") or {}).get("_record_id")) == str(record_code)
        ),
        None,
    )
    _enforce_field_entry_permissions(
        layer,
        user,
        answers,
        geometry,
        existing=(existing_feature or {}).get("properties") if existing_feature else None,
    )

    if is_submit and not geometry:
        raise HTTPException(
            status_code=400,
            detail="सर्वेक्षण बुझाउन ज्यामिति (geometry) आवश्यक छ। (A geometry is required to submit a survey.)",
        )

    if is_submit and questionnaire_id is not None:
        q_obj = next(
            (q for q in STATE.get("questionnaires", []) if str(q.get("id")) == str(questionnaire_id)),
            None,
        )
        validation_issues = _validate_record_answers_against_questionnaire(q_obj, answers)
        if validation_issues:
            return JSONResponse(
                status_code=422,
                content={"detail": validation_issues[0]["message"], "issues": validation_issues},
            )

    # Validate the optional feature link before any record/feature is persisted so
    # a rejected pairing never leaves an orphan survey feature behind.
    link_info = payload.get("link_to")
    prepared_link = None
    if is_submit and link_info:
        prepared_link = await _prepare_feature_link_async(
            {"id": record_code, "geometry": geometry, "properties": {**answers, "_id": record_code}},
            layer.get("id"),
            link_info,
            user,
        )

    task = None
    if geometry:
        task, grid_error = _resolve_collector_grid(project_id, user, geometry, layer.get("id"))
        if grid_error and is_submit:
            raise HTTPException(status_code=403, detail=grid_error)
        if is_submit:
            _enforce_vertex_grid_rules(project_id, user, layer.get("id"), {}, geometry)
            _enforce_layer_scope_for_grid(project_id, user, layer.get("id"), geometry)

    now = time.time()

    record = {
        "id": payload.get("id") or int(now * 1000),
        "record_id": record_code,
        "project_id": project_id,
        "layer_id": layer.get("id"),
        "questionnaire_id": questionnaire_id,
        "task_grid_id": task.get("id") if task else None,
        "status": "SUBMITTED" if is_submit else "DRAFT",
        "geom_geojson": geometry,
        "geometry_type": payload.get("geometry_type") or (geometry or {}).get("type") or "POINT",
        "answers": answers,
        "repeat_data": payload.get("repeat_data") or {},
        "calculated_values": payload.get("calculated_values") or {},
        "media_refs": payload.get("media_refs") or [],
        "completion_percentage": 100.0 if is_submit else payload.get("completion_percentage", 50.0),
        "created_by": user.get("id"),
        "created_by_username": user.get("username") or "unknown",
        "collector_id": user.get("id"),
        "collector_username": user.get("username") or "unknown",
        "collector_name": user.get("full_name") or user.get("username") or "unknown",
        "review_status": None,
        "reviewer_notes": "",
        "created_at": now,
        "updated_at": now,
        "submitted_at": now if is_submit else None,
    }

    STATE.setdefault("records", [])
    existing_record = next(
        (item for item in STATE["records"] if str(item.get("record_id")) == str(record_code)),
        None,
    )
    if existing_record is not None:
        existing_status = str(existing_record.get("status") or "").upper()
        if not is_submit and existing_status in ("SUBMITTED", "APPROVED"):
            raise HTTPException(
                status_code=409,
                detail="पेश भइसकेको वा स्वीकृत रेकर्डलाई DRAFT मा फर्काउन मिल्दैन। (Cannot downgrade a SUBMITTED or APPROVED record to DRAFT.)",
            )
        is_owner = str(existing_record.get("created_by")) == str(user.get("id"))
        is_validator = _actor_role(user) == "Validator"
        if not is_owner and not _is_admin_user(user) and not is_validator:
            raise HTTPException(
                status_code=403,
                detail="अर्को संकलकको रेकर्ड परिमार्जन गर्न अधिकार छैन। (You cannot overwrite another collector's record.)",
            )
        if is_validator and not is_owner:
            v_grid_scope = _assigned_grid_geometries(project_id, user)
            if v_grid_scope is not None and not _record_within_grids(existing_record, v_grid_scope):
                raise HTTPException(
                    status_code=403,
                    detail="यो रेकर्ड तपाईंको तोकिएको ग्रिडभित्र छैन। (This record is outside your assigned grid.)",
                )
        # Preserve the original authorship/timestamps; this is the same survey.
        record["id"] = existing_record.get("id") or record["id"]
        record["created_at"] = existing_record.get("created_at") or record["created_at"]
        record["created_by"] = existing_record.get("created_by") or record["created_by"]
        record["created_by_username"] = existing_record.get("created_by_username") or record["created_by_username"]
        record["collector_id"] = existing_record.get("collector_id") or record["collector_id"]
        record["collector_username"] = existing_record.get("collector_username") or record["collector_username"]
        record["collector_name"] = existing_record.get("collector_name") or record["collector_name"]
        record["submitted_at"] = record["submitted_at"] or existing_record.get("submitted_at")
        STATE["records"] = [record if item is existing_record else item for item in STATE["records"]]
    else:
        STATE["records"].insert(0, record)

    feature = None
    if is_submit and geometry:
        feature = _upsert_record_feature(layer, record, answers, geometry, user, task)
        await _sync_record_feature_to_postgis(layer, feature, user)
        if prepared_link:
            prepared_link["link"]["source_feature_id"] = feature.get("id")
            _apply_prepared_feature_link(feature, prepared_link)
            await _sync_record_feature_to_postgis(layer, feature, user)
            if prepared_link.get("target_is_postgis") and prepared_link.get("target_db_id"):
                await _update_postgis_feature(
                    prepared_link["link"]["target_layer_id"],
                    prepared_link["target_db_id"],
                    None,
                    prepared_link["target_feature"].get("properties") or {},
                    user=user,
                )

    _record_audit_entry(
        layer.get("id"),
        "SUBMIT" if is_submit else "DRAFT",
        user,
        feature_id=feature.get("id") if feature else None,
        details={
            "record_id": record.get("record_id"),
            "task_grid_id": task.get("id") if task else None,
            "field_count": len(answers),
        },
    )
    _save_persistent_state(sync=True)
    return {**record, "feature_id": feature.get("id") if feature else None}


@app.post("/api/records/submit")
@app.post("/api/records/draft")
async def submit_or_draft_global_record(payload: Dict[str, Any], request: Request):
    """Record endpoint supporting both global and project-scoped submissions."""
    proj_id = payload.get("project_id")
    return await submit_or_draft_record(proj_id, payload, request)


# OGC API - Features bridge used by QGIS (per-layer collections + Toggle Editing).
# Imported last so the router can reuse every helper defined in this module.
from .ogc_features import router as ogc_features_router  # noqa: E402

app.include_router(ogc_features_router)