"""
KMC-GIS-SERVER — Grid & AOI engine tests (no database required).

Run inside the backend image:

    docker compose run --rm --no-deps -v "$PWD/backend/app:/app/app:ro" \
        -v "$PWD/backend/tests:/app/tests:ro" --entrypoint python backend \
        -m unittest discover -s /app/tests -v

The core field-tasking rule under test: **a grid must cover the entire AOI**, with
no cells outside it and (for partition modes) no overlapping cells.
"""

import math
import unittest

from shapely.geometry import Point, Polygon, shape
from shapely.ops import unary_union

from app.spatial_grid import (
    GRID_MODES,
    generate_grid_cells,
    normalize_aoi_geometry,
    normalize_grid_mode,
    validate_cell_size,
)

SQUARE_AOI = {
    "type": "Polygon",
    "coordinates": [[
        [85.300, 27.690],
        [85.320, 27.690],
        [85.320, 27.710],
        [85.300, 27.710],
        [85.300, 27.690],
    ]],
}

# L-shaped (concave) AOI: a bounding-box grid would over-cover this.
L_SHAPED_AOI = {
    "type": "Polygon",
    "coordinates": [[
        [85.300, 27.690],
        [85.320, 27.690],
        [85.320, 27.696],
        [85.308, 27.696],
        [85.308, 27.710],
        [85.300, 27.710],
        [85.300, 27.690],
    ]],
}

HOLED_AOI = {
    "type": "Polygon",
    "coordinates": [
        [[85.300, 27.690], [85.320, 27.690], [85.320, 27.710], [85.300, 27.710], [85.300, 27.690]],
        [[85.306, 27.696], [85.306, 27.704], [85.314, 27.704], [85.314, 27.696], [85.306, 27.696]],
    ],
}

# A thin, bent corridor: lattice clipping leaves irregular residuals here.
NARROW_AOI = {
    "type": "Polygon",
    "coordinates": [[
        [85.3000, 27.6900], [85.3012, 27.6900], [85.3012, 27.7080], [85.3180, 27.7080],
        [85.3180, 27.7092], [85.3000, 27.7092], [85.3000, 27.6900],
    ]],
}

MULTI_AOI = {
    "type": "MultiPolygon",
    "coordinates": [
        [[[85.300, 27.690], [85.308, 27.690], [85.308, 27.698], [85.300, 27.698], [85.300, 27.690]]],
        [[[85.312, 27.702], [85.320, 27.702], [85.320, 27.710], [85.312, 27.710], [85.312, 27.702]]],
    ],
}

ALL_MODES = sorted(set(GRID_MODES.values()))


def _aoi_area(aoi_geojson):
    return normalize_aoi_geometry(aoi_geojson).area


class GridGenerationTest(unittest.TestCase):
    def _generate(self, aoi, mode, size=200):
        result = generate_grid_cells(aoi, mode, size, seed=7)
        self.assertGreater(result["stats"]["cells"], 0)
        return result

    def test_every_mode_has_a_generator(self):
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                result = self._generate(SQUARE_AOI, mode, size=400)
                self.assertEqual(result["grid_shape"], mode)
                self.assertEqual(result["cell_size_m"], 400.0)

    def test_all_modes_cover_the_entire_aoi(self):
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                result = self._generate(SQUARE_AOI, mode, size=300)
                coverage = result["stats"]["coverage_percent"]
                self.assertGreaterEqual(coverage, 99.0, f"{mode} covers only {coverage}% of the AOI")

    def test_no_cell_falls_outside_the_aoi(self):
        aoi = normalize_aoi_geometry(SQUARE_AOI)
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                result = self._generate(SQUARE_AOI, mode, size=350)
                for cell in result["cells"]:
                    geom = shape(cell["geometry"])
                    outside = geom.difference(aoi).area
                    self.assertLess(outside, 1.0, f"{mode} cell {cell['grid_index']} escapes the AOI")

    def test_partition_modes_do_not_double_count_area(self):
        aoi_area = _aoi_area(SQUARE_AOI)
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                result = self._generate(SQUARE_AOI, mode, size=350)
                cell_area_sum = sum(shape(cell["geometry"]).area for cell in result["cells"])
                # Sum of cell areas must match the union (i.e. no significant overlap).
                self.assertLess(
                    cell_area_sum,
                    aoi_area * 1.05,
                    f"{mode} cells overlap heavily (sum={cell_area_sum:.1f}, aoi={aoi_area:.1f})",
                )

    def test_concave_aoi_is_fully_covered_without_filling_the_notch(self):
        result = self._generate(L_SHAPED_AOI, "SQUARE", size=250)
        aoi = normalize_aoi_geometry(L_SHAPED_AOI)
        coverage = result["stats"]["coverage_percent"]
        self.assertGreaterEqual(coverage, 99.0)

        union = unary_union([shape(cell["geometry"]) for cell in result["cells"]])
        notch = Point(85.316, 27.704)
        self.assertFalse(union.contains(notch), "grid must not fill the concave notch")
        self.assertGreater(union.intersection(aoi).area / aoi.area, 0.99)

    def test_aoi_with_hole_is_fully_covered_and_hole_preserved(self):
        aoi = normalize_aoi_geometry(HOLED_AOI)
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                result = self._generate(HOLED_AOI, mode, size=250)
                self.assertGreaterEqual(result["stats"]["coverage_percent"], 99.9)
                union = unary_union([shape(cell["geometry"]) for cell in result["cells"]])
                self.assertLess(union.intersection(aoi).area / aoi.area, 1.001)
                hole_point = Point(85.310, 27.700)
                self.assertFalse(union.contains(hole_point), "grid must not fill the AOI hole")

    def test_narrow_corridor_is_fully_covered(self):
        for mode in ALL_MODES:
            with self.subTest(mode=mode):
                result = self._generate(NARROW_AOI, mode, size=120)
                self.assertGreaterEqual(
                    result["stats"]["coverage_percent"], 99.9,
                    f"{mode} left AOI area ungridded",
                )

    def test_multipolygon_aoi_covers_both_parts(self):
        result = self._generate(MULTI_AOI, "HEXAGON", size=300)
        aoi = normalize_aoi_geometry(MULTI_AOI)
        union = unary_union([shape(cell["geometry"]) for cell in result["cells"]])
        for part in aoi.geoms:
            overlap = union.intersection(part).area / part.area
            self.assertGreater(overlap, 0.99, "each AOI part must be gridded")

    def test_cells_are_numbered_contiguously_and_labelled(self):
        result = self._generate(SQUARE_AOI, "SQUARE", size=500)
        indices = [cell["grid_index"] for cell in result["cells"]]
        self.assertEqual(indices, list(range(1, len(indices) + 1)))
        codes = [cell["grid_code"] for cell in result["cells"]]
        self.assertEqual(len(codes), len(set(codes)))
        for cell in result["cells"]:
            self.assertEqual(len(cell["bbox"]), 4)
            self.assertEqual(len(cell["centroid"]), 2)
            self.assertGreater(cell["area_sqm"], 0)

    def test_random_mode_is_deterministic(self):
        first = generate_grid_cells(SQUARE_AOI, "RANDOM", 300, seed=42)
        second = generate_grid_cells(SQUARE_AOI, "RANDOM", 300, seed=42)
        self.assertEqual(first["stats"]["cells"], second["stats"]["cells"])

    def test_cell_size_controls_resolution(self):
        coarse = generate_grid_cells(SQUARE_AOI, "SQUARE", 1000)
        fine = generate_grid_cells(SQUARE_AOI, "SQUARE", 250)
        self.assertGreater(fine["stats"]["cells"], coarse["stats"]["cells"])

    def test_aoi_accepts_feature_and_feature_collection(self):
        feature = {"type": "Feature", "properties": {}, "geometry": SQUARE_AOI}
        self.assertGreater(normalize_aoi_geometry(feature).area, 0)

        collection = {
            "type": "FeatureCollection",
            "features": [feature, {"type": "Feature", "properties": {}, "geometry": MULTI_AOI}],
        }
        self.assertGreater(normalize_aoi_geometry(collection).area, normalize_aoi_geometry(feature).area)

    def test_invalid_inputs_are_rejected(self):
        with self.assertRaises(ValueError):
            normalize_grid_mode("OCTAGON")
        with self.assertRaises(ValueError):
            validate_cell_size(1)
        with self.assertRaises(ValueError):
            validate_cell_size(9000)
        with self.assertRaises(ValueError):
            validate_cell_size("abc")
        with self.assertRaises(ValueError):
            normalize_aoi_geometry({"type": "LineString", "coordinates": [[0, 0], [1, 1]]})
        with self.assertRaises(ValueError):
            generate_grid_cells(SQUARE_AOI, "SQUARE", 5)  # AOI 44 km² / 25 m² > MAX_GRID_CELLS

    def test_grid_size_validation_bounds(self):
        self.assertEqual(validate_cell_size(5), 5.0)
        self.assertEqual(validate_cell_size("5000"), 5000.0)
        self.assertTrue(math.isfinite(validate_cell_size(180)))


if __name__ == "__main__":
    unittest.main(verbosity=2)
