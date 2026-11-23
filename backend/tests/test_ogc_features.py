"""OGC API - Features (QGIS editing bridge) contract tests.

Verifies that:
  * every request needs credentials and a 401 carries a Basic challenge so QGIS
    prompts for the app username/password;
  * each vector layer is exposed as its own collection with GeoJSON items;
  * OPTIONS advertises POST/PUT/PATCH/DELETE so QGIS can enable Toggle Editing;
  * create/replace/patch/delete route through the REST pipeline, persist in the
    authoritative state and respect layer edit locks and project isolation.
"""

import json
import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

ADMIN_ID = 1
COLLECTOR_ID = 7
OUTSIDER_ID = 9
PROJECT_ID = 940
GLOBAL_LAYER = 970
PROJECT_LAYER = 971
LOCKED_LAYER = 972
PASSWORD = "Survey-Pass-2026"


def _point(feature_id, lng, lat, **props):
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
        "properties": props,
    }


class OgcFeaturesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            "users": list(STATE.get("users", [])),
            "projects": list(STATE.get("projects", [])),
            "vector_layers": list(STATE.get("vector_layers", [])),
            "features_by_layer": dict(STATE.get("features_by_layer", {})),
            "project_collectors": dict(STATE.get("project_collectors", {})),
            "tasks_by_project": dict(STATE.get("tasks_by_project", {})),
            "audit_edits_by_layer": dict(STATE.get("audit_edits_by_layer", {})),
            "feature_links": list(STATE.get("feature_links", [])),
        }
        password_hash = backend.hash_password(PASSWORD)
        STATE["users"] = [
            {"id": ADMIN_ID, "username": "kmc_ogc_admin", "role": "SuperAdmin", "is_active": True, "password_hash": password_hash},
            {"id": COLLECTOR_ID, "username": "kmc_ogc_collector", "role": "DataCollector", "is_active": True, "password_hash": password_hash},
            {"id": OUTSIDER_ID, "username": "kmc_ogc_outsider", "role": "DataCollector", "is_active": True, "password_hash": password_hash},
        ]
        STATE["projects"] = [{"id": PROJECT_ID, "name": "OGC", "status": "ACTIVE", "editable_layer_ids": [PROJECT_LAYER]}]
        STATE["project_collectors"] = {PROJECT_ID: [COLLECTOR_ID]}
        STATE["tasks_by_project"] = {}
        STATE["vector_layers"] = [
            {
                "id": GLOBAL_LAYER,
                "name": "Public Points",
                "project_id": None,
                "geometry_type": "Point",
                "editable_by_collectors": True,
                "bounds": [85.30, 27.69, 85.34, 27.72],
                "fields_config": [{"name": "name", "label": "Name", "type": "text", "access_level": "public"}],
            },
            {
                "id": PROJECT_LAYER,
                "name": "Project Points",
                "project_id": PROJECT_ID,
                "geometry_type": "Point",
                "editable_by_collectors": True,
                "fields_config": [{"name": "name", "label": "Name", "type": "text"}],
            },
            {
                "id": LOCKED_LAYER,
                "name": "Locked Points",
                "project_id": PROJECT_ID,
                "geometry_type": "Point",
                "editable_by_collectors": False,
                "fields_config": [{"name": "name", "label": "Name", "type": "text"}],
            },
        ]
        STATE["features_by_layer"] = {
            str(GLOBAL_LAYER): [
                _point("ogc-1", 85.31, 27.70, name="Alpha"),
                _point("ogc-2", 85.32, 27.71, name="Beta"),
            ],
            str(PROJECT_LAYER): [_point("p1", 85.31, 27.70, name="Project One")],
            str(LOCKED_LAYER): [_point("l1", 85.31, 27.70, name="Locked One")],
        }
        STATE["audit_edits_by_layer"] = {}
        STATE["feature_links"] = []
        backend._FEATURE_ID_INDEX.clear()
        self.client = TestClient(backend.app)
        self.admin = (STATE["users"][0]["username"], PASSWORD)
        self.collector = (STATE["users"][1]["username"], PASSWORD)
        self.outsider = (STATE["users"][2]["username"], PASSWORD)

    def tearDown(self):
        backend._FEATURE_ID_INDEX.clear()
        STATE.update(self._state_backup)

    # ------------------------------------------------------------ authentication

    def test_requests_without_credentials_get_basic_challenge(self):
        response = self.client.get("/ogc/collections")
        self.assertEqual(response.status_code, 401)
        self.assertIn("Basic", response.headers.get("www-authenticate", ""))

    def test_bearer_token_is_accepted(self):
        headers = {"Authorization": f"Bearer {backend._issue_access_token(ADMIN_ID)}"}
        response = self.client.get("/ogc/collections", headers=headers)
        self.assertEqual(response.status_code, 200)

    def test_wrong_password_is_rejected(self):
        response = self.client.get("/ogc/collections", auth=("kmc_ogc_admin", "wrong-password"))
        self.assertEqual(response.status_code, 401)

    # -------------------------------------------------------------- collections

    def test_collections_are_visible_layers_only(self):
        response = self.client.get("/ogc/collections", auth=self.admin)
        self.assertEqual(response.status_code, 200)
        ids = {entry["id"] for entry in response.json()["collections"]}
        self.assertEqual(ids, {str(GLOBAL_LAYER), str(PROJECT_LAYER), str(LOCKED_LAYER)})

        collector_view = self.client.get("/ogc/collections", auth=self.collector).json()
        self.assertEqual({entry["id"] for entry in collector_view["collections"]}, {str(GLOBAL_LAYER), str(PROJECT_LAYER), str(LOCKED_LAYER)})

        outsider_view = self.client.get("/ogc/collections", auth=self.outsider).json()
        self.assertEqual({entry["id"] for entry in outsider_view["collections"]}, {str(GLOBAL_LAYER)})
        self.assertEqual(
            self.client.get(f"/ogc/collections/{PROJECT_LAYER}", auth=self.outsider).status_code,
            404,
        )

    def test_collection_metadata_links_items(self):
        response = self.client.get(f"/ogc/collections/{GLOBAL_LAYER}", auth=self.admin)
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["id"], str(GLOBAL_LAYER))
        rels = {link["rel"] for link in body["links"]}
        self.assertIn("items", rels)

    # -------------------------------------------------------------------- items

    def test_items_are_geojson_with_string_ids(self):
        response = self.client.get(f"/ogc/collections/{GLOBAL_LAYER}/items", auth=self.admin)
        self.assertEqual(response.status_code, 200)
        self.assertIn("application/geo+json", response.headers["content-type"])
        body = response.json()
        self.assertEqual(body["type"], "FeatureCollection")
        self.assertEqual(body["numberMatched"], 2)
        self.assertEqual(body["numberReturned"], 2)
        self.assertEqual({feature["id"] for feature in body["features"]}, {"ogc-1", "ogc-2"})
        self.assertEqual(body["features"][0]["properties"]["name"], "Alpha")

    def test_items_paging_emits_next_link(self):
        response = self.client.get(
            f"/ogc/collections/{GLOBAL_LAYER}/items?limit=1&offset=0", auth=self.admin
        )
        body = response.json()
        self.assertEqual(body["numberReturned"], 1)
        rels = {link["rel"] for link in body["links"]}
        self.assertIn("next", rels)

    def test_items_bbox_filters_features(self):
        response = self.client.get(
            f"/ogc/collections/{GLOBAL_LAYER}/items?bbox=85.315,27.705,85.325,27.715", auth=self.admin
        )
        self.assertEqual({feature["id"] for feature in response.json()["features"]}, {"ogc-2"})

    def test_options_advertise_editing_methods(self):
        collection = self.client.options(f"/ogc/collections/{GLOBAL_LAYER}/items")
        self.assertEqual(collection.status_code, 204)
        self.assertIn("POST", collection.headers["allow"])

        item = self.client.options(f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-1")
        self.assertEqual(item.status_code, 204)
        allowed = item.headers["allow"]
        for method in ("PUT", "PATCH", "DELETE"):
            self.assertIn(method, allowed)

    # ------------------------------------------------------------ write through

    def test_create_item_persists_in_shared_store(self):
        payload = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [85.33, 27.695]},
            "properties": {"name": "Created in QGIS"},
        }
        response = self.client.post(f"/ogc/collections/{GLOBAL_LAYER}/items", json=payload, auth=self.admin)
        self.assertEqual(response.status_code, 201)
        created = response.json()
        self.assertIn("Location", response.headers)
        self.assertEqual(created["properties"]["name"], "Created in QGIS")

        stored = backend.get_layer_features_list(GLOBAL_LAYER)
        self.assertTrue(any(str(feature.get("id")) == created["id"] for feature in stored))

        listed = self.client.get(f"/ogc/collections/{GLOBAL_LAYER}/items", auth=self.admin).json()
        self.assertEqual(listed["numberMatched"], 3)

    def test_replace_item_updates_geometry_and_attributes(self):
        payload = {
            "type": "Feature",
            "id": "ogc-1",
            "geometry": {"type": "Point", "coordinates": [85.345, 27.725]},
            "properties": {"name": "Moved"},
        }
        response = self.client.put(f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-1", json=payload, auth=self.admin)
        self.assertEqual(response.status_code, 204)

        fetched = self.client.get(f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-1", auth=self.admin).json()
        self.assertEqual(fetched["geometry"]["coordinates"], [85.345, 27.725])
        self.assertEqual(fetched["properties"]["name"], "Moved")

    def test_patch_item_updates_attributes_only(self):
        response = self.client.patch(
            f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-2",
            json={"type": "Feature", "properties": {"name": "Patched"}},
            auth=self.admin,
        )
        self.assertEqual(response.status_code, 204)

        fetched = self.client.get(f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-2", auth=self.admin).json()
        self.assertEqual(fetched["properties"]["name"], "Patched")
        self.assertEqual(fetched["geometry"]["coordinates"], [85.32, 27.71])

    def test_delete_item_removes_it_everywhere(self):
        response = self.client.delete(f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-2", auth=self.admin)
        self.assertEqual(response.status_code, 204)

        self.assertEqual(
            self.client.get(f"/ogc/collections/{GLOBAL_LAYER}/items/ogc-2", auth=self.admin).status_code,
            404,
        )
        remaining = [feature.get("id") for feature in backend.get_layer_features_list(GLOBAL_LAYER)]
        self.assertNotIn("ogc-2", remaining)

    def test_qgis_media_types_and_payloads_are_accepted(self):
        """Mirror the exact wire requests the QGIS OAPIF provider sends."""
        create = self.client.post(
            f"/ogc/collections/{GLOBAL_LAYER}/items",
            content=json.dumps(
                {
                    "type": "Feature",
                    "geometry": {"type": "Point", "coordinates": [85.33, 27.695]},
                    "properties": {"name": "QGIS add"},
                }
            ),
            headers={"Content-Type": "application/geo+json"},
            auth=self.admin,
        )
        self.assertEqual(create.status_code, 201)
        self.assertIn("/items/", create.headers["location"])
        created_id = create.json()["id"]

        attribute_patch = self.client.patch(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}",
            content=json.dumps({"properties": {"name": "QGIS attr edit"}}),
            headers={"Content-Type": "application/merge-patch+json"},
            auth=self.admin,
        )
        self.assertEqual(attribute_patch.status_code, 204)
        fetched = self.client.get(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}", auth=self.admin
        ).json()
        self.assertEqual(fetched["properties"]["name"], "QGIS attr edit")

        geometry_patch = self.client.patch(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}",
            content=json.dumps({"geometry": {"type": "Point", "coordinates": [85.34, 27.7]}}),
            headers={"Content-Type": "application/merge-patch+json"},
            auth=self.admin,
        )
        self.assertEqual(geometry_patch.status_code, 204)
        fetched = self.client.get(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}", auth=self.admin
        ).json()
        self.assertEqual(fetched["geometry"]["coordinates"], [85.34, 27.7])

        replace = self.client.put(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}",
            content=json.dumps(
                {
                    "type": "Feature",
                    "id": created_id,
                    "geometry": {"type": "Point", "coordinates": [85.35, 27.71]},
                    "properties": {"name": "QGIS replace"},
                }
            ),
            headers={"Content-Type": "application/geo+json"},
            auth=self.admin,
        )
        self.assertEqual(replace.status_code, 204)
        fetched = self.client.get(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}", auth=self.admin
        ).json()
        self.assertEqual(fetched["properties"]["name"], "QGIS replace")

        removed = self.client.delete(
            f"/ogc/collections/{GLOBAL_LAYER}/items/{created_id}", auth=self.admin
        )
        self.assertEqual(removed.status_code, 204)

    def test_duplicate_feature_ids_are_scoped_to_the_collection(self):
        """Imported layers reuse ids (1..N); a QGIS edit must hit only its layer."""
        STATE["features_by_layer"][str(GLOBAL_LAYER)] = [
            _point("dup-1", 85.31, 27.70, name="Global dup")
        ]
        STATE["features_by_layer"][str(PROJECT_LAYER)] = [
            _point("dup-1", 85.315, 27.705, name="Project dup")
        ]

        patched = self.client.patch(
            f"/ogc/collections/{PROJECT_LAYER}/items/dup-1",
            json={"type": "Feature", "properties": {"name": "Project patched"}},
            auth=self.admin,
        )
        self.assertEqual(patched.status_code, 204)
        project_feature = self.client.get(
            f"/ogc/collections/{PROJECT_LAYER}/items/dup-1", auth=self.admin
        ).json()
        global_feature = self.client.get(
            f"/ogc/collections/{GLOBAL_LAYER}/items/dup-1", auth=self.admin
        ).json()
        self.assertEqual(project_feature["properties"]["name"], "Project patched")
        self.assertEqual(global_feature["properties"]["name"], "Global dup")

        removed = self.client.delete(
            f"/ogc/collections/{PROJECT_LAYER}/items/dup-1", auth=self.admin
        )
        self.assertEqual(removed.status_code, 204)
        self.assertEqual(
            self.client.get(f"/ogc/collections/{PROJECT_LAYER}/items/dup-1", auth=self.admin).status_code,
            404,
        )
        self.assertEqual(
            self.client.get(f"/ogc/collections/{GLOBAL_LAYER}/items/dup-1", auth=self.admin).status_code,
            200,
        )

    def test_rest_writes_accept_layer_scope(self):
        """The web app pins PUT/DELETE to a layer so collisions cannot cross layers."""
        headers = {"Authorization": f"Bearer {backend._issue_access_token(ADMIN_ID)}"}
        STATE["features_by_layer"][str(GLOBAL_LAYER)] = [
            _point("dup-2", 85.31, 27.70, name="Global")
        ]
        STATE["features_by_layer"][str(PROJECT_LAYER)] = [
            _point("dup-2", 85.315, 27.705, name="Project")
        ]

        updated = self.client.put(
            "/api/features/dup-2",
            json={
                "layer_id": PROJECT_LAYER,
                "properties": {"name": "REST patched"},
                "geom_geojson": {"type": "Point", "coordinates": [85.316, 27.706]},
            },
            headers=headers,
        )
        self.assertEqual(updated.status_code, 200)

        stored = {
            str(feature.get("id")): feature
            for feature in backend.get_layer_features_list(PROJECT_LAYER)
        }["dup-2"]
        self.assertEqual(stored["properties"]["name"], "REST patched")
        untouched = {
            str(feature.get("id")): feature
            for feature in backend.get_layer_features_list(GLOBAL_LAYER)
        }["dup-2"]
        self.assertEqual(untouched["properties"]["name"], "Global")

        deleted = self.client.delete(
            f"/api/features/dup-2?layer_id={PROJECT_LAYER}", headers=headers
        )
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(backend.get_layer_features_list(PROJECT_LAYER), [])
        self.assertEqual(len(backend.get_layer_features_list(GLOBAL_LAYER)), 1)

    # ------------------------------------------------------------- permissions

    def test_collector_can_edit_unlocked_project_layer(self):
        payload = {
            "type": "Feature",
            "id": "p1",
            "geometry": {"type": "Point", "coordinates": [85.31, 27.70]},
            "properties": {"name": "Collector edit"},
        }
        response = self.client.put(f"/ogc/collections/{PROJECT_LAYER}/items/p1", json=payload, auth=self.collector)
        self.assertEqual(response.status_code, 204)
        fetched = self.client.get(f"/ogc/collections/{PROJECT_LAYER}/items/p1", auth=self.collector).json()
        self.assertEqual(fetched["properties"]["name"], "Collector edit")

    def test_locked_layer_rejects_collector_writes(self):
        payload = {
            "type": "Feature",
            "id": "l1",
            "geometry": {"type": "Point", "coordinates": [85.31, 27.70]},
            "properties": {"name": "Should not happen"},
        }
        response = self.client.put(f"/ogc/collections/{LOCKED_LAYER}/items/l1", json=payload, auth=self.collector)
        self.assertEqual(response.status_code, 403)

        stored = next(feature for feature in backend.get_layer_features_list(LOCKED_LAYER) if feature.get("id") == "l1")
        self.assertEqual(stored["properties"]["name"], "Locked One")

    def test_outsider_cannot_write_hidden_collection(self):
        payload = {
            "type": "Feature",
            "geometry": {"type": "Point", "coordinates": [85.31, 27.70]},
            "properties": {"name": "Outsider"},
        }
        response = self.client.post(f"/ogc/collections/{PROJECT_LAYER}/items", json=payload, auth=self.outsider)
        self.assertEqual(response.status_code, 404)


if __name__ == "__main__":
    unittest.main()
