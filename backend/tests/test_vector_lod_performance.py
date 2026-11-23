"""
Tests for Vector LOD Performance, Spatial Grid Progressive Quotas,
Single Feature Detail Lookup, and Admin Visibility of Unpublished Layers.
"""
import unittest
from fastapi.testclient import TestClient
from app import main as backend
from app.main import (
    app,
    STATE,
    set_layer_features,
    get_or_build_spatial_index,
    invalidate_spatial_index,
)


class TestVectorLodPerformance(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(app)

    def setUp(self):
        self.layer_id = 8888
        layer_meta = {
            "id": self.layer_id,
            "name": "Test LOD Roads",
            "geometry_type": "LineString",
            "feature_count": 500,
            "project_id": None, # Global public layer
            "published": True,
            "fields_config": [
                {"name": "roadname", "type": "text"},
                {"name": "roadclass", "type": "text"},
                {"name": "custom_detail_1", "type": "text"},
                {"name": "custom_detail_2", "type": "text"},
            ],
        }
        STATE["vector_layers"] = [l for l in STATE.get("vector_layers", []) if l.get("id") != self.layer_id] + [layer_meta]

        # Generate 500 lines across Kathmandu bounding box
        feats = []
        for i in range(500):
            offset = i * 0.0001
            feats.append({
                "type": "Feature",
                "id": 50000 + i,
                "geometry": {
                    "type": "LineString",
                    "coordinates": [
                        [85.30 + offset, 27.70],
                        [85.30 + offset + 0.00005, 27.705],
                        [85.30 + offset + 0.0001, 27.71],
                    ],
                },
                "properties": {
                    "_id": 50000 + i,
                    "roadname": f"Road Segment {i}",
                    "roadclass": "Primary" if i < 10 else "Residential",
                    "length": 150.0 + i,
                    "road_width": 8.0,
                    "custom_detail_1": "Very large surveyor notes that should be stripped on overview",
                    "custom_detail_2": "Detailed structural inspection history from 2024",
                    "custom_detail_3": "Pavement distress rating index 89.2",
                    "custom_detail_4": "Sub-base thickness 250mm crushed gravel",
                },
            })
        set_layer_features(self.layer_id, feats)
        invalidate_spatial_index(self.layer_id)

        token = backend._issue_access_token(1) # Admin
        self.admin_headers = {"Authorization": f"Bearer {token}"}

    def test_single_feature_get_endpoint_returns_full_properties(self):
        """GET /api/features/{id} must return 100% of all properties."""
        res = self.client.get(f"/api/features/50000", headers=self.admin_headers)
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertEqual(data.get("id"), 50000)
        props = data.get("properties", {})
        self.assertIn("custom_detail_1", props)
        self.assertIn("custom_detail_4", props)
        self.assertEqual(props.get("roadname"), "Road Segment 0")

    def test_viewport_query_at_low_zoom_applies_lod_and_essential_props(self):
        """At overview zoom (Z=12), payload has adaptive quota and essential properties."""
        res = self.client.get(
            f"/api/layers/{self.layer_id}/features?bbox=85.29,27.69,85.35,27.72&zoom=12",
            headers=self.admin_headers,
        )
        self.assertEqual(res.status_code, 200)
        fc = res.json()
        features = fc.get("features", [])
        # Road quota at Z=12 is capped at 600
        self.assertLessEqual(len(features), 600)
        self.assertGreater(len(features), 0)

        # Overview properties should retain essential keys but strip heavy details
        sample = features[0]
        sample_props = sample.get("properties", {})
        self.assertIn("roadname", sample_props)
        self.assertIn("roadclass", sample_props)
        # Heavy custom detail should not bloat the viewport payload
        self.assertNotIn("custom_detail_1", sample_props)

    def test_viewport_query_at_street_zoom_delivers_full_properties(self):
        """At block zoom (Z=17), 100% of properties are returned intact."""
        res = self.client.get(
            f"/api/layers/{self.layer_id}/features?bbox=85.29,27.69,85.35,27.72&zoom=17",
            headers=self.admin_headers,
        )
        self.assertEqual(res.status_code, 200)
        fc = res.json()
        features = fc.get("features", [])
        self.assertGreater(len(features), 0)
        sample_props = features[0].get("properties", {})
        self.assertIn("custom_detail_1", sample_props)
        self.assertIn("custom_detail_4", sample_props)

    def test_admin_can_view_unpublished_layer(self):
        """When super admin hides a layer from public view (published=False), admin can still view it."""
        layer = next(l for l in STATE["vector_layers"] if l["id"] == self.layer_id)
        layer["published"] = False

        # Public anonymous access is blocked
        res_public = self.client.get(f"/api/layers/{self.layer_id}/features?portal=true")
        self.assertEqual(res_public.status_code, 403)

        # Admin access is permitted
        res_admin = self.client.get(
            f"/api/layers/{self.layer_id}/features?portal=true",
            headers=self.admin_headers,
        )
        self.assertEqual(res_admin.status_code, 200)
        fc = res_admin.json()
        self.assertGreater(len(fc.get("features", [])), 0)
