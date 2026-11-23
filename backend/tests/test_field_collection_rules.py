"""
KMC-GIS-SERVER — field-collection integrity tests.

Run inside the backend container (Python is not required on the host):

    docker compose run --rm --no-deps \
        -v "$PWD/backend/app:/app/app:ro" -v "$PWD/backend/tests:/app/tests:ro" \
        --entrypoint python backend -m unittest discover -s /app/tests -v

Covers the golden rules added for surveyed field data:
  * a DataCollector may only submit inside a task grid assigned to them,
  * records/features are attributed to the authenticated user (never the admin),
  * a questionnaire record can only be written to its linked vector layer,
  * draft -> submit is idempotent (one record, one feature),
  * linking a questionnaire synchronises the layer field schema.
"""

import unittest

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app import main as backend
from app.main import (
    STATE,
    _changed_vertices_outside_grids,
    _clean_record_answers,
    _geometry_rings,
    _geometry_within_task_grid,
    _layer_download_allowed,
    _normalize_multi_assignments,
    _point_in_ring,
    _project_layer_is_editable,
    _questionnaire_fields_config,
    _resolve_collector_grid,
    _resolve_record_layer,
    _upsert_record_feature,
)

COLLECTOR_ID = 7
OTHER_COLLECTOR_ID = 8
ADMIN_ID = 1
MASTER_ID = 2
VALIDATOR_ID = 9
PROJECT_ID = 42
LAYER_ID = 900
QUESTIONNAIRE_ID = 300
GRID_ASSIGNED_ID = 501
GRID_OTHER_ID = 502

INSIDE_GRID = {"type": "Point", "coordinates": [5, 5]}
OUTSIDE_GRID = {"type": "Point", "coordinates": [50, 50]}

GRID_RING = [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]]


def _token(user_id):
    """Signed access token accepted by the backend's HMAC verifier."""
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class FieldCollectionRulesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        backend._save_persistent_state = lambda *args, **kwargs: None

    def setUp(self):
        self._state_backup = {
            "users": list(STATE.get("users", [])),
            "projects": list(STATE.get("projects", [])),
            "vector_layers": list(STATE.get("vector_layers", [])),
            "features_by_layer": dict(STATE.get("features_by_layer", {})),
            "tasks_by_project": dict(STATE.get("tasks_by_project", {})),
            "questionnaires": list(STATE.get("questionnaires", [])),
            "records": list(STATE.get("records", [])),
            "project_collectors": dict(STATE.get("project_collectors", {})),
            "audit_edits_by_layer": dict(STATE.get("audit_edits_by_layer", {})),
        }
        STATE["users"] = [
            {"id": ADMIN_ID, "username": "KmcSuperUser2083", "full_name": "GIS Admin", "role": "GisAdmin", "is_active": True},
            {"id": MASTER_ID, "username": "kmc_master", "full_name": "Master", "role": "MasterAdmin", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector_ward10", "full_name": "Collector", "role": "DataCollector", "is_active": True},
            {"id": OTHER_COLLECTOR_ID, "username": "collector_ward11", "full_name": "Other", "role": "DataCollector", "is_active": True},
            {"id": VALIDATOR_ID, "username": "validator1", "full_name": "Validator One", "role": "Validator", "is_active": True},
        ]
        STATE["projects"] = [
            {
                "id": PROJECT_ID,
                "name": "Test Ward Project",
                "status": "ACTIVE",
                "project_mode": "ADVANCED_QUESTIONNAIRE",
                "geometry_config": {"type": "Point"},
                # The DepartmentAdmin fixture manages this project and its
                # collectors/validators only.
                "department_admin_ids": [ADMIN_ID],
                "editable_layer_ids": [LAYER_ID],
            }
        ]
        STATE["project_collectors"] = {PROJECT_ID: [COLLECTOR_ID, OTHER_COLLECTOR_ID, VALIDATOR_ID]}
        STATE["audit_edits_by_layer"] = {}
        STATE["vector_layers"] = [
            {
                "id": LAYER_ID,
                "name": "घरधुरी सर्वेक्षण तह",
                "project_id": PROJECT_ID,
                "questionnaire_id": QUESTIONNAIRE_ID,
                "fields_config": [],
                "feature_count": 0,
                # Explicitly unlocked by an administrator for field editing.
                "editable_by_collectors": True,
            },
            {
                "id": 901,
                "name": "Unlinked layer",
                "project_id": PROJECT_ID,
                "questionnaire_id": None,
                "fields_config": [],
                "feature_count": 0,
            },
        ]
        STATE["features_by_layer"] = {LAYER_ID: [], 901: []}
        STATE["tasks_by_project"] = {
            PROJECT_ID: [
                {
                    "id": GRID_ASSIGNED_ID,
                    "project_id": PROJECT_ID,
                    "name": "कार्यक्षेत्र #1",
                    "assigned_to": COLLECTOR_ID,
                    "status": "LOCKED",
                    "geometry": {"type": "Polygon", "coordinates": [GRID_RING]},
                },
                {
                    "id": GRID_OTHER_ID,
                    "project_id": PROJECT_ID,
                    "name": "कार्यक्षेत्र #2",
                    "assigned_to": OTHER_COLLECTOR_ID,
                    "status": "READY",
                    "geometry": {"type": "Polygon", "coordinates": [[[20, 20], [30, 20], [30, 30], [20, 30], [20, 20]]]},
                },
            ]
        }
        STATE["questionnaires"] = [
            {
                "id": QUESTIONNAIRE_ID,
                "project_id": PROJECT_ID,
                "title": "घरधुरी सर्वेक्षण",
                "status": "PUBLISHED",
                "is_active": True,
                "schema_definition": {
                    "sections": [{"id": "sec_1", "title": "General", "title_ne": "सामान्य", "order": 1}],
                    "questions": [
                        {"id": "q1", "name": "owner_name", "label": "Owner name", "label_ne": "घरधनीको नाम", "type": "text", "section_id": "sec_1", "required": True},
                        {"id": "q2", "name": "floors", "label": "Floors", "label_ne": "तल्ला", "type": "integer", "section_id": "sec_1", "required": False},
                    ],
                },
            },
            {
                "id": 301,
                "project_id": PROJECT_ID,
                "title": "Unlinked questionnaire",
                "status": "DRAFT",
                "is_active": False,
                "schema_definition": {"sections": [], "questions": []},
            },
        ]
        STATE["records"] = []
        self.client = TestClient(backend.app)

    def tearDown(self):
        for key, value in self._state_backup.items():
            STATE[key] = value

    # ------------------------------------------------------------------ helpers

    def test_point_in_ring_and_grid_containment(self):
        self.assertTrue(_point_in_ring(5, 5, GRID_RING))
        self.assertFalse(_point_in_ring(50, 50, GRID_RING))

        grid = {"type": "Polygon", "coordinates": [GRID_RING, [[4, 4], [6, 4], [6, 6], [4, 6], [4, 4]]]}
        self.assertTrue(_geometry_within_task_grid(grid, {"type": "Point", "coordinates": [1, 1]}))
        # Inside the hole of the grid -> not part of the assigned work area.
        self.assertFalse(_geometry_within_task_grid(grid, {"type": "Point", "coordinates": [5, 5]}))
        self.assertEqual(len(_geometry_rings(grid)), 2)

    def test_answers_cannot_inject_system_properties(self):
        cleaned = _clean_record_answers({"owner_name": "Sita", "_created_by": 1, "_status": "VALIDATED", "geometry": {}})
        self.assertEqual(cleaned, {"owner_name": "Sita"})

    def test_questionnaire_field_schema_is_derived_and_keeps_visibility(self):
        fields = _questionnaire_fields_config(STATE["questionnaires"][0], [{"name": "floors", "visible_in_popup": False}])
        self.assertEqual([field["name"] for field in fields], ["owner_name", "floors"])
        self.assertEqual(fields[1]["type"], "number")
        self.assertFalse(fields[1]["visible_in_popup"])
        self.assertTrue(fields[0]["visible_in_popup"])

    def test_collector_grid_resolution(self):
        collector = next(u for u in STATE["users"] if u["id"] == COLLECTOR_ID)
        task, error = _resolve_collector_grid(PROJECT_ID, collector, INSIDE_GRID)
        self.assertIsNone(error)
        self.assertEqual(task["id"], GRID_ASSIGNED_ID)

        task, error = _resolve_collector_grid(PROJECT_ID, collector, OUTSIDE_GRID)
        self.assertIsNone(task)
        self.assertIsNotNone(error)

        stranger = {"id": 99, "role": "DataCollector"}
        task, error = _resolve_collector_grid(PROJECT_ID, stranger, INSIDE_GRID)
        self.assertIsNone(task)
        self.assertIsNotNone(error)

        admin = STATE["users"][0]
        task, error = _resolve_collector_grid(PROJECT_ID, admin, INSIDE_GRID)
        self.assertIsNone(error)
        self.assertEqual(task["id"], GRID_ASSIGNED_ID)

    def test_layer_resolution_never_guesses(self):
        layer = _resolve_record_layer(PROJECT_ID, {"layer_id": LAYER_ID}, QUESTIONNAIRE_ID)
        self.assertEqual(layer["id"], LAYER_ID)

        # A layer that is not linked yet may still receive a record from an
        # ADVANCED_QUESTIONNAIRE project (the form is project driven).
        unlinked = _resolve_record_layer(PROJECT_ID, {"layer_id": 901}, QUESTIONNAIRE_ID)
        self.assertEqual(unlinked["id"], 901)

        # A layer linked to a DIFFERENT questionnaire must be refused.
        STATE["vector_layers"][1]["questionnaire_id"] = 302
        with self.assertRaises(HTTPException):
            _resolve_record_layer(PROJECT_ID, {"layer_id": 901}, QUESTIONNAIRE_ID)

        with self.assertRaises(HTTPException):
            _resolve_record_layer(PROJECT_ID, {"layer_id": 999999}, QUESTIONNAIRE_ID)
        with self.assertRaises(HTTPException):
            _resolve_record_layer(PROJECT_ID, {}, 301)
        with self.assertRaises(HTTPException):
            _resolve_record_layer(PROJECT_ID, {}, None)

    def test_feature_upsert_is_idempotent_and_keeps_authorship(self):
        layer = STATE["vector_layers"][0]
        record = {"record_id": "KMC-REC-42-1", "questionnaire_id": QUESTIONNAIRE_ID, "status": "SUBMITTED"}
        collector = next(u for u in STATE["users"] if u["id"] == COLLECTOR_ID)
        task = {"id": GRID_ASSIGNED_ID}

        first = _upsert_record_feature(layer, record, {"owner_name": "Sita"}, INSIDE_GRID, collector, task)
        self.assertEqual(first["properties"]["_created_by"], COLLECTOR_ID)
        self.assertEqual(first["properties"]["_task_grid_id"], GRID_ASSIGNED_ID)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_ID]), 1)

        validator = next(u for u in STATE["users"] if u["id"] == VALIDATOR_ID)
        second = _upsert_record_feature(layer, record, {"owner_name": "Sita Kumari"}, {"type": "Point", "coordinates": [6, 6]}, validator, task)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_ID]), 1, "re-submit must not duplicate the feature")
        self.assertEqual(second["properties"]["owner_name"], "Sita Kumari")
        self.assertEqual(second["properties"]["_created_by"], COLLECTOR_ID, "original authorship preserved")
        self.assertEqual(second["properties"]["_updated_by"], VALIDATOR_ID, "last editor stamped")
        self.assertEqual(second["properties"]["_updated_by_username"], "validator1")
        self.assertEqual(second["geometry"]["coordinates"], [6, 6])
        self.assertEqual(layer["feature_count"], 1)

    # ---------------------------------------------------------------- endpoints

    def _draft_payload(self, **overrides):
        payload = {
            "questionnaire_id": QUESTIONNAIRE_ID,
            "layer_id": LAYER_ID,
            "geom_geojson": INSIDE_GRID,
            "geometry_type": "Point",
            "answers": {"owner_name": "Sita", "_created_by": 1},
        }
        payload.update(overrides)
        return payload

    def test_draft_does_not_create_a_feature(self):
        response = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/draft",
            json=self._draft_payload(),
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_ID]), 0)
        self.assertEqual(STATE["records"][0]["status"], "DRAFT")
        self.assertNotIn("_created_by", STATE["records"][0]["answers"])

    def test_submit_creates_attributed_stamped_feature_once(self):
        payload = self._draft_payload()
        first = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json=payload,
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(first.status_code, 200, first.text)
        data = first.json()
        self.assertEqual(data["status"], "SUBMITTED")
        self.assertEqual(data["layer_id"], LAYER_ID)
        self.assertEqual(data["task_grid_id"], GRID_ASSIGNED_ID)
        self.assertEqual(data["created_by"], COLLECTOR_ID)
        self.assertTrue(data["feature_id"])

        features = STATE["features_by_layer"][LAYER_ID]
        self.assertEqual(len(features), 1)
        self.assertEqual(features[0]["properties"]["_created_by"], COLLECTOR_ID)
        self.assertEqual(features[0]["properties"]["_created_by_username"], "collector_ward10")
        self.assertEqual(features[0]["properties"]["_updated_by"], COLLECTOR_ID)
        self.assertEqual(features[0]["properties"]["_updated_by_username"], "collector_ward10")
        self.assertEqual(features[0]["properties"]["_task_grid_id"], GRID_ASSIGNED_ID)
        self.assertEqual(features[0]["properties"]["_status"], "SUBMITTED")
        self.assertEqual(features[0]["properties"]["owner_name"], "Sita")

        resubmit = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json={**payload, "record_id": data["record_id"]},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(resubmit.status_code, 200, resubmit.text)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_ID]), 1, "re-submit must be idempotent")
        self.assertEqual(len([r for r in STATE["records"] if r["record_id"] == data["record_id"]]), 1)

    def test_collector_cannot_submit_outside_assigned_grid(self):
        response = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json=self._draft_payload(geom_geojson=OUTSIDE_GRID),
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(len(STATE["features_by_layer"][LAYER_ID]), 0)

    def test_unlinked_questionnaire_is_rejected(self):
        response = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json=self._draft_payload(questionnaire_id=301, layer_id=None),
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(response.status_code, 400, response.text)
        self.assertIn("जोडिएको छैन", response.json()["detail"])
        self.assertEqual(len(STATE["features_by_layer"][LAYER_ID]), 0)

    def test_feature_create_requires_layer_and_respects_grid(self):
        inside = self.client.post(
            "/api/features",
            json={"layer_id": LAYER_ID, "geom_geojson": INSIDE_GRID, "properties": {"owner_name": "Ram"}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(inside.status_code, 200, inside.text)
        created = inside.json()
        self.assertEqual(created["properties"]["_created_by"], COLLECTOR_ID)
        self.assertEqual(created["properties"]["_task_grid_id"], GRID_ASSIGNED_ID)

        outside = self.client.post(
            "/api/features",
            json={"layer_id": LAYER_ID, "geom_geojson": OUTSIDE_GRID, "properties": {}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(outside.status_code, 403, outside.text)

        no_layer = self.client.post(
            "/api/features",
            json={"geom_geojson": INSIDE_GRID, "properties": {}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(no_layer.status_code, 400, no_layer.text)

    def test_linking_questionnaire_syncs_layer_fields(self):
        response = self.client.put(
            f"/api/layers/{LAYER_ID}",
            json={"questionnaire_id": 301},
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        layer = next(item for item in STATE["vector_layers"] if item["id"] == LAYER_ID)
        self.assertEqual(layer["questionnaire_id"], 301)
        self.assertEqual(layer["fields_config"], [], "quest 301 has no questions")

        response = self.client.put(
            f"/api/layers/{LAYER_ID}",
            json={"questionnaire_id": QUESTIONNAIRE_ID},
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        layer = next(item for item in STATE["vector_layers"] if item["id"] == LAYER_ID)
        self.assertEqual([field["name"] for field in layer["fields_config"]], ["owner_name", "floors"])
        self.assertEqual(layer["fields_config"][1]["type"], "number")

    # ------------------------------------------------------- users & identity

    def test_user_creation_hashes_password_and_login_verifies_it(self):
        created = self.client.post(
            "/api/users",
            json={
                "username": "new_collector",
                "full_name": "New Collector",
                "role": "DataCollector",
                "password": "Field#Secret2026",
            },
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(created.status_code, 200, created.text)
        self.assertNotIn("password_hash", created.json(), "API must never return the hash")

        stored = next(user for user in STATE["users"] if user["username"] == "new_collector")
        self.assertTrue(stored["password_hash"].startswith("pbkdf2_sha256$"))

        ok = self.client.post(
            "/api/auth/login",
            json={"username": "new_collector", "password": "Field#Secret2026"},
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        self.assertNotIn("password_hash", ok.json()["user"])

        bad = self.client.post(
            "/api/auth/login",
            json={"username": "new_collector", "password": "wrong-password"},
        )
        self.assertEqual(bad.status_code, 401)

        duplicate = self.client.post(
            "/api/users",
            json={"username": "new_collector", "role": "DataCollector"},
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(duplicate.status_code, 409)

    def test_auth_me_uses_the_token_identity(self):
        me = self.client.get("/api/auth/me", headers=_token(COLLECTOR_ID))
        self.assertEqual(me.status_code, 200, me.text)
        self.assertEqual(me.json()["id"], COLLECTOR_ID)
        self.assertEqual(me.json()["role"], "DataCollector")
        self.assertEqual(self.client.get("/api/auth/me").status_code, 401)

    def test_deleting_a_collector_releases_assigned_grids(self):
        response = self.client.delete(f"/api/users/{COLLECTOR_ID}", headers=_token(ADMIN_ID))
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(any(user["id"] == COLLECTOR_ID for user in STATE["users"]))
        released = next(task for task in STATE["tasks_by_project"][PROJECT_ID] if task["id"] == GRID_ASSIGNED_ID)
        self.assertIsNone(released["assigned_to"])
        self.assertEqual(released["status"], "READY")

    # ---------------------------------------------------------- validator QA

    def test_validator_review_updates_record_and_feature_status(self):
        submit = self.client.post(
            f"/api/projects/{PROJECT_ID}/records/submit",
            json=self._draft_payload(),
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(submit.status_code, 200, submit.text)
        record = submit.json()

        forbidden = self.client.put(
            f"/api/records/{record['id']}/review",
            json={"status": "APPROVED"},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(forbidden.status_code, 403, forbidden.text)

        approved = self.client.put(
            f"/api/records/{record['id']}/review",
            json={"status": "APPROVED", "reviewer_notes": "Verified on site"},
            headers=_token(VALIDATOR_ID),
        )
        self.assertEqual(approved.status_code, 200, approved.text)
        self.assertEqual(approved.json()["status"], "APPROVED")

        feature = STATE["features_by_layer"][LAYER_ID][0]
        self.assertEqual(feature["properties"]["_status"], "APPROVED")
        self.assertEqual(feature["properties"]["_review_notes"], "Verified on site")

        approved_records = self.client.get(
            f"/api/projects/{PROJECT_ID}/records?status_filter=APPROVED",
            headers=_token(VALIDATOR_ID),
        )
        self.assertEqual(len(approved_records.json()), 1)
        submitted_records = self.client.get(
            f"/api/projects/{PROJECT_ID}/records?status_filter=SUBMITTED",
            headers=_token(VALIDATOR_ID),
        )
        self.assertEqual(submitted_records.json(), [])

        my_records = self.client.get(f"/api/projects/{PROJECT_ID}/records/my", headers=_token(COLLECTOR_ID))
        self.assertEqual(len(my_records.json()), 1)
        other_records = self.client.get(f"/api/projects/{PROJECT_ID}/records/my", headers=_token(OTHER_COLLECTOR_ID))
        self.assertEqual(other_records.json(), [])

    def test_feature_update_persists_geom_geojson_and_enforces_grid(self):
        created = self.client.post(
            "/api/features",
            json={"layer_id": LAYER_ID, "geom_geojson": INSIDE_GRID, "properties": {"owner_name": "Ram"}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(created.status_code, 200, created.text)
        feature_id = created.json()["id"]

        # Spatial edit saved through the same `geom_geojson` key the UI sends.
        moved = self.client.put(
            f"/api/features/{feature_id}",
            json={
                "geom_geojson": {"type": "Point", "coordinates": [6, 6]},
                "properties": {"owner_name": "Ram K."},
            },
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(moved.status_code, 200, moved.text)
        self.assertEqual(moved.json()["geometry"]["coordinates"], [6, 6])
        self.assertEqual(moved.json()["properties"]["owner_name"], "Ram K.")
        self.assertEqual(moved.json()["properties"]["_updated_by"], COLLECTOR_ID)

        # Moving a feature outside the assigned grid is rejected and not applied.
        blocked = self.client.put(
            f"/api/features/{feature_id}",
            json={"geom_geojson": OUTSIDE_GRID},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(blocked.status_code, 403, blocked.text)
        stored = STATE["features_by_layer"][LAYER_ID][0]
        self.assertEqual(stored["geometry"]["coordinates"], [6, 6])

    def test_duplicate_questionnaire_creates_inactive_draft(self):
        response = self.client.post(
            f"/api/questionnaires/{QUESTIONNAIRE_ID}/duplicate",
            headers=_token(ADMIN_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        copy = response.json()
        self.assertNotEqual(copy["id"], QUESTIONNAIRE_ID)
        self.assertEqual(copy["status"], "DRAFT")
        self.assertFalse(copy["is_active"])
        self.assertIn("प्रतिलिपि", copy["title"])

    # ------------------------------------------------ project linkage & roles

    def test_unlinked_collector_cannot_reach_project_apis(self):
        stranger_id = 99
        STATE["users"].append({
            "id": stranger_id,
            "username": "outsider",
            "full_name": "Outsider",
            "role": "DataCollector",
            "is_active": True,
        })
        denied = self.client.get(
            f"/api/projects/{PROJECT_ID}/tasks",
            headers=_token(stranger_id),
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        listed = self.client.get("/api/projects", headers=_token(stranger_id))
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertFalse(any(str(p.get("id")) == str(PROJECT_ID) for p in listed.json()))

        linked = self.client.get(
            f"/api/projects/{PROJECT_ID}/tasks",
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(linked.status_code, 200, linked.text)

    def test_basic_viewer_is_limited_to_global_scope(self):
        viewer = {"id": 98, "username": "public_viewer", "role": "BasicViewer", "is_active": True}
        STATE["users"].append(viewer)
        self.assertFalse(backend._user_can_access_project(viewer, PROJECT_ID))
        self.assertTrue(backend._user_can_access_project(viewer, None))

        denied = self.client.get(
            f"/api/projects/{PROJECT_ID}/layers",
            headers=_token(viewer["id"]),
        )
        self.assertEqual(denied.status_code, 403, denied.text)

        listed = self.client.get("/api/projects", headers=_token(viewer["id"]))
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertFalse(any(str(p.get("id")) == str(PROJECT_ID) for p in listed.json()))

    def test_layer_download_permissions_are_admin_granted(self):
        layer = STATE["vector_layers"][0]
        self.assertFalse(_layer_download_allowed(layer, {"id": VALIDATOR_ID, "role": "Validator"}))
        self.assertFalse(_layer_download_allowed(layer, {"id": COLLECTOR_ID, "role": "DataCollector"}))
        self.assertTrue(_layer_download_allowed(layer, {"id": ADMIN_ID, "role": "GisAdmin"}))

        layer["validator_download_allowed"] = True
        self.assertTrue(_layer_download_allowed(layer, {"id": VALIDATOR_ID, "role": "Validator"}))

    def test_project_editable_layer_scope(self):
        project = {"id": PROJECT_ID, "editable_layer_ids": [LAYER_ID]}
        collector = {"id": COLLECTOR_ID, "role": "DataCollector"}
        self.assertTrue(_project_layer_is_editable(project, STATE["vector_layers"][0], collector))
        self.assertFalse(_project_layer_is_editable(project, STATE["vector_layers"][1], collector))
        # Admins always retain editing rights.
        self.assertTrue(
            _project_layer_is_editable(project, STATE["vector_layers"][1], {"id": ADMIN_ID, "role": "GisAdmin"})
        )

    def test_master_only_swarm_secrets(self):
        denied = self.client.get("/api/system/swarm-secrets", headers=_token(ADMIN_ID))
        self.assertEqual(denied.status_code, 403, denied.text)
        allowed = self.client.get("/api/system/swarm-secrets", headers=_token(MASTER_ID))
        self.assertEqual(allowed.status_code, 200, allowed.text)

    # ------------------------------------------- multi-collector & vertex scope

    def test_multi_collector_layer_scope_cannot_overlap(self):
        with self.assertRaises(HTTPException) as conflict:
            _normalize_multi_assignments(PROJECT_ID, [
                {"user_id": COLLECTOR_ID, "layer_ids": [LAYER_ID]},
                {"user_id": OTHER_COLLECTOR_ID, "layer_ids": [LAYER_ID]},
            ])
        self.assertEqual(conflict.exception.status_code, 409)

        normalized = _normalize_multi_assignments(PROJECT_ID, [
            {"user_id": COLLECTOR_ID, "layer_ids": [LAYER_ID]},
            {"user_id": OTHER_COLLECTOR_ID, "layer_ids": [901]},
        ])
        self.assertEqual(len(normalized), 2)
        self.assertEqual(normalized[1]["layer_ids"], [901])

    def test_multi_collector_requires_explicit_layer_scope(self):
        with self.assertRaises(HTTPException):
            _normalize_multi_assignments(PROJECT_ID, [
                {"user_id": COLLECTOR_ID, "layer_ids": [LAYER_ID]},
                {"user_id": OTHER_COLLECTOR_ID, "layer_ids": []},
            ])

    def test_collector_grid_layer_scope_is_enforced(self):
        task = STATE["tasks_by_project"][PROJECT_ID][0]
        task["assignments"] = [{
            "user_id": COLLECTOR_ID,
            "username": "collector_ward10",
            "full_name": "Collector",
            "layer_ids": [LAYER_ID],
        }]
        collector = next(u for u in STATE["users"] if u["id"] == COLLECTOR_ID)

        resolved, error = _resolve_collector_grid(PROJECT_ID, collector, INSIDE_GRID, LAYER_ID)
        self.assertIsNone(error)
        self.assertEqual(resolved["id"], GRID_ASSIGNED_ID)

        blocked, error = _resolve_collector_grid(PROJECT_ID, collector, INSIDE_GRID, 901)
        self.assertIsNone(blocked)
        self.assertIsNotNone(error)

    def test_only_changed_vertices_must_stay_inside_grid(self):
        grids = [{"type": "Polygon", "coordinates": [GRID_RING]}]
        old = {"type": "LineString", "coordinates": [[5, 5], [50, 50]]}
        # The outside vertex is unchanged, only the inside vertex moves.
        moved_inside = {"type": "LineString", "coordinates": [[6, 6], [50, 50]]}
        self.assertEqual(_changed_vertices_outside_grids(moved_inside, old, grids), [])

        # Moving the outside vertex is refused.
        moved_outside = {"type": "LineString", "coordinates": [[6, 6], [60, 60]]}
        self.assertEqual(len(_changed_vertices_outside_grids(moved_outside, old, grids)), 1)

    def test_edit_audit_log_records_actor_and_action(self):
        created = self.client.post(
            "/api/features",
            json={"layer_id": LAYER_ID, "geom_geojson": INSIDE_GRID, "properties": {"owner_name": "Audit"}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(created.status_code, 200, created.text)
        feature_id = created.json()["id"]

        updated = self.client.put(
            f"/api/features/{feature_id}",
            json={"geom_geojson": {"type": "Point", "coordinates": [6, 6]}},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(updated.status_code, 200, updated.text)

        log = STATE["audit_edits_by_layer"][str(LAYER_ID)]
        self.assertEqual([entry["action"] for entry in log[:2]], ["UPDATE", "CREATE"])
        self.assertTrue(all(entry["user_id"] == COLLECTOR_ID for entry in log[:2]))
        self.assertTrue(all(entry["timestamp"] for entry in log[:2]))


if __name__ == "__main__":
    unittest.main(verbosity=2)
