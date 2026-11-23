"""
KMC-GIS-SERVER — cross-layer linking API tests.

The LinkLayersModal contract is `POST /api/layers/{source}/link`: it matches
source features against a target layer (attribute or spatial) and materialises
the target value as a new source attribute while recording feature_links.
"""

import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

SOURCE_LAYER_ID = 920
TARGET_LAYER_ID = 921
ADMIN_ID = 1
COLLECTOR_ID = 7


def _polygon(feature_id, min_lng, min_lat, max_lng, max_lat, **props):
    ring = [
        [min_lng, min_lat],
        [max_lng, min_lat],
        [max_lng, max_lat],
        [min_lng, max_lat],
        [min_lng, min_lat],
    ]
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": props,
    }


def _point(feature_id, lng, lat, **props):
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
        "properties": props,
    }


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class LayerLinkingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            "users": list(STATE.get("users", [])),
            "vector_layers": list(STATE.get("vector_layers", [])),
            "features_by_layer": dict(STATE.get("features_by_layer", {})),
            "feature_links": list(STATE.get("feature_links", [])),
            "audit_edits_by_layer": dict(STATE.get("audit_edits_by_layer", {})),
        }
        STATE["users"] = [
            {"id": ADMIN_ID, "username": "KmcSuperUser2083", "role": "SuperAdmin", "is_active": True},
            {"id": 2, "username": "master", "role": "MasterAdmin", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector", "role": "DataCollector", "is_active": True},
        ]
        STATE["vector_layers"] = [
            {
                "id": SOURCE_LAYER_ID,
                "name": "Buildings",
                "project_id": None,
                "geometry_type": "Polygon",
                "fields_config": [{"name": "ward_no", "label": "Ward", "type": "number"}],
            },
            {
                "id": TARGET_LAYER_ID,
                "name": "Roads",
                "project_id": None,
                "geometry_type": "Polygon",
                "fields_config": [{"name": "road_name", "label": "Road", "type": "text"}],
            },
        ]
        STATE["features_by_layer"] = {
            SOURCE_LAYER_ID: [
                _polygon("b1", 85.320, 27.694, 85.321, 27.695, ward_no=10),
                _polygon("b2", 85.321, 27.694, 85.322, 27.695, ward_no=11),
                _polygon("b3", 85.322, 27.694, 85.323, 27.695, ward_no=99),
            ],
            TARGET_LAYER_ID: [
                _polygon("r1", 85.319, 27.693, 85.3215, 27.696, ward_no=10, road_name="Baneshwor Road"),
                _polygon("r2", 85.3205, 27.693, 85.3235, 27.696, ward_no=11, road_name="Tinkune Road"),
            ],
        }
        STATE["feature_links"] = []
        STATE["audit_edits_by_layer"] = {}
        self.client = TestClient(backend.app)

    def tearDown(self):
        STATE.update(self._state_backup)

    def test_attribute_link_materialises_target_value(self):
        response = self.client.post(
            f"/api/layers/{SOURCE_LAYER_ID}/link",
            json={
                "target_layer_id": TARGET_LAYER_ID,
                "target_id_field": "road_name",
                "link_method": "attribute",
                "source_match_field": "ward_no",
                "target_match_field": "ward_no",
                "overwrite_existing": True,
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["linked_attribute_name"], "Roads_linked_id")
        self.assertEqual(payload["linked_count"], 2)
        self.assertEqual(payload["total_source_features"], 3)
        self.assertEqual(payload["matched_percentage"], 66.7)

        features = STATE["features_by_layer"][SOURCE_LAYER_ID]
        by_id = {f["id"]: f for f in features}
        self.assertEqual(by_id["b1"]["properties"]["Roads_linked_id"], "Baneshwor Road")
        self.assertEqual(by_id["b2"]["properties"]["Roads_linked_id"], "Tinkune Road")
        self.assertNotIn("Roads_linked_id", by_id["b3"]["properties"])
        self.assertEqual(len(STATE["feature_links"]), 2)
        self.assertTrue(
            any(f["name"] == "Roads_linked_id" for f in STATE["vector_layers"][0]["fields_config"])
        )
        self.assertTrue(
            any(entry["action"] == "LINK" for entry in STATE["audit_edits_by_layer"][str(SOURCE_LAYER_ID)])
        )

    def test_spatial_within_link_stores_target_id(self):
        response = self.client.post(
            f"/api/layers/{SOURCE_LAYER_ID}/link",
            json={
                "target_layer_id": TARGET_LAYER_ID,
                "target_id_field": "_id",
                "link_method": "spatial",
                "source_match_field": None,
                "target_match_field": None,
                "spatial_predicate": "within",
                "custom_field_name": "road_feature_id",
                "overwrite_existing": True,
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["linked_attribute_name"], "road_feature_id")
        self.assertEqual(payload["linked_count"], 3)

        values = {
            f["id"]: f["properties"].get("road_feature_id")
            for f in STATE["features_by_layer"][SOURCE_LAYER_ID]
        }
        self.assertEqual(values["b1"], "r1")
        self.assertEqual(values["b2"], "r2")
        # b3 extends past the target polygons but its lower-left corner is inside r2.
        self.assertEqual(values["b3"], "r2")

    def test_overwrite_existing_false_keeps_existing_values(self):
        STATE["features_by_layer"][SOURCE_LAYER_ID][0]["properties"]["road_link"] = "MANUAL"
        response = self.client.post(
            f"/api/layers/{SOURCE_LAYER_ID}/link",
            json={
                "target_layer_id": TARGET_LAYER_ID,
                "target_id_field": "road_name",
                "link_method": "attribute",
                "source_match_field": "ward_no",
                "target_match_field": "ward_no",
                "custom_field_name": "road_link",
                "overwrite_existing": False,
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["linked_count"], 1)
        self.assertEqual(
            STATE["features_by_layer"][SOURCE_LAYER_ID][0]["properties"]["road_link"], "MANUAL"
        )

    def test_link_requires_authentication_and_write_access(self):
        payload = {
            "target_layer_id": TARGET_LAYER_ID,
            "target_id_field": "_id",
            "link_method": "attribute",
            "source_match_field": "ward_no",
            "target_match_field": "ward_no",
        }
        self.assertEqual(
            self.client.post(f"/api/layers/{SOURCE_LAYER_ID}/link", json=payload).status_code,
            401,
        )
        self.assertEqual(
            self.client.post(
                f"/api/layers/{SOURCE_LAYER_ID}/link", json=payload, headers=_token(COLLECTOR_ID)
            ).status_code,
            403,
        )
        STATE["vector_layers"][0]["editable_by_collectors"] = True
        self.assertEqual(
            self.client.post(
                f"/api/layers/{SOURCE_LAYER_ID}/link", json=payload, headers=_token(COLLECTOR_ID)
            ).status_code,
            200,
        )


if __name__ == "__main__":
    unittest.main()
