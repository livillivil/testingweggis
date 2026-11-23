"""
KMC-GIS-SERVER Safe Savepoint Migration Engine & Async Database Session (backend/app/db.py)
Follows "Build Once, Run Anywhere": initializes the database engine lazily at runtime using
container environment variables rather than import-time or build-time baked credentials.
"""

import os
from typing import Optional
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker, AsyncSession, AsyncEngine
from sqlalchemy import text

from .models import Base
from .config import settings

_engine: Optional[AsyncEngine] = None
_session_factory: Optional[async_sessionmaker[AsyncSession]] = None


def get_engine() -> AsyncEngine:
    """Lazily creates the SQLAlchemy AsyncEngine at runtime from environment variables."""
    global _engine
    if _engine is None:
        pool_size = settings.db_pool_size
        max_overflow = settings.db_max_overflow
        pool_timeout = int(os.getenv("DB_POOL_TIMEOUT", "30"))
        pool_recycle = int(os.getenv("DB_POOL_RECYCLE", "1800"))
        _engine = create_async_engine(
            settings.database_url,
            pool_size=pool_size,
            max_overflow=max_overflow,
            pool_timeout=pool_timeout,
            pool_recycle=pool_recycle,
            pool_pre_ping=True,
            connect_args={"statement_cache_size": 0},
            echo=False,
        )
    return _engine


def get_session_factory() -> async_sessionmaker[AsyncSession]:
    """Lazily returns the runtime session maker."""
    global _session_factory
    if _session_factory is None:
        _session_factory = async_sessionmaker(
            get_engine(),
            expire_on_commit=False,
            class_=AsyncSession,
        )
    return _session_factory


SAFE_MIGRATION_STATEMENTS = [
    "CREATE EXTENSION IF NOT EXISTS postgis;",
    "CREATE EXTENSION IF NOT EXISTS pg_trgm;",
    # Runtime ids are epoch milliseconds; widen every id/FK column that stores them.
    # Guarded via information_schema.columns so already-migrated databases do NOT
    # acquire ACCESS EXCLUSIVE locks or drop/re-add foreign keys on restart.
    """
    DO $$
    DECLARE r record;
    BEGIN
      IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND (
            (table_name = 'survey_projects' AND column_name IN ('id', 'aoi_source_layer_id'))
            OR (table_name = 'task_grids' AND column_name IN ('id', 'project_id'))
            OR (table_name = 'task_invalidation_history' AND column_name = 'task_grid_id')
            OR (table_name = 'vector_layers' AND column_name IN ('id', 'project_id'))
            OR (table_name = 'vector_features' AND column_name IN ('layer_id', 'task_grid_id'))
            OR (table_name = 'offline_packages' AND column_name IN ('package_id', 'project_id', 'task_grid_id'))
          )
          AND data_type <> 'bigint'
      ) THEN
        FOR r IN
          SELECT conrelid::regclass AS tbl, conname
          FROM pg_constraint
          WHERE contype = 'f'
            AND confrelid IN ('survey_projects'::regclass, 'task_grids'::regclass, 'vector_layers'::regclass)
        LOOP
          EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
        END LOOP;

        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'survey_projects' AND column_name = 'id' AND data_type <> 'bigint') THEN
          ALTER TABLE survey_projects ALTER COLUMN id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'survey_projects' AND column_name = 'aoi_source_layer_id' AND data_type <> 'bigint') THEN
          ALTER TABLE survey_projects ALTER COLUMN aoi_source_layer_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'task_grids' AND column_name = 'id' AND data_type <> 'bigint') THEN
          ALTER TABLE task_grids ALTER COLUMN id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'task_grids' AND column_name = 'project_id' AND data_type <> 'bigint') THEN
          ALTER TABLE task_grids ALTER COLUMN project_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'task_invalidation_history' AND column_name = 'task_grid_id' AND data_type <> 'bigint') THEN
          ALTER TABLE task_invalidation_history ALTER COLUMN task_grid_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vector_layers' AND column_name = 'id' AND data_type <> 'bigint') THEN
          ALTER TABLE vector_layers ALTER COLUMN id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vector_layers' AND column_name = 'project_id' AND data_type <> 'bigint') THEN
          ALTER TABLE vector_layers ALTER COLUMN project_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vector_features' AND column_name = 'layer_id' AND data_type <> 'bigint') THEN
          ALTER TABLE vector_features ALTER COLUMN layer_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'vector_features' AND column_name = 'task_grid_id' AND data_type <> 'bigint') THEN
          ALTER TABLE vector_features ALTER COLUMN task_grid_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'offline_packages' AND column_name = 'package_id' AND data_type <> 'bigint') THEN
          ALTER TABLE offline_packages ALTER COLUMN package_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'offline_packages' AND column_name = 'project_id' AND data_type <> 'bigint') THEN
          ALTER TABLE offline_packages ALTER COLUMN project_id TYPE BIGINT;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'offline_packages' AND column_name = 'task_grid_id' AND data_type <> 'bigint') THEN
          ALTER TABLE offline_packages ALTER COLUMN task_grid_id TYPE BIGINT;
        END IF;

        -- Re-create the dropped constraints; NOT VALID keeps legacy orphan rows loadable
        -- while still enforcing integrity on every new write.
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_grids_project_id_fkey') THEN
          ALTER TABLE task_grids ADD CONSTRAINT task_grids_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey_projects(id) ON DELETE CASCADE NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'task_invalidation_history_task_grid_id_fkey') THEN
          ALTER TABLE task_invalidation_history ADD CONSTRAINT task_invalidation_history_task_grid_id_fkey FOREIGN KEY (task_grid_id) REFERENCES task_grids(id) ON DELETE CASCADE NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vector_layers_project_id_fkey') THEN
          ALTER TABLE vector_layers ADD CONSTRAINT vector_layers_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey_projects(id) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vector_features_layer_id_fkey') THEN
          ALTER TABLE vector_features ADD CONSTRAINT vector_features_layer_id_fkey FOREIGN KEY (layer_id) REFERENCES vector_layers(id) ON DELETE CASCADE NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vector_features_task_grid_id_fkey') THEN
          ALTER TABLE vector_features ADD CONSTRAINT vector_features_task_grid_id_fkey FOREIGN KEY (task_grid_id) REFERENCES task_grids(id) ON DELETE SET NULL NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offline_packages_project_id_fkey') THEN
          ALTER TABLE offline_packages ADD CONSTRAINT offline_packages_project_id_fkey FOREIGN KEY (project_id) REFERENCES survey_projects(id) NOT VALID;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'offline_packages_task_grid_id_fkey') THEN
          ALTER TABLE offline_packages ADD CONSTRAINT offline_packages_task_grid_id_fkey FOREIGN KEY (task_grid_id) REFERENCES task_grids(id) NOT VALID;
        END IF;
      END IF;
    END $$;
    """,
    # Ensure vector_features.task_grid_id FK uses ON DELETE SET NULL without touching
    # the table if it is already configured.
    """
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'vector_features_task_grid_id_fkey'
          AND confdeltype <> 'n'
      ) THEN
        ALTER TABLE vector_features DROP CONSTRAINT vector_features_task_grid_id_fkey;
        ALTER TABLE vector_features ADD CONSTRAINT vector_features_task_grid_id_fkey
          FOREIGN KEY (task_grid_id) REFERENCES task_grids(id) ON DELETE SET NULL NOT VALID;
      END IF;
    END $$;
    """,
    """
    DO $$
    BEGIN
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vector_features_created_by_fkey') THEN
        ALTER TABLE vector_features DROP CONSTRAINT vector_features_created_by_fkey;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vector_features_updated_by_fkey') THEN
        ALTER TABLE vector_features DROP CONSTRAINT vector_features_updated_by_fkey;
      END IF;
      IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'vector_features_reviewed_by_fkey') THEN
        ALTER TABLE vector_features DROP CONSTRAINT vector_features_reviewed_by_fkey;
      END IF;
    END $$;
    """,
    "ALTER TABLE survey_projects ADD COLUMN IF NOT EXISTS aoi_source_type VARCHAR(50) DEFAULT 'selected_features';",
    "ALTER TABLE survey_projects ADD COLUMN IF NOT EXISTS aoi_source_layer_id BIGINT;",
    "ALTER TABLE survey_projects ADD COLUMN IF NOT EXISTS aoi_source_feature_ids JSONB DEFAULT '[]'::jsonb;",
    "ALTER TABLE survey_projects ADD COLUMN IF NOT EXISTS grid_shape VARCHAR(50) DEFAULT 'HEXAGON';",
    "ALTER TABLE survey_projects ADD COLUMN IF NOT EXISTS grid_params JSONB DEFAULT '{}'::jsonb;",
    "ALTER TABLE survey_projects ADD COLUMN IF NOT EXISTS offline_layer_ids JSONB DEFAULT '[]'::jsonb;",
    "ALTER TABLE task_grids ADD COLUMN IF NOT EXISTS grid_shape VARCHAR(50) DEFAULT 'HEXAGON';",
    "ALTER TABLE task_grids ADD COLUMN IF NOT EXISTS offline_bundle_url VARCHAR(512);",
    # AOI-clipped grid cells may be multi-part; widen the historical POLYGON typmod only if needed.
    """
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'task_grids'
          AND column_name = 'geom'
          AND udt_name = 'geometry'
      ) AND EXISTS (
        SELECT 1 FROM geometry_columns
        WHERE f_table_schema = 'public'
          AND f_table_name = 'task_grids'
          AND f_geometry_column = 'geom'
          AND upper(type) <> 'GEOMETRY'
      ) THEN
        ALTER TABLE task_grids ALTER COLUMN geom TYPE geometry(Geometry, 4326) USING ST_Force2D(geom);
      END IF;
    END $$;
    """,
    "ALTER TABLE vector_features ADD COLUMN IF NOT EXISTS record_id VARCHAR(64);",
    "ALTER TABLE vector_features ADD COLUMN IF NOT EXISTS sync_status VARCHAR(32) DEFAULT 'synced';",
    "ALTER TABLE vector_features ADD COLUMN IF NOT EXISTS qa_flags JSONB DEFAULT '[]'::jsonb;",
    "ALTER TABLE vector_features ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;",
    "ALTER TABLE vector_features ADD COLUMN IF NOT EXISTS valid_from TIMESTAMP DEFAULT NOW();",
    "ALTER TABLE vector_features ADD COLUMN IF NOT EXISTS valid_to TIMESTAMP;",
    "DROP INDEX IF EXISTS idx_vector_features_layer_geom;",
    "CREATE INDEX IF NOT EXISTS idx_vector_features_geom_gist ON vector_features USING GIST (geom);",
    "CREATE INDEX IF NOT EXISTS idx_vector_features_layer_id ON vector_features (layer_id);",
    "CREATE INDEX IF NOT EXISTS idx_vector_features_props_gin ON vector_features USING GIN (properties jsonb_path_ops);",
    "CREATE INDEX IF NOT EXISTS idx_task_grids_geom_gist ON task_grids USING GIST (geom);",
]


async def get_db():
    session_factory = get_session_factory()
    async with session_factory() as session:
        yield session


async def run_safe_savepoint_migrations():
    engine = get_engine()
    async with engine.begin() as conn:
        lock_acquired = False
        try:
            await conn.execute(text("SELECT pg_advisory_lock(hashtext('kmc_schema_migrations'))"))
            lock_acquired = True

            for ext_stmt in ("CREATE EXTENSION IF NOT EXISTS postgis;", "CREATE EXTENSION IF NOT EXISTS pg_trgm;"):
                try:
                    async with conn.begin_nested():
                        await conn.execute(text(ext_stmt))
                except Exception as exc:
                    print(f"[KMC-DB] Extension check ({ext_stmt}): {exc}")

            await conn.run_sync(Base.metadata.create_all)

            for stmt in SAFE_MIGRATION_STATEMENTS:
                try:
                    async with conn.begin_nested():
                        await conn.execute(text(stmt))
                except Exception as exc:
                    print(f"[KMC-DB] Skipped or already applied migration ({stmt[:45]}...): {exc}")
        finally:
            if lock_acquired:
                try:
                    async with conn.begin_nested():
                        await conn.execute(text("SELECT pg_advisory_unlock(hashtext('kmc_schema_migrations'))"))
                except Exception:
                    pass
