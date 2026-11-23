import asyncio
import asyncpg
import json
import os

async def main():
    pw_path = '/run/secrets/kmc_postgres_password'
    if os.path.exists(pw_path):
        with open(pw_path) as f:
            pw = f.read().strip()
    else:
        pw = 'kmc_password_2026'

    conn = await asyncpg.connect(
        user='kmc_user',
        password=pw,
        database='kmc_gis',
        host='postgres',
        port=5432
    )

    geom_json = json.dumps({'type': 'Point', 'coordinates': [85.32, 27.71]})
    await conn.execute('''
        INSERT INTO vector_features (record_id, layer_id, geom, properties, version)
        VALUES ($1, $2, ST_SetSRID(ST_GeomFromGeoJSON($3::text), 4326), $4::jsonb, 1)
        ON CONFLICT (record_id) DO NOTHING;
    ''', 'test_rec_1', 1795080840951, geom_json, '{}')

    row = await conn.fetchrow('SELECT id, ST_AsText(geom) FROM vector_features WHERE record_id = $1', 'test_rec_1')
    print('Inserted row successfully:', row)
    await conn.execute('DELETE FROM vector_features WHERE record_id = $1', 'test_rec_1')
    await conn.close()

if __name__ == '__main__':
    asyncio.run(main())
