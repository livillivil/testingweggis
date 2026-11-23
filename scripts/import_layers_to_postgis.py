import asyncio
import asyncpg
import json
import os
import sys
import time

async def import_layer(conn, layer_id, layer_name, slug, geom_type, geojson_path, id_prefix, is_utm=True):
    print(f"\n--- Importing Layer: {layer_name} (ID: {layer_id}) from {geojson_path} ---")
    if not os.path.exists(geojson_path):
        print(f"File not found: {geojson_path}")
        return

    # 1. Register layer in vector_layers table
    await conn.execute('''
        INSERT INTO vector_layers (id, name, slug, geometry_type, published_in_geoportal, default_visible_in_geoportal)
        VALUES ($1, $2, $3, $4, true, true)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, geometry_type = EXCLUDED.geometry_type;
    ''', layer_id, layer_name, slug, geom_type)

    # 2. Check if already populated
    existing_count = await conn.fetchval('SELECT count(*) FROM vector_features WHERE layer_id = $1', layer_id)
    if existing_count > 0:
        print(f"Layer {layer_id} already has {existing_count} features in PostGIS. Skipping import.")
        return

    # 3. Read GeoJSON file
    t0 = time.time()
    print(f"Reading {geojson_path}...")
    with open(geojson_path, 'r', encoding='utf-8', errors='replace') as f:
        data = json.load(f)
    raw_feats = data.get('features', [])
    print(f"Loaded {len(raw_feats)} features in {time.time() - t0:.2f}s")

    # 4. Batch insert into vector_features
    # Use ST_Transform if UTM Zone 45N (EPSG:32645)
    srid_from = 32645 if is_utm else 4326
    sql = f'''
        INSERT INTO vector_features (record_id, layer_id, geom, properties, version)
        VALUES ($1, $2, ST_Multi(ST_Transform(ST_SetSRID(ST_GeomFromGeoJSON($3::text), {srid_from}), 4326)), $4::jsonb, 1)
        ON CONFLICT (record_id) DO NOTHING;
    '''

    batch_size = 2000
    batch = []
    total = len(raw_feats)
    inserted = 0
    t_start = time.time()

    for idx, f in enumerate(raw_feats):
        geom = f.get('geometry')
        if not geom or not geom.get('coordinates'):
            continue
        props = f.get('properties') or {}
        feat_raw_id = props.get('id') or props.get('gid') or idx
        rec_id = f"{id_prefix}_{feat_raw_id}_{idx}"

        geom_str = json.dumps(geom)
        props_str = json.dumps(props)
        batch.append((rec_id, layer_id, geom_str, props_str))

        if len(batch) >= batch_size:
            try:
                await conn.executemany(sql, batch)
                inserted += len(batch)
                print(f"  Inserted {inserted}/{total} features ({inserted/total*100:.1f}%) in {time.time() - t_start:.1f}s")
            except Exception as batch_err:
                print(f"  Batch error at {idx}: {batch_err}")
            batch = []

    if batch:
        try:
            await conn.executemany(sql, batch)
            inserted += len(batch)
            print(f"  Inserted {inserted}/{total} features (100.0%) in {time.time() - t_start:.1f}s")
        except Exception as batch_err:
            print(f"  Final batch error: {batch_err}")

    # 5. Analyze table
    print(f"Completed layer {layer_id}: {inserted} features inserted.")

async def main():
    pw_path = '/run/secrets/kmc_postgres_password'
    if os.path.exists(pw_path):
        with open(pw_path) as f:
            pw = f.read().strip()
    else:
        pw = 'kmc_password_2026'

    print("Connecting to PostgreSQL PostGIS...")
    conn = await asyncpg.connect(
        user='kmc_user',
        password=pw,
        database='kmc_gis',
        host='postgres',
        port=5432
    )
    print("Connected successfully!")

    # 1. Roads layer (11,331 features)
    await import_layer(
        conn,
        layer_id=1795080836506,
        layer_name='or roads',
        slug='or_roads',
        geom_type='MultiLineString',
        geojson_path='/app/uploads/layers/or_roads.geojson',
        id_prefix='road',
        is_utm=True
    )

    # 2. Building footprints layer (168,458 features)
    await import_layer(
        conn,
        layer_id=1795080840951,
        layer_name='UnetRaw',
        slug='unetraw_buildings',
        geom_type='MultiPolygon',
        geojson_path='/app/uploads/layers/UnetRaw.geojson',
        id_prefix='bldg',
        is_utm=True
    )

    print("\nRunning ANALYZE on vector_features and vector_layers...")
    await conn.execute('ANALYZE vector_features;')
    await conn.execute('ANALYZE vector_layers;')

    count_roads = await conn.fetchval('SELECT count(*) FROM vector_features WHERE layer_id = 1795080836506')
    count_bldgs = await conn.fetchval('SELECT count(*) FROM vector_features WHERE layer_id = 1795080840951')
    print(f"\nFinal PostGIS Counts:")
    print(f"  Road features: {count_roads}")
    print(f"  Building features: {count_bldgs}")

    await conn.close()

if __name__ == '__main__':
    asyncio.run(main())
