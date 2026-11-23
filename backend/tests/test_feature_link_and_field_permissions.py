"""
Feature-level linking and admin field-permission tests.

Covers the production contract:
  * two features link only when the chosen attribute holds the same value on
    both sides (409 otherwise) and the pairing is recorded reciprocally;
  * a failed link never leaves an orphan feature behind;
  * the admin panel's access_level / editable_roles restriction is enforced on
    create, update and questionnaire submission, not only in the browser;
  * role-filtered layer schemas never expose admin-restricted fields.
"""

import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

ADMIN_ID = 1
GIS_ADMIN_ID = 2
COLLECTOR_ID = 7
VALIDATOR_ID = 8
PROJECT_ID = 940
QUESTIONNAIRE_ID = 950
LAYER_A = 930
LAYER_B = 931
LAYER_Q = 932


def _point(feature_id, lng, lat, **props):
    return {
        "type": "Feature",
        "id": feature_id,
        "geometry": {"type": "Point", "coordinates": [lng, lat]},
        "properties": props,
    }


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class FeatureLinkAndFieldPermissionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            "users": list(STATE.get("users", [])),
            "projects": list(STATE.get("projects", [])),
            "vector_layers": list(STATE.get("vector_layers", [])),
            "features_by_layer": dict(STATE.get("features_by_layer", {})),
            "feature_links": list(STATE.get("feature_links", [])),
            "questionnaires": list(STATE.get("questionnaires", [])),
            "records": list(STATE.get("records", [])),
            "project_collectors": dict(STATE.get("project_collectors", [])),
            "tasks_by_project": dict(STATE.get("tasks_by_project", {})),
            "audit_edits_by_layer": dict(STATE.get("audit_edits_by_layer", {})),
        }
        STATE["users"] = [
            {"id": ADMIN_ID, "username": "kmc_super", "role": "SuperAdmin", "is_active": True},
            {"id": GIS_ADMIN_ID, "username": "kmc_gis", "role": "GisAdmin", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector1", "role": "DataCollector", "is_active": True},
            {"id": VALIDATOR_ID, "username": "validator1", "role": "Validator", "is_active": True},
        ]
        STATE["projects"] = [
            {
                "id": PROJECT_ID,
                "name": "Link",
                "status": "ACTIVE",
                "project_mode": "ADVANCED_QUESTIONNAIRE",
                "department_admin_ids": [GIS_ADMIN_ID],
                "editable_layer_ids": [LAYER_Q],
            }
        ]
        STATE["project_collectors"] = {PROJECT_ID: [COLLECTOR_ID, VALIDATOR_ID]}
        STATE["tasks_by_project"] = {}
        STATE["vector_layers"] = [
            {
                "id": LAYER_A,
                "name": "Buildings",
                "project_id": None,
                "geometry_type": "Point",
                "editable_by_collectors": True,
                "fields_config": [
                    {"name": "parcel_no", "label": "Parcel", "type": "text", "access_level": "public"},
                    {"name": "owner_name", "label": "Owner", "type": "text", "access_level": "validator"},
                    {"name": "tax_code", "label": "Tax", "type": "text", "access_level": "admin"},
                    {"name": "locked_note", "label": "Note", "type": "text", "editable_roles": ["Validator"]},
                ],
            },
            {
                "id": LAYER_B,
                "name": "Roads",
                "project_id": None,
                "geometry_type": "Point",
                "editable_by_collectors": True,
                "fields_config": [
                    {"name": "parcel_no", "label": "Parcel", "type": "text"},
                    {"name": "road_name", "label": "Road", "type": "text"},
                ],
            },
            {
                "id": LAYER_Q,
                "name": "Survey",
                "project_id": PROJECT_ID,
                "questionnaire_id": QUESTIONNAIRE_ID,
                "geometry_type": "Point",
                "editable_by_collectors": True,
                "fields_config": [
                    {"name": "owner_name", "label": "Owner", "type": "text"},
                    {"name": "tax_code", "label": "Tax", "type": "text", "access_level": "admin"},
                ],
            },
        ]
        STATE["features_by_layer"] = {
            LAYER_A: [
                _point("a1", 85.30, 27.70, parcel_no="P-1", owner_name="Sita", tax_code="T-1"),
                _point("a2", 85.31, 27.70, parcel_no="P-2"),
                _point("a3", 85.32, 27.70),
            ],
            LAYER_B: [
                _point("b1", 85.30, 27.71, parcel_no="P-1", road_name="Baneshwor Road"),
                _point("b2", 85.31, 27.71, parcel_no="P-9"),
                _point("b3", 85.32, 27.71),
            ],
            LAYER_Q: [],
        }
        STATE["feature_links"] = []
        STATE["questionnaires"] = [
            {
                "id": QUESTIONNAIRE_ID,
                "project_id": PROJECT_ID,
                "title": "Survey",
                "status": "PUBLISHED",
                "is_active": True,
                "schema_definition": {
                    "sections": [{"id": "sec_1", "title": "General", "order": 1}],
                    "questions": [
                        {"id": "q1", "name": "owner_name", "label": "Owner", "type": "text", "section_id": "sec_1", "required": True},
                    ],
                },
            }
        ]
        STATE["records"] = []
        STATE["audit_edits_by_layer"] = {}
        backend._FEATURE_ID_INDEX.clear()
        self.client = TestClient(backend.app)

    def tearDown(self):
        backend._FEATURE_ID_INDEX.clear()
        STATE.update(self._state_backup)

    # ---------------------------------------------------------------- helpers

    def _link(self, source_id, target_id, source_attr="parcel_no", target_attr="parcel_no",
              user=ADMIN_ID, source_layer=LAYER_A, target_layer=LAYER_B):
        return self.client.post(
            f"/api/features/{source_id}/link",
            json={
                "target_feature_id": target_id,
                "source_layer_id": source_layer,
                "target_layer_id": target_layer,
                "source_link_attribute": source_attr,
                "target_link_attribute": target_attr,
                "link_attribute": source_attr,
                "relationship_type": "base_layer_link",
            },
            headers=_token(user),
        )

    def _create(self, user, **props):
        return self.client.post(
            "/api/features",
            json={
                "layer_id": LAYER_A,
                "geometry": {"type": "Point", "coordinates": [85.33, 27.72]},
                "properties": props,
            },
            headers=_token(user),
        )

    # ------------------------------------------------------------- linking

    def test_matching_field_values_link_both_features(self):
        response = self._link("a1", "b1")
        self.assertEqual(response.status_code, 200, response.text)
        link = response.json()["link"]
        self.assertEqual(link["source_link_attribute"], "parcel_no")
        self.assertEqual(link["target_link_attribute"], "parcel_no")
        self.assertEqual(link["link_value"], "P-1")

        a1 = STATE["features_by_layer"][LAYER_A][0]
        b1 = STATE["features_by_layer"][LAYER_B][0]
        self.assertEqual(a1["properties"]["linked_feature_id"], "b1")
        self.assertEqual(b1["properties"]["linked_feature_id"], "a1")
        self.assertEqual(a1["properties"]["link_attribute"], "parcel_no")
        self.assertEqual(b1["properties"]["link_attribute"], "parcel_no")

    def test_mismatched_values_are_rejected(self):
        response = self._link("a1", "b2")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(STATE["feature_links"], [])

    def test_missing_values_on_both_sides_are_rejected(self):
        response = self._link("a3", "b3", source_attr="parcel_no", target_attr="parcel_no")
        self.assertEqual(response.status_code, 400, response.text)

    def test_only_one_link_attribute_is_rejected(self):
        response = self.client.post(
            f"/api/features/a1/link",
            json={
                "target_feature_id": "b1",
                "source_link_attribute": "parcel_no",
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 400, response.text)

    def test_self_link_is_rejected(self):
        response = self._link("a1", "a1", source_attr="_id", target_attr="_id")
        self.assertEqual(response.status_code, 400, response.text)

    def test_link_requires_write_access_on_both_layers(self):
        STATE["vector_layers"][0]["editable_by_collectors"] = False
        response = self._link("a1", "b1", user=COLLECTOR_ID)
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(STATE["feature_links"], [])

    def test_get_linked_hides_admin_only_attributes(self):
        # b1 -> a1 so the resolved linked payload exposes a1's properties.
        response = self._link("b1", "a1", source_layer=LAYER_B, target_layer=LAYER_A)
        self.assertEqual(response.status_code, 200, response.text)
        response = self.client.get("/api/features/b1/linked", headers=_token(COLLECTOR_ID))
        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertEqual(len(payload["linked_features"]), 1)
        source_props = payload["linked_features"][0]["properties"]
        self.assertIn("parcel_no", source_props)
        self.assertNotIn("tax_code", source_props)
        self.assertNotIn("owner_name", source_props)

    def test_unlink_clears_reciprocal_references(self):
        self._link("a1", "b1")
        response = self.client.delete(
            "/api/features/a1/link",
            params={"target_feature_id": "b1"},
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(STATE["feature_links"], [])
        self.assertNotIn("linked_feature_id", STATE["features_by_layer"][LAYER_A][0]["properties"])
        self.assertNotIn("linked_feature_id", STATE["features_by_layer"][LAYER_B][0]["properties"])

    def test_create_with_failed_link_does_not_leave_orphan_feature(self):
        before = len(STATE["features_by_layer"][LAYER_A])
        response = self.client.post(
            "/api/features",
            json={
                "layer_id": LAYER_A,
                "geometry": {"type": "Point", "coordinates": [85.34, 27.72]},
                "properties": {"parcel_no": "NEW"},
                "link_to": {
                    "target_feature_id": "b1",
                    "source_layer_id": LAYER_A,
                    "target_layer_id": LAYER_B,
                    "source_link_attribute": "parcel_no",
                    "target_link_attribute": "parcel_no",
                },
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_A]), before)

    def test_create_with_matching_link_persists_feature_and_link(self):
        response = self.client.post(
            "/api/features",
            json={
                "layer_id": LAYER_A,
                "geometry": {"type": "Point", "coordinates": [85.35, 27.73]},
                "properties": {"parcel_no": "P-1"},
                "link_to": {
                    "target_feature_id": "b1",
                    "source_layer_id": LAYER_A,
                    "target_layer_id": LAYER_B,
                    "source_link_attribute": "parcel_no",
                    "target_link_attribute": "parcel_no",
                },
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        created = response.json()
        new_id = created["id"]
        self.assertEqual(created["properties"]["linked_feature_id"], "b1")
        self.assertEqual(
            STATE["features_by_layer"][LAYER_B][0]["properties"]["linked_feature_id"], new_id
        )
        self.assertEqual(len(STATE["feature_links"]), 1)

    # ------------------------------------------------------ field permissions

    def test_collector_can_only_enter_public_fields(self):
        ok = self._create(COLLECTOR_ID, parcel_no="P-5")
        self.assertEqual(ok.status_code, 200, ok.text)

        admin_field = self._create(COLLECTOR_ID, parcel_no="P-6", tax_code="T-9")
        self.assertEqual(admin_field.status_code, 403, admin_field.text)

        validator_field = self._create(COLLECTOR_ID, parcel_no="P-7", owner_name="Ram")
        self.assertEqual(validator_field.status_code, 403, validator_field.text)

        pinned_field = self._create(COLLECTOR_ID, parcel_no="P-8", locked_note="n")
        self.assertEqual(pinned_field.status_code, 403, pinned_field.text)

        unknown = self._create(COLLECTOR_ID, parcel_no="P-9", ghost_field="x")
        self.assertEqual(unknown.status_code, 403, unknown.text)

    def test_validator_can_enter_validator_fields_but_not_admin_fields(self):
        ok = self._create(VALIDATOR_ID, parcel_no="P-10", owner_name="Hari", locked_note="n")
        self.assertEqual(ok.status_code, 200, ok.text)
        denied = self._create(VALIDATOR_ID, parcel_no="P-11", tax_code="T-2")
        self.assertEqual(denied.status_code, 403, denied.text)

    def test_admin_can_enter_admin_fields(self):
        ok = self._create(GIS_ADMIN_ID, parcel_no="P-12", tax_code="T-3")
        self.assertEqual(ok.status_code, 200, ok.text)

    def test_update_blocks_restricted_field_changes(self):
        response = self.client.put(
            "/api/features/a1",
            json={"properties": {"tax_code": "CHANGED"}},
            headers=_token(VALIDATOR_ID),
        )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(
            STATE["features_by_layer"][LAYER_A][0]["properties"]["tax_code"], "T-1"
        )

        allowed = self.client.put(
            "/api/features/a1",
            json={"properties": {"owner_name": "Sita Devi"}},
            headers=_token(VALIDATOR_ID),
        )
        self.assertEqual(allowed.status_code, 200, allowed.text)

    def test_layer_fields_are_filtered_per_role(self):
        collector_view = self.client.get(
            f"/api/layers/{LAYER_A}/fields", headers=_token(COLLECTOR_ID)
        ).json()
        self.assertEqual(
            [field["name"] for field in collector_view["editable_fields"]], ["parcel_no"]
        )

        validator_view = self.client.get(
            f"/api/layers/{LAYER_A}/fields", headers=_token(VALIDATOR_ID)
        ).json()
        self.assertEqual(
            sorted(field["name"] for field in validator_view["editable_fields"]),
            ["locked_note", "owner_name", "parcel_no"],
        )

        admin_view = self.client.get(
            f"/api/layers/{LAYER_A}/fields", headers=_token(ADMIN_ID)
        ).json()
        self.assertEqual(len(admin_view["editable_fields"]), 4)

    def test_non_field_roles_cannot_write_even_on_unlocked_global_layer(self):
        STATE["users"].append({"id": 101, "username": "viewer", "role": "BasicViewer", "is_active": True})
        STATE["users"].append({"id": 102, "username": "municipal", "role": "MunicipalUser", "is_active": True})
        for user_id in (101, 102):
            denied = self._create(user_id, parcel_no="P-BLOCKED")
            self.assertEqual(denied.status_code, 403, denied.text)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_A]), 3)

    def test_municipal_user_reads_public_fields_only(self):
        STATE["users"].append({"id": 102, "username": "municipal", "role": "MunicipalUser", "is_active": True})
        view = self.client.get(
            f"/api/layers/{LAYER_A}/fields", headers=_token(102)
        ).json()
        self.assertEqual(
            [field["name"] for field in view["fields"]], ["parcel_no", "locked_note"]
        )

    def test_geometry_field_config_is_filtered_per_role(self):
        STATE["vector_layers"][0]["geometry_fields_config"] = {
            "Point": [
                {"name": "parcel_no", "label": "Parcel", "type": "text"},
                {"name": "tax_code", "label": "Tax", "type": "text", "access_level": "admin"},
            ]
        }
        collector_view = self.client.get(
            f"/api/layers/{LAYER_A}/fields", headers=_token(COLLECTOR_ID)
        ).json()
        self.assertEqual(
            [field["name"] for field in collector_view["geometry_fields_config"]["Point"]],
            ["parcel_no"],
        )

    def test_questionnaire_sync_keeps_layer_attributes(self):
        STATE["vector_layers"][2]["fields_config"] = [
            {"name": "custom_note", "label": "Note", "type": "text", "visible_in_popup": False}
        ]
        backend._sync_questionnaire_layer_fields(STATE["questionnaires"][0])
        names = [field["name"] for field in STATE["vector_layers"][2]["fields_config"]]
        self.assertEqual(names, ["owner_name", "custom_note"])
        self.assertFalse(STATE["vector_layers"][2]["fields_config"][1]["visible_in_popup"])

    def test_questionnaire_submission_enforces_entry_permissions(self):
        base_payload = {
            "questionnaire_id": QUESTIONNAIRE_ID,
            "layer_id": LAYER_Q,
            "record_id": "KMC-REC-TEST-1",
            "geom_geojson": {"type": "Point", "coordinates": [85.30, 27.70]},
            "geometry_type": "Point",
        }
        denied = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json={**base_payload, "answers": {"owner_name": "Sita", "tax_code": "T-9"}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        ok = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json={**base_payload, "answers": {"owner_name": "Sita"}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_Q]), 1)

    # ------------------------------------------- project-independent surveys

    GLOBAL_LAYER = 933
    GLOBAL_QUESTIONNAIRE = 951

    def _enable_global_survey(self):
        STATE["questionnaires"].append(
            {
                "id": self.GLOBAL_QUESTIONNAIRE,
                "project_id": None,
                "title": "Global",
                "status": "PUBLISHED",
                "is_active": True,
                "schema_definition": {
                    "sections": [{"id": "sec_1", "title": "General", "order": 1}],
                    "questions": [
                        {"id": "q1", "name": "parcel_no", "label": "Parcel", "type": "text", "section_id": "sec_1"}
                    ],
                },
            }
        )
        STATE["vector_layers"].append(
            {
                "id": self.GLOBAL_LAYER,
                "name": "Global Survey",
                "project_id": None,
                "questionnaire_id": self.GLOBAL_QUESTIONNAIRE,
                "geometry_type": "Point",
                "editable_by_collectors": True,
                "fields_config": [{"name": "parcel_no", "label": "Parcel", "type": "text"}],
            }
        )
        STATE["features_by_layer"][self.GLOBAL_LAYER] = []

    def _global_submit(self, answers, link_to=None, questionnaire_id=None):
        payload = {
            "questionnaire_id": questionnaire_id or self.GLOBAL_QUESTIONNAIRE,
            "layer_id": self.GLOBAL_LAYER,
            "record_id": "KMC-REC-GLOBAL-1",
            "geom_geojson": {"type": "Point", "coordinates": [85.30, 27.72]},
            "geometry_type": "Point",
            "answers": answers,
        }
        if link_to:
            payload["link_to"] = link_to
        return self.client.post("/api/records/submit", json=payload, headers=_token(COLLECTOR_ID))

    def test_global_questionnaire_submit_without_project(self):
        self._enable_global_survey()
        response = self._global_submit({"parcel_no": "P-20"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIsNone(response.json()["project_id"])
        self.assertEqual(len(STATE["features_by_layer"][self.GLOBAL_LAYER]), 1)

    def test_global_questionnaire_submit_applies_feature_link(self):
        self._enable_global_survey()
        response = self._global_submit(
            {"parcel_no": "P-1"},
            link_to={
                "target_feature_id": "a1",
                "source_layer_id": self.GLOBAL_LAYER,
                "target_layer_id": LAYER_A,
                "source_link_attribute": "parcel_no",
                "target_link_attribute": "parcel_no",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        created = STATE["features_by_layer"][self.GLOBAL_LAYER][0]
        self.assertEqual(created["properties"]["linked_feature_id"], "a1")
        a1 = STATE["features_by_layer"][LAYER_A][0]
        self.assertEqual(a1["properties"]["linked_feature_id"], created["id"])
        self.assertEqual(len(STATE["feature_links"]), 1)

    def test_global_questionnaire_mismatched_link_leaves_no_record_or_feature(self):
        self._enable_global_survey()
        response = self._global_submit(
            {"parcel_no": "P-9"},
            link_to={
                "target_feature_id": "a1",
                "target_layer_id": LAYER_A,
                "source_link_attribute": "parcel_no",
                "target_link_attribute": "parcel_no",
            },
        )
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(STATE["features_by_layer"][self.GLOBAL_LAYER], [])
        self.assertEqual(STATE["feature_links"], [])
        self.assertEqual(STATE["records"], [])

    def test_resubmitting_a_linked_survey_does_not_duplicate_the_link(self):
        self._enable_global_survey()
        link_to = {
            "target_feature_id": "a1",
            "target_layer_id": LAYER_A,
            "source_link_attribute": "parcel_no",
            "target_link_attribute": "parcel_no",
        }
        first = self._global_submit({"parcel_no": "P-1"}, link_to=link_to)
        self.assertEqual(first.status_code, 200, first.text)
        second = self._global_submit({"parcel_no": "P-1"}, link_to=link_to)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(len(STATE["feature_links"]), 1)
        self.assertEqual(len(STATE["features_by_layer"][self.GLOBAL_LAYER]), 1)


if __name__ == "__main__":
    unittest.main()
