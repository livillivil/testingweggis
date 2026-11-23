"""
KMC WebGIS Enterprise Production Spatial Engine (backend/app/spatial_engine.py)
Implements:
1. Spatial Ingestion & Coordinate Normalization:
   - Detects CRS (EPSG:32645 / UTM Zone 45N vs EPSG:4326) and reprojects geometries to WGS84.
   - Precomputes per-feature metrics: WGS84 bbox [min_x, min_y, max_x, max_y], area_m2, length_m, vertex_count, importance.
   - Indexes features in SQLite R-Tree virtual table `features_rtree` with `importance DESC` ordering.
2. High-Speed Vector Tile Pipeline (MVT Protobuf v2.1):
   - Spatial query with zoom-adaptive LOD & 3% edge buffer.
   - Server-side binary MVT Protobuf v2.1 encoder (extent=4096, coordinate clamping [-2048, 6144],
     sequential vertex deduplication, Douglas-Peucker simplification, clockwise exterior / counter-clockwise holes,
     degenerate ring discarding, role-filtered attributes).
   - Role-scoped LRU memory cache with instant invalidation.
3. High-Speed Raster Tile Streaming (MBTiles B-Tree):
   - Direct SQLite B-tree handle caching, XYZ to TMS conversion, magic byte format sniffing,
     HTTP 204 for missing tiles, immutable caching headers.
4. Live Spatial Analytics & Feature Attribute Lookups:
   - Live bbox analytics from R-Tree without downloading raw GeoJSON.
"""

import os
import sys
import re
import math
import time
import json
import struct
import sqlite3
import threading
from collections import OrderedDict
from typing import Any, Dict, List, Optional, Tuple, Union

import pyproj
from shapely.geometry import shape, mapping, Point, LineString, Polygon, MultiPoint, MultiLineString, MultiPolygon
from shapely.ops import transform as shapely_transform

# --- Concurrency & Thread-Local Storage ---
_SPATIAL_DB_LOCK = threading.RLock()
_THREAD_LOCAL = threading.local()

try:
    import fcntl
except ImportError:
    fcntl = None


class InterProcessFileLock:
    """Reentrant cross-process file lock using OS fcntl.flock on Linux/Unix with safe timeout."""
    def __init__(self, lock_path: Optional[str] = None):
        if lock_path is None:
            # Place in /tmp (in-memory Linux tmpfs) to avoid deadlocks on Windows bind mounts
            tmp_dir = "/tmp" if os.path.exists("/tmp") and os.path.isdir("/tmp") else tempfile.gettempdir()
            lock_path = os.path.join(tmp_dir, "spatial_features_db.lock")
        self.lock_path = lock_path
        self._fd = None

    def __enter__(self):
        depth = getattr(_THREAD_LOCAL, f"_flock_depth_{self.lock_path}", 0)
        if depth > 0:
            setattr(_THREAD_LOCAL, f"_flock_depth_{self.lock_path}", depth + 1)
            return self
        if fcntl is not None:
            try:
                self._fd = open(self.lock_path, "w")
                # Bounded non-blocking lock with 3.0s timeout to prevent deadlocks
                deadline = time.monotonic() + 3.0
                acquired = False
                while time.monotonic() < deadline:
                    try:
                        fcntl.flock(self._fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                        acquired = True
                        break
                    except (BlockingIOError, OSError):
                        time.sleep(0.02)
                if acquired:
                    setattr(_THREAD_LOCAL, f"_flock_fd_{self.lock_path}", self._fd)
                else:
                    try:
                        self._fd.close()
                    except Exception:
                        pass
                    self._fd = None
            except Exception:
                self._fd = None
        setattr(_THREAD_LOCAL, f"_flock_depth_{self.lock_path}", 1)
        return self

    def __exit__(self, exc_type, exc_val, exc_tb):
        depth = getattr(_THREAD_LOCAL, f"_flock_depth_{self.lock_path}", 0)
        if depth > 1:
            setattr(_THREAD_LOCAL, f"_flock_depth_{self.lock_path}", depth - 1)
            return
        setattr(_THREAD_LOCAL, f"_flock_depth_{self.lock_path}", 0)
        fd = getattr(_THREAD_LOCAL, f"_flock_fd_{self.lock_path}", None)
        if fd is not None:
            if fcntl is not None:
                try:
                    fcntl.flock(fd.fileno(), fcntl.LOCK_UN)
                except Exception:
                    pass
            try:
                fd.close()
            except Exception:
                pass
            setattr(_THREAD_LOCAL, f"_flock_fd_{self.lock_path}", None)

# Coordinate Transformers
_UTM45N_TO_WGS84 = pyproj.Transformer.from_crs("EPSG:32645", "EPSG:4326", always_xy=True)
_WGS84_TO_UTM45N = pyproj.Transformer.from_crs("EPSG:4326", "EPSG:32645", always_xy=True)

# LRU Cache for MVT tiles (max 16,384 tiles in memory)
_MVT_LRU_MAX = 16384
_MVT_LRU_CACHE: OrderedDict[str, bytes] = OrderedDict()
_MVT_CACHE_LOCK = threading.Lock()
_LAYER_TILE_VERSIONS: Dict[str, int] = {}

# MBTiles connection cache per thread
_MBTILES_CONNS: Dict[str, sqlite3.Connection] = {}
_MBTILES_LOCK = threading.Lock()

# Transparent 1x1 PNG for fallback
TRANSPARENT_1X1_PNG = b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\rIDATx\x9cc`\x00\x00\x00\x02\x00\x01Haf\xa0\x00\x00\x00\x00IEND\xaeB`\x82'


def get_spatial_db_path() -> str:
    """Returns the persistent SQLite database path for spatial features and R-Tree index."""
    # Preferred location: /tileserver-data (mounted to host ./data/tileserver)
    for p in ["/tileserver-data", "/app/uploads", "./data/tileserver", "./data/uploads", "."]:
        if os.path.exists(p) and os.path.isdir(p):
            return os.path.join(p, "spatial_features.db")
    return "spatial_features.db"


_SCHEMA_INITIALIZED = False


def _db_file_identity(path: str) -> Optional[Tuple[int, int]]:
    """Returns (device, inode) of the live database file, or None if it is absent.

    The spatial database is rebuilt out-of-band by seed/ingest jobs. When that
    happens the old inode survives as an anonymous "(deleted)" file handle that
    long-lived connections keep writing to, so every request must verify that
    its cached connection still points at the current file.
    """
    try:
        st = os.stat(path)
        return (st.st_dev, st.st_ino)
    except OSError:
        return None


def _close_thread_spatial_conn() -> None:
    conn = getattr(_THREAD_LOCAL, "spatial_db_conn", None)
    if conn is not None:
        try:
            conn.close()
        except Exception:
            pass
    _THREAD_LOCAL.spatial_db_conn = None
    _THREAD_LOCAL.spatial_db_identity = None


def get_spatial_db_conn() -> sqlite3.Connection:
    """Thread-local connection that reconnects when the database file is replaced."""
    db_path = get_spatial_db_path()
    identity = _db_file_identity(db_path)
    conn = getattr(_THREAD_LOCAL, "spatial_db_conn", None)
    cached_identity = getattr(_THREAD_LOCAL, "spatial_db_identity", None)

    if conn is not None and (identity is None or identity != cached_identity):
        _close_thread_spatial_conn()
        conn = None

    if conn is None:
        conn = sqlite3.connect(db_path, timeout=30.0, isolation_level=None, check_same_thread=False)
        conn.execute("PRAGMA journal_mode = WAL;")
        conn.execute("PRAGMA synchronous = NORMAL;")
        conn.execute("PRAGMA busy_timeout = 30000;")
        conn.execute("PRAGMA mmap_size = 268435456;")  # 256MB memory-mapped I/O
        conn.execute("PRAGMA cache_size = -64000;")     # 64MB cache
        _THREAD_LOCAL.spatial_db_conn = conn
        _THREAD_LOCAL.spatial_db_identity = _db_file_identity(db_path)

    try:
        cur = conn.cursor()
        cur.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='feature_records' LIMIT 1;")
        if not cur.fetchone():
            _init_spatial_db_schema(conn)
    except Exception:
        _init_spatial_db_schema(conn)
    return conn


def ensure_spatial_db_schema(conn: Optional[sqlite3.Connection] = None) -> None:
    """Explicitly ensure the spatial database schema and indices are initialized."""
    if conn is None:
        conn = get_spatial_db_conn()
    else:
        _init_spatial_db_schema(conn)


def _init_spatial_db_schema(conn: sqlite3.Connection) -> None:
    """Initializes the R-Tree virtual table and feature store."""
    with _SPATIAL_DB_LOCK:
        with InterProcessFileLock():
            cur = conn.cursor()
            cur.execute("""
                CREATE VIRTUAL TABLE IF NOT EXISTS features_rtree USING rtree(
                    id,
                    min_x, max_x,
                    min_y, max_y
                );
            """)
            cur.execute("""
                CREATE TABLE IF NOT EXISTS feature_records (
                    id INTEGER PRIMARY KEY,
                    layer_id TEXT NOT NULL,
                    feature_uid TEXT NOT NULL,
                    geom_type TEXT NOT NULL,
                    area_m2 REAL DEFAULT 0,
                    length_m REAL DEFAULT 0,
                    vertex_count INTEGER DEFAULT 0,
                    importance REAL DEFAULT 0,
                    geometry_json TEXT NOT NULL,
                    properties_json TEXT NOT NULL
                );
            """)
            cur.execute("CREATE INDEX IF NOT EXISTS idx_feat_layer_imp ON feature_records(layer_id, importance DESC);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_feat_layer_uid ON feature_records(layer_id, feature_uid);")
            cur.execute("CREATE INDEX IF NOT EXISTS idx_feat_uid ON feature_records(feature_uid);")


# ============================================================================
# 1. SPATIAL INGESTION & COORDINATE NORMALIZATION
# ============================================================================

def detect_and_reproject_coords(coords: Any, source_crs: Optional[str] = None) -> Tuple[Any, bool]:
    """
    Recursively inspects coordinates. If coordinates fall in UTM Zone 45N ranges
    (x: 100,000..900,000, y: 2,000,000..4,000,000) or source_crs is EPSG:32645,
    reprojects them to EPSG:4326 (WGS84).
    """
    if not coords or not isinstance(coords, (list, tuple)):
        return coords, False

    # Check if this is a single coordinate pair [x, y]
    if len(coords) >= 2 and isinstance(coords[0], (int, float)) and isinstance(coords[1], (int, float)):
        x, y = float(coords[0]), float(coords[1])
        is_utm = (
            (source_crs and "32645" in str(source_crs)) or
            (100000.0 <= x <= 900000.0 and 2000000.0 <= y <= 4000000.0)
        )
        if is_utm:
            lng, lat = _UTM45N_TO_WGS84.transform(x, y)
            extra = list(coords[2:])
            return [round(lng, 7), round(lat, 7)] + extra, True
        return [round(x, 7), round(y, 7)], False

    # Recursively transform nested coordinate arrays
    transformed = []
    any_reprojected = False
    for sub in coords:
        sub_t, was_rep = detect_and_reproject_coords(sub, source_crs)
        transformed.append(sub_t)
        if was_rep:
            any_reprojected = True
    return transformed, any_reprojected


def compute_geometry_metrics(geom_dict: Dict[str, Any], props: Optional[Dict[str, Any]] = None) -> Tuple[Tuple[float, float, float, float], float, float, int]:
    """
    Precomputes per-feature metrics:
      - WGS84 bbox: (min_x, min_y, max_x, max_y)
      - area_m2 for polygons (geodesic / precalculated)
      - length_m for linestrings
      - vertex_count
    """
    min_x, min_y, max_x, max_y = float("inf"), float("inf"), float("-inf"), float("-inf")
    vertex_count = 0

    def scan(coords):
        nonlocal min_x, min_y, max_x, max_y, vertex_count
        if not coords or not isinstance(coords, (list, tuple)):
            return
        if len(coords) >= 2 and isinstance(coords[0], (int, float)) and isinstance(coords[1], (int, float)):
            x, y = float(coords[0]), float(coords[1])
            if not (math.isnan(x) or math.isnan(y)):
                vertex_count += 1
                if x < min_x: min_x = x
                if x > max_x: max_x = x
                if y < min_y: min_y = y
                if y > max_y: max_y = y
        else:
            for sub in coords:
                scan(sub)

    coords = geom_dict.get("coordinates")
    if coords:
        scan(coords)

    if min_x == float("inf"):
        min_x, min_y, max_x, max_y = 85.32, 27.71, 85.32, 27.71

    area_m2 = 0.0
    length_m = 0.0

    # 1. Check if area/length is already present in properties
    if props:
        for k in ["area", "area_m2", "shape_area", "Shape_Area", "st_area"]:
            if k in props and props[k] is not None:
                try:
                    area_m2 = round(float(props[k]), 2)
                    break
                except Exception:
                    pass
        for k in ["length", "length_m", "shape_leng", "Shape_Leng", "st_length"]:
            if k in props and props[k] is not None:
                try:
                    length_m = round(float(props[k]), 2)
                    break
                except Exception:
                    pass

    # 2. Fast calculation if not present in properties
    g_type = geom_dict.get("type", "Polygon").upper()
    if area_m2 == 0.0 and "POLYGON" in g_type:
        try:
            s_geom = shape(geom_dict)
            lat_rad = math.radians((min_y + max_y) / 2.0)
            m_per_deg_lat = 111132.0
            m_per_deg_lng = 111132.0 * math.cos(lat_rad)
            area_m2 = round(abs(float(s_geom.area)) * m_per_deg_lat * m_per_deg_lng, 2)
        except Exception:
            pass
    elif length_m == 0.0 and "LINE" in g_type:
        coords = geom_dict.get("coordinates")
        if coords:
            try:
                lat_rad = math.radians((min_y + max_y) / 2.0)
                m_per_deg_lat = 111132.0
                m_per_deg_lng = 111132.0 * math.cos(lat_rad)
                def _calc_line_len(pts):
                    tot = 0.0
                    for i in range(len(pts) - 1):
                        dx = (pts[i+1][0] - pts[i][0]) * m_per_deg_lng
                        dy = (pts[i+1][1] - pts[i][1]) * m_per_deg_lat
                        tot += math.hypot(dx, dy)
                    return tot
                if "MULTI" in g_type:
                    length_m = round(sum(_calc_line_len(p) for p in coords if p and len(p) >= 2), 2)
                else:
                    length_m = round(_calc_line_len(coords), 2)
            except Exception:
                try:
                    s_geom = shape(geom_dict)
                    lat_rad = math.radians((min_y + max_y) / 2.0)
                    m_per_deg_lat = 111132.0
                    m_per_deg_lng = 111132.0 * math.cos(lat_rad)
                    length_m = round(float(s_geom.length) * ((m_per_deg_lat + m_per_deg_lng) / 2.0), 2)
                except Exception:
                    pass

    return (min_x, min_y, max_x, max_y), area_m2, length_m, vertex_count


def calculate_feature_importance(props: Dict[str, Any], geom_type: str, area_m2: float, length_m: float) -> float:
    """
    Computes an importance score so low-zoom tiles prioritize major roads and landmark structures.
    """
    score = 0.0
    props_str = json.dumps(props, ensure_ascii=False).lower()

    if "LINE" in geom_type.upper():
        score += length_m
        # Road Hierarchy Boosts
        if any(h in props_str for h in ["national highway", "ring road", "highway", "expressway", "rajpath", "nh-"]):
            score += 1000000.0
        elif any(a in props_str for a in ["arterial", "main road", "primary", "trunk"]):
            score += 100000.0
        elif any(s in props_str for s in ["secondary", "collector", "avenue"]):
            score += 10000.0
        elif any(r in props_str for r in ["residential", "local", "galli", "marg"]):
            score += 500.0
    elif "POLYGON" in geom_type.upper():
        score += area_m2
        # Landmark boosts
        if any(w in props_str for w in ["hospital", "campus", "university", "parliament", "durbar", "temple", "stadium", "airport", "singha durbar", "headquarters"]):
            score += 50000.0
        elif any(w in props_str for w in ["school", "college", "bank", "ministry", "heritage", "palace"]):
            score += 20000.0
        elif any(w in props_str for w in ["commercial", "government", "public"]):
            score += 5000.0
    else: # Point
        score += 100.0
        if any(w in props_str for w in ["gate", "entrance", "landmark", "hospital", "station"]):
            score += 5000.0

    return round(score, 2)


def iter_geojson_features(file_path: str):
    """
    Memory-efficient GeoJSON feature generator.
    Streams features with low RAM usage (<20MB) even on multi-hundred-megabyte files.
    """
    if not os.path.exists(file_path):
        return

    file_size = os.path.getsize(file_path)
    if file_size < 8 * 1024 * 1024:
        with open(file_path, "r", encoding="utf-8", errors="replace") as f:
            try:
                data = json.load(f)
            except Exception:
                return
        if isinstance(data, dict) and "features" in data and isinstance(data["features"], list):
            for feat in data["features"]:
                if isinstance(feat, dict):
                    yield feat
        elif isinstance(data, list):
            for feat in data:
                if isinstance(feat, dict):
                    yield feat
        elif isinstance(data, dict) and data.get("type") == "Feature":
            yield data
        return

    # Streaming mode for large files
    with open(file_path, "r", encoding="utf-8", errors="replace") as f:
        # Detect if features are line-delimited
        is_line_delimited = False
        for _ in range(30):
            line = f.readline()
            if not line:
                break
            stripped = line.strip().rstrip(",")
            if stripped.startswith("{") and '"Feature"' in stripped[:50]:
                is_line_delimited = True
                break
        f.seek(0)

        if is_line_delimited:
            for line in f:
                stripped = line.strip().rstrip(",")
                if stripped.startswith("{") and '"Feature"' in stripped[:50]:
                    try:
                        feat = json.loads(stripped)
                        if isinstance(feat, dict):
                            yield feat
                    except Exception:
                        continue
        else:
            # Chunked JSON buffer reader for multiline features
            buffer = ""
            in_feature = False
            brace_depth = 0
            in_string = False
            escape = False
            feat_start_idx = 0

            for chunk in iter(lambda: f.read(65536), ""):
                buffer += chunk
                idx = 0
                while idx < len(buffer):
                    char = buffer[idx]
                    if escape:
                        escape = False
                        idx += 1
                        continue
                    if char == "\\":
                        escape = True
                        idx += 1
                        continue
                    if char == '"':
                        in_string = not in_string
                        idx += 1
                        continue
                    if in_string:
                        idx += 1
                        continue

                    if char == "{":
                        if not in_feature:
                            lookahead = buffer[idx:idx + 60]
                            if '"type"' in lookahead and '"Feature"' in lookahead:
                                in_feature = True
                                brace_depth = 1
                                feat_start_idx = idx
                        else:
                            brace_depth += 1
                    elif char == "}":
                        if in_feature:
                            brace_depth -= 1
                            if brace_depth == 0:
                                feat_str = buffer[feat_start_idx:idx + 1]
                                try:
                                    feat = json.loads(feat_str)
                                    if isinstance(feat, dict):
                                        yield feat
                                except Exception:
                                    pass
                                in_feature = False
                                buffer = buffer[idx + 1:]
                                idx = -1
                    idx += 1
                if not in_feature and len(buffer) > 32768:
                    buffer = buffer[-4096:]


def ingest_features_to_spatial_index(
    layer_id: Union[str, int],
    features: Any,
    source_crs: Optional[str] = None,
    purge_existing: bool = True,
    progress_callback: Optional[Any] = None,
) -> Dict[str, Any]:
    """
    Ingests GeoJSON features (list or generator) into the SQLite R-Tree spatial index and feature store.
    Reprojects CRS, precomputes metrics, and indexes by (layer_id, importance DESC).
    """
    str_lid = str(layer_id)

    with _SPATIAL_DB_LOCK:
        with InterProcessFileLock():
            conn = get_spatial_db_conn()
            _init_spatial_db_schema(conn)
            for attempt in range(6):
                try:
                    conn.execute("PRAGMA busy_timeout = 30000;")
                    conn.execute("BEGIN IMMEDIATE;")
                    cur = conn.cursor()
                    if purge_existing:
                        # Delete old entries for this layer
                        variants = resolve_layer_id_variants(str_lid)
                        placeholders = ",".join("?" for _ in variants)
                        cur.execute(f"SELECT id FROM feature_records WHERE layer_id IN ({placeholders})", list(variants))
                        old_ids = [r[0] for r in cur.fetchall()]
                        if old_ids:
                            cur.executemany("DELETE FROM features_rtree WHERE id = ?", [(oid,) for oid in old_ids])
                            cur.execute(f"DELETE FROM feature_records WHERE layer_id IN ({placeholders})", list(variants))

                    rtree_batch = []
                    record_batch = []

                    global_min_x, global_min_y = float("inf"), float("inf")
                    global_max_x, global_max_y = float("-inf"), float("-inf")
                    feature_count = 0

                    # Query highest existing id across both feature_records and features_rtree
                    cur.execute("DELETE FROM features_rtree WHERE id NOT IN (SELECT id FROM feature_records)")
                    cur.execute("SELECT MAX(m) FROM (SELECT COALESCE(MAX(id), 0) AS m FROM feature_records UNION ALL SELECT COALESCE(MAX(id), 0) AS m FROM features_rtree)")
                    current_id = cur.fetchone()[0] or 0

                    for idx, feat in enumerate(features):
                        if not isinstance(feat, dict):
                            continue
                        geom = feat.get("geometry")
                        if not geom or not isinstance(geom, dict) or not geom.get("coordinates"):
                            continue

                        current_id += 1
                        rec_id = current_id

                        # Coordinate normalization & reprojection
                        reproj_coords, _ = detect_and_reproject_coords(geom["coordinates"], source_crs)
                        normalized_geom = {
                            "type": geom.get("type", "Polygon"),
                            "coordinates": reproj_coords
                        }

                        # Feature UID resolution
                        props = dict(feat.get("properties") or {})
                        f_uid = str(feat.get("id") or props.get("id") or props.get("record_id") or props.get("_id") or f"{str_lid}_{current_id}")
                        props["feature_uid"] = f_uid

                        # Precomputed metrics
                        bbox, area_m2, length_m, v_count = compute_geometry_metrics(normalized_geom, props)
                        min_x, min_y, max_x, max_y = bbox
                        g_type = normalized_geom["type"]
                        importance = calculate_feature_importance(props, g_type, area_m2, length_m)

                        # Update layer bounds
                        if min_x < global_min_x: global_min_x = min_x
                        if max_x > global_max_x: global_max_x = max_x
                        if min_y < global_min_y: global_min_y = min_y
                        if max_y > global_max_y: global_max_y = max_y

                        rtree_batch.append((rec_id, min_x, max_x, min_y, max_y))
                        record_batch.append((
                            rec_id, str_lid, f_uid, g_type, area_m2, length_m, v_count, importance,
                            json.dumps(normalized_geom, separators=(",", ":")),
                            json.dumps(props, separators=(",", ":"), ensure_ascii=False)
                        ))
                        feature_count += 1

                        if len(rtree_batch) >= 2500:
                            cur.executemany("INSERT OR REPLACE INTO features_rtree (id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)", rtree_batch)
                            cur.executemany("""
                                INSERT OR REPLACE INTO feature_records (id, layer_id, feature_uid, geom_type, area_m2, length_m, vertex_count, importance, geometry_json, properties_json)
                                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """, record_batch)
                            rtree_batch.clear()
                            record_batch.clear()
                            if progress_callback:
                                try:
                                    progress_callback(feature_count)
                                except Exception:
                                    pass

                    if rtree_batch:
                        cur.executemany("INSERT OR REPLACE INTO features_rtree (id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)", rtree_batch)
                        cur.executemany("""
                            INSERT OR REPLACE INTO feature_records (id, layer_id, feature_uid, geom_type, area_m2, length_m, vertex_count, importance, geometry_json, properties_json)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """, record_batch)

                    conn.execute("COMMIT;")
                    break
                except sqlite3.OperationalError as e:
                    try:
                        conn.execute("ROLLBACK;")
                    except Exception:
                        pass
                    if "locked" in str(e).lower() and attempt < 5:
                        time.sleep(0.2 * (attempt + 1))
                        continue
                    raise
                except Exception:
                    try:
                        conn.execute("ROLLBACK;")
                    except Exception:
                        pass
                    raise

        # Invalidate MVT cache for this layer
        invalidate_mvt_cache_for_layer(str_lid)

        if global_min_x == float("inf"):
            global_min_x, global_min_y, global_max_x, global_max_y = 85.28, 27.67, 85.37, 27.75

        return {
            "layer_id": str_lid,
            "feature_count": feature_count,
            "bounds": [round(global_min_x, 6), round(global_min_y, 6), round(global_max_x, 6), round(global_max_y, 6)],
            "tile_version": get_layer_tile_version(str_lid)
        }


# ============================================================================
# 2. HIGH-SPEED VECTOR TILE PIPELINE (MVT Protobuf v2.1)
# ============================================================================

def tile_xyz_to_lnglat_bounds(x: int, y: int, z: int) -> Tuple[float, float, float, float]:
    """
    Converts slippy-map (z, x, y) tile coordinates to WGS84 bounding box (min_lng, min_lat, max_lng, max_lat).
    """
    n = 1 << z
    min_lng = x / n * 360.0 - 180.0
    max_lng = (x + 1) / n * 360.0 - 180.0

    lat_rad_top = math.atan(math.sinh(math.pi * (1.0 - 2.0 * y / n)))
    lat_rad_bottom = math.atan(math.sinh(math.pi * (1.0 - 2.0 * (y + 1) / n)))

    max_lat = math.degrees(lat_rad_top)
    min_lat = math.degrees(lat_rad_bottom)

    return min_lng, min_lat, max_lng, max_lat


def get_zoom_feature_cap(z: int) -> int:
    """
    Zoom-based feature cap ensuring zero client lag at all zoom levels:
      z < 12: 80
      z < 13: 220
      z < 14: 550
      z < 15: 1200
      z < 16: 2600
      z >= 16: 12000
    """
    if z < 12: return 80
    if z < 13: return 220
    if z < 14: return 550
    if z < 15: return 1200
    if z < 16: return 2600
    return 12000


def get_zoom_simplification_tolerance(z: int) -> float:
    """
    Zoom-adaptive Douglas-Peucker simplification tolerance in tile pixels:
      z >= 18: 0.0px
      z >= 16: 1.2px
      z >= 14: 2.8px
      z < 14:  5.5px
    """
    if z >= 18: return 0.0
    if z >= 16: return 1.2
    if z >= 14: return 2.8
    return 5.5


def resolve_layer_id_variants(layer_id: str) -> List[str]:
    """Returns all known identifier/slug aliases for a layer."""
    lid = str(layer_id).strip()
    variants = {lid, lid.lower(), lid.replace("-", "_"), lid.replace("_", "-")}
    # Specific known aliases for our target layers
    if lid in ("1795243402839", "UnetRaw", "unet_raw", "unetraw", "Unet"):
        variants.update(["1795243402839", "unet_raw", "UnetRaw", "unetraw"])
    if lid in ("1795243406025", "heritage_buildings", "heritage buildings", "heritage"):
        variants.update(["1795243406025", "heritage_buildings", "heritage buildings"])
    if lid in ("1795243405359", "kmc_hq", "kmc hq", "kmchq"):
        variants.update(["1795243405359", "kmc_hq", "kmc hq"])
    if lid in ("1795243400450", "test_buildings", "test buildings"):
        variants.update(["1795243400450", "test_buildings", "test buildings"])
    if lid in ("10101", "kmc_municipal_buildings"):
        variants.update(["10101", "kmc_municipal_buildings"])
    if lid in ("10102", "kmc_road_network"):
        variants.update(["10102", "kmc_road_network"])
    if lid in ("10103", "kmc_building_gates"):
        variants.update(["10103", "kmc_building_gates"])
    if lid in ("10104", "kmc_surveys", "kmc_field_surveys", "kmc_field_survey_layer"):
        variants.update(["10104", "kmc_surveys", "kmc_field_surveys", "kmc_field_survey_layer"])
    return list(variants)


def query_spatial_rtree_tile(layer_id: str, z: int, x: int, y: int) -> List[Dict[str, Any]]:
    """
    Queries SQLite R-Tree for features intersecting (z, x, y) tile with ~3% edge buffer,
    ordered by importance DESC with zoom-based feature cap.
    """
    min_lng, min_lat, max_lng, max_lat = tile_xyz_to_lnglat_bounds(x, y, z)
    # ~3% edge buffer to eliminate tile seam clipping
    pad_x = (max_lng - min_lng) * 0.03
    pad_y = (max_lat - min_lat) * 0.03
    q_min_x = min_lng - pad_x
    q_max_x = max_lng + pad_x
    q_min_y = min_lat - pad_y
    q_max_y = max_lat + pad_y

    cap = get_zoom_feature_cap(z)
    conn = get_spatial_db_conn()
    cur = conn.cursor()

    variants = resolve_layer_id_variants(layer_id)
    placeholders = ",".join("?" for _ in variants)

    cur.execute(f"""
        SELECT f.feature_uid, f.geom_type, f.geometry_json, f.properties_json
        FROM features_rtree r
        JOIN feature_records f ON r.id = f.id
        WHERE f.layer_id IN ({placeholders})
          AND r.max_x >= ? AND r.min_x <= ?
          AND r.max_y >= ? AND r.min_y <= ?
        ORDER BY f.importance DESC
        LIMIT ?
    """, list(variants) + [q_min_x, q_max_x, q_min_y, q_max_y, cap])

    rows = cur.fetchall()
    features = []
    for r in rows:
        try:
            features.append({
                "feature_uid": r[0],
                "geom_type": r[1],
                "geometry": json.loads(r[2]),
                "properties": json.loads(r[3]),
            })
        except Exception:
            continue
    return features


# --- MVT Protobuf v2.1 Wire Encoding Helpers ---

def _varint(val: int) -> bytes:
    buf = bytearray()
    while val >= 0x80:
        buf.append((val & 0x7F) | 0x80)
        val >>= 7
    buf.append(val & 0x7F)
    return bytes(buf)


def _zigzag(n: int) -> int:
    return (n << 1) ^ (n >> 31)


def _signed_area(ring: List[Tuple[int, int]]) -> float:
    """Returns signed area. In screen coordinates (Y down), clockwise ring has area > 0."""
    total = 0.0
    n = len(ring)
    for i in range(n):
        x1, y1 = ring[i]
        x2, y2 = ring[(i + 1) % n]
        total += (x2 - x1) * (y2 + y1)
    return total / 2.0


def _simplify_coords_dp(coords: List[Tuple[int, int]], tol: float) -> List[Tuple[int, int]]:
    """Standard Douglas-Peucker line simplification in integer tile pixel space."""
    if tol <= 0.0 or len(coords) <= 2:
        return coords

    # Find point with maximum distance
    dmax = 0.0
    index = 0
    x1, y1 = coords[0]
    x2, y2 = coords[-1]
    dx = x2 - x1
    dy = y2 - y1
    denom = math.hypot(dx, dy)

    for i in range(1, len(coords) - 1):
        x0, y0 = coords[i]
        if denom == 0:
            d = math.hypot(x0 - x1, y0 - y1)
        else:
            d = abs(dy * x0 - dx * y0 + x2 * y1 - y2 * x1) / denom
        if d > dmax:
            index = i
            dmax = d

    if dmax > tol:
        rec1 = _simplify_coords_dp(coords[:index + 1], tol)
        rec2 = _simplify_coords_dp(coords[index:], tol)
        return rec1[:-1] + rec2
    else:
        return [coords[0], coords[-1]]


def encode_mvt_v2(
    layer_name: str,
    features: List[Dict[str, Any]],
    z: int, x: int, y: int,
    permitted_fields: Optional[List[str]] = None,
    extent: int = 4096
) -> Optional[bytes]:
    """
    Encodes features intersecting (z, x, y) tile into Mapbox Vector Tile Protobuf v2.1 binary format.
    - Extent: 4096.
    - Coordinate clamping: [-2048, 6144].
    - Deduplicates sequential identical integer vertices.
    - Zoom-adaptive Douglas-Peucker simplification.
    - Polygon ring winding: clockwise exterior rings, counter-clockwise hole rings.
    - Filters degenerate sub-pixel rings (|area| < 1 at high zoom, < 6 at low zoom).
    - Encodes feature_uid and permitted scalar properties into MVT tags.
    - Returns None if 0 valid features.
    """
    if not features:
        return None

    min_lng, min_lat, max_lng, max_lat = tile_xyz_to_lnglat_bounds(x, y, z)
    scale_x = extent / (max_lng - min_lng)
    scale_y = extent / (max_lat - min_lat)
    tol = get_zoom_simplification_tolerance(z)

    def to_tile_pt(lng: float, lat: float) -> Tuple[int, int]:
        tx = int(round((lng - min_lng) * scale_x))
        ty = int(round((max_lat - lat) * scale_y))  # MVT Y increases downward
        # Clamp out-of-bounds coordinates to [-2048, 6144]
        tx = max(-2048, min(6144, tx))
        ty = max(-2048, min(6144, ty))
        return tx, ty

    # Keys and Values dictionaries for layer
    keys_list: List[str] = []
    keys_map: Dict[str, int] = {}
    values_list: List[Dict[str, Any]] = []
    values_map: Dict[Tuple[str, Any], int] = {}

    def get_key_idx(k: str) -> int:
        if k not in keys_map:
            idx = len(keys_list)
            keys_list.append(k)
            keys_map[k] = idx
            return idx
        return keys_map[k]

    def get_val_idx(val: Any) -> int:
        v_type = "str"
        if isinstance(val, bool):
            v_type = "bool"
        elif isinstance(val, int):
            v_type = "int"
        elif isinstance(val, float):
            v_type = "double"
        else:
            val = str(val)

        pair = (v_type, val)
        if pair not in values_map:
            idx = len(values_list)
            values_list.append({"type": v_type, "value": val})
            values_map[pair] = idx
            return idx
        return values_map[pair]

    encoded_features = []
    min_area_thresh = 1.0 if z >= 16 else 6.0

    for feat in features:
        geom = feat.get("geometry")
        if not geom or not geom.get("coordinates"):
            continue

        raw_type = geom.get("type", "Point").upper()
        raw_coords = geom.get("coordinates")

        # Encode geometry commands
        geom_cmds: List[int] = []
        mvt_geom_type = 0  # 1: Point, 2: LineString, 3: Polygon

        cursor_x = 0
        cursor_y = 0

        if "POINT" in raw_type:
            mvt_geom_type = 1
            pts = []
            if raw_type == "POINT":
                pts.append(to_tile_pt(raw_coords[0], raw_coords[1]))
            else:
                for p in raw_coords:
                    pts.append(to_tile_pt(p[0], p[1]))

            # MoveTo command for points: (1 & 0x7) | (count << 3)
            geom_cmds.append((1 & 0x7) | (len(pts) << 3))
            for px, py in pts:
                dx = px - cursor_x
                dy = py - cursor_y
                geom_cmds.append(_zigzag(dx))
                geom_cmds.append(_zigzag(dy))
                cursor_x = px
                cursor_y = py

        elif "LINE" in raw_type:
            mvt_geom_type = 2
            lines = [raw_coords] if raw_type == "LINESTRING" else raw_coords

            for line in lines:
                # Deduplicate sequential vertices & project
                projected = []
                for pt in line:
                    t_pt = to_tile_pt(pt[0], pt[1])
                    if not projected or projected[-1] != t_pt:
                        projected.append(t_pt)

                # Simplify
                if tol > 0.0 and len(projected) > 2:
                    projected = _simplify_coords_dp(projected, tol)

                if len(projected) < 2:
                    continue

                # MoveTo(1)
                geom_cmds.append((1 & 0x7) | (1 << 3))
                dx = projected[0][0] - cursor_x
                dy = projected[0][1] - cursor_y
                geom_cmds.append(_zigzag(dx))
                geom_cmds.append(_zigzag(dy))
                cursor_x = projected[0][0]
                cursor_y = projected[0][1]

                # LineTo(len - 1)
                geom_cmds.append((2 & 0x7) | ((len(projected) - 1) << 3))
                for pt in projected[1:]:
                    dx = pt[0] - cursor_x
                    dy = pt[1] - cursor_y
                    geom_cmds.append(_zigzag(dx))
                    geom_cmds.append(_zigzag(dy))
                    cursor_x = pt[0]
                    cursor_y = pt[1]

        elif "POLYGON" in raw_type:
            mvt_geom_type = 3
            polys = [raw_coords] if raw_type == "POLYGON" else raw_coords

            for poly in polys:
                for ring_idx, raw_ring in enumerate(poly):
                    # Project and deduplicate sequential vertices
                    projected = []
                    for pt in raw_ring:
                        t_pt = to_tile_pt(pt[0], pt[1])
                        if not projected or projected[-1] != t_pt:
                            projected.append(t_pt)

                    # Remove closing vertex if duplicated
                    if len(projected) > 2 and projected[0] == projected[-1]:
                        projected.pop()

                    # Simplify ring
                    if tol > 0.0 and len(projected) > 3:
                        projected = _simplify_coords_dp(projected, tol)

                    if len(projected) < 3:
                        continue

                    # Check winding order:
                    # Exterior ring (ring_idx == 0): must be Clockwise (signed_area > 0)
                    # Interior hole (ring_idx > 0): must be Counter-Clockwise (signed_area < 0)
                    area = _signed_area(projected)
                    if abs(area) < min_area_thresh:
                        # Discard degenerate sub-pixel rings
                        continue

                    is_exterior = (ring_idx == 0)
                    if is_exterior and area < 0:
                        projected.reverse()
                    elif not is_exterior and area > 0:
                        projected.reverse()

                    # MoveTo(1)
                    geom_cmds.append((1 & 0x7) | (1 << 3))
                    dx = projected[0][0] - cursor_x
                    dy = projected[0][1] - cursor_y
                    geom_cmds.append(_zigzag(dx))
                    geom_cmds.append(_zigzag(dy))
                    cursor_x = projected[0][0]
                    cursor_y = projected[0][1]

                    # LineTo(len - 1)
                    geom_cmds.append((2 & 0x7) | ((len(projected) - 1) << 3))
                    for pt in projected[1:]:
                        dx = pt[0] - cursor_x
                        dy = pt[1] - cursor_y
                        geom_cmds.append(_zigzag(dx))
                        geom_cmds.append(_zigzag(dy))
                        cursor_x = pt[0]
                        cursor_y = pt[1]

                    # ClosePath(1) = (7 & 0x7) | (1 << 3) = 15
                    geom_cmds.append(15)

        if not geom_cmds or mvt_geom_type == 0:
            continue

        # Build feature tags
        tags: List[int] = []
        props = dict(feat.get("properties") or {})
        uid = feat.get("feature_uid") or props.get("feature_uid") or str(feat.get("id", ""))
        props["feature_uid"] = uid

        for k, v in props.items():
            if k.startswith("_") and k != "_id":
                continue
            if permitted_fields is not None and k != "feature_uid" and k not in permitted_fields:
                # Strict server-side field-level isolation
                continue
            if v is None or isinstance(v, (dict, list)):
                continue
            k_idx = get_key_idx(k)
            v_idx = get_val_idx(v)
            tags.extend([k_idx, v_idx])

        # Pack feature protobuf message
        # Field 1: id (uint64)
        # Field 2: tags (packed uint32)
        # Field 3: type (enum)
        # Field 4: geometry (packed uint32)
        feat_bytes = bytearray()
        if uid.isdigit():
            feat_bytes.extend(b'\x08' + _varint(int(uid)))

        if tags:
            tag_buf = bytearray()
            for t in tags:
                tag_buf.extend(_varint(t))
            feat_bytes.extend(b'\x12' + _varint(len(tag_buf)) + tag_buf)

        feat_bytes.extend(b'\x18' + _varint(mvt_geom_type))

        geom_buf = bytearray()
        for c in geom_cmds:
            geom_buf.extend(_varint(c))
        feat_bytes.extend(b'\x22' + _varint(len(geom_buf)) + geom_buf)

        encoded_features.append(bytes(feat_bytes))

    if not encoded_features:
        return None

    # Pack Layer message:
    # Field 1: name (string)
    # Field 2: features (repeated Feature)
    # Field 3: keys (repeated string)
    # Field 4: values (repeated Value)
    # Field 5: extent (uint32)
    # Field 15: version (uint32 = 2)
    layer_bytes = bytearray()
    # Name
    layer_name_bytes = layer_name.encode("utf-8")
    layer_bytes.extend(b'\x0a' + _varint(len(layer_name_bytes)) + layer_name_bytes)

    # Features
    for fb in encoded_features:
        layer_bytes.extend(b'\x12' + _varint(len(fb)) + fb)

    # Keys
    for k in keys_list:
        kb = k.encode("utf-8")
        layer_bytes.extend(b'\x1a' + _varint(len(kb)) + kb)

    # Values
    for v in values_list:
        v_bytes = bytearray()
        vt = v["type"]
        val = v["value"]
        if vt == "str":
            vb = str(val).encode("utf-8")
            v_bytes.extend(b'\x0a' + _varint(len(vb)) + vb)
        elif vt == "float":
            v_bytes.extend(b'\x15' + struct.pack("<f", float(val)))
        elif vt == "double":
            v_bytes.extend(b'\x19' + struct.pack("<d", float(val)))
        elif vt == "int":
            v_bytes.extend(b'\x20' + _varint(int(val)))
        elif vt == "bool":
            v_bytes.extend(b'\x38' + (b'\x01' if val else b'\x00'))
        layer_bytes.extend(b'\x22' + _varint(len(v_bytes)) + v_bytes)

    # Extent (Field 5 = uint32, wire_type 0: (5 << 3) | 0 = 40 = 0x28)
    layer_bytes.extend(b'\x28' + _varint(extent))

    # Version (Field 15 = uint32, wire_type 0: (15 << 3) | 0 = 120 = 0x78)
    layer_bytes.extend(b'\x78\x02')

    # Wrap in Tile message: Field 3 = layers (repeated message, wire_type 2: (3 << 3) | 2 = 26 = 0x1a)
    tile_bytes = b'\x1a' + _varint(len(layer_bytes)) + bytes(layer_bytes)
    return tile_bytes


# --- Role-Scoped MVT LRU Cache ---

def get_layer_tile_version(layer_id: str) -> int:
    return _LAYER_TILE_VERSIONS.get(str(layer_id), 1)


def invalidate_mvt_cache_for_layer(layer_id: str) -> None:
    """Purges cached tiles for a layer and increments its tile version."""
    str_lid = str(layer_id)
    with _MVT_CACHE_LOCK:
        _LAYER_TILE_VERSIONS[str_lid] = _LAYER_TILE_VERSIONS.get(str_lid, 1) + 1
        prefix = f"{str_lid}:"
        keys_to_del = [k for k in _MVT_LRU_CACHE.keys() if k.startswith(prefix)]
        for k in keys_to_del:
            _MVT_LRU_CACHE.pop(k, None)


def get_cached_mvt_tile(layer_id: str, role: str, z: int, x: int, y: int) -> Optional[bytes]:
    key = f"{layer_id}:{role}:{z}:{x}:{y}"
    with _MVT_CACHE_LOCK:
        if key in _MVT_LRU_CACHE:
            _MVT_LRU_CACHE.move_to_end(key)
            return _MVT_LRU_CACHE[key]
    return None


def set_cached_mvt_tile(layer_id: str, role: str, z: int, x: int, y: int, data: bytes) -> None:
    key = f"{layer_id}:{role}:{z}:{x}:{y}"
    with _MVT_CACHE_LOCK:
        _MVT_LRU_CACHE[key] = data
        if len(_MVT_LRU_CACHE) > _MVT_LRU_MAX:
            _MVT_LRU_CACHE.popitem(last=False)


# ============================================================================
# 3. HIGH-SPEED RASTER TILE STREAMING (MBTiles B-Tree)
# ============================================================================

def get_mbtiles_connection(mbtiles_path: str) -> Optional[sqlite3.Connection]:
    """Cached read-only thread-local connection for MBTiles archive."""
    abs_path = os.path.abspath(mbtiles_path)
    if not os.path.exists(abs_path):
        return None

    tl_key = f"mbtiles_conn_{abs_path}"
    conn = getattr(_THREAD_LOCAL, tl_key, None)
    if conn is None:
        try:
            conn = sqlite3.connect(
                f"file:{abs_path}?mode=ro",
                uri=True,
                check_same_thread=False,
                timeout=15.0
            )
            conn.execute("PRAGMA query_only = 1;")
            conn.execute("PRAGMA read_uncommitted = 1;")
            conn.execute("PRAGMA mmap_size = 268435456;")
            conn.execute("PRAGMA cache_size = -64000;")
            setattr(_THREAD_LOCAL, tl_key, conn)
        except Exception as e:
            print(f"[MBTILES-CONN] Error opening {abs_path}: {e}")
            return None
    return conn


def fetch_raster_mbtiles_tile(
    mbtiles_path: str,
    z: int, x: int, y: int
) -> Optional[Tuple[bytes, str]]:
    """
    Fetches raw tile blob from MBTiles archive using XYZ -> TMS row conversion:
      tile_row = (1 << z) - 1 - y
    Returns (tile_bytes, media_type) or None if tile does not exist.
    """
    conn = get_mbtiles_connection(mbtiles_path)
    if not conn:
        return None

    try:
        cur = conn.cursor()
        tms_y = (1 << z) - 1 - y

        # 1. Standard MBTiles TMS row convention
        cur.execute(
            "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
            (z, x, tms_y)
        )
        row = cur.fetchone()

        # 2. Direct XYZ convention fallback
        if not row:
            cur.execute(
                "SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?",
                (z, x, y)
            )
            row = cur.fetchone()

        if row and row[0]:
            blob = row[0]
            # Magic byte format sniffing
            media_type = "image/png"
            if len(blob) >= 12 and blob[:4] == b'RIFF' and blob[8:12] == b'WEBP':
                media_type = "image/webp"
            elif blob.startswith(b'\x89PNG'):
                media_type = "image/png"
            elif blob.startswith(b'\xff\xd8\xff'):
                media_type = "image/jpeg"
            elif blob.startswith(b'\x1f\x8b'):
                media_type = "application/x-protobuf"

            return blob, media_type
    except Exception as e:
        print(f"[MBTILES-STREAM] Read error at {z}/{x}/{y}: {e}")
    return None


# ============================================================================
# 4. LIVE VIEWPORT ANALYTICS & FEATURE INSPECTION
# ============================================================================

def get_layer_feature_count(layer_id: str) -> int:
    """Returns count of indexed features in SQLite spatial store."""
    conn = get_spatial_db_conn()
    cur = conn.cursor()
    variants = resolve_layer_id_variants(layer_id)
    placeholders = ",".join("?" for _ in variants)
    cur.execute(f"SELECT count(*) FROM feature_records WHERE layer_id IN ({placeholders})", list(variants))
    row = cur.fetchone()
    return int(row[0]) if row else 0


def get_feature_by_uid(feature_uid: Any, layer_id: Optional[str] = None) -> Optional[Dict[str, Any]]:
    """Retrieves full GeoJSON feature from SQLite spatial store by feature_uid or id with resilient format matching."""
    conn = get_spatial_db_conn()
    cur = conn.cursor()
    f_str = str(feature_uid).strip()

    cands = [f_str]
    if f_str.isdigit():
        cands.append(f"{f_str}.0")
    elif f_str.endswith(".0"):
        cands.append(f_str[:-2])
    try:
        flt = float(f_str)
        cands.append(str(int(flt)))
        cands.append(str(flt))
    except Exception:
        pass
    cands = list(dict.fromkeys(cands))
    int_id = int(f_str) if f_str.isdigit() else (int(float(f_str)) if f_str.replace(".", "", 1).isdigit() else -1)
    cand_ph = ",".join("?" for _ in cands)

    if layer_id:
        variants = resolve_layer_id_variants(layer_id)
        placeholders = ",".join("?" for _ in variants)
        sql = f"""
            SELECT feature_uid, geom_type, geometry_json, properties_json, layer_id
            FROM feature_records
            WHERE (
                feature_uid IN ({cand_ph})
                OR id = ?
                OR json_extract(properties_json, '$._id') IN ({cand_ph})
                OR json_extract(properties_json, '$.id') IN ({cand_ph})
                OR json_extract(properties_json, '$.gid') IN ({cand_ph})
            )
            AND layer_id IN ({placeholders})
            LIMIT 1
        """
        cur.execute(sql, cands + [int_id] + cands + cands + cands + list(variants))
    else:
        cur.execute(f"""
            SELECT feature_uid, geom_type, geometry_json, properties_json, layer_id
            FROM feature_records
            WHERE (
                feature_uid IN ({cand_ph})
                OR id = ?
                OR json_extract(properties_json, '$._id') IN ({cand_ph})
                OR json_extract(properties_json, '$.id') IN ({cand_ph})
                OR json_extract(properties_json, '$.gid') IN ({cand_ph})
            )
            LIMIT 1
        """, cands + [int_id] + cands + cands + cands)

    row = cur.fetchone()
    if not row:
        return None

    try:
        f_uid, geom_type, geom_str, props_str, l_id = row
        geom = json.loads(geom_str)
        props = json.loads(props_str)
        return {
            "type": "Feature",
            "id": f_uid,
            "geometry": geom,
            "properties": props,
            "_layer_id": l_id,
        }
    except Exception as e:
        print(f"[SPATIAL-ENGINE] Error deserializing feature {feature_uid}: {e}")
        return None


def compute_live_spatial_analytics(layer_id: str, bbox: Optional[List[float]] = None) -> Dict[str, Any]:
    """
    Queries SQLite R-Tree for spatial features and aggregates live metrics
    (feature count, area sum, building types, categories, breakdown) in < 5ms.
    """
    conn = get_spatial_db_conn()
    cur = conn.cursor()
    str_lid = str(layer_id)
    variants = resolve_layer_id_variants(layer_id)
    placeholders = ",".join("?" for _ in variants)

    if bbox and len(bbox) == 4:
        min_x, min_y, max_x, max_y = bbox
        cur.execute(f"""
            SELECT f.feature_uid, f.geom_type, f.area_m2, f.length_m, f.properties_json
            FROM features_rtree r
            JOIN feature_records f ON r.id = f.id
            WHERE f.layer_id IN ({placeholders})
              AND r.max_x >= ? AND r.min_x <= ?
              AND r.max_y >= ? AND r.min_y <= ?
        """, list(variants) + [min_x, max_x, min_y, max_y])
    else:
        cur.execute(f"""
            SELECT feature_uid, geom_type, area_m2, length_m, properties_json
            FROM feature_records
            WHERE layer_id IN ({placeholders})
        """, list(variants))

    rows = cur.fetchall()
    total_features = len(rows)
    total_area = sum(r[2] for r in rows)
    total_length = sum(r[3] for r in rows)

    type_counts: Dict[str, int] = {}
    ward_counts: Dict[str, int] = {}

    for r in rows:
        try:
            props = json.loads(r[4])
            b_type = str(props.get("building_type") or props.get("type") or props.get("category") or "General")
            type_counts[b_type] = type_counts.get(b_type, 0) + 1

            w = props.get("ward") or props.get("ward_no")
            if w is not None:
                w_str = f"Ward {w}"
                ward_counts[w_str] = ward_counts.get(w_str, 0) + 1
        except Exception:
            continue

    return {
        "layer_id": str_lid,
        "total_features": total_features,
        "total_area_m2": round(total_area, 2),
        "total_length_m": round(total_length, 2),
        "type_breakdown": type_counts,
        "ward_breakdown": ward_counts,
        "is_viewport_filtered": bbox is not None
    }


# ============================================================================
# 5. ATOMIC FAST FEATURE CRUD OPERATIONS (< 3ms)
# ============================================================================

def add_feature_to_spatial_index(
    layer_id: Union[str, int],
    feat: Dict[str, Any],
    source_crs: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Atomically adds a single GeoJSON feature to SQLite R-Tree and feature_records.
    Executes in < 3ms without wiping or rebuilding existing features.
    """
    str_lid = str(layer_id)
    geom = feat.get("geometry") or feat.get("geom_geojson") or {}
    if not geom or not isinstance(geom, dict) or not geom.get("coordinates"):
        raise ValueError("Invalid feature geometry")

    # Reproject coordinates if needed
    reproj_coords, _ = detect_and_reproject_coords(geom["coordinates"], source_crs)
    normalized_geom = {
        "type": geom.get("type", "Polygon"),
        "coordinates": reproj_coords,
    }

    props = dict(feat.get("properties") or {})

    with _SPATIAL_DB_LOCK:
        with InterProcessFileLock():
            conn = get_spatial_db_conn()
            _init_spatial_db_schema(conn)
            for attempt in range(6):
                try:
                    conn.execute("PRAGMA busy_timeout = 10000;")
                    conn.execute("BEGIN IMMEDIATE;")
                    cur = conn.cursor()

                    # Next record ID
                    cur.execute("SELECT COALESCE(MAX(id), 0) FROM feature_records")
                    rec_id = (cur.fetchone()[0] or 0) + 1

                    f_uid = str(feat.get("id") or props.get("id") or props.get("record_id") or props.get("_id") or f"{str_lid}_{rec_id}")
                    props["feature_uid"] = f_uid
                    props["_id"] = rec_id

                    bbox, area_m2, length_m, v_count = compute_geometry_metrics(normalized_geom, props)
                    min_x, min_y, max_x, max_y = bbox
                    g_type = normalized_geom["type"]
                    importance = calculate_feature_importance(props, g_type, area_m2, length_m)

                    cur.execute(
                        "INSERT OR REPLACE INTO features_rtree (id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)",
                        (rec_id, min_x, max_x, min_y, max_y),
                    )
                    cur.execute(
                        """
                        INSERT OR REPLACE INTO feature_records (id, layer_id, feature_uid, geom_type, area_m2, length_m, vertex_count, importance, geometry_json, properties_json)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            rec_id,
                            str_lid,
                            f_uid,
                            g_type,
                            area_m2,
                            length_m,
                            v_count,
                            importance,
                            json.dumps(normalized_geom, separators=(",", ":")),
                            json.dumps(props, separators=(",", ":"), ensure_ascii=False),
                        ),
                    )
                    conn.commit()
                    break
                except sqlite3.OperationalError as e:
                    if ("locked" in str(e).lower() or "busy" in str(e).lower()) and attempt < 5:
                        time.sleep(0.05 * (attempt + 1))
                        continue
                    raise

    # Invalidate tile cache and increment tile version
    _LAYER_TILE_VERSIONS[str_lid] = _LAYER_TILE_VERSIONS.get(str_lid, 0) + 1
    invalidate_mvt_cache_for_layer(str_lid)

    return {
        "type": "Feature",
        "id": rec_id,
        "geometry": normalized_geom,
        "properties": props,
        "_layer_id": str_lid,
    }


def delete_feature_from_spatial_index(layer_id: Union[str, int], feature_uid_or_id: Any) -> bool:
    """
    Atomically removes a feature from features_rtree and feature_records.
    Executes in < 3ms with resilient ID matching across all numeric/string formats.
    """
    str_lid = str(layer_id)
    f_str = str(feature_uid_or_id).strip()

    cands = [f_str]
    if f_str.isdigit():
        cands.append(f"{f_str}.0")
    elif f_str.endswith(".0"):
        cands.append(f_str[:-2])
    try:
        flt = float(f_str)
        cands.append(str(int(flt)))
        cands.append(str(flt))
    except Exception:
        pass
    cands = list(dict.fromkeys(cands))
    int_id = int(f_str) if f_str.isdigit() else (int(float(f_str)) if f_str.replace(".", "", 1).isdigit() else -1)
    cand_ph = ",".join("?" for _ in cands)

    variants = resolve_layer_id_variants(str_lid)
    placeholders = ",".join("?" for _ in variants)

    with _SPATIAL_DB_LOCK:
        with InterProcessFileLock():
            conn = get_spatial_db_conn()
            _init_spatial_db_schema(conn)
            for attempt in range(6):
                try:
                    conn.execute("PRAGMA busy_timeout = 10000;")
                    conn.execute("BEGIN IMMEDIATE;")
                    cur = conn.cursor()

                    cur.execute(
                        f"""
                        SELECT id FROM feature_records
                        WHERE (
                            feature_uid IN ({cand_ph})
                            OR id = ?
                            OR json_extract(properties_json, '$._id') IN ({cand_ph})
                            OR json_extract(properties_json, '$.id') IN ({cand_ph})
                            OR json_extract(properties_json, '$.gid') IN ({cand_ph})
                        )
                        AND layer_id IN ({placeholders})
                        """,
                        cands + [int_id] + cands + cands + cands + list(variants),
                    )
                    rows = cur.fetchall()
                    if not rows:
                        cur.execute(
                            f"""
                            SELECT id FROM feature_records
                            WHERE (
                                feature_uid IN ({cand_ph})
                                OR id = ?
                                OR json_extract(properties_json, '$._id') IN ({cand_ph})
                                OR json_extract(properties_json, '$.id') IN ({cand_ph})
                                OR json_extract(properties_json, '$.gid') IN ({cand_ph})
                            )
                            """,
                            cands + [int_id] + cands + cands + cands,
                        )
                        rows = cur.fetchall()

                    if not rows:
                        conn.rollback()
                        return False

                    row_ids = [r[0] for r in rows]
                    cur.executemany("DELETE FROM features_rtree WHERE id = ?", [(rid,) for rid in row_ids])
                    cur.executemany("DELETE FROM feature_records WHERE id = ?", [(rid,) for rid in row_ids])
                    conn.commit()
                    break
                except sqlite3.OperationalError as e:
                    if ("locked" in str(e).lower() or "busy" in str(e).lower()) and attempt < 5:
                        time.sleep(0.05 * (attempt + 1))
                        continue
                    raise

    _LAYER_TILE_VERSIONS[str_lid] = _LAYER_TILE_VERSIONS.get(str_lid, 0) + 1
    invalidate_mvt_cache_for_layer(str_lid)
    return True


def update_feature_in_spatial_index(
    layer_id: Union[str, int],
    feature_uid_or_id: Any,
    geom: Optional[Dict[str, Any]] = None,
    props: Optional[Dict[str, Any]] = None,
    source_crs: Optional[str] = None,
) -> Optional[Dict[str, Any]]:
    """
    Atomically updates geometry and/or attributes of a feature in SQLite R-Tree and feature_records.
    """
    str_lid = str(layer_id)
    f_str = str(feature_uid_or_id).strip()
    int_id = int(f_str) if f_str.isdigit() else -1
    variants = resolve_layer_id_variants(str_lid)
    placeholders = ",".join("?" for _ in variants)

    with _SPATIAL_DB_LOCK:
        with InterProcessFileLock():
            conn = get_spatial_db_conn()
            _init_spatial_db_schema(conn)
            for attempt in range(6):
                try:
                    conn.execute("PRAGMA busy_timeout = 10000;")
                    conn.execute("BEGIN IMMEDIATE;")
                    cur = conn.cursor()

                    cur.execute(
                        f"""
                        SELECT id, feature_uid, geom_type, geometry_json, properties_json
                        FROM feature_records
                        WHERE (feature_uid = ? OR id = ?) AND layer_id IN ({placeholders})
                        LIMIT 1
                        """,
                        [f_str, int_id] + list(variants),
                    )
                    row = cur.fetchone()
                    if not row:
                        conn.rollback()
                        return None

                    rec_id, f_uid, old_gtype, old_geom_str, old_props_str = row
                    current_geom = json.loads(old_geom_str)
                    current_props = json.loads(old_props_str)

                    if geom and isinstance(geom, dict) and geom.get("coordinates"):
                        reproj_coords, _ = detect_and_reproject_coords(geom["coordinates"], source_crs)
                        current_geom = {
                            "type": geom.get("type", old_gtype),
                            "coordinates": reproj_coords,
                        }

                    if props and isinstance(props, dict):
                        current_props.update(props)

                    bbox, area_m2, length_m, v_count = compute_geometry_metrics(current_geom, current_props)
                    min_x, min_y, max_x, max_y = bbox
                    g_type = current_geom["type"]
                    importance = calculate_feature_importance(current_props, g_type, area_m2, length_m)

                    cur.execute(
                        "INSERT OR REPLACE INTO features_rtree (id, min_x, max_x, min_y, max_y) VALUES (?, ?, ?, ?, ?)",
                        (rec_id, min_x, max_x, min_y, max_y),
                    )
                    cur.execute(
                        """
                        UPDATE feature_records
                        SET geom_type = ?, area_m2 = ?, length_m = ?, vertex_count = ?, importance = ?, geometry_json = ?, properties_json = ?
                        WHERE id = ?
                        """,
                        (
                            g_type,
                            area_m2,
                            length_m,
                            v_count,
                            importance,
                            json.dumps(current_geom, separators=(",", ":")),
                            json.dumps(current_props, separators=(",", ":"), ensure_ascii=False),
                            rec_id,
                        ),
                    )
                    conn.commit()
                    break
                except sqlite3.OperationalError as e:
                    if ("locked" in str(e).lower() or "busy" in str(e).lower()) and attempt < 5:
                        time.sleep(0.05 * (attempt + 1))
                        continue
                    raise

    _LAYER_TILE_VERSIONS[str_lid] = _LAYER_TILE_VERSIONS.get(str_lid, 0) + 1
    invalidate_mvt_cache_for_layer(str_lid)
    return {
        "type": "Feature",
        "id": rec_id,
        "geometry": current_geom,
        "properties": current_props,
        "_layer_id": str_lid,
    }


def query_spatial_features(
    layer_id: Union[str, int],
    bbox: Optional[Tuple[float, float, float, float]] = None,
    limit: int = 2500,
) -> List[Dict[str, Any]]:
    """
    Returns a list of GeoJSON features from SQLite spatial store.
    """
    conn = get_spatial_db_conn()
    cur = conn.cursor()
    str_lid = str(layer_id)
    variants = resolve_layer_id_variants(str_lid)
    placeholders = ",".join("?" for _ in variants)

    if bbox and len(bbox) == 4:
        min_x, min_y, max_x, max_y = bbox
        cur.execute(
            f"""
            SELECT f.id, f.feature_uid, f.geometry_json, f.properties_json
            FROM features_rtree r
            JOIN feature_records f ON r.id = f.id
            WHERE f.layer_id IN ({placeholders})
              AND r.max_x >= ? AND r.min_x <= ?
              AND r.max_y >= ? AND r.min_y <= ?
            LIMIT ?
            """,
            list(variants) + [min_x, max_x, min_y, max_y, limit],
        )
    else:
        cur.execute(
            f"""
            SELECT id, feature_uid, geometry_json, properties_json
            FROM feature_records
            WHERE layer_id IN ({placeholders})
            LIMIT ?
            """,
            list(variants) + [limit],
        )

    results = []
    for row in cur.fetchall():
        try:
            rec_id, f_uid, geom_str, props_str = row
            geom = json.loads(geom_str)
            props = json.loads(props_str)
            props["_id"] = rec_id
            props["feature_uid"] = f_uid
            results.append({
                "type": "Feature",
                "id": rec_id,
                "geometry": geom,
                "properties": props,
                "_layer_id": str_lid,
            })
        except Exception:
            continue
    return results


def check_unique_field_value_exists(
    layer_id: Union[str, int],
    field_name: str,
    field_value: Any,
    exclude_feature_id: Optional[Any] = None,
) -> bool:
    """
    Checks if a given field value already exists within a layer in spatial_features.db.
    """
    conn = get_spatial_db_conn()
    cur = conn.cursor()
    str_lid = str(layer_id)
    variants = resolve_layer_id_variants(str_lid)
    placeholders = ",".join("?" for _ in variants)
    target_val_str = str(field_value).strip().lower()

    cur.execute(
        f"""
        SELECT id, feature_uid, properties_json
        FROM feature_records
        WHERE layer_id IN ({placeholders})
        """,
        list(variants),
    )
    for r in cur.fetchall():
        r_id, f_uid, props_str = r
        if exclude_feature_id is not None and (str(r_id) == str(exclude_feature_id) or str(f_uid) == str(exclude_feature_id)):
            continue
        try:
            props = json.loads(props_str)
            val = props.get(field_name)
            if val is not None and str(val).strip().lower() == target_val_str:
                return True
        except Exception:
            continue
    return False


def apply_layer_primary_key_sqlite(
    layer_id: Union[str, int],
    primary_key_field: str,
    autogenerate_missing: bool = True,
    prefix: Optional[str] = None,
) -> Dict[str, Any]:
    """
    Enforces and audits a Primary Key / Unique ID field across all feature records of a layer in SQLite.
    For any feature where the primary key is null, empty string, or duplicate:
    Auto-generates a guaranteed unique ID with custom/derived prefix and sequential counter.
    Returns audit summary with total features, count of auto-generated IDs, and audit records.
    """
    str_lid = str(layer_id)
    variants = resolve_layer_id_variants(str_lid)
    placeholders = ",".join("?" for _ in variants)

    pfx = str(prefix).strip() if prefix else ""
    if not pfx:
        clean_field = re.sub(r'[^a-zA-Z0-9]', '', primary_key_field).upper()[:4] or "UID"
        pfx = f"KMC-{clean_field}-"

    with _SPATIAL_DB_LOCK:
        with InterProcessFileLock():
            conn = get_spatial_db_conn()
            _init_spatial_db_schema(conn)
            cur = conn.cursor()
            cur.execute(
                f"""
                SELECT id, feature_uid, properties_json
                FROM feature_records
                WHERE layer_id IN ({placeholders})
                ORDER BY id ASC
                """,
                list(variants),
            )
            rows = cur.fetchall()

            total_features = len(rows)
            seen_values = set()
            audit_records = []
            updates = []

            # Pass 1: Collect valid, unique existing non-empty values
            candidates_for_autogen = []
            for row_id, feat_uid, props_json in rows:
                try:
                    props = json.loads(props_json) if props_json else {}
                except Exception:
                    props = {}
                val = props.get(primary_key_field)
                if val is None or str(val).strip().lower() in ("", "null", "none", "nan", "undefined"):
                    candidates_for_autogen.append((row_id, feat_uid, props, val, "empty_or_null"))
                else:
                    str_val = str(val).strip()
                    if str_val in seen_values:
                        candidates_for_autogen.append((row_id, feat_uid, props, val, "duplicate"))
                    else:
                        seen_values.add(str_val)

            # Pass 2: If autogenerate_missing is True, generate unique IDs
            if autogenerate_missing:
                seq = 1
                for row_id, feat_uid, props, orig_val, reason in candidates_for_autogen:
                    candidate_id = f"{pfx}{seq:05d}"
                    while candidate_id in seen_values:
                        seq += 1
                        candidate_id = f"{pfx}{seq:05d}"
                    seen_values.add(candidate_id)
                    seq += 1

                    props[primary_key_field] = candidate_id
                    props["_id"] = candidate_id
                    new_props_json = json.dumps(props)
                    new_feat_uid = candidate_id

                    updates.append((new_props_json, new_feat_uid, row_id))
                    audit_records.append({
                        "id": row_id,
                        "feature_id": row_id,
                        "old_value": orig_val if orig_val is not None else "(खाली / Null)",
                        "generated_value": candidate_id,
                        "reason": "खाली/नल (Empty/Null)" if reason == "empty_or_null" else "दोहोरिएको मान (Duplicate)",
                    })

                if updates:
                    conn.execute("PRAGMA busy_timeout = 10000;")
                    conn.execute("BEGIN IMMEDIATE;")
                    cur.executemany(
                        "UPDATE feature_records SET properties_json = ?, feature_uid = ? WHERE id = ?",
                        updates,
                    )
                    conn.commit()

    _LAYER_TILE_VERSIONS[str_lid] = _LAYER_TILE_VERSIONS.get(str_lid, 0) + 1
    invalidate_mvt_cache_for_layer(str_lid)

    return {
        "layer_id": layer_id,
        "primary_key_field": primary_key_field,
        "prefix": pfx,
        "total_features": total_features,
        "total_autogenerated": len(audit_records),
        "audit_samples": audit_records[:200],
        "all_audit_records": audit_records,
    }

