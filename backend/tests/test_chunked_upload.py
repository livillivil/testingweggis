"""
KMC-GIS-SERVER - Resilient multi-worker chunked upload and state persistence tests.
"""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

ADMIN_ID = 1
MASTER_ID = 2


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class ChunkedUploadPipelineTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._orig_save = backend._save_persistent_state
        backend._save_persistent_state = lambda *args, **kwargs: None

    @classmethod
    def tearDownClass(cls):
        backend._save_persistent_state = cls._orig_save

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        self.uploads_dir = os.path.join(root, "uploads")
        self.tiles_dir = os.path.join(root, "tiles")
        os.makedirs(os.path.join(self.uploads_dir, "layers"), exist_ok=True)
        os.makedirs(os.path.join(self.tiles_dir, "temp"), exist_ok=True)

        self.saved_users = list(STATE.get("users", []))
        self.saved_vl = list(STATE.get("vector_layers", []))
        self.saved_rl = list(STATE.get("raster_layers", []))
        self.saved_fbl = dict(STATE.get("features_by_layer", {}))
        self.saved_pu = dict(STATE.get("pending_uploads", {}))

        STATE["users"] = [
            {"id": ADMIN_ID, "username": "admin", "role": "SuperAdmin", "is_active": True},
            {"id": MASTER_ID, "username": "master", "role": "MasterAdmin", "is_active": True},
        ]
        STATE["vector_layers"] = []
        STATE["raster_layers"] = []
        STATE["features_by_layer"] = {}
        STATE["pending_uploads"] = {}

        self.tiles_patch = patch("app.main.get_tileserver_dir", return_value=self.tiles_dir)
        self.uploads_patch = patch("app.main.get_uploads_dir", return_value=self.uploads_dir)
        self.tiles_patch.start()
        self.uploads_patch.start()

        self.client = TestClient(backend.app)

    def tearDown(self):
        self.tiles_patch.stop()
        self.uploads_patch.stop()
        STATE["users"] = self.saved_users
        STATE["vector_layers"] = self.saved_vl
        STATE["raster_layers"] = self.saved_rl
        STATE["features_by_layer"] = self.saved_fbl
        STATE["pending_uploads"] = self.saved_pu
        self._tmp.cleanup()

    def test_direct_chunk_sparse_writing_and_status(self):
        """Test that chunks are written in-place directly without duplicate files or concatenation."""
        content_part_0 = b"Hello "
        content_part_1 = b"World "
        content_part_2 = b"Nepal!"
        total_data = content_part_0 + content_part_1 + content_part_2

        # 1. Initialize upload session
        init_res = self.client.post(
            "/api/uploads/init",
            json={
                "filename": "survey_area.mbtiles",
                "kind": "raster",
                "total_size": len(total_data),
                "is_global": True,
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(init_res.status_code, 200)
        data = init_res.json()
        upload_id = data["upload_id"]
        chunk_size = data["chunk_size"]

        # Override chunk size in session for small-file testing
        session = backend._load_upload_session(upload_id)
        session["chunk_size"] = 6
        session["total_chunks"] = 3
        backend._save_upload_session(upload_id, session)

        # 2. Upload chunk 0
        c0 = self.client.post(
            f"/api/uploads/{upload_id}/chunk",
            params={"index": 0},
            content=content_part_0,
            headers={**_token(ADMIN_ID), "Content-Type": "application/octet-stream"},
        )
        self.assertEqual(c0.status_code, 200)

        # 3. Simulate another Uvicorn worker checking status from disk
        STATE["pending_uploads"].clear()  # simulate separate worker memory
        status_res = self.client.get(
            f"/api/uploads/{upload_id}",
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(status_res.status_code, 200)
        st = status_res.json()
        self.assertEqual(st["received_chunks_count"], 1)
        self.assertEqual(st["next_index"], 1)

        # 4. Upload chunk 1 and 2
        c1 = self.client.post(
            f"/api/uploads/{upload_id}/chunk",
            params={"index": 1},
            content=content_part_1,
            headers={**_token(ADMIN_ID), "Content-Type": "application/octet-stream"},
        )
        self.assertEqual(c1.status_code, 200)

        c2 = self.client.post(
            f"/api/uploads/{upload_id}/chunk",
            params={"index": 2},
            content=content_part_2,
            headers={**_token(ADMIN_ID), "Content-Type": "application/octet-stream"},
        )
        self.assertEqual(c2.status_code, 200)

        # Verify complete status
        st2 = self.client.get(f"/api/uploads/{upload_id}", headers=_token(ADMIN_ID)).json()
        self.assertEqual(st2["received_chunks_count"], 3)
        self.assertEqual(st2["progress_percent"], 100.0)

        # 5. Complete upload
        done_res = self.client.post(
            f"/api/uploads/{upload_id}/complete",
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(done_res.status_code, 200)
        tile_meta = done_res.json()
        self.assertEqual(tile_meta["filename"], "survey_area.mbtiles")

        # Verify destination file exists and contains exact assembled bytes
        dest_file = os.path.join(self.tiles_dir, "survey_area.mbtiles")
        self.assertTrue(os.path.exists(dest_file))
        with open(dest_file, "rb") as f:
            written_bytes = f.read()
        self.assertEqual(written_bytes, total_data)

    def test_vector_upload_and_persistence(self):
        """Test vector GeoJSON upload sets filename and appears in list_layers immediately."""
        geojson_content = json.dumps({
            "type": "FeatureCollection",
            "features": [
                {
                    "type": "Feature",
                    "id": 101,
                    "geometry": {"type": "Point", "coordinates": [85.32, 27.71]},
                    "properties": {"name": "Test Point"},
                }
            ],
        }).encode("utf-8")

        init_res = self.client.post(
            "/api/uploads/init",
            json={
                "filename": "ward_landmarks.geojson",
                "kind": "vector",
                "total_size": len(geojson_content),
                "is_global": True,
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(init_res.status_code, 200)
        upload_id = init_res.json()["upload_id"]

        # Upload chunk
        c0 = self.client.post(
            f"/api/uploads/{upload_id}/chunk",
            params={"index": 0},
            content=geojson_content,
            headers={**_token(ADMIN_ID), "Content-Type": "application/octet-stream"},
        )
        self.assertEqual(c0.status_code, 200)

        # Complete
        comp_res = self.client.post(
            f"/api/uploads/{upload_id}/complete",
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(comp_res.status_code, 200)
        layer = comp_res.json()
        self.assertEqual(layer["filename"], "ward_landmarks.geojson")
        self.assertEqual(layer["feature_count"], 1)

        # Verify layer appears in list_layers()
        list_res = self.client.get("/api/layers", headers=_token(ADMIN_ID))
        self.assertEqual(list_res.status_code, 200)
        layers = list_res.json()
        self.assertTrue(any(l["filename"] == "ward_landmarks.geojson" for l in layers))


if __name__ == "__main__":
    unittest.main()
