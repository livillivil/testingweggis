"""
Unit tests for Project-based Metric House Numbering.
Verifies:
1. Metric distance from road start point.
2. Cross product side determination (Left: Odd, Right: Even).
3. Road name prefix (e.g. RoadA/55) and unnamed road fallback (RNR/metric_number).
4. Gate and Building linkage via identical configured column.
5. Project house numbering API endpoints.
"""
import unittest
from fastapi.testclient import TestClient
import app.main as backend
from app.main import STATE


class ProjectMetricHouseNumberingTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(backend.app)
        self._orig_projects = list(STATE.get("projects", []))
        self._orig_layers = list(STATE.get("vector_layers", []))
        self._orig_features = dict(STATE.get("features_by_layer", {}))
        self.token = backend._issue_access_token(1)
        self.headers = {"Authorization": f"Bearer {self.token}"}

    def tearDown(self):
        STATE["projects"] = self._orig_projects
        STATE["vector_layers"] = self._orig_layers
        STATE["features_by_layer"] = self._orig_features

    def test_project_metric_house_numbering_calculation(self):
        # 1. Create a Project
        proj_res = self.client.post(
            "/api/projects",
            json={
                "name": "House Numbering Test Project",
                "status": "active",
                "house_numbering_enabled": True,
            },
            headers=self.headers,
        )
        self.assertEqual(proj_res.status_code, 200, proj_res.text)
        proj = proj_res.json()
        p_id = proj["id"]

        # 2. Create Road Layer (LineString)
        road_layer_res = self.client.post(
            "/api/layers",
            json={
                "name": "Roads Layer",
                "geometry_type": "LineString",
                "project_id": p_id,
            },
            headers=self.headers,
        )
        road_layer_id = road_layer_res.json()["id"]

        # Add two roads: one named 'RoadA', one unnamed
        road_features = [
            {
                "type": "Feature",
                "id": 101,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[85.3200, 27.7000], [85.3200, 27.7100]],
                },
                "properties": {
                    "id": 101,
                    "name": "RoadA",
                },
            },
            {
                "type": "Feature",
                "id": 102,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [[85.3300, 27.7000], [85.3300, 27.7100]],
                },
                "properties": {
                    "id": 102,
                    # No name -> should be RNR
                },
            },
        ]
        backend.set_layer_features(road_layer_id, road_features)

        # 3. Create Gate Layer (Point)
        gate_layer_res = self.client.post(
            "/api/layers",
            json={
                "name": "Gate Layer",
                "geometry_type": "Point",
                "project_id": p_id,
            },
            headers=self.headers,
        )
        gate_layer_id = gate_layer_res.json()["id"]

        # 4. Create Building Layer (Polygon)
        bldg_layer_res = self.client.post(
            "/api/layers",
            json={
                "name": "Building Layer",
                "geometry_type": "Polygon",
                "project_id": p_id,
            },
            headers=self.headers,
        )
        bldg_layer_id = bldg_layer_res.json()["id"]

        # Gates:
        # Heading North (positive Y) along RoadA (85.32, 27.70 -> 27.71):
        # - Gate 1: (85.3195, 27.7005) is West (Left of heading North!). Approx 55 meters North.
        #   Left side -> must be ODD!
        # - Gate 2: (85.3205, 27.7005) is East (Right of heading North!). Approx 55 meters North.
        #   Right side -> must be EVEN!
        # - Gate 3: Near unnamed road (85.3305, 27.7004) -> Right of unnamed road -> RNR/even!
        gate_features = [
            {
                "type": "Feature",
                "id": 201,
                "geometry": {"type": "Point", "coordinates": [85.3195, 27.7005]},
                "properties": {"id": 201, "bldg_code": "BLD-LEFT"},
            },
            {
                "type": "Feature",
                "id": 202,
                "geometry": {"type": "Point", "coordinates": [85.3205, 27.7005]},
                "properties": {"id": 202, "bldg_code": "BLD-RIGHT"},
            },
            {
                "type": "Feature",
                "id": 203,
                "geometry": {"type": "Point", "coordinates": [85.3305, 27.7004]},
                "properties": {"id": 203, "bldg_code": "BLD-UNNAMED"},
            },
        ]
        backend.set_layer_features(gate_layer_id, gate_features)

        # Buildings associated by 'bldg_code'
        bldg_features = [
            {
                "type": "Feature",
                "id": 301,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[85.3190, 27.7004], [85.3194, 27.7004], [85.3194, 27.7006], [85.3190, 27.7006], [85.3190, 27.7004]]],
                },
                "properties": {"id": 301, "bldg_code": "BLD-LEFT", "owner_name": "Ram"},
            },
            {
                "type": "Feature",
                "id": 302,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[85.3206, 27.7004], [85.3210, 27.7004], [85.3210, 27.7006], [85.3206, 27.7006], [85.3206, 27.7004]]],
                },
                "properties": {"id": 302, "bldg_code": "BLD-RIGHT", "owner_name": "Sita"},
            },
            {
                "type": "Feature",
                "id": 303,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [[[85.3306, 27.7003], [85.3310, 27.7003], [85.3310, 27.7005], [85.3306, 27.7005], [85.3306, 27.7003]]],
                },
                "properties": {"id": 303, "bldg_code": "BLD-UNNAMED", "owner_name": "Hari"},
            },
        ]
        backend.set_layer_features(bldg_layer_id, bldg_features)

        # Configure house numbering on project with link_field='bldg_code'
        update_res = self.client.put(
            f"/api/projects/{p_id}",
            json={
                "house_numbering_enabled": True,
                "house_numbering_config": {
                    "building_layer_id": bldg_layer_id,
                    "gate_layer_id": gate_layer_id,
                    "road_layer_id": road_layer_id,
                    "link_field": "bldg_code",
                    "road_name_field": "name",
                },
            },
            headers=self.headers,
        )
        self.assertEqual(update_res.status_code, 200)

        # Generate house numbers
        gen_res = self.client.post(
            f"/api/projects/{p_id}/house-numbering/generate",
            json={},
            headers=self.headers,
        )
        self.assertEqual(gen_res.status_code, 200, gen_res.text)
        data = gen_res.json()
        self.assertEqual(data["status"], "success")
        self.assertEqual(data["total_gates_numbered"], 3)
        self.assertEqual(data["total_buildings_numbered"], 3)

        # Verify Gates
        updated_gates = backend.get_layer_features_list(gate_layer_id)
        g_left = next(g for g in updated_gates if g["id"] == 201)
        g_right = next(g for g in updated_gates if g["id"] == 202)
        g_unnamed = next(g for g in updated_gates if g["id"] == 203)

        # Left gate must have RoadA and ODD metric number
        self.assertEqual(g_left["properties"]["side"], "LEFT")
        self.assertEqual(g_left["properties"]["road_name"], "RoadA")
        self.assertEqual(g_left["properties"]["metric_number"] % 2, 1)  # ODD
        self.assertEqual(g_left["properties"]["house_number"], f"RoadA/{g_left['properties']['metric_number']}")

        # Right gate must have RoadA and EVEN metric number
        self.assertEqual(g_right["properties"]["side"], "RIGHT")
        self.assertEqual(g_right["properties"]["road_name"], "RoadA")
        self.assertEqual(g_right["properties"]["metric_number"] % 2, 0)  # EVEN
        self.assertEqual(g_right["properties"]["house_number"], f"RoadA/{g_right['properties']['metric_number']}")

        # Unnamed road must have RNR prefix
        self.assertEqual(g_unnamed["properties"]["road_name"], "RNR")
        self.assertTrue(g_unnamed["properties"]["house_number"].startswith("RNR/"))

        # Verify Buildings inherited the identical house number via bldg_code link!
        updated_bldgs = backend.get_layer_features_list(bldg_layer_id)
        b_left = next(b for b in updated_bldgs if b["properties"]["bldg_code"] == "BLD-LEFT")
        b_right = next(b for b in updated_bldgs if b["properties"]["bldg_code"] == "BLD-RIGHT")
        b_unnamed = next(b for b in updated_bldgs if b["properties"]["bldg_code"] == "BLD-UNNAMED")

        self.assertEqual(b_left["properties"]["house_number"], g_left["properties"]["house_number"])
        self.assertEqual(b_right["properties"]["house_number"], g_right["properties"]["house_number"])
        self.assertEqual(b_unnamed["properties"]["house_number"], g_unnamed["properties"]["house_number"])


if __name__ == "__main__":
    unittest.main()
