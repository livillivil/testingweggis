"""
KMC-GIS-SERVER — public GeoPortal catalog, role access and kill-switch tests.

The portal UI consumes `categories[].layers[]`; these tests pin that contract
and verify that access levels, field permissions and the MasterAdmin halt
switch are enforced server-side rather than only in the browser.
"""

import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

PUBLIC_LAYER_ID = 920
VALIDATOR_LAYER_ID = 921
HIDDEN_LAYER_ID = 922
RASTER_ID = 923
ADMIN_ID = 1
MASTER_ID = 2
VALIDATOR_ID = 3
COLLECTOR_ID = 4

FIELDS_CONFIG = [
    {"name": "name", "label": "Name", "type": "text"},
    {"name": "owner", "label": "Owner", "type": "text"},
    {"name": "area", "label": "Area", "type": "number"},
]


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


def _layer(layer_id, access_level, published=True):
    return {
        "id": layer_id,
        "name": f"Layer {layer_id}",
        "category": "Test Category",
        "project_id": None,
        "geometry_type": "Polygon",
        "access_level": access_level,
        "published": published,
        "default_visible": access_level == "public",
        "fields_config": list(FIELDS_CONFIG),
        "field_permissions": {"owner": ["DepartmentAdmin", "SuperAdmin", "MasterAdmin"]},
        "bounds": [85.30, 27.69, 85.31, 27.70],
    }


def _feature(feature_id, owner, area):
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {"type": "Point", "coordinates": [85.30, 27.69]},
        "properties": {"name": f"Feature {feature_id}", "owner": owner, "area": area},
    }


class GeoportalCatalogTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            "users": list(STATE.get("users", [])),
            "vector_layers": list(STATE.get("vector_layers", [])),
            "raster_layers": list(STATE.get("raster_layers", [])),
            "features_by_layer": dict(STATE.get("features_by_layer", {})),
            "platform_settings": dict(STATE.get("platform_settings", {})),
        }
        STATE["users"] = [
            {"id": ADMIN_ID, "username": "admin", "role": "SuperAdmin", "is_active": True},
            {"id": MASTER_ID, "username": "master", "role": "MasterAdmin", "is_active": True},
            {"id": VALIDATOR_ID, "username": "validator", "role": "Validator", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector", "role": "DataCollector", "is_active": True},
        ]
        STATE["vector_layers"] = [
            _layer(PUBLIC_LAYER_ID, "public"),
            _layer(VALIDATOR_LAYER_ID, "validator"),
            _layer(HIDDEN_LAYER_ID, "admin_only"),
            _layer(924, "public", published=False),
        ]
        STATE["raster_layers"] = [
            {"id": RASTER_ID, "name": "Ortho", "project_id": None, "published": True, "access_level": "public"}
        ]
        STATE["features_by_layer"] = {
            PUBLIC_LAYER_ID: [_feature("f1", "Alice", 10), _feature("f2", "Bob", 20)],
            VALIDATOR_LAYER_ID: [_feature("f3", "Carol", 30)],
            HIDDEN_LAYER_ID: [_feature("f4", "Dave", 40)],
        }
        STATE["platform_settings"] = {**dict(STATE.get("platform_settings", {})), "geoportal_enabled": True}
        self.client = TestClient(backend.app)

    def tearDown(self):
        STATE.update(self._state_backup)

    def _layer_ids(self, response):
        payload = response.json()
        return {
            layer["id"]
            for category in payload["categories"]
            for layer in category["layers"]
        }

    def test_anonymous_catalog_groups_layers_and_hides_restricted_roles(self):
        response = self.client.get("/api/geoportal/catalog")
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["is_admin"])
        self.assertIn("categories", payload)
        self.assertEqual(self._layer_ids(response), {PUBLIC_LAYER_ID, RASTER_ID})

        public_layer = next(
            layer
            for category in payload["categories"]
            for layer in category["layers"]
            if layer["id"] == PUBLIC_LAYER_ID
        )
        self.assertEqual(public_layer["type"], "vector")
        self.assertIn("/api/layers/%s/features" % PUBLIC_LAYER_ID, public_layer["feature_url"])
        self.assertIn("all_fields_config", public_layer)
        # `owner` is administrator-only, so it must not be advertised publicly.
        self.assertEqual({f["name"] for f in public_layer["fields_config"]}, {"name", "area"})
        self.assertEqual({f["name"] for f in public_layer["all_fields_config"]}, {"name", "owner", "area"})

    def test_role_access_levels_reach_their_layers(self):
        validator = self.client.get("/api/geoportal/catalog", headers=_token(VALIDATOR_ID))
        self.assertEqual(validator.status_code, 200)
        self.assertEqual(self._layer_ids(validator), {PUBLIC_LAYER_ID, VALIDATOR_LAYER_ID, RASTER_ID})

        admin = self.client.get("/api/geoportal/catalog", headers=_token(ADMIN_ID))
        self.assertTrue(admin.json()["is_admin"])
        # Admins can view unpublished layers (e.g. 924) in the catalog to manage them,
        # whereas public/validator users never see unpublished layers.
        self.assertEqual(
            self._layer_ids(admin),
            {PUBLIC_LAYER_ID, VALIDATOR_LAYER_ID, HIDDEN_LAYER_ID, 924, RASTER_ID},
        )
        admin_public = next(
            layer
            for category in admin.json()["categories"]
            for layer in category["layers"]
            if layer["id"] == PUBLIC_LAYER_ID
        )
        self.assertEqual({f["name"] for f in admin_public["fields_config"]}, {"name", "owner", "area"})

    def test_analytics_respects_access_level_and_field_permissions(self):
        anonymous_hidden = self.client.get(f"/api/analytics/layer/{HIDDEN_LAYER_ID}")
        self.assertEqual(anonymous_hidden.status_code, 403)

        anonymous_public = self.client.get(f"/api/analytics/layer/{PUBLIC_LAYER_ID}")
        self.assertEqual(anonymous_public.status_code, 200, anonymous_public.text)
        payload = anonymous_public.json()
        chart_fields = {chart["field"] for chart in payload["charts"]["categories"]}
        chart_fields |= {summary["field"] for summary in payload["charts"]["numeric_summaries"]}
        self.assertNotIn("owner", chart_fields)
        self.assertIn("area", chart_fields)

        admin_hidden = self.client.get(
            f"/api/analytics/layer/{HIDDEN_LAYER_ID}", headers=_token(ADMIN_ID)
        )
        self.assertEqual(admin_hidden.status_code, 200, admin_hidden.text)

    def test_portal_feature_stream_hides_restricted_fields_and_raw_stream_requires_auth(self):
        portal = self.client.get(
            f"/api/layers/{PUBLIC_LAYER_ID}/features", params={"portal": "1"}
        )
        self.assertEqual(portal.status_code, 200, portal.text)
        props = portal.json()["features"][0]["properties"]
        self.assertNotIn("owner", props)
        self.assertIn("name", props)

        admin_portal = self.client.get(
            f"/api/layers/{PUBLIC_LAYER_ID}/features",
            params={"portal": "1"},
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(admin_portal.status_code, 200, admin_portal.text)
        self.assertIn("owner", admin_portal.json()["features"][0]["properties"])

        # The raw (non-portal) stream is an internal contract and must not be
        # reachable anonymously, otherwise field permissions are bypassable.
        self.assertEqual(
            self.client.get(f"/api/layers/{PUBLIC_LAYER_ID}/features").status_code,
            401,
        )
        staff = self.client.get(
            f"/api/layers/{PUBLIC_LAYER_ID}/features", headers=_token(COLLECTOR_ID)
        )
        self.assertEqual(staff.status_code, 200, staff.text)
        staff_props = staff.json()["features"][0]["properties"]
        # Admin-only field permissions hold on every stream, including the raw
        # internal one, so restricted attributes cannot be scraped by staff.
        self.assertNotIn("owner", staff_props)
        self.assertIn("name", staff_props)

    def test_master_kill_switch_halts_public_surfaces_but_keeps_staff_maps(self):
        STATE["platform_settings"]["geoportal_enabled"] = False
        try:
            self.assertEqual(self.client.get("/api/geoportal/catalog").status_code, 503)
            self.assertEqual(self.client.get("/api/analytics/layer/%s" % PUBLIC_LAYER_ID).status_code, 503)
            self.assertEqual(self.client.get("/api/tiles").status_code, 503)
            self.assertEqual(
                self.client.get(
                    f"/api/layers/{PUBLIC_LAYER_ID}/features", params={"portal": "1"}
                ).status_code,
                503,
            )
            # Authenticated internal staff keep their dashboard maps.
            self.assertEqual(
                self.client.get("/api/tiles", headers=_token(COLLECTOR_ID)).status_code, 200
            )
            self.assertEqual(
                self.client.get("/api/geoportal/catalog", headers=_token(MASTER_ID)).status_code, 200
            )
        finally:
            STATE["platform_settings"]["geoportal_enabled"] = True


    def test_unpublished_layer_hidden_from_public_visible_to_admin(self):
        # Layer 924 is public access_level but published=False (Draft/Unpublished).
        # Anonymous users must NOT see it in catalog or feature endpoint:
        anon_cat = self.client.get("/api/geoportal/catalog")
        self.assertNotIn(924, self._layer_ids(anon_cat))
        anon_feat = self.client.get("/api/layers/924/features", params={"portal": "1"})
        self.assertEqual(anon_feat.status_code, 403)

        # Admin users MUST see it in the catalog and be able to query its features:
        admin_cat = self.client.get("/api/geoportal/catalog", headers=_token(ADMIN_ID))
        self.assertIn(924, self._layer_ids(admin_cat))
        admin_feat = self.client.get(
            "/api/layers/924/features", params={"portal": "1"}, headers=_token(ADMIN_ID)
        )
        self.assertEqual(admin_feat.status_code, 200)


if __name__ == "__main__":
    unittest.main()
