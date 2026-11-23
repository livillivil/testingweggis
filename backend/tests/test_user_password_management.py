"""Password-management rules for application accounts.

Run inside the backend container:

    docker compose run --rm --no-deps \
        -v "$PWD/backend/app:/app/app:ro" -v "$PWD/backend/tests:/app/tests:ro" \
        --entrypoint python backend -m unittest discover -s /app/tests -v

Golden rules:
  * MasterAdmin may set the password of any account (including its own)
    without supplying the current password.
  * Every other authenticated user may only change their own password and
    must supply the correct current one.
  * New passwords are hashed, never returned, and must be at least 8 chars.
"""

import unittest

from fastapi.testclient import TestClient

from app import main as backend
from app.main import STATE, hash_password

MASTER_ID = 1
SUPER_ID = 2
COLLECTOR_ID = 3

MASTER_OLD = "MasterOld#2026"
SUPER_OLD = "SuperOld#2026"
COLLECTOR_OLD = "CollectorOld#2026"


def _token(user_id):
    return {"Authorization": f"Bearer {backend._issue_access_token(user_id)}"}


class UserPasswordManagementTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls._original_save = backend._save_persistent_state
        backend._save_persistent_state = lambda *args, **kwargs: None

    @classmethod
    def tearDownClass(cls):
        backend._save_persistent_state = cls._original_save

    def setUp(self):
        self._state_backup = {"users": list(STATE.get("users", []))}
        STATE["users"] = [
            {
                "id": MASTER_ID,
                "username": "kmc_master",
                "role": "MasterAdmin",
                "is_active": True,
                "password_hash": hash_password(MASTER_OLD),
            },
            {
                "id": SUPER_ID,
                "username": "super_admin",
                "role": "SuperAdmin",
                "is_active": True,
                "password_hash": hash_password(SUPER_OLD),
            },
            {
                "id": COLLECTOR_ID,
                "username": "collector_one",
                "role": "DataCollector",
                "is_active": True,
                "password_hash": hash_password(COLLECTOR_OLD),
            },
        ]
        self.client = TestClient(backend.app)

    def tearDown(self):
        STATE.update(self._state_backup)

    # ------------------------------------------------------ master reset

    def test_master_resets_any_password_without_current(self):
        response = self.client.put(
            f"/api/users/{COLLECTOR_ID}/password",
            json={"new_password": "CollectorNew#2026"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        self.assertNotIn("password_hash", response.json()["user"])
        self.assertEqual(response.json()["user"]["id"], COLLECTOR_ID)

        login = self.client.post(
            "/api/auth/login",
            json={"username": "collector_one", "password": "CollectorNew#2026"},
        )
        self.assertEqual(login.status_code, 200, login.text)
        self.assertNotIn("password_hash", login.json()["user"])

        old = self.client.post(
            "/api/auth/login",
            json={"username": "collector_one", "password": COLLECTOR_OLD},
        )
        self.assertEqual(old.status_code, 401)

    def test_master_resets_own_password_without_current(self):
        response = self.client.put(
            f"/api/users/{MASTER_ID}/password",
            json={"new_password": "MasterNew#2026"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        login = self.client.post(
            "/api/auth/login",
            json={"username": "kmc_master", "password": "MasterNew#2026"},
        )
        self.assertEqual(login.status_code, 200, login.text)

    # ------------------------------------------------------- self change

    def test_self_change_requires_the_correct_current_password(self):
        wrong = self.client.put(
            f"/api/users/{COLLECTOR_ID}/password",
            json={"current_password": "not-the-password", "new_password": "CollectorNew#2026"},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(wrong.status_code, 400, wrong.text)

        missing = self.client.put(
            f"/api/users/{COLLECTOR_ID}/password",
            json={"new_password": "CollectorNew#2026"},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(missing.status_code, 400, missing.text)

        ok = self.client.put(
            f"/api/users/{COLLECTOR_ID}/password",
            json={"current_password": COLLECTOR_OLD, "new_password": "CollectorNew#2026"},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(ok.status_code, 200, ok.text)
        login = self.client.post(
            "/api/auth/login",
            json={"username": "collector_one", "password": "CollectorNew#2026"},
        )
        self.assertEqual(login.status_code, 200, login.text)

    def test_super_can_reset_collector_password(self):
        # SuperAdmin can reset a collector's password without current password
        response = self.client.put(
            f"/api/users/{COLLECTOR_ID}/password",
            json={"new_password": "SuperReset#2026"},
            headers=_token(SUPER_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        stored = next(u for u in STATE["users"] if u["id"] == COLLECTOR_ID)
        self.assertTrue(backend.verify_password("SuperReset#2026", stored["password_hash"]))

        # But SuperAdmin CANNOT reset MasterAdmin's password
        deny_master_reset = self.client.put(
            f"/api/users/{MASTER_ID}/password",
            json={"new_password": "HijackMaster#2026"},
            headers=_token(SUPER_ID),
        )
        self.assertEqual(deny_master_reset.status_code, 403, deny_master_reset.text)

        # And a standard collector CANNOT reset another account's password
        deny_collector = self.client.put(
            f"/api/users/{SUPER_ID}/password",
            json={"new_password": "CollectorHijack#2026"},
            headers=_token(COLLECTOR_ID),
        )
        self.assertEqual(deny_collector.status_code, 403, deny_collector.text)

    def test_unauthenticated_request_is_rejected(self):
        response = self.client.put(
            f"/api/users/{COLLECTOR_ID}/password",
            json={"new_password": "NoAuth#2026"},
        )
        self.assertEqual(response.status_code, 401, response.text)

    # -------------------------------------------------------- validation

    def test_short_password_is_rejected_for_master_and_self(self):
        for actor_id, payload in (
            (MASTER_ID, {"new_password": "short"}),
            (COLLECTOR_ID, {"current_password": COLLECTOR_OLD, "new_password": "seven77"}),
        ):
            response = self.client.put(
                f"/api/users/{COLLECTOR_ID}/password",
                json=payload,
                headers=_token(actor_id),
            )
            self.assertEqual(response.status_code, 400, response.text)

    def test_generic_user_update_allows_password_field(self):
        response = self.client.put(
            f"/api/users/{COLLECTOR_ID}",
            json={"password": "SideDoor#2026"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(response.status_code, 200, response.text)
        stored = next(u for u in STATE["users"] if u["id"] == COLLECTOR_ID)
        self.assertTrue(backend.verify_password("SideDoor#2026", stored["password_hash"]))

    def test_missing_user_returns_404(self):
        response = self.client.put(
            "/api/users/9999/password",
            json={"new_password": "NobodyNew#2026"},
            headers=_token(MASTER_ID),
        )
        self.assertEqual(response.status_code, 404, response.text)


if __name__ == "__main__":
    unittest.main()
