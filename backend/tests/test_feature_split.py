"""
Tests for Feature Split workflows:
- Single split into 2 divisions
- Consecutive splits into 3 divisions (ensuring no division is lost or overwritten)
- Multi-cut split resulting in 3 or more divisions in a single blade pass
"""
import unittest
from fastapi.testclient import TestClient
from app import main as backend
from app.main import app, STATE, set_layer_features, get_layer_features_list


class TestFeatureSplit(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def setUp(self):
        # Create a test vector layer
        self.layer_id = 9999
        layer_meta = {
            "id": self.layer_id,
            "name": "Test Split Parcels",
            "geometry_type": "Polygon",
            "feature_count": 1,
            "project_id": 1,
            "fields_config": [{"name": "name", "type": "text"}, {"name": "bldg_code", "type": "text"}],
        }
        STATE["vector_layers"] = [l for l in STATE.get("vector_layers", []) if l.get("id") != self.layer_id] + [layer_meta]

        # Initial polygon: 100x100 square
        self.initial_feature = {
            "type": "Feature",
            "id": 1001,
            "geometry": {
                "type": "Polygon",
                "coordinates": [[[85.30, 27.70], [85.32, 27.70], [85.32, 27.72], [85.30, 27.72], [85.30, 27.70]]],
            },
            "properties": {
                "_id": 1001,
                "name": "Original Parcel",
                "bldg_code": "BLD-01",
            },
        }
        set_layer_features(self.layer_id, [self.initial_feature])

        # Admin token
        token = backend._issue_access_token(1)
        self.headers = {"Authorization": f"Bearer {token}"}

    def test_split_twice_into_three_divisions_preserves_all_parts(self):
        # 1. Preview first split: vertical line through center (lon=85.31)
        blade_1 = {
            "type": "LineString",
            "coordinates": [[85.31, 27.69], [85.31, 27.73]],
        }
        res1 = self.client.post(
            f"/api/features/1001/split-preview",
            json={"blade": blade_1},
            headers=self.headers,
        )
        self.assertEqual(res1.status_code, 200)
        data1 = res1.json()
        self.assertEqual(data1["part_count"], 2)

        # 2. Confirm first split: keeping part 1 as 1001, part 2 as 1001_B
        parts1 = [
            {"id": "1001", "geometry": data1["parts"][0]["geometry"], "properties": {"name": "Part 1A"}},
            {"id": "1001_B", "geometry": data1["parts"][1]["geometry"], "properties": {"name": "Part 1B"}},
        ]
        conf1 = self.client.post(
            f"/api/features/1001/split-confirm",
            json={"parts": parts1},
            headers=self.headers,
        )
        self.assertEqual(conf1.status_code, 200)

        # Verify layer features after split 1: exactly 2 features (1001 and 1001_B)
        feats_after_1 = get_layer_features_list(self.layer_id)
        self.assertEqual(len(feats_after_1), 2)
        ids_after_1 = [str(f.get("id")) for f in feats_after_1]
        self.assertIn("1001", ids_after_1)
        self.assertIn("1001_B", ids_after_1)

        # 3. Second split on feature 1001 (cutting it horizontally into 2 parts, giving 3 divisions total!)
        blade_2 = {
            "type": "LineString",
            "coordinates": [[85.29, 27.71], [85.32, 27.71]],
        }
        res2 = self.client.post(
            f"/api/features/1001/split-preview",
            json={"blade": blade_2},
            headers=self.headers,
        )
        self.assertEqual(res2.status_code, 200)
        data2 = res2.json()
        self.assertEqual(data2["part_count"], 2)

        # Notice: data2 suggested_id for part 2 must NOT collide with 1001_B!
        suggested_id_part2 = data2["parts"][1]["suggested_id"]
        self.assertNotEqual(suggested_id_part2, "1001_B", "Suggested ID must not collide with existing 1001_B!")

        # 4. Confirm second split
        parts2 = [
            {"id": "1001", "geometry": data2["parts"][0]["geometry"], "properties": {"name": "Part 2A"}},
            {"id": suggested_id_part2, "geometry": data2["parts"][1]["geometry"], "properties": {"name": "Part 2B"}},
        ]
        conf2 = self.client.post(
            f"/api/features/1001/split-confirm",
            json={"parts": parts2},
            headers=self.headers,
        )
        self.assertEqual(conf2.status_code, 200)

        # 5. Verify layer features after split 2: MUST HAVE EXACTLY 3 DIVISIONS! None lost!
        feats_after_2 = get_layer_features_list(self.layer_id)
        self.assertEqual(len(feats_after_2), 3, f"Expected 3 divisions, got {len(feats_after_2)}")

        final_ids = [str(f.get("id")) for f in feats_after_2]
        self.assertEqual(len(set(final_ids)), 3, "All 3 division IDs must be strictly unique!")
        self.assertIn("1001_B", final_ids, "The first split division (1001_B) must NOT be lost!")
        self.assertIn("1001", final_ids)
        self.assertIn(suggested_id_part2, final_ids)

    def test_single_blade_multi_cut_splits_into_three_divisions(self):
        # A zigzag blade that cuts through the polygon in 2 places, dividing it into 3 parts at once
        multi_cut_blade = {
            "type": "LineString",
            "coordinates": [
                [85.305, 27.69],
                [85.305, 27.73],
                [85.315, 27.73],
                [85.315, 27.69],
            ],
        }
        res = self.client.post(
            f"/api/features/1001/split-preview",
            json={"blade": multi_cut_blade},
            headers=self.headers,
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["part_count"], 3, "Zigzag blade cutting twice must produce exactly 3 divisions")

        # Confirm all 3 parts
        parts = [
            {"id": "1001", "geometry": data["parts"][0]["geometry"], "properties": {}},
            {"id": data["parts"][1]["suggested_id"], "geometry": data["parts"][1]["geometry"], "properties": {}},
            {"id": data["parts"][2]["suggested_id"], "geometry": data["parts"][2]["geometry"], "properties": {}},
        ]
        conf = self.client.post(
            f"/api/features/1001/split-confirm",
            json={"parts": parts},
            headers=self.headers,
        )
        self.assertEqual(conf.status_code, 200)

        feats = get_layer_features_list(self.layer_id)
        self.assertEqual(len(feats), 3, "All 3 divisions must be preserved in the layer")
        f_ids = [str(f.get("id")) for f in feats]
        self.assertEqual(len(set(f_ids)), 3, "All 3 division IDs must be unique")

    def test_direct_split_endpoint_supports_multiple_divisions(self):
        multi_cut_blade = {
            "type": "LineString",
            "coordinates": [
                [85.305, 27.69],
                [85.305, 27.73],
                [85.315, 27.73],
                [85.315, 27.69],
            ],
        }
        res = self.client.post(
            f"/api/features/1001/split",
            json={"blade": multi_cut_blade},
            headers=self.headers,
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data["part_count"], 3)
        self.assertEqual(len(data["new_feature_ids"]), 3)

        feats = get_layer_features_list(self.layer_id)
        self.assertEqual(len(feats), 3)


if __name__ == "__main__":
    unittest.main()
