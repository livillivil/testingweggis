"""
KMC-GIS-SERVER — house-numbering & addressing API tests.

Verifies the metric addressing rules end to end:
  * metric numbers follow chainage with odd numbers on the left and even on
    the right of the road direction,
  * generated numbers persist and are exported as GeoJSON/CSV,
  * anonymous callers are rejected and deletion stays administrator-only.
"""

import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

ROAD_LAYER_ID = 910
BUILDING_LAYER_ID = 911
ROAD_FEATURE_ID = "road-1"
ADMIN_ID = 1
COLLECTOR_ID = 7

ROAD_LINE = [[85.320, 27.695], [85.325, 27.695]]


def _building(feature_id, longitude, latitude):
    ring = [
        [longitude - 0.0001, latitude - 0.0001],
        [longitude + 0.0001, latitude - 0.0001],
        [longitude + 0.0001, latitude + 0.0001],
        [longitude - 0.0001, latitude + 0.0001],
        [longitude - 0.0001, latitude - 0.0001],
    ]
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {"type": "Polygon", "coordinates": [ring]},
        "properties": {"bldg_code": f"KMC-BLD-{feature_id}", "owner_name": f"Owner {feature_id}"},
    }


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class HouseNumberingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            "users": list(STATE.get("users", [])),
            "vector_layers": list(STATE.get("vector_layers", [])),
            "features_by_layer": dict(STATE.get("features_by_layer", {})),
            "house_numbers": list(STATE.get("house_numbers", [])),
        }
        STATE["users"] = [
            {"id": ADMIN_ID, "username": "KmcSuperUser2083", "role": "SuperAdmin", "is_active": True},
            {"id": 2, "username": "master", "role": "MasterAdmin", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector", "role": "DataCollector", "is_active": True},
        ]
        STATE["vector_layers"] = [
            {"id": ROAD_LAYER_ID, "name": "Roads", "project_id": None, "geometry_type": "LineString"},
            {"id": BUILDING_LAYER_ID, "name": "Buildings", "project_id": None, "geometry_type": "Polygon"},
        ]
        STATE["features_by_layer"] = {
            ROAD_LAYER_ID: [
                {
                    "type": "Feature",
                    "id": ROAD_FEATURE_ID,
                    "geometry": {"type": "LineString", "coordinates": ROAD_LINE},
                    "properties": {"name": "Baneshwor Road"},
                }
            ],
            BUILDING_LAYER_ID: [
                _building("b-left", 85.322, 27.6952),
                _building("b-right", 85.322, 27.6948),
                _building("b-far", 85.324, 27.6952),
            ],
        }
        STATE["house_numbers"] = []
        self.client = TestClient(backend.app)

    def tearDown(self):
        STATE.update(self._state_backup)

    def _generate(self, headers, save=False):
        return self.client.post(
            "/api/house-numbering/generate",
            json={
                "road_layer_id": ROAD_LAYER_ID,
                "road_feature_id": ROAD_FEATURE_ID,
                "building_layer_id": BUILDING_LAYER_ID,
                "ward": "10",
                "numbering_scheme": "METRIC",
                "interval_m": 5.0,
                "start_number": 1,
                "prefix": "W10-",
                "max_distance_from_road_m": 60.0,
                "save_to_database": save,
            },
            headers=headers,
        )

    def test_metric_numbers_follow_chainage_and_side_parity(self):
        response = self._generate(_token(COLLECTOR_ID))
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(payload["total_buildings_detected"], 3)

        by_building = {p["building_id"]: p for p in payload["proposals"]}
        self.assertEqual(by_building["b-left"]["side"], "LEFT")
        self.assertEqual(by_building["b-right"]["side"], "RIGHT")
        self.assertEqual(int(by_building["b-left"]["house_number"].replace("W10-", "")) % 2, 1)
        self.assertEqual(int(by_building["b-right"]["house_number"].replace("W10-", "")) % 2, 0)
        # The farther building has the larger chainage and therefore a larger number.
        self.assertGreater(
            by_building["b-far"]["chainage_m"], by_building["b-left"]["chainage_m"]
        )
        self.assertGreater(
            int(by_building["b-far"]["house_number"].replace("W10-", "")),
            int(by_building["b-left"]["house_number"].replace("W10-", "")),
        )

    def test_saved_numbers_are_listed_counted_and_exported(self):
        headers = _token(ADMIN_ID)
        generated = self._generate(headers, save=True)
        self.assertEqual(generated.status_code, 200, generated.text)
        self.assertEqual(generated.json()["saved_count"], 3)

        listed = self.client.get("/api/house-numbering/numbers", headers=headers)
        self.assertEqual(listed.status_code, 200)
        collection = listed.json()
        self.assertEqual(collection["type"], "FeatureCollection")
        self.assertEqual(len(collection["features"]), 3)
        self.assertEqual(collection["features"][0]["geometry"]["type"], "Point")

        stats = self.client.get("/api/house-numbering/stats", headers=headers).json()
        self.assertEqual(stats["total_house_numbers"], 3)
        self.assertEqual(stats["by_side"]["LEFT"] + stats["by_side"]["RIGHT"], 3)
        self.assertIn("10", {str(f["properties"]["ward_no"]) for f in collection["features"]})

        exported = self.client.get(
            "/api/house-numbering/export", params={"format": "csv", "ward": "10"}, headers=headers
        )
        self.assertEqual(exported.status_code, 200)
        self.assertTrue(exported.headers["content-type"].startswith("text/csv"))
        self.assertIn("house_number", exported.text)

        geojson = self.client.get("/api/house-numbering/export", headers=headers)
        self.assertEqual(geojson.status_code, 200)
        self.assertEqual(geojson.json()["type"], "FeatureCollection")

    def test_regenerating_same_buildings_does_not_duplicate(self):
        headers = _token(ADMIN_ID)
        self.assertEqual(self._generate(headers, save=True).json()["saved_count"], 3)
        second = self._generate(headers, save=True).json()
        self.assertEqual(second["saved_count"], 0)
        self.assertEqual(len(STATE["house_numbers"]), 3)

    def test_writes_require_a_role_and_delete_is_admin_only(self):
        self.assertEqual(self._generate({}).status_code, 401)

        admin_headers = _token(ADMIN_ID)
        generated = self._generate(admin_headers, save=True).json()
        number_id = generated["proposals"][0]["id"]

        updated = self.client.put(
            f"/api/house-numbering/numbers/{number_id}",
            json={"status": "VERIFIED"},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(updated.status_code, 200, updated.text)
        stats = self.client.get("/api/house-numbering/stats", headers=admin_headers).json()
        self.assertEqual(stats["verified_count"], 1)

        forbidden = self.client.delete(
            f"/api/house-numbering/numbers/{number_id}", headers=_token(COLLECTOR_ID)
        )
        self.assertEqual(forbidden.status_code, 403)

        deleted = self.client.delete(
            f"/api/house-numbering/numbers/{number_id}", headers=admin_headers
        )
        self.assertEqual(deleted.status_code, 200, deleted.text)
        self.assertEqual(len(STATE["house_numbers"]), 2)


if __name__ == "__main__":
    unittest.main()
