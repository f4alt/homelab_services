import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from todo_sync.api import create_app
from todo_sync.config import Settings


class ApiTest(unittest.TestCase):
    def test_health_reports_ok(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(todo_directory=Path(tmp), enable_cors=False)

            response = create_app(settings).test_client().get("/health")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json(), {"status": "ok"})

    def test_post_sync_runs_sync_and_returns_result(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(todo_directory=Path(tmp), enable_cors=False)

            with patch("todo_sync.api.SyncService") as service_type:
                service_type.return_value.run_once.return_value.to_dict.return_value = {
                    "task_count": 2,
                    "synced_at": "2026-07-18T12:00:00+00:00",
                }
                client = create_app(settings).test_client()

                response = client.post("/sync")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.get_json(),
                {
                    "message": "Todos synced.",
                    "sync": {
                        "task_count": 2,
                        "synced_at": "2026-07-18T12:00:00+00:00",
                    },
                },
            )

    def test_get_sync_is_rejected_without_running_sync(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(todo_directory=Path(tmp), enable_cors=False)

            with patch("todo_sync.api.SyncService") as service_type:
                client = create_app(settings).test_client()

                response = client.get("/sync")

            self.assertEqual(response.status_code, 405)
            service_type.return_value.run_once.assert_not_called()

    def test_uid_update_changes_the_task_visible_through_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "home.org").write_text(
                "* TODO Pay bill\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":END:\n",
                encoding="utf-8",
            )
            settings = Settings(todo_directory=directory, enable_cors=False)
            client = create_app(settings).test_client()

            response = client.post("/tasks/update", json={"uid": "fixed", "status": "DONE"})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["task"]["uid"], "fixed")
            self.assertEqual(response.get_json()["task"]["status"], "DONE")
            tasks = client.get("/tasks").get_json()["tasks"]
            self.assertEqual([(task["uid"], task["status"]) for task in tasks], [("fixed", "DONE")])

    def test_content_and_source_file_update_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "home.org").write_text(
                "* TODO Pay bill\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":END:\n",
                encoding="utf-8",
            )
            settings = Settings(todo_directory=directory, enable_cors=False)
            client = create_app(settings).test_client()

            response = client.post(
                "/tasks/update",
                json={"content": "Pay bill", "source_file": "home.org", "status": "DONE"},
            )

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json(), {"error": "uid is required"})
            self.assertEqual(client.get("/tasks").get_json()["tasks"][0]["status"], "TODO")

    def test_task_update_rejects_an_invalid_status(self):
        with tempfile.TemporaryDirectory() as tmp:
            settings = Settings(todo_directory=Path(tmp), enable_cors=False)
            client = create_app(settings).test_client()

            response = client.post("/tasks/update", json={"uid": "fixed", "status": "WAITING"})

            self.assertEqual(response.status_code, 400)
            self.assertEqual(response.get_json(), {"error": "status must be one of ['DONE', 'TODO']"})


if __name__ == "__main__":
    unittest.main()
