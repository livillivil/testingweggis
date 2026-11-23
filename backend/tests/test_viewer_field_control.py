"""
KMC-GIS-SERVER — Tests for Viewer Field Permissions, Feature Retrieval, and AOI Boundary Persistence.
"""

import unittest
from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

LAYER_ID = 950
PROJECT_ID = 95
ADMIN_ID = 1
VALIDATOR_ID = 3
COLLECTOR_ID = 4
VIEWER_ID = 5

FIELDS_CONFIG = [
    {"name": "name", "label": "Name", "type": "text", "visible_in_popup": True},
    {"name": "ward_no", "label": "Ward No", "type": "number", "visible_in_popup": True},
    {"name": "validator_notes", "label": "Validator Notes", "type": "text", "visible_in_popup": True},
    {"name": "secret_tax_id", "label": "Secret Tax ID", "type": "text", "visible_in_popup": True},
]

FIELD_PERMISSIONS = {
    "name": ["BasicViewer", "DataCollector", "Validator", "DepartmentAdmin", "GisAdmin", "SuperAdmin", "MasterAdmin"],
    "ward_no": ["BasicViewer", "DataCollector", "Validator", "DepartmentAdmin", "GisAdmin", "SuperAdmin", "MasterAdmin"],
    "validator_notes": ["Validator", "DepartmentAdmin", "GisAdmin", "SuperAdmin", "MasterAdmin"],
    "secret_tax_id": ["DepartmentAdmin", "GisAdmin", "SuperAdmin", "MasterAdmin"],
}

SAMPLE_FEATURE = {
    "type": "Feature",
    "id": 95001,
    "geometry": {
        "type": "Polygon",
        "coordinates": [
            [[85.31, 27.69], [85.32, 27.69], [85.32, 27.70], [85.31, 27.70], [85.31, 27.69]]
        ],
    },
    "properties": {
        "id": 95001,
        "_id": 95001,
        "name": "KMC Ward Office",
        "ward_no": 10,
        "validator_notes": "Verified on site by validator",
        "secret_tax_id": "TAX-KMC-9999",
        "layer_id": LAYER_ID,
    },
}


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class TestViewerFieldControlAndAOI(unittest.TestCase):
    def setUp(self):
        backend._save_persistent_state = lambda *args, **kwargs: None
        self.client = TestClient(backend.app)

        self.users_backup = list(STATE.get("users", []))
        self.layers_backup = list(STATE.get("vector_layers", []))
        self.features_backup = {k: list(v) for k, v in STATE.get("features_by_layer", {}).items()}
        self.projects_backup = list(STATE.get("projects", []))

        backend._FEATURE_ID_INDEX.clear()

        STATE["users"] = [
            {"id": ADMIN_ID, "username": "admin", "role": "SuperAdmin", "is_active": True},
            {"id": VALIDATOR_ID, "username": "validator", "role": "Validator", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector", "role": "DataCollector", "is_active": True},
            {"id": VIEWER_ID, "username": "viewer", "role": "BasicViewer", "is_active": True},
        ]

        # Global layer accessible to all users for field permission testing
        STATE["vector_layers"] = [
            {
                "id": LAYER_ID,
                "name": "Viewer Control Layer",
                "project_id": None,
                "geometry_type": "Polygon",
                "published": True,
                "access_level": "public",
                "fields_config": list(FIELDS_CONFIG),
                "field_permissions": dict(FIELD_PERMISSIONS),
                "bounds": [85.30, 27.68, 85.33, 27.71],
            }
        ]

        STATE["features_by_layer"][LAYER_ID] = [dict(SAMPLE_FEATURE)]

        STATE["projects"] = [
            {
                "id": PROJECT_ID,
                "name": "AOI Test Project",
                "boundary_geojson": None,
                "aoi_mode": "project_boundary",
                "grid_type": "HEXAGON",
                "grid_size_m": 200,
            }
        ]

    def tearDown(self):
        STATE["users"] = self.users_backup
        STATE["vector_layers"] = self.layers_backup
        STATE["features_by_layer"] = self.features_backup
        STATE["projects"] = self.projects_backup
        backend._FEATURE_ID_INDEX.clear()

    def test_admin_gets_all_fields_on_single_feature(self):
        res = self.client.get(f"/api/features/95001", headers=_token(ADMIN_ID))
        self.assertEqual(res.status_code, 200, res.text)
        props = res.json().get("properties", {})
        self.assertIn("name", props)
        self.assertIn("ward_no", props)
        self.assertIn("validator_notes", props)
        self.assertIn("secret_tax_id", props)

    def test_validator_sees_validator_fields_but_not_admin_fields(self):
        res = self.client.get(f"/api/features/95001", headers=_token(VALIDATOR_ID))
        self.assertEqual(res.status_code, 200, res.text)
        props = res.json().get("properties", {})
        self.assertIn("name", props)
        self.assertIn("ward_no", props)
        self.assertIn("validator_notes", props)
        self.assertNotIn("secret_tax_id", props)

    def test_basic_viewer_sees_public_fields_only(self):
        res = self.client.get(f"/api/features/95001", headers=_token(VIEWER_ID))
        self.assertEqual(res.status_code, 200, res.text)
        props = res.json().get("properties", {})
        self.assertIn("name", props)
        self.assertIn("ward_no", props)
        self.assertNotIn("validator_notes", props)
        self.assertNotIn("secret_tax_id", props)

    def test_update_layer_fields_persists_field_permissions(self):
        new_permissions = {
            "name": ["BasicViewer", "DataCollector", "Validator", "DepartmentAdmin", "SuperAdmin"],
            "ward_no": ["Validator", "SuperAdmin"],
        }
        res = self.client.put(
            f"/api/layers/{LAYER_ID}/fields",
            json={
                "fields": FIELDS_CONFIG,
                "field_permissions": new_permissions,
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(res.status_code, 200, res.text)
        layer = next(l for l in STATE["vector_layers"] if l["id"] == LAYER_ID)
        self.assertEqual(layer.get("field_permissions"), new_permissions)

    def test_get_layer_fields_filters_for_non_admin(self):
        res_admin = self.client.get(f"/api/layers/{LAYER_ID}/fields", headers=_token(ADMIN_ID))
        self.assertEqual(res_admin.status_code, 200, res_admin.text)
        admin_fields = [f["name"] for f in res_admin.json()["fields"]]
        self.assertEqual(len(admin_fields), 4)

        res_viewer = self.client.get(f"/api/layers/{LAYER_ID}/fields", headers=_token(VIEWER_ID))
        self.assertEqual(res_viewer.status_code, 200, res_viewer.text)
        viewer_fields = [f["name"] for f in res_viewer.json()["fields"]]
        self.assertIn("name", viewer_fields)
        self.assertIn("ward_no", viewer_fields)
        self.assertNotIn("validator_notes", viewer_fields)
        self.assertNotIn("secret_tax_id", viewer_fields)

    def test_project_boundary_endpoint_persists_aoi(self):
        aoi_poly = {
            "type": "Polygon",
            "coordinates": [
                [[85.31, 27.69], [85.33, 27.69], [85.33, 27.71], [85.31, 27.71], [85.31, 27.69]]
            ],
        }
        res = self.client.post(
            f"/api/projects/{PROJECT_ID}/boundary",
            json={"boundary_geojson": aoi_poly, "aoi_mode": "drawn_polygon"},
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(res.status_code, 200, res.text)
        data = res.json()
        self.assertEqual(data["status"], "ok")
        self.assertGreater(data["aoi_area_sqm"], 0)

        project = next(p for p in STATE["projects"] if p["id"] == PROJECT_ID)
        self.assertIsNotNone(project.get("boundary_geojson"))
        self.assertEqual(project.get("aoi_mode"), "drawn_polygon")
