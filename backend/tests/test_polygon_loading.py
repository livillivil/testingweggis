"""
Tests for polygon feature loading, SpatialGridIndex LOD decimation,
coordinate normalization, and viewport bounding box queries.
"""

import math
import unittest
from fastapi.testclient import TestClient

from app.main import (
    app,
    STATE,
    SpatialGridIndex,
    get_or_build_spatial_index,
    invalidate_spatial_index,
    _coords_bounds,
)


class PolygonLoadingTest(unittest.TestCase):
    def setUp(self):
        # Sample building footprints (Kathmandu coordinates)
        self.sample_polygons = [
            {
                "type": "Feature",
                "id": 101,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [85.304775, 27.701744],
                            [85.304850, 27.701744],
                            [85.304850, 27.701800],
                            [85.304775, 27.701800],
                            [85.304775, 27.701744],
                        ]
                    ],
                },
                "properties": {"id": 101, "name": "Building A", "area": 55.4},
            },
            {
                "type": "Feature",
                "id": 102,
                "geometry": {
                    "type": "Polygon",
                    "coordinates": [
                        [
                            [85.305000, 27.702000],
                            [85.305100, 27.702000],
                            [85.305100, 27.702100],
                            [85.305000, 27.702100],
                            [85.305000, 27.702000],
                        ]
                    ],
                },
                # Missing 'area' property - should be calculated from coordinates
                "properties": {"id": 102, "name": "Building B"},
            },
            {
                "type": "Feature",
                "id": 103,
                "geometry": {
                    "type": "MultiPolygon",
                    "coordinates": [
                        [
                            [
                                [85.306000, 27.703000],
                                [85.306200, 27.703000],
                                [85.306200, 27.703200],
                                [85.306000, 27.703200],
                                [85.306000, 27.703000],
                            ]
                        ]
                    ],
                },
                "properties": {"id": 103, "name": "Building Complex C", "area": 380.0},
            },
        ]

    def test_polygon_importance_calculation(self):
        """Polygons without an explicit area property must calculate positive sqm importance."""
        idx = SpatialGridIndex("test_poly", self.sample_polygons)
        # Check area for building B (missing 'area' prop)
        # Bbox is 0.0001 deg lon x 0.0001 deg lat ~= 10m x 11m ~= 110 sqm
        area_b = idx.areas[1]
        self.assertGreater(area_b, 50.0)
        self.assertLess(area_b, 500.0)
        # Check area for building A (has area: 55.4)
        area_a = idx.areas[0]
        self.assertEqual(area_a, 55.4)

    def test_polygon_query_preserves_coordinates_across_all_zooms(self):
        """Simplification at lower zooms must NEVER collapse polygons into empty coordinates."""
        idx = SpatialGridIndex("test_poly", self.sample_polygons)
        bbox = (85.300, 27.700, 85.310, 27.710)

        for z in [9.0, 10.0, 11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 18.0]:
            results = idx.query(bbox[0], bbox[1], bbox[2], bbox[3], zoom=z)
            self.assertGreater(len(results), 0, f"Zoom {z} should return matched features")
            for feat in results:
                geom = feat.get("geometry")
                self.assertIsNotNone(geom, f"Feature at zoom {z} has no geometry")
                coords = geom.get("coordinates")
                self.assertIsNotNone(coords, f"Feature at zoom {z} has no coordinates")
                self.assertGreater(len(coords), 0, f"Feature at zoom {z} has empty coordinates")
                gtype = geom.get("type")
                self.assertIn(gtype, ("Polygon", "MultiPolygon"))

    def test_bounding_box_order_normalization(self):
        """Query must succeed even if coordinates are inverted or passed as lat/lon."""
        idx = SpatialGridIndex("test_poly", self.sample_polygons)
        # Standard order: min_lon, min_lat, max_lon, max_lat
        res_std = idx.query(85.300, 27.700, 85.310, 27.710)
        self.assertEqual(len(res_std), 3)

        # Inverted order: max_lon, max_lat, min_lon, min_lat
        res_inv = idx.query(85.310, 27.710, 85.300, 27.700)
        self.assertEqual(len(res_inv), 3)

        # Lat/Lon order: min_lat, min_lon, max_lat, max_lon
        res_latlon = idx.query(27.700, 85.300, 27.710, 85.310)
        self.assertEqual(len(res_latlon), 3)

    def test_api_layer_features_with_bbox(self):
        """FastAPI /api/layers/{id}/features?bbox=... returns building polygons with full geometry."""
        client = TestClient(app)
        test_lid = 99999901
        test_layer = {
            "id": test_lid,
            "name": "Test Building Footprints",
            "geom_type": "Polygon",
            "geometry_type": "Polygon",
            "published": True,
            "deleted_at": None,
            "project_id": None,
        }
        STATE.setdefault("vector_layers", []).append(test_layer)
        STATE.setdefault("features_by_layer", {})[str(test_lid)] = self.sample_polygons
        STATE["features_by_layer"][test_lid] = self.sample_polygons
        invalidate_spatial_index(test_lid)

        try:
            url = f"/api/layers/{test_lid}/features?bbox=85.30,27.70,85.31,27.71&zoom=14&portal=true"
            resp = client.get(url)
            self.assertEqual(resp.status_code, 200)
            data = resp.json()
            self.assertEqual(data.get("type"), "FeatureCollection")
            feats = data.get("features", [])
            self.assertGreater(len(feats), 0)
            for f in feats:
                coords = f.get("geometry", {}).get("coordinates", [])
                self.assertGreater(len(coords), 0, "Building geometry must have coordinates")
        finally:
            STATE["vector_layers"] = [l for l in STATE.get("vector_layers", []) if l.get("id") != test_lid]
            STATE.get("features_by_layer", {}).pop(str(test_lid), None)
            STATE.get("features_by_layer", {}).pop(test_lid, None)
            invalidate_spatial_index(test_lid)


if __name__ == "__main__":
    unittest.main()
