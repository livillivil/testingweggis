"""OGC API - Features for KMC-GIS-SERVER (QGIS editing bridge).

Every vector layer is published as its own collection so survey staff can load
layers individually in QGIS, enable Toggle Editing, and have each save written
straight into the authoritative app store. Reads and writes reuse the exact
same permission checks, field-entry rules, task-grid enforcement, audit log and
debounced persistence as the REST API -- there is no second copy of the data.

Protocol coverage:
  * OGC API - Features Part 1 (core, GeoJSON, collections, items, paging)
  * OGC API - Features Part 4 (create / replace / update / delete)

Authentication: HTTP Basic with the user's KMC app username + password (QGIS
prompts for it), or the app's HMAC Bearer token. A 401 always carries a Basic
challenge so QGIS opens its credential dialog instead of reporting an opaque
"host requires authentication" failure.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import text

from .config import settings

router = APIRouter(prefix="/ogc", tags=["OGC API - Features"])

CRS84 = "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
DEFAULT_BBOX = [85.31, 27.682, 85.345, 27.702]
DEFAULT_PAGE_SIZE = 1000
MAX_PAGE_SIZE = 10000

_HOST_DISALLOWED_RE = re.compile(r"[\x00-\x1f\x7f\s/\\?#@]+")

CONFORMANCE_CLASSES = [
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/landing-page",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/json",
    "http://www.opengis.net/spec/ogcapi-common-1/1.0/conf/oas30",
    "http://www.opengis.net/spec/ogcapi-common-2/1.0/conf/collections",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30",
    "http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson",
    "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/create-replace-delete",
    "http://www.opengis.net/spec/ogcapi-features-4/1.0/conf/features",
]


def kmc():
    """Late import so this module never creates an import cycle with main."""
    from . import main

    return main


def _auth_challenge() -> HTTPException:
    return HTTPException(
        status_code=401,
        detail="प्रमाणीकरण आवश्यक छ। (Authentication required.)",
        headers={"WWW-Authenticate": 'Basic realm="KMC-GIS OGC API", charset="UTF-8"'},
    )


def _basic_credentials(request: Request) -> Optional[tuple]:
    header = request.headers.get("authorization") or ""
    if not header.lower().startswith("basic "):
        return None
    try:
        decoded = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    username, separator, password = decoded.partition(":")
    if not separator or not username or not password:
        return None
    return username, password


def resolve_ogc_user(request: Request) -> Dict[str, Any]:
    """Authenticates a QGIS client by Bearer token or HTTP Basic credentials."""
    backend = kmc()
    user = backend.resolve_request_user(request)
    if user is not None:
        return user
    credentials = _basic_credentials(request)
    if credentials is None:
        raise _auth_challenge()
    username, password = credentials

    def _find_user() -> Optional[Dict[str, Any]]:
        return next(
            (
                entry
                for entry in backend.STATE.get("users", [])
                if str(entry.get("username", "")).lower() == username.lower()
            ),
            None,
        )

    candidate = _find_user()
    if (
        candidate is None
        or candidate.get("is_active") is False
        or not backend._verify_current_password(candidate, password)
    ):
        try:
            backend._load_persistent_state()
        except Exception:
            pass
        candidate = _find_user()

    if candidate is None or candidate.get("is_active") is False:
        raise _auth_challenge()
    if not backend._verify_current_password(candidate, password):
        raise _auth_challenge()
    return candidate


def _authenticated_request(request: Request, user: Dict[str, Any]) -> Request:
    """Re-uses the REST feature endpoints with the already-authenticated user.

    Those endpoints resolve the caller from the Bearer header, so the inbound
    request is cloned with a short-lived signed token for this user. Running the
    real endpoints (instead of copying their logic) keeps write permissions,
    task-grid checks, audit entries and persistence in one place.
    """
    backend = kmc()
    token = backend._issue_access_token(user.get("id"))
    headers = [(key, value) for key, value in request.headers.raw if key.lower() != b"authorization"]
    headers.append((b"authorization", f"Bearer {token}".encode("latin-1")))
    scope = dict(request.scope)
    scope["headers"] = headers
    return Request(scope)


def _sanitize_host(raw_host: str) -> str:
    return _HOST_DISALLOWED_RE.sub("", (raw_host or "").split(",")[0].strip())


def _external_base(request: Request) -> str:
    root_path = (request.scope.get("root_path") or "").rstrip("/")
    if settings.public_base_url:
        return f"{settings.public_base_url.rstrip('/')}{root_path}"

    proto = (request.headers.get("x-forwarded-proto") or request.url.scheme or "http").split(",")[0].strip().lower()
    if proto not in ("http", "https"):
        proto = "http"
    raw_host = request.headers.get("x-forwarded-host") or request.headers.get("host") or request.url.netloc or ""
    host = _sanitize_host(raw_host) or _sanitize_host(request.url.netloc or "") or "localhost"
    return f"{proto}://{host}{root_path}"


def _visible_layers(user: Dict[str, Any]) -> List[Dict[str, Any]]:
    backend = kmc()
    return [
        layer
        for layer in backend.STATE.get("vector_layers", [])
        if not layer.get("deleted_at") and backend._layer_visible_to_user(layer, user)
    ]


def _require_collection(collection_id: Any, user: Dict[str, Any]) -> Dict[str, Any]:
    for layer in _visible_layers(user):
        if str(layer.get("id")) == str(collection_id):
            return layer
    # A hidden collection and a missing one are indistinguishable on purpose.
    raise HTTPException(status_code=404, detail="Collection not found.")


async def _fetch_postgis_items_page(
    layer_id: Any,
    box: Optional[tuple],
    limit: int,
    offset: int,
) -> Optional[Tuple[List[Dict[str, Any]], int]]:
    """Queries a PostGIS-backed layer with optional bbox filter and pagination."""
    backend = kmc()
    pg_lid = int(str(layer_id)) if str(layer_id).isdigit() else layer_id
    where_clause = "WHERE layer_id = :lid"
    params: Dict[str, Any] = {"lid": pg_lid, "lim": limit, "off": offset}
    if box is not None:
        min_x, min_y, max_x, max_y = box
        where_clause += " AND ST_Intersects(geom, ST_MakeEnvelope(:min_x, :min_y, :max_x, :max_y, 4326))"
        params.update(min_x=min_x, min_y=min_y, max_x=max_x, max_y=max_y)

    try:
        engine = backend.get_engine()
        async with engine.connect() as conn:
            count_q = text(f"SELECT COUNT(*) FROM vector_features {where_clause};")
            total = int((await conn.execute(count_q, params)).scalar() or 0)

            page_q = text(
                f"""
                SELECT id, record_id, ST_AsGeoJSON(geom) AS geom_json, properties
                FROM vector_features
                {where_clause}
                ORDER BY id
                LIMIT :lim OFFSET :off;
                """
            )
            rows = (await conn.execute(page_q, params)).fetchall()
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
            return features, total
    except Exception:
        return None


async def _find_in_collection(layer: Dict[str, Any], feature_id: Any) -> Dict[str, Any]:
    backend = kmc()
    layer_id = layer.get("id")
    if await backend._is_postgis_layer(layer_id):
        matched = await backend._get_postgis_features_by_ids(layer_id, [feature_id])
        if matched:
            return matched[0]

    wanted = str(feature_id)
    for feature in backend.get_layer_features_list(layer_id):
        if str(feature.get("id")) == wanted:
            return feature
        if str((feature.get("properties") or {}).get("_id")) == wanted:
            return feature
    raise HTTPException(status_code=404, detail="Feature not found in this collection.")


def _collection_extent(layer: Dict[str, Any]) -> List[float]:
    bounds = layer.get("bounds") or DEFAULT_BBOX
    try:
        values = [float(value) for value in list(bounds)[:4]]
    except (TypeError, ValueError):
        return list(DEFAULT_BBOX)
    return values if len(values) == 4 else list(DEFAULT_BBOX)


def _collection_document(layer: Dict[str, Any], base: str) -> Dict[str, Any]:
    layer_id = str(layer.get("id"))
    return {
        "id": layer_id,
        "title": str(layer.get("name") or layer_id),
        "description": str(layer.get("description") or "KMC vector layer"),
        "itemType": "feature",
        "crs": [CRS84],
        "storageCrs": CRS84,
        "extent": {"spatial": {"bbox": [_collection_extent(layer)], "crs": CRS84}},
        "links": [
            {"href": f"{base}/ogc/collections/{layer_id}", "rel": "self", "type": "application/json", "title": "Collection metadata"},
            {"href": f"{base}/ogc/collections/{layer_id}/items", "rel": "items", "type": "application/geo+json", "title": "Features"},
        ],
    }


def _serialize_feature(layer: Dict[str, Any], feature: Dict[str, Any], user: Dict[str, Any], base: str) -> Dict[str, Any]:
    backend = kmc()
    cleaned = backend._clean_feature_properties_for_geojson(feature)
    if not backend._is_admin_user(user):
        filtered = backend._portal_filter_feature_properties(layer, user, [cleaned])
        cleaned = filtered[0] if filtered else {"type": "Feature", "id": feature.get("id"), "geometry": None, "properties": {}}
    layer_id = str(layer.get("id"))
    feature_id = str(cleaned.get("id"))
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": cleaned.get("geometry"),
        "properties": dict(cleaned.get("properties") or {}),
        "links": [
            {"href": f"{base}/ogc/collections/{layer_id}/items/{feature_id}", "rel": "self", "type": "application/geo+json", "title": "This feature"},
            {"href": f"{base}/ogc/collections/{layer_id}", "rel": "collection", "type": "application/json", "title": "Collection"},
        ],
    }


def _parse_bbox(raw: Optional[str]) -> Optional[tuple]:
    if not raw:
        return None
    try:
        values = [float(part) for part in str(raw).split(",") if part.strip() != ""]
    except ValueError:
        raise HTTPException(status_code=400, detail="bbox must be four comma-separated numbers.")
    if len(values) == 6:
        values = [values[0], values[1], values[3], values[4]]
    if len(values) != 4:
        raise HTTPException(status_code=400, detail="bbox must be four comma-separated numbers.")
    min_x, min_y, max_x, max_y = values
    if min_x > max_x or min_y > max_y:
        raise HTTPException(status_code=400, detail="bbox minimums must not exceed maximums.")
    return min_x, min_y, max_x, max_y


def _page_links(base: str, layer_id: str, request: Request, offset: int, returned: int, total: int) -> List[Dict[str, Any]]:
    links = [
        {
            "href": f"{base}/ogc/collections/{layer_id}/items",
            "rel": "self",
            "type": "application/geo+json",
            "title": "This page of features",
        },
        {"href": f"{base}/ogc/collections/{layer_id}", "rel": "collection", "type": "application/json", "title": "Collection"},
    ]
    query = {key: value for key, value in request.query_params.items() if key not in ("offset", "f")}
    if offset + returned < total:
        next_query = dict(query, offset=str(offset + returned))
        links.append({"href": f"{base}/ogc/collections/{layer_id}/items?{_urlencode(next_query)}", "rel": "next", "type": "application/geo+json", "title": "Next page"})
    if offset > 0:
        prev_offset = max(0, offset - returned)
        prev_query = dict(query, offset=str(prev_offset))
        links.append({"href": f"{base}/ogc/collections/{layer_id}/items?{_urlencode(prev_query)}", "rel": "prev", "type": "application/geo+json", "title": "Previous page"})
    return links


def _urlencode(values: Dict[str, Any]) -> str:
    from urllib.parse import urlencode

    return urlencode(values)


def _editable_properties(layer: Dict[str, Any], user: Dict[str, Any], properties: Any, geometry: Any) -> Dict[str, Any]:
    """Keeps only attributes the layer schema defines (plus system keys).

    QGIS echoes every column it received, including read-only/system columns and
    legacy import columns. The layer schema stays authoritative for field users;
    administrators keep full entry access (the REST endpoint performs its own
    strict validation for them).
    """
    backend = kmc()
    props = dict(properties) if isinstance(properties, dict) else {}
    if backend._is_admin_user(user):
        return props
    schema = {
        str(field.get("name"))
        for field in backend._layer_field_schema(layer, geometry)
        if field.get("name")
    }
    if not schema:
        return props
    return {key: value for key, value in props.items() if str(key).startswith("_") or str(key) in schema}


def _feature_body(payload: Any) -> Dict[str, Any]:
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="A GeoJSON Feature object is required.")
    if payload.get("type") not in (None, "Feature"):
        raise HTTPException(status_code=400, detail="Only GeoJSON Feature objects are accepted.")
    return payload


@router.get("/", include_in_schema=False)
@router.get("", include_in_schema=False)
async def landing_page(request: Request):
    resolve_ogc_user(request)
    base = _external_base(request)
    return {
        "title": "Kathmandu Metropolitan City — OGC API Features",
        "description": (
            "KMC vector layers as OGC API - Features collections. Authenticate with your "
            "KMC username and password (HTTP Basic) or a Bearer token."
        ),
        "links": [
            {"href": f"{base}/ogc/", "rel": "self", "type": "application/json", "title": "Landing page"},
            {"href": f"{base}/ogc/conformance", "rel": "conformance", "type": "application/json", "title": "Conformance classes"},
            {"href": f"{base}/ogc/collections", "rel": "data", "type": "application/json", "title": "Collections"},
            {"href": f"{base}/ogc/openapi.json", "rel": "service-desc", "type": "application/vnd.oai.openapi+json;version=3.0", "title": "OpenAPI description"},
        ],
    }


@router.get("/conformance", include_in_schema=False)
async def conformance(request: Request):
    resolve_ogc_user(request)
    return {"conformsTo": CONFORMANCE_CLASSES}


@router.get("/openapi.json", include_in_schema=False)
async def openapi_description(request: Request):
    resolve_ogc_user(request)
    base = _external_base(request)
    feature_operation = {"parameters": [{"$ref": "#/components/parameters/collectionId"}, {"$ref": "#/components/parameters/featureId"}]}
    return JSONResponse(
        {
            "openapi": "3.0.3",
            "info": {"title": "KMC-GIS OGC API - Features", "version": "1.0.0"},
            "servers": [{"url": f"{base}/ogc"}],
            "paths": {
                "/": {"get": {"summary": "Landing page", "responses": {"200": {"description": "Landing page"}}}},
                "/conformance": {"get": {"summary": "Conformance", "responses": {"200": {"description": "Conformance classes"}}}},
                "/collections": {"get": {"summary": "Collections", "responses": {"200": {"description": "Collection list"}}}},
                "/collections/{collectionId}": {"get": {"summary": "Collection metadata", **feature_operation}},
                "/collections/{collectionId}/items": {
                    "get": {"summary": "Features", "parameters": [{"$ref": "#/components/parameters/collectionId"}]},
                    "post": {"summary": "Create a feature", "responses": {"201": {"description": "Created"}}},
                },
                "/collections/{collectionId}/items/{featureId}": {
                    "get": {"summary": "One feature", **feature_operation},
                    "put": {"summary": "Replace a feature", **feature_operation},
                    "patch": {"summary": "Update a feature", **feature_operation},
                    "delete": {"summary": "Delete a feature", **feature_operation},
                },
            },
            "components": {
                "parameters": {
                    "collectionId": {"name": "collectionId", "in": "path", "required": True, "schema": {"type": "string"}},
                    "featureId": {"name": "featureId", "in": "path", "required": True, "schema": {"type": "string"}},
                }
            },
        },
        media_type="application/vnd.oai.openapi+json;version=3.0",
    )


@router.get("/collections", include_in_schema=False)
async def list_collections(request: Request):
    user = resolve_ogc_user(request)
    base = _external_base(request)
    collections = [_collection_document(layer, base) for layer in _visible_layers(user)]
    return {
        "collections": collections,
        "links": [
            {"href": f"{base}/ogc/collections", "rel": "self", "type": "application/json", "title": "Collections"},
            {"href": f"{base}/ogc/", "rel": "root", "type": "application/json", "title": "Landing page"},
        ],
    }


@router.get("/collections/{collection_id}", include_in_schema=False)
async def get_collection(collection_id: str, request: Request):
    user = resolve_ogc_user(request)
    layer = _require_collection(collection_id, user)
    return _collection_document(layer, _external_base(request))


@router.options("/collections/{collection_id}/items", include_in_schema=False)
async def options_items(collection_id: str):
    return Response(
        status_code=204,
        headers={
            "Allow": "GET, HEAD, POST, OPTIONS",
            "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS",
        },
    )


@router.options("/collections/{collection_id}/items/{feature_id}", include_in_schema=False)
async def options_item(collection_id: str, feature_id: str):
    return Response(
        status_code=204,
        headers={
            "Allow": "GET, HEAD, PUT, PATCH, DELETE, OPTIONS",
            "Access-Control-Allow-Methods": "GET, HEAD, PUT, PATCH, DELETE, OPTIONS",
        },
    )


@router.get("/collections/{collection_id}/items", include_in_schema=False)
async def list_items(
    collection_id: str,
    request: Request,
    bbox: Optional[str] = None,
    limit: int = DEFAULT_PAGE_SIZE,
    offset: int = 0,
):
    backend = kmc()
    user = resolve_ogc_user(request)
    layer = _require_collection(collection_id, user)
    raw_layer_id = layer.get("id")
    layer_id = str(raw_layer_id)

    box = _parse_bbox(bbox)
    page_size = max(1, min(int(limit), MAX_PAGE_SIZE))
    start = max(0, int(offset))

    pg_result = None
    if await backend._is_postgis_layer(raw_layer_id):
        pg_result = await _fetch_postgis_items_page(raw_layer_id, box, page_size, start)

    if pg_result is not None:
        page, total = pg_result
    else:
        features = list(backend.get_layer_features_list(raw_layer_id))
        if box:
            features = [feature for feature in features if backend._feature_intersects_bbox(feature, *box)]
        total = len(features)
        page = features[start:start + page_size]

    base = _external_base(request)
    return JSONResponse(
        {
            "type": "FeatureCollection",
            "timeStamp": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "numberMatched": total,
            "numberReturned": len(page),
            "features": [_serialize_feature(layer, feature, user, base) for feature in page],
            "links": _page_links(base, layer_id, request, start, len(page), total),
        },
        media_type="application/geo+json",
    )


@router.get("/collections/{collection_id}/items/{feature_id}", include_in_schema=False)
async def get_item(collection_id: str, feature_id: str, request: Request):
    user = resolve_ogc_user(request)
    layer = _require_collection(collection_id, user)
    feature = await _find_in_collection(layer, feature_id)
    return JSONResponse(
        _serialize_feature(layer, feature, user, _external_base(request)),
        media_type="application/geo+json",
    )


@router.post("/collections/{collection_id}/items", include_in_schema=False)
async def create_item(collection_id: str, payload: Dict[str, Any], request: Request):
    backend = kmc()
    user = resolve_ogc_user(request)
    layer = _require_collection(collection_id, user)
    backend._enforce_layer_write_access(layer, user)

    body = _feature_body(payload)
    geometry = body.get("geometry")
    feature_payload: Dict[str, Any] = {
        "layer_id": layer.get("id"),
        "geometry": geometry,
        "properties": _editable_properties(layer, user, body.get("properties"), geometry),
    }
    client_id = body.get("id")
    if client_id not in (None, ""):
        feature_payload["id"] = client_id

    created = await backend.create_feature(feature_payload, _authenticated_request(request, user))
    base = _external_base(request)
    feature_id = str(created.get("id"))
    return JSONResponse(
        status_code=201,
        content=_serialize_feature(layer, created, user, base),
        media_type="application/geo+json",
        headers={"Location": f"{base}/ogc/collections/{layer.get('id')}/items/{feature_id}"},
    )


async def _replace_or_patch(collection_id: str, feature_id: str, payload: Dict[str, Any], request: Request) -> Response:
    backend = kmc()
    user = resolve_ogc_user(request)
    layer = _require_collection(collection_id, user)
    backend._enforce_layer_write_access(layer, user)
    existing = await _find_in_collection(layer, feature_id)

    body = _feature_body(payload)
    update_payload: Dict[str, Any] = {}
    geometry = body.get("geometry")
    if isinstance(geometry, dict) and geometry:
        update_payload["geometry"] = geometry
    if "properties" in body:
        update_payload["properties"] = _editable_properties(
            layer, user, body.get("properties"), geometry or existing.get("geometry")
        )
    if not update_payload:
        raise HTTPException(status_code=400, detail="No geometry or properties were supplied.")

    # Pin the write to this collection: feature ids repeat across imported layers.
    update_payload["layer_id"] = layer.get("id")
    await backend.update_feature(feature_id, update_payload, _authenticated_request(request, user))
    return Response(status_code=204)


@router.put("/collections/{collection_id}/items/{feature_id}", include_in_schema=False)
async def replace_item(collection_id: str, feature_id: str, payload: Dict[str, Any], request: Request):
    return await _replace_or_patch(collection_id, feature_id, payload, request)


@router.patch("/collections/{collection_id}/items/{feature_id}", include_in_schema=False)
async def patch_item(collection_id: str, feature_id: str, payload: Dict[str, Any], request: Request):
    return await _replace_or_patch(collection_id, feature_id, payload, request)


@router.delete("/collections/{collection_id}/items/{feature_id}", include_in_schema=False)
async def delete_item(collection_id: str, feature_id: str, request: Request):
    backend = kmc()
    user = resolve_ogc_user(request)
    layer = _require_collection(collection_id, user)
    backend._enforce_layer_write_access(layer, user)
    await _find_in_collection(layer, feature_id)
    await backend.delete_feature(
        feature_id, _authenticated_request(request, user), layer_id=layer.get("id")
    )
    return Response(status_code=204)
