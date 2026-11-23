"""
KMC-GIS-SERVER — master-only permanent deletion cleanup tests.

Deleting one uploaded layer or raster from Master Control must not leave
dangling ids behind in projects, project assignments or feature links.
"""

import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

LAYER_ID = 970
TILE_ID = 980
PROJECT_ID = 995
MASTER_ID = 2


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class PermanentDeletionCleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            key: STATE.get(key)
            for key in (
                "users",
                "vector_layers",
                "raster_layers",
                "features_by_layer",
                "feature_links",
                "projects",
                "project_assignments",
                "audit_edits_by_layer",
            )
        }
        STATE["users"] = [
            {"id": 1, "username": "super", "role": "SuperAdmin", "is_active": True},
            {"id": MASTER_ID, "username": "master", "role": "MasterAdmin", "is_active": True},
        ]
        STATE["vector_layers"] = [{"id": LAYER_ID, "name": "Layer To Delete", "project_id": None}]
        STATE["raster_layers"] = [{"id": TILE_ID, "name": "Tile To Delete", "project_id": None}]
        STATE["features_by_layer"] = {LAYER_ID: [{"id": "f1", "properties": {}}]}
        STATE["audit_edits_by_layer"] = {str(LAYER_ID): [{"action": "CREATE"}]}
        STATE["feature_links"] = [
            {"id": 1, "source_layer_id": LAYER_ID, "target_layer_id": 999},
            {"id": 2, "source_layer_id": 999, "target_layer_id": LAYER_ID},
            {"id": 3, "source_layer_id": 998, "target_layer_id": 999},
        ]
        STATE["projects"] = [
            {
                "id": PROJECT_ID,
                "editable_layer_ids": [LAYER_ID, 999],
                "download_layer_ids": [LAYER_ID, TILE_ID, 999],
            }
        ]
        STATE["project_assignments"] = {
            str(PROJECT_ID): {
                "assigned_layer_ids": [LAYER_ID, 999],
                "assigned_mbtiles_ids": [TILE_ID, 999],
            }
        }
        self.client = TestClient(backend.app)

    def tearDown(self):
        for key, value in self._state_backup.items():
            STATE[key] = value

    def test_layer_delete_prunes_every_reference(self):
        response = self.client.delete(f"/api/layers/{LAYER_ID}/permanent", headers=_token(MASTER_ID))
        self.assertEqual(response.status_code, 200, response.text)

        project = STATE["projects"][0]
        self.assertEqual(project["editable_layer_ids"], [999])
        self.assertEqual(project["download_layer_ids"], [TILE_ID, 999])
        assignment = STATE["project_assignments"][str(PROJECT_ID)]
        self.assertEqual(assignment["assigned_layer_ids"], [999])
        self.assertEqual(assignment["assigned_mbtiles_ids"], [TILE_ID, 999])

        self.assertEqual([link["id"] for link in STATE["feature_links"]], [3])
        self.assertNotIn(LAYER_ID, STATE["features_by_layer"])
        self.assertNotIn(str(LAYER_ID), STATE["audit_edits_by_layer"])
        self.assertEqual(STATE["vector_layers"], [])

    def test_tile_delete_prunes_project_and_assignment_references(self):
        response = self.client.delete(f"/api/tiles/{TILE_ID}/permanent", headers=_token(MASTER_ID))
        self.assertEqual(response.status_code, 200, response.text)

        project = STATE["projects"][0]
        self.assertEqual(project["editable_layer_ids"], [LAYER_ID, 999])
        self.assertEqual(project["download_layer_ids"], [LAYER_ID, 999])
        assignment = STATE["project_assignments"][str(PROJECT_ID)]
        self.assertEqual(assignment["assigned_mbtiles_ids"], [999])
        self.assertEqual(STATE["raster_layers"], [])

    def test_super_admin_cannot_permanently_delete(self):
        response = self.client.delete(f"/api/layers/{LAYER_ID}/permanent", headers=_token(1))
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(len(STATE["vector_layers"]), 1)


if __name__ == "__main__":
    unittest.main()
