"""
End-to-end field-survey workflow (in-memory, no live data touched).

Covers the operational scenario requested for production verification:
  MasterAdmin provisions a DepartmentAdmin; the DepartmentAdmin creates a project,
  generates task grids, creates two DataCollectors and one Validator, links them to
  the project, builds a questionnaire (dropdown, date, time, camera photo, skip
  logic, required answers), links it to vector layers (both a new layer and an
  existing layer), assigns grids, locks/submits/validates them, submits survey
  records whose answers become layer attributes, and reuses a global questionnaire
  on a second project.
"""

import secrets
import unittest
import uuid

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

# Random per-run credential: no known/test password is ever stored in the repo.
PASSWORD = f"E2e-{secrets.token_urlsafe(24)}"
BOUNDARY = {
    "type": "Polygon",
    "coordinates": [[
        [85.3000, 27.6800],
        [85.3040, 27.6800],
        [85.3040, 27.6840],
        [85.3000, 27.6840],
        [85.3000, 27.6800],
    ]],
}

STATE_KEYS = (
    "users", "projects", "vector_layers", "raster_layers", "project_assignments",
    "project_collectors", "tasks_by_project", "questionnaires", "records",
    "features_by_layer", "audit_edits_by_layer", "task_invalidation_history",
    "feature_links",
)


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


class FieldSurveyEndToEndTest(unittest.TestCase):
    def setUp(self):
        self._orig_state = {key: STATE.get(key) for key in STATE_KEYS}
        self._orig_save = backend._save_persistent_state
        backend._save_persistent_state = lambda *args, **kwargs: None

        STATE["users"] = [{
            "id": 1,
            "username": "e2e_master",
            "email": "master@kmc.gov.np",
            "full_name": "E2E Master",
            "role": "MasterAdmin",
            "is_active": True,
            "password_hash": backend.hash_password(PASSWORD),
        }]
        for key in STATE_KEYS:
            if key == "users":
                continue
            if key in ("project_assignments", "project_collectors", "tasks_by_project",
                       "features_by_layer", "audit_edits_by_layer"):
                STATE[key] = {}
            else:
                STATE[key] = []

        self.client = TestClient(backend.app)
        self.master = self._login("e2e_master")

    def tearDown(self):
        backend._save_persistent_state = self._orig_save
        for key, value in self._orig_state.items():
            STATE[key] = value

    # ---------------------------------------------------------------- helpers
    def _login(self, username, password=PASSWORD):
        resp = self.client.post("/api/auth/login", json={"username": username, "password": password})
        self.assertEqual(resp.status_code, 200, resp.text)
        return _auth(resp.json()["access_token"])

    def _create_user(self, headers, username, role):
        resp = self.client.post("/api/users", json={
            "username": username,
            "email": f"{username}@kmc.gov.np",
            "full_name": username.replace("_", " ").title(),
            "role": role,
            "password": PASSWORD,
        }, headers=headers)
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def _create_project(self, headers, name):
        resp = self.client.post("/api/projects", json={
            "name": name,
            "description": "E2E field survey",
            "project_mode": "ADVANCED_QUESTIONNAIRE",
            "geometry_config": {"type": "Point"},
            "grid_type": "HEXAGON",
            "grid_size_m": 100,
            "boundary_geojson": BOUNDARY,
        }, headers=headers)
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()

    def _questionnaire_schema(self):
        return {
            "sections": [
                {"id": "sec_1", "title": "Building Survey", "title_ne": "भवन सर्वेक्षण", "order": 1, "description": ""},
            ],
            "questions": [
                {"id": "q_owner", "section_id": "sec_1", "name": "building_owner", "label": "Building Owner",
                 "label_ne": "भवन मालिक", "type": "text", "required": True},
                {"id": "q_type", "section_id": "sec_1", "name": "building_type", "label": "Building Type",
                 "label_ne": "भवनको प्रकार", "type": "dropdown", "required": True,
                 "options": [
                     {"value": "residential", "label": "Residential", "label_ne": "आवासीय"},
                     {"value": "commercial", "label": "Commercial", "label_ne": "व्यापारिक"},
                 ]},
                {"id": "q_date", "section_id": "sec_1", "name": "inspection_date", "label": "Inspection Date",
                 "label_ne": "निरीक्षण मिति", "type": "date", "required": True},
                {"id": "q_time", "section_id": "sec_1", "name": "inspection_time", "label": "Inspection Time",
                 "label_ne": "निरीक्षण समय", "type": "time", "required": True},
                {"id": "q_photo", "section_id": "sec_1", "name": "camera_photo", "label": "Camera Photo",
                 "label_ne": "क्यामेरा फोटो", "type": "photo", "required": True},
                {"id": "q_water", "section_id": "sec_1", "name": "has_water", "label": "Has Water Supply",
                 "label_ne": "पानी आपूर्ति छ?", "type": "yes_no", "required": True},
                {"id": "q_source", "section_id": "sec_1", "name": "water_source", "label": "Water Source",
                 "label_ne": "पानीको स्रोत", "type": "dropdown", "required": False,
                 "conditions": [{"depends_on": "has_water", "operator": "==", "value": "yes"}],
                 "condition_logic": "AND",
                 "options": [
                     {"value": "municipal", "label": "Municipal", "label_ne": "नगरपालिका"},
                     {"value": "well", "label": "Well", "label_ne": "इनार"},
                 ]},
            ],
            "settings": {"autosave_seconds": 30, "require_gps": True},
        }

    def _build_questionnaire(self, headers, project_id):
        resp = self.client.post(f"/api/projects/{project_id}/questionnaires", json={
            "title": "Building Attribute Survey",
            "description": "Door-to-door building survey",
            "schema_definition": self._questionnaire_schema(),
        }, headers=headers)
        self.assertEqual(resp.status_code, 200, resp.text)
        questionnaire = resp.json()

        validation = self.client.post(f"/api/questionnaires/{questionnaire['id']}/validate", headers=headers)
        self.assertEqual(validation.status_code, 200, validation.text)
        self.assertTrue(validation.json()["valid"], validation.text)

        published = self.client.post(f"/api/questionnaires/{questionnaire['id']}/publish", headers=headers)
        self.assertEqual(published.status_code, 200, published.text)
        body = published.json()
        self.assertEqual(body["status"], "PUBLISHED")
        self.assertTrue(body["is_active"])
        self.assertEqual(body["schema_definition"]["questions"][6]["conditions"][0]["depends_on"], "has_water")
        return body

    def _tasks(self, headers, project_id):
        resp = self.client.get(f"/api/projects/{project_id}/tasks", headers=headers)
        self.assertEqual(resp.status_code, 200, resp.text)
        return resp.json()["features"]

    @staticmethod
    def _centroid_lnglat(feature):
        point = backend._representative_point(feature["geometry"])
        return point[0], point[1]

    @staticmethod
    def _interior_lnglat(feature):
        """A deterministic point guaranteed to lie inside a clipped grid cell."""
        geometry = feature["geometry"]
        min_x, min_y, max_x, max_y = backend._geometry_bbox(geometry)
        for i in range(1, 32):
            for j in range(1, 32):
                x = min_x + (max_x - min_x) * i / 32
                y = min_y + (max_y - min_y) * j / 32
                if backend._point_in_task_geometry(x, y, geometry):
                    return x, y
        return FieldSurveyEndToEndTest._centroid_lnglat(feature)

    # ------------------------------------------------------------------- test
    def test_department_head_full_field_survey_lifecycle(self):
        dept = self._create_user(self.master, "e2e_dept_head", "DepartmentAdmin")
        dept_headers = self._login("e2e_dept_head")

        # A DepartmentAdmin owns the project they create and is auto-linked.
        project = self._create_project(dept_headers, "E2E Ward Survey")
        project_id = project["id"]
        self.assertEqual([str(x) for x in project["department_admin_ids"]], [str(dept["id"])])

        # Field users created by the department head are automatically linked.
        collector1 = self._create_user(dept_headers, "e2e_collector_1", "DataCollector")
        collector2 = self._create_user(dept_headers, "e2e_collector_2", "DataCollector")
        validator = self._create_user(dept_headers, "e2e_validator", "Validator")
        collector_ids = {str(collector1["id"]), str(collector2["id"]), str(validator["id"])}
        linked = {str(item) for item in backend._project_collector_ids(project_id)}
        self.assertTrue(collector_ids.issubset(linked), linked)

        # Grids are generated from the project boundary.
        grid = self.client.post(f"/api/projects/{project_id}/generate-grid",
                                json={"grid_type": "HEXAGON", "grid_size_m": 100},
                                headers=dept_headers)
        self.assertEqual(grid.status_code, 200, grid.text)
        self.assertGreater(grid.json()["tasks_created"], 0)
        tasks = self._tasks(dept_headers, project_id)
        self.assertGreaterEqual(len(tasks), 2)
        task_a, task_b = tasks[0], tasks[1]

        questionnaire = self._build_questionnaire(dept_headers, project_id)

        # New layer linked at creation time: questionnaire questions become fields.
        new_layer_resp = self.client.post(f"/api/projects/{project_id}/layers", json={
            "name": "Building Survey Points",
            "geometry_type": "Point",
            "questionnaire_id": questionnaire["id"],
            "editable_by_collectors": True,
        }, headers=dept_headers)
        self.assertEqual(new_layer_resp.status_code, 200, new_layer_resp.text)
        new_layer = new_layer_resp.json()
        new_layer_fields = {f["name"]: f["type"] for f in new_layer["fields_config"]}
        self.assertEqual(new_layer_fields["building_type"], "select")
        self.assertEqual(new_layer_fields["inspection_date"], "date")
        self.assertEqual(new_layer_fields["inspection_time"], "time")
        self.assertEqual(new_layer_fields["camera_photo"], "image")
        self.assertEqual(new_layer_fields["has_water"], "boolean")
        self.assertEqual(new_layer_fields["water_source"], "select")

        # Existing layer linked afterwards: PUT re-derives its attribute schema.
        existing_layer_resp = self.client.post(f"/api/projects/{project_id}/layers", json={
            "name": "Building Survey Lines",
            "geometry_type": "LineString",
        }, headers=dept_headers)
        self.assertEqual(existing_layer_resp.status_code, 200, existing_layer_resp.text)
        existing_layer = existing_layer_resp.json()
        link_resp = self.client.put(f"/api/layers/{existing_layer['id']}", json={
            "questionnaire_id": questionnaire["id"],
        }, headers=dept_headers)
        self.assertEqual(link_resp.status_code, 200, link_resp.text)
        self.assertEqual(
            {f["name"] for f in link_resp.json()["fields_config"]},
            set(new_layer_fields),
        )

        # Unlock both layers for field editing through the project whitelist.
        unlock_resp = self.client.put(f"/api/projects/{project_id}", json={
            "editable_layer_ids": [new_layer["id"], existing_layer["id"]],
        }, headers=dept_headers)
        self.assertEqual(unlock_resp.status_code, 200, unlock_resp.text)

        # One grid shared by a collector and the validator, each with a layer scope.
        assign = self.client.post(f"/api/projects/{project_id}/tasks/assign", json={
            "task_ids": [task_a["properties"]["task_id"]],
            "assignments": [
                {"user_id": collector1["id"], "layer_ids": [new_layer["id"]]},
                {"user_id": validator["id"], "layer_ids": [existing_layer["id"]]},
            ],
        }, headers=dept_headers)
        self.assertEqual(assign.status_code, 200, assign.text)
        self.assertEqual(assign.json()["assigned_count"], 1)

        second_assign = self.client.post(f"/api/projects/{project_id}/tasks/assign", json={
            "task_ids": [task_b["properties"]["task_id"]],
            "assignments": [
                {"user_id": collector2["id"], "layer_ids": [new_layer["id"]]},
                {"user_id": validator["id"], "layer_ids": [existing_layer["id"]]},
            ],
        }, headers=dept_headers)
        self.assertEqual(second_assign.status_code, 200, second_assign.text)

        collector1_headers = self._login("e2e_collector_1")
        collector2_headers = self._login("e2e_collector_2")
        validator_headers = self._login("e2e_validator")

        # Collectors only see their own grids.
        visible = self._tasks(collector1_headers, project_id)
        self.assertEqual([f["properties"]["task_id"] for f in visible], [task_a["properties"]["task_id"]])

        lng, lat = self._interior_lnglat(task_a)
        self.assertTrue(
            backend._geometry_within_task_grid(
                task_a["geometry"], {"type": "Point", "coordinates": [lng, lat]}
            ),
            f"interior point {lng},{lat} not inside {task_a['geometry']}",
        )
        server_task = next(
            t for t in STATE["tasks_by_project"][project_id]
            if str(t["id"]) == str(task_a["properties"]["task_id"])
        )
        self.assertTrue(
            backend._geometry_within_task_grid(
                server_task["geometry"], {"type": "Point", "coordinates": [lng, lat]}
            ),
            "interior point is not inside the stored grid geometry",
        )

        # GPS gate: locking from outside the grid must fail.
        outside_lock = self.client.post(
            f"/api/tasks/{task_a['properties']['task_id']}/lock",
            json={"collector_lat": lat + 1.0, "collector_lng": lng + 1.0},
            headers=collector1_headers,
        )
        self.assertEqual(outside_lock.status_code, 403, outside_lock.text)

        lock = self.client.post(
            f"/api/tasks/{task_a['properties']['task_id']}/lock",
            json={"collector_lat": lat, "collector_lng": lng},
            headers=collector1_headers,
        )
        self.assertEqual(lock.status_code, 200, lock.text)
        self.assertEqual(lock.json()["task"]["status"], "LOCKED_FOR_MAPPING")

        # The collector cannot write into a layer outside their grid scope.
        out_of_scope = self.client.post(f"/api/projects/{project_id}/records/submit", json={
            "layer_id": existing_layer["id"],
            "geom_geojson": {"type": "Point", "coordinates": [lng, lat]},
            "answers": {"building_owner": "Scope Test"},
        }, headers=collector1_headers)
        self.assertEqual(out_of_scope.status_code, 403, out_of_scope.text)

        record_id = f"KMC-E2E-{uuid.uuid4().hex[:10]}"
        submit = self.client.post(f"/api/projects/{project_id}/records/submit", json={
            "record_id": record_id,
            "layer_id": new_layer["id"],
            "questionnaire_id": questionnaire["id"],
            "geom_geojson": {"type": "Point", "coordinates": [lng, lat]},
            "answers": {
                "building_owner": "Sita Sharma",
                "building_type": "residential",
                "inspection_date": "2026-11-16",
                "inspection_time": "10:35",
                "camera_photo": "/uploads/e2e/camera_photo.jpg",
                "has_water": "yes",
                "water_source": "municipal",
                "_created_by": 999,  # reserved key must be ignored
            },
            "media_refs": [{"field": "camera_photo", "url": "/uploads/e2e/camera_photo.jpg"}],
        }, headers=collector1_headers)
        self.assertEqual(submit.status_code, 200, submit.text)
        record = submit.json()
        self.assertEqual(record["status"], "SUBMITTED")
        self.assertEqual(record["task_grid_id"], task_a["properties"]["task_id"])
        self.assertNotIn("_created_by", record["answers"])

        task_submit = self.client.post(
            f"/api/tasks/{task_a['properties']['task_id']}/submit", headers=collector1_headers)
        self.assertEqual(task_submit.status_code, 200, task_submit.text)
        self.assertEqual(task_submit.json()["task"]["status"], "MAPPED")

        task_validate = self.client.post(
            f"/api/tasks/{task_a['properties']['task_id']}/validate", headers=validator_headers)
        self.assertEqual(task_validate.status_code, 200, task_validate.text)
        self.assertEqual(task_validate.json()["task"]["status"], "VALIDATED")

        review = self.client.put(f"/api/records/{record_id}/review", json={
            "status": "APPROVED",
            "reviewer_notes": "Field data verified",
        }, headers=validator_headers)
        self.assertEqual(review.status_code, 200, review.text)
        self.assertEqual(review.json()["status"], "APPROVED")

        # Answers are persisted as the feature's attributes.
        features = self.client.get(f"/api/layers/{new_layer['id']}/features", headers=dept_headers)
        self.assertEqual(features.status_code, 200, features.text)
        feature_list = features.json()
        if isinstance(feature_list, dict):
            feature_list = feature_list.get("features") or []
        feature = next(f for f in feature_list if f["properties"].get("_record_id") == record_id)
        props = feature["properties"]
        self.assertEqual(props["building_owner"], "Sita Sharma")
        self.assertEqual(props["building_type"], "residential")
        self.assertEqual(props["inspection_date"], "2026-11-16")
        self.assertEqual(props["inspection_time"], "10:35")
        self.assertEqual(props["camera_photo"], "/uploads/e2e/camera_photo.jpg")
        self.assertEqual(props["water_source"], "municipal")
        self.assertEqual(props["_task_grid_id"], task_a["properties"]["task_id"])
        self.assertEqual(props["_created_by_username"], "e2e_collector_1")

        fields_resp = self.client.get(f"/api/layers/{new_layer['id']}/fields", headers=dept_headers)
        self.assertEqual(fields_resp.status_code, 200, fields_resp.text)
        self.assertEqual(
            {f["name"] for f in fields_resp.json()["fields"]},
            set(new_layer_fields),
        )

        # Second collector works a different grid; validator can invalidate.
        lng_b, lat_b = self._interior_lnglat(task_b)
        lock_b = self.client.post(
            f"/api/tasks/{task_b['properties']['task_id']}/lock",
            json={"collector_lat": lat_b, "collector_lng": lng_b},
            headers=collector2_headers,
        )
        self.assertEqual(lock_b.status_code, 200, lock_b.text)
        submit_b = self.client.post(
            f"/api/tasks/{task_b['properties']['task_id']}/submit", headers=collector2_headers)
        self.assertEqual(submit_b.status_code, 200, submit_b.text)
        invalidate_b = self.client.post(
            f"/api/tasks/{task_b['properties']['task_id']}/validate?action=invalidate",
            json={"comment": "Roof photo is missing"},
            headers=validator_headers,
        )
        self.assertEqual(invalidate_b.status_code, 200, invalidate_b.text)
        self.assertEqual(invalidate_b.json()["task"]["status"], "INVALIDATED")

        # Department heads cannot create organisation-wide questionnaires.
        blocked_global = self.client.post("/api/projects/0/questionnaires", json={
            "title": "Unauthorised Global",
            "schema_definition": self._questionnaire_schema(),
        }, headers=dept_headers)
        self.assertEqual(blocked_global.status_code, 403, blocked_global.text)

        # The master user can create a global questionnaire, reusable on any project.
        global_resp = self.client.post("/api/questionnaires", json={
            "title": "Global Building Survey",
            "schema_definition": self._questionnaire_schema(),
        }, headers=self.master)
        self.assertEqual(global_resp.status_code, 200, global_resp.text)
        global_q = global_resp.json()
        self.assertTrue(global_q["is_global"])
        self.assertIsNone(global_q["project_id"])
        self.assertEqual(
            self.client.post(f"/api/questionnaires/{global_q['id']}/publish",
                             headers=self.master).status_code, 200)

        second_project = self._create_project(dept_headers, "E2E Second Project")
        second_layer_resp = self.client.post(f"/api/projects/{second_project['id']}/layers", json={
            "name": "Second Project Buildings",
            "geometry_type": "Point",
        }, headers=dept_headers)
        second_layer = second_layer_resp.json()
        reuse_link = self.client.put(f"/api/layers/{second_layer['id']}", json={
            "questionnaire_id": global_q["id"],
        }, headers=dept_headers)
        self.assertEqual(reuse_link.status_code, 200, reuse_link.text)
        self.assertEqual(
            {f["name"] for f in reuse_link.json()["fields_config"]},
            set(new_layer_fields),
        )
        active_second = self.client.get(
            f"/api/projects/{second_project['id']}/questionnaires/active", headers=dept_headers)
        self.assertEqual(active_second.status_code, 200, active_second.text)
        self.assertEqual(active_second.json()["id"], global_q["id"])

        # Validators cannot create projects; collectors cannot lock unassigned grids.
        self.assertEqual(
            self.client.post("/api/projects", json={"name": "Nope"}, headers=validator_headers).status_code,
            403,
        )
        self.assertEqual(
            self.client.post(f"/api/tasks/{task_b['properties']['task_id']}/lock",
                             json={"collector_lat": lat_b, "collector_lng": lng_b},
                             headers=collector1_headers).status_code,
            403,
        )


if __name__ == "__main__":
    unittest.main()
