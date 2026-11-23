"""
KMC-GIS-SERVER — Tests for Project Layer Linking, Collector Edit Toggle, Auto Task Collector Linking, and Questionnaire Validation Issues.
"""

import unittest
from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

PROJECT_ID = 88
GLOBAL_LAYER_ID = 881
OWNED_LAYER_ID = 882
GLOBAL_TILE_ID = 883
ADMIN_ID = 1
COLLECTOR_ID = 4


def _token(user_id: int) -> dict:
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


def _admin_token(user_id: int = ADMIN_ID) -> dict:
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class ProjectLayersAndQuestionnaireSyncTest(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(backend.app)

        self._orig_users = list(STATE.get("users", []))
        self._orig_projects = list(STATE.get("projects", []))
        self._orig_layers = list(STATE.get("vector_layers", []))
        self._orig_rasters = list(STATE.get("raster_layers", []))
        self._orig_assignments = dict(STATE.get("project_assignments", {}))
        self._orig_questionnaires = list(STATE.get("questionnaires", []))
        self._orig_tasks = dict(STATE.get("tasks_by_project", {}))

        STATE["users"] = [
            {"id": ADMIN_ID, "username": "superadmin", "role": "SuperAdmin", "is_active": True},
            {"id": COLLECTOR_ID, "username": "collector_1", "role": "DataCollector", "is_active": True},
        ]

        STATE["projects"] = [
            {
                "id": PROJECT_ID,
                "name": "KMC Project 88",
                "status": "ACTIVE",
                "editable_layer_ids": [],
                "download_layer_ids": [],
            }
        ]

        STATE["vector_layers"] = [
            {
                "id": GLOBAL_LAYER_ID,
                "name": "Global Vector Layer",
                "project_id": None,
                "is_global": True,
                "editable_by_collectors": False,
                "fields_config": [{"name": "name", "label": "Name", "type": "text"}],
            },
            {
                "id": OWNED_LAYER_ID,
                "name": "Project Owned Layer",
                "project_id": PROJECT_ID,
                "is_global": False,
                "editable_by_collectors": False,
                "fields_config": [{"name": "name", "label": "Name", "type": "text"}],
            },
        ]

        STATE["raster_layers"] = [
            {
                "id": GLOBAL_TILE_ID,
                "name": "Global Orthophoto MBTiles",
                "project_id": None,
                "is_global": True,
                "tile_url": "/tiles/data/ortho/{z}/{x}/{y}.pbf",
            }
        ]

        STATE["project_assignments"] = {
            PROJECT_ID: {
                "assigned_layer_ids": [GLOBAL_LAYER_ID],
                "assigned_mbtiles_ids": [GLOBAL_TILE_ID],
                "assigned_collector_ids": [],
            }
        }

        STATE["tasks_by_project"] = {
            PROJECT_ID: [
                {
                    "id": "task_88_001",
                    "project_id": PROJECT_ID,
                    "grid_index": 1,
                    "grid_code": "G-001",
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[85.3, 27.7], [85.31, 27.7], [85.31, 27.71], [85.3, 27.71], [85.3, 27.7]]],
                    },
                    "assignments": [],
                }
            ]
        }

    def tearDown(self):
        STATE["users"] = self._orig_users
        STATE["projects"] = self._orig_projects
        STATE["vector_layers"] = self._orig_layers
        STATE["raster_layers"] = self._orig_rasters
        STATE["project_assignments"] = self._orig_assignments
        STATE["questionnaires"] = self._orig_questionnaires
        STATE["tasks_by_project"] = self._orig_tasks

    def test_list_project_layers_includes_assigned_global_layers(self):
        resp = self.client.get(f"/api/projects/{PROJECT_ID}/layers", headers=_admin_token())
        self.assertEqual(resp.status_code, 200, resp.text)
        layer_ids = [l["id"] for l in resp.json()]
        self.assertIn(OWNED_LAYER_ID, layer_ids)
        self.assertIn(GLOBAL_LAYER_ID, layer_ids)

    def test_list_project_tiles_includes_assigned_tiles(self):
        resp = self.client.get(f"/api/projects/{PROJECT_ID}/tiles", headers=_admin_token())
        self.assertEqual(resp.status_code, 200, resp.text)
        tile_ids = [t["id"] for t in resp.json()]
        self.assertIn(GLOBAL_TILE_ID, tile_ids)

    def test_project_editable_layer_ids_syncs_layer_editable_by_collectors(self):
        resp = self.client.put(
            f"/api/projects/{PROJECT_ID}",
            json={"editable_layer_ids": [GLOBAL_LAYER_ID, OWNED_LAYER_ID]},
            headers=_admin_token(),
        )
        self.assertEqual(resp.status_code, 200, resp.text)

        global_layer = next(l for l in STATE["vector_layers"] if l["id"] == GLOBAL_LAYER_ID)
        owned_layer = next(l for l in STATE["vector_layers"] if l["id"] == OWNED_LAYER_ID)
        self.assertTrue(global_layer.get("editable_by_collectors"))
        self.assertTrue(owned_layer.get("editable_by_collectors"))

    def test_task_assignment_auto_links_collector(self):
        resp = self.client.post(
            f"/api/projects/{PROJECT_ID}/tasks/assign",
            json={
                "task_ids": ["task_88_001"],
                "user_id": COLLECTOR_ID,
            },
            headers=_admin_token(),
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        self.assertEqual(resp.json()["assigned_count"], 1)

        rec = STATE["project_assignments"][PROJECT_ID]
        self.assertIn(COLLECTOR_ID, rec.get("assigned_collector_ids", []))

    def test_questionnaire_validation_returns_issues_with_targets(self):
        raw_q = {
            "title": "",
            "schema_definition": {
                "sections": [{"id": "sec_1", "title": "", "title_ne": ""}],
                "questions": [{"id": "q_1", "name": "", "label": "", "type": "text", "section_id": "sec_1"}],
            },
        }
        report = backend._validate_questionnaire_template(raw_q)
        self.assertFalse(report["valid"])
        self.assertTrue(len(report["issues"]) >= 3)

        header_issue = next((iss for iss in report["issues"] if iss.get("target_type") == "header"), None)
        self.assertIsNotNone(header_issue)
        self.assertEqual(header_issue["field"], "title")

        section_issue = next((iss for iss in report["issues"] if iss.get("target_type") == "section"), None)
        self.assertIsNotNone(section_issue)
        self.assertEqual(section_issue["section_id"], "sec_1")

        question_issue = next((iss for iss in report["issues"] if iss.get("target_type") == "question"), None)
        self.assertIsNotNone(question_issue)
        self.assertEqual(question_issue["question_id"], "q_1")

    def test_global_questionnaire_listing_and_creation(self):
        resp = self.client.post(
            "/api/questionnaires",
            json={
                "title": "Global Municipal Survey",
                "description": "City-wide baseline survey",
            },
            headers=_admin_token(),
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        created = resp.json()
        self.assertTrue(created.get("is_global"))
        self.assertIsNone(created.get("project_id"))

        list_resp = self.client.get(f"/api/projects/{PROJECT_ID}/questionnaires", headers=_admin_token())
        self.assertEqual(list_resp.status_code, 200, list_resp.text)
        q_ids = [q["id"] for q in list_resp.json()]
        self.assertIn(created["id"], q_ids)

    def test_link_global_questionnaire_to_project_layer(self):
        # 1. Create a global questionnaire
        q_resp = self.client.post(
            "/api/questionnaires",
            json={
                "title": "Global Building Assessment",
                "schema_definition": {
                    "sections": [{"id": "s1", "title": "Building Info"}],
                    "questions": [
                        {"id": "q1", "name": "building_use", "label": "Building Use", "type": "select", "section_id": "s1"}
                    ],
                },
            },
            headers=_admin_token(),
        )
        self.assertEqual(q_resp.status_code, 200)
        global_q_id = q_resp.json()["id"]

        # 2. Update existing project layer to link global questionnaire
        update_resp = self.client.put(
            f"/api/layers/{OWNED_LAYER_ID}",
            json={"questionnaire_id": global_q_id},
            headers=_admin_token(),
        )
        self.assertEqual(update_resp.status_code, 200, update_resp.text)
        self.assertEqual(update_resp.json()["questionnaire_id"], global_q_id)

        # 3. Create a new layer with this global questionnaire
        create_resp = self.client.post(
            "/api/layers",
            json={
                "name": "New Survey Layer",
                "geometry_type": "Point",
                "project_id": PROJECT_ID,
                "questionnaire_id": global_q_id,
            },
            headers=_admin_token(),
        )
        self.assertEqual(create_resp.status_code, 200, create_resp.text)
        created_layer = create_resp.json()
        self.assertEqual(created_layer["questionnaire_id"], global_q_id)
        field_names = [f["name"] for f in created_layer.get("fields_config", [])]
        self.assertIn("building_use", field_names)


if __name__ == "__main__":
    unittest.main()
