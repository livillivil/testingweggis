"""
KMC-GIS-SERVER Unified Central Enterprise PostGIS 3.4 Schema (SQLAlchemy 2.0 + GeoAlchemy2)
Preserves 100% backward compatibility with existing models while adding:
 - 6-Mode Grid Shapes (SQUARE/rectangular, TRIANGLE/triangular, CIRCULAR/circular, HEXAGON/hexagonal, RANDOM/Voronoi, STRAIGHT_SKELETON)
 - 3 AOI Source Modes (drawn_polygon, entire_layer, selected_features)
 - QFieldCloud-style FeatureDelta & OfflinePackage models
 - TaskInvalidationHistory & Bitemporal Lineage (valid_from, valid_to)
"""

import enum
from sqlalchemy import (
    Column, Integer, BigInteger, String, Text, Float, Boolean, DateTime,
    ForeignKey, Enum, Index, func,
)
from sqlalchemy.dialects.postgresql import JSONB as JSON
from sqlalchemy.orm import DeclarativeBase, relationship
from sqlalchemy.ext.asyncio import AsyncAttrs
from geoalchemy2 import Geometry


class Base(AsyncAttrs, DeclarativeBase):
    pass


class UserRole(str, enum.Enum):
    MasterAdmin = "MasterAdmin"
    SuperAdmin = "SuperAdmin"
    GisAdmin = "GisAdmin"
    DepartmentAdmin = "DepartmentAdmin"
    MunicipalUser = "MunicipalUser"  # Preserved for backward compatibility
    Validator = "Validator"
    DataCollector = "DataCollector"
    BasicViewer = "BasicViewer"


class TaskStatus(str, enum.Enum):
    READY = "READY"
    LOCKED_FOR_MAPPING = "LOCKED_FOR_MAPPING"
    MAPPED = "MAPPED"
    LOCKED_FOR_VALIDATION = "LOCKED_FOR_VALIDATION"
    VALIDATED = "VALIDATED"
    INVALIDATED = "INVALIDATED"
    BAD_IMAGERY = "BAD_IMAGERY"
    SPLIT = "SPLIT"


class GridType(str, enum.Enum):
    SQUARE = "SQUARE"
    HEXAGON = "HEXAGON"
    TRIANGLE = "TRIANGLE"
    CIRCULAR = "CIRCULAR"
    RANDOM = "RANDOM"
    STRAIGHT_SKELETON = "STRAIGHT_SKELETON"


class AoiSourceType(str, enum.Enum):
    drawn_polygon = "drawn_polygon"
    entire_layer = "entire_layer"
    selected_features = "selected_features"


class ProjectStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    COMPLETED = "COMPLETED"
    ARCHIVED = "ARCHIVED"


class ProjectMode(str, enum.Enum):
    STANDARD = "STANDARD"
    ADVANCED_QUESTIONNAIRE = "ADVANCED_QUESTIONNAIRE"


class ResponseLifecycleStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    IN_PROGRESS = "IN_PROGRESS"
    COMPLETED = "COMPLETED"
    SUBMITTED = "SUBMITTED"
    UNDER_REVIEW = "UNDER_REVIEW"
    RETURNED = "RETURNED"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class Department(Base):
    __tablename__ = "departments"
    id = Column(Integer, primary_key=True, autoincrement=True)
    code = Column(String(50), unique=True, nullable=False)
    name = Column(String(255), nullable=False)
    name_ne = Column(String(255), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class User(Base):
    __tablename__ = "users"
    id = Column(Integer, primary_key=True, autoincrement=True)
    username = Column(String(100), unique=True, nullable=False, index=True)
    email = Column(String(255), unique=True, nullable=False, index=True)
    hashed_password = Column(String(255), nullable=False)
    full_name = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), nullable=False, default=UserRole.DataCollector)
    department_id = Column(Integer, ForeignKey("departments.id"), nullable=True)
    assigned_ward = Column(Integer, nullable=True)
    is_active = Column(Boolean, default=True, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class SurveyProject(Base):
    __tablename__ = "survey_projects"
    # Runtime project ids are epoch milliseconds, which overflow PostgreSQL INTEGER.
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    department_id = Column(Integer, ForeignKey("departments.id"), nullable=True)
    name = Column(String(255), nullable=False, index=True)
    name_ne = Column(String(255), nullable=True)
    status = Column(Enum(ProjectStatus), default=ProjectStatus.ACTIVE, nullable=False)
    mode = Column(Enum(ProjectMode), default=ProjectMode.STANDARD, nullable=False)
    aoi_source_type = Column(Enum(AoiSourceType), default=AoiSourceType.selected_features)
    aoi_source_layer_id = Column(BigInteger, nullable=True)
    aoi_source_feature_ids = Column(JSON, default=list)
    boundary = Column(Geometry("MULTIPOLYGON", srid=4326), nullable=True)
    grid_shape = Column(String(50), default="HEXAGON")
    grid_params = Column(JSON, default=dict)
    offline_layer_ids = Column(JSON, default=list)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class TaskGrid(Base):
    __tablename__ = "task_grids"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    project_id = Column(BigInteger, ForeignKey("survey_projects.id", ondelete="CASCADE"), nullable=False, index=True)
    grid_index = Column(Integer, nullable=False)
    name = Column(String(255), nullable=True)
    grid_shape = Column(String(50), default="HEXAGON")
    status = Column(Enum(TaskStatus), default=TaskStatus.READY, nullable=False, index=True)
    assigned_to = Column(Integer, ForeignKey("users.id"), nullable=True)
    locked_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    locked_at = Column(DateTime, nullable=True)
    lock_expires_at = Column(DateTime, nullable=True)
    mapped_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    validated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    offline_bundle_url = Column(String(512), nullable=True)
    properties = Column(JSON, default=dict)
    # GEOMETRY (not POLYGON): AOI-clipped cells can legitimately be multi-part.
    geom = Column(Geometry("GEOMETRY", srid=4326), nullable=False)


class TaskInvalidationHistory(Base):
    __tablename__ = "task_invalidation_history"
    id = Column(Integer, primary_key=True, autoincrement=True)
    task_grid_id = Column(BigInteger, ForeignKey("task_grids.id", ondelete="CASCADE"), nullable=False, index=True)
    validator_id = Column(Integer, ForeignKey("users.id"), nullable=False)
    collector_id = Column(Integer, ForeignKey("users.id"), nullable=True)
    issue_categories = Column(JSON, default=list)
    validator_comment = Column(Text, nullable=False)
    is_resolved = Column(Boolean, default=False, nullable=False)
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class VectorLayer(Base):
    __tablename__ = "vector_layers"
    # Runtime layer ids are epoch milliseconds too.
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    project_id = Column(BigInteger, ForeignKey("survey_projects.id"), nullable=True)
    department_id = Column(Integer, ForeignKey("departments.id"), nullable=True)
    name = Column(String(255), nullable=False)
    name_ne = Column(String(255), nullable=True)
    slug = Column(String(120), unique=True, nullable=False)
    category = Column(String(120), default="Buildings & Infrastructure")
    geometry_type = Column(String(50), default="POLYGON")
    fields_config = Column(JSON, default=list)
    field_permissions = Column(JSON, default=dict)
    role_permissions = Column(JSON, default=dict)
    style = Column(JSON, default=dict)
    allow_snapping = Column(Boolean, default=True)
    editable_by_collectors = Column(Boolean, default=True)
    published_in_geoportal = Column(Boolean, default=False)
    default_visible_in_geoportal = Column(Boolean, default=False)
    deleted_at = Column(DateTime, nullable=True)


class VectorFeature(Base):
    __tablename__ = "vector_features"
    id = Column(BigInteger, primary_key=True, autoincrement=True)
    record_id = Column(String(64), unique=True, nullable=False, index=True)
    layer_id = Column(BigInteger, ForeignKey("vector_layers.id", ondelete="CASCADE"), nullable=False, index=True)
    task_grid_id = Column(BigInteger, ForeignKey("task_grids.id", ondelete="SET NULL"), nullable=True, index=True)
    geom = Column(Geometry("GEOMETRY", srid=4326), nullable=False)
    properties = Column(JSON, default=dict, nullable=False)
    departmental_facets = Column(JSON, default=dict)
    record_status = Column(Enum(ResponseLifecycleStatus), default=ResponseLifecycleStatus.SUBMITTED)
    sync_status = Column(String(32), default="synced")
    qa_flags = Column(JSON, default=list)
    review_notes = Column(Text, nullable=True)
    ward_code = Column(Integer, nullable=True, index=True)
    gps_accuracy = Column(Float, nullable=True)
    version = Column(Integer, default=1, nullable=False)
    valid_from = Column(DateTime, server_default=func.now(), nullable=False)
    valid_to = Column(DateTime, nullable=True)
    created_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    updated_by = Column(Integer, ForeignKey("users.id"), nullable=True)
    reviewed_by = Column(Integer, ForeignKey("users.id"), nullable=True)


class FeatureDelta(Base):
    __tablename__ = "feature_deltas"
    delta_id = Column(BigInteger, primary_key=True, autoincrement=True)
    record_id = Column(String(64), nullable=False, index=True)
    base_version = Column(Integer, nullable=False)
    operation = Column(String(16), nullable=False)  # CREATE, PATCH, DELETE
    old_geom = Column(Geometry("GEOMETRY", srid=4326), nullable=True)
    new_geom = Column(Geometry("GEOMETRY", srid=4326), nullable=True)
    old_properties = Column(JSON, default=dict)
    new_properties = Column(JSON, default=dict)
    apply_status = Column(String(24), default="PENDING")  # PENDING, APPLIED, CONFLICT
    created_at = Column(DateTime, server_default=func.now(), nullable=False)


class OfflinePackage(Base):
    __tablename__ = "offline_packages"
    package_id = Column(BigInteger, primary_key=True, autoincrement=True)
    project_id = Column(BigInteger, ForeignKey("survey_projects.id"), nullable=False)
    task_grid_id = Column(BigInteger, ForeignKey("task_grids.id"), nullable=True)
    aoi_geom = Column(Geometry("POLYGON", srid=4326), nullable=False)
    file_path = Column(String(512), nullable=False)
    size_bytes = Column(BigInteger, default=0)
    checksum = Column(String(64), nullable=False)
    expires_at = Column(DateTime, nullable=True)
