"""Questionnaire schema normalisation: nested questions must reach the renderer."""

import secrets
import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE

PASSWORD = f"Norm-{secrets.token_urlsafe(24)}"

NESTED_SCHEMA = {
    "sections": [
        {
            "id": "sec_a",
            "title": "Section A",
            "questions": [
                {"id": "q_name", "name": "name", "label": "Name", "type": "text", "required": True},
                {"id": "q_ward", "name": "ward", "label": "Ward", "type": "dropdown",
                 "options": [{"value": "1", "label": "Ward 1"}]},
            ],
        },
        {
            "id": "sec_b",
            "title": "Section B",
            "questions": [
                {"id": "q_photo", "name": "photo", "label": "Photo", "type": "photo"},
            ],
        },
    ],
}


class QuestionnaireNormalisationTest(unittest.TestCase):
    def setUp(self):
        self._orig_state = {key: STATE.get(key) for key in ("users", "questionnaires", "vector_layers")}
        self._orig_save = backend._save_persistent_state
        backend._save_persistent_state = lambda *args, **kwargs: None
        STATE["users"] = [{
            "id": 1,
            "username": "norm_master",
            "role": "MasterAdmin",
            "is_active": True,
            "password_hash": backend.hash_password(PASSWORD),
        }]
        STATE["questionnaires"] = []
        STATE["vector_layers"] = []
        self.client = TestClient(backend.app)
        resp = self.client.post("/api/auth/login", json={"username": "norm_master", "password": PASSWORD})
        self.assertEqual(resp.status_code, 200, resp.text)
        self.headers = {"Authorization": f"Bearer {resp.json()['access_token']}"}

    def tearDown(self):
        backend._save_persistent_state = self._orig_save
        for key, value in self._orig_state.items():
            STATE[key] = value

    def test_nested_questions_are_promoted_on_create(self):
        resp = self.client.post("/api/questionnaires", json={
            "title": "Nested survey",
            "schema_definition": NESTED_SCHEMA,
        }, headers=self.headers)
        self.assertEqual(resp.status_code, 200, resp.text)
        questionnaire = resp.json()
        questions = questionnaire["schema_definition"]["questions"]
        self.assertEqual([q["name"] for q in questions], ["name", "ward", "photo"])
        self.assertEqual([q["section_id"] for q in questions], ["sec_a", "sec_a", "sec_b"])

    def test_validation_counts_nested_questions(self):
        questionnaire = self.client.post("/api/questionnaires", json={
            "title": "Nested survey",
            "schema_definition": NESTED_SCHEMA,
        }, headers=self.headers).json()
        resp = self.client.post(
            f"/api/questionnaires/{questionnaire['id']}/validate", headers=self.headers
        )
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["valid"], body)
        self.assertEqual(body["total_questions"], 3)

    def test_startup_normalisation_repairs_stored_templates(self):
        STATE["questionnaires"] = [{"id": 7, "title": "Stored", "schema_definition": NESTED_SCHEMA}]
        backend._normalise_all_questionnaires()
        questions = STATE["questionnaires"][0]["schema_definition"]["questions"]
        self.assertEqual(len(questions), 3)


if __name__ == "__main__":
    unittest.main()
