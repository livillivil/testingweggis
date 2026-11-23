"""
KMC-GIS-SERVER — per-file storage management tests.

Master Control lists individual files on disk (including files left behind by
deleted layers) and deletes them one by one, releasing disk space immediately.
"""

import json
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

MASTER_ID = 2
LAYER_ID = 970
TILE_ID = 980
PROJECT_ID = 995


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class StorageFilesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        root = self._tmp.name
        self.uploads_dir = os.path.join(root, "uploads")
        self.tiles_dir = os.path.join(root, "tiles")
        os.makedirs(os.path.join(self.uploads_dir, "layers"))
        os.makedirs(os.path.join(self.uploads_dir, "offline_bundles"))
        os.makedirs(os.path.join(self.tiles_dir, "temp"))
        for relative, payload in (
            ("uploads/layers/small.geojson", b'{"type":"FeatureCollection","features":[]}'),
            ("uploads/layers/big.geojson", b"x" * 4096),
            ("uploads/offline_bundles/bundle.zip", b"zip"),
            ("uploads/kmc_state_store.json", b"{}"),
            ("uploads/offline_bundles/README.md", b"readme"),
            ("tiles/orthophoto.mbtiles", b"mbtiles"),
            ("tiles/config.json", b"{}"),
            ("tiles/kmc_state_store.json", b"{}"),
            ("tiles/kmc_state_store.json.tmp", b"partial-state"),
            ("tiles/temp/.gitkeep", b""),
        ):
            with open(os.path.join(root, relative), "wb") as handle:
                handle.write(payload)
        with open(os.path.join(self.tiles_dir, "config.json"), "w", encoding="utf-8") as handle:
            json.dump({"data": {"orthophoto": {"mbtiles": "orthophoto.mbtiles"}}}, handle)

        self._patchers = [
            patch.object(backend, "get_uploads_dir", lambda: self.uploads_dir),
            patch.object(backend, "get_tileserver_dir", lambda: self.tiles_dir),
        ]
        for patcher in self._patchers:
            patcher.start()

        self._state_backup = {
            key: STATE.get(key)
            for key in (
                "users",
                "vector_layers",
                "raster_layers",
                "deleted_vector_layers",
                "deleted_raster_layers",
                "features_by_layer",
                "feature_links",
                "projects",
                "project_assignments",
                "audit_edits_by_layer",
                "purged_assets",
            )
        }
        STATE["users"] = [
            {"id": 1, "username": "super", "role": "SuperAdmin", "is_active": True},
            {"id": MASTER_ID, "username": "master", "role": "MasterAdmin", "is_active": True},
        ]
        STATE["vector_layers"] = [
            {
                "id": LAYER_ID,
                "name": "big",
                "filename": "big.geojson",
                "project_id": None,
            }
        ]
        STATE["raster_layers"] = [
            {"id": TILE_ID, "name": "Orthophoto", "filename": "orthophoto.mbtiles", "project_id": None}
        ]
        STATE["deleted_vector_layers"] = []
        STATE["deleted_raster_layers"] = []
        STATE["features_by_layer"] = {LAYER_ID: [{"id": "f1", "properties": {}}]}
        STATE["feature_links"] = [
            {"id": 1, "source_layer_id": LAYER_ID, "target_layer_id": 999},
            {"id": 2, "source_layer_id": 999, "target_layer_id": 999},
        ]
        STATE["projects"] = [
            {"id": PROJECT_ID, "editable_layer_ids": [LAYER_ID], "download_layer_ids": [TILE_ID]}
        ]
        STATE["project_assignments"] = {
            str(PROJECT_ID): {"assigned_layer_ids": [LAYER_ID], "assigned_mbtiles_ids": [TILE_ID]}
        }
        STATE["audit_edits_by_layer"] = {str(LAYER_ID): [{"action": "CREATE"}]}
        STATE["purged_assets"] = []
        self.client = TestClient(backend.app)

    def tearDown(self):
        for patcher in self._patchers:
            patcher.stop()
        for key, value in self._state_backup.items():
            STATE[key] = value
        self._tmp.cleanup()

    def test_inventory_hides_protected_files_and_sorts_by_size(self):
        response = self.client.get("/api/system/storage/files", headers=_token(MASTER_ID))
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()

        upload_paths = [item["path"] for item in payload["uploads"]]
        self.assertEqual(upload_paths, ["layers/big.geojson", "layers/small.geojson", "offline_bundles/bundle.zip"])
        tile_paths = [item["path"] for item in payload["tiles"]]
        self.assertEqual(tile_paths, ["orthophoto.mbtiles"])
        self.assertEqual(payload["uploads_files"], 3)
        self.assertEqual(payload["tiles_files"], 1)

    def test_storage_totals_exclude_application_state(self):
        response = self.client.get("/api/system/storage", headers=_token(MASTER_ID))
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["tileserver"]["files"], 1)
        self.assertEqual(payload["tileserver"]["bytes"], len(b"mbtiles"))
        self.assertEqual(payload["vector_layers_active"], 1)
        self.assertEqual(payload["vector_layers_recycled"], 0)

    def test_delete_vector_file_removes_layer_and_references(self):
        response = self.client.delete(
            "/api/system/storage/file",
            params={"root": "uploads", "path": "layers/big.geojson"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["bytes_released"], 4096)
        self.assertEqual(payload["layers_removed"], 1)

        self.assertFalse(os.path.exists(os.path.join(self.uploads_dir, "layers", "big.geojson")))
        self.assertEqual(STATE["vector_layers"], [])
        self.assertNotIn(LAYER_ID, STATE["features_by_layer"])
        self.assertEqual(STATE["feature_links"], [{"id": 2, "source_layer_id": 999, "target_layer_id": 999}])
        self.assertEqual(STATE["projects"][0]["editable_layer_ids"], [])
        self.assertEqual(STATE["project_assignments"][str(PROJECT_ID)]["assigned_layer_ids"], [])

    def test_delete_mbtiles_removes_raster_metadata_and_config_entry(self):
        response = self.client.delete(
            "/api/system/storage/file",
            params={"root": "tiles", "path": "orthophoto.mbtiles"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["rasters_removed"], 1)

        self.assertFalse(os.path.exists(os.path.join(self.tiles_dir, "orthophoto.mbtiles")))
        self.assertEqual(STATE["raster_layers"], [])
        self.assertEqual(STATE["projects"][0]["download_layer_ids"], [])
        self.assertEqual(STATE["project_assignments"][str(PROJECT_ID)]["assigned_mbtiles_ids"], [])
        with open(os.path.join(self.tiles_dir, "config.json"), "r", encoding="utf-8") as handle:
            self.assertEqual(json.load(handle)["data"], {})

    def test_delete_rejects_protected_files_traversal_and_non_master(self):
        protected = self.client.delete(
            "/api/system/storage/file",
            params={"root": "tiles", "path": "kmc_state_store.json"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(protected.status_code, 400, protected.text)

        traversal = self.client.delete(
            "/api/system/storage/file",
            params={"root": "uploads", "path": "../tiles/config.json"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(traversal.status_code, 400, traversal.text)

        state_tmp = self.client.delete(
            "/api/system/storage/file",
            params={"root": "tiles", "path": "kmc_state_store.json.tmp"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(state_tmp.status_code, 400, state_tmp.text)

        denied = self.client.delete(
            "/api/system/storage/file",
            params={"root": "uploads", "path": "layers/big.geojson"},
            headers=_token(1),
        )
        self.assertEqual(denied.status_code, 403, denied.text)
        self.assertTrue(os.path.exists(os.path.join(self.uploads_dir, "layers", "big.geojson")))


if __name__ == "__main__":
    unittest.main()
