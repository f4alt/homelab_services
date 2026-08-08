import tempfile
import unittest
from datetime import datetime, timezone
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

    def test_tracked_done_update_records_completion_and_returns_settled_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "home.org"
            path.write_text(
                "* TODO Change filter [100%]\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":TIME_SINCE:\n"
                ":OWNER: household\n"
                ":END:\n",
                encoding="utf-8",
            )
            settings = Settings(todo_directory=directory, enable_cors=False)
            client = create_app(settings).test_client()
            observed_at = datetime(2026, 8, 8, 19, 30, 0, 999999, tzinfo=timezone.utc)

            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                response = client.post("/tasks/update", json={"uid": "fixed", "status": "DONE"})

            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.get_json()["task"]["status"], "TODO")
            self.assertIsNone(response.get_json()["task"]["percent_complete"])
            text = path.read_text(encoding="utf-8")
            self.assertIn("* TODO Change filter\n", text)
            self.assertIn(":TIME_SINCE: 2026-08-08T19:30:00Z\n", text)
            self.assertIn(":OWNER: household\n", text)

    def test_tracked_done_update_preserves_non_complete_progress(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "home.org"
            path.write_text(
                "* TODO Change filter [50%]\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":TIME_SINCE:\n"
                ":END:\n",
                encoding="utf-8",
            )
            client = create_app(Settings(todo_directory=directory, enable_cors=False)).test_client()
            observed_at = datetime(2026, 8, 8, 19, 30, tzinfo=timezone.utc)

            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                response = client.post("/tasks/update", json={"uid": "fixed", "status": "DONE"})

            self.assertEqual(response.get_json()["task"]["percent_complete"], 50)
            self.assertIn("* TODO Change filter [50%]\n", path.read_text(encoding="utf-8"))

    def test_tracked_done_update_does_not_move_fractional_time_backward(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            path = directory / "home.org"
            path.write_text(
                "* TODO Change filter\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":TIME_SINCE: 2026-08-08T19:30:00.900Z\n"
                ":END:\n",
                encoding="utf-8",
            )
            client = create_app(Settings(todo_directory=directory, enable_cors=False)).test_client()
            observed_at = datetime(2026, 8, 8, 19, 30, 0, 950000, tzinfo=timezone.utc)

            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                response = client.post("/tasks/update", json={"uid": "fixed", "status": "DONE"})

            self.assertEqual(response.get_json()["task"]["status"], "TODO")
            self.assertIn(":TIME_SINCE: 2026-08-08T19:30:00.900Z\n", path.read_text(encoding="utf-8"))

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

    def test_time_since_projects_only_tracked_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "home.org").write_text(
                "* TODO Never completed\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: empty\n"
                ":TIME_SINCE:\n"
                ":TIME_SINCE_TARGET_DAYS: 30\n"
                ":END:\n"
                "* TODO Completed\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: complete\n"
                ":TIME_SINCE: 2026-08-08T14:30:00-05:00\n"
                ":TIME_SINCE_TARGET_DAYS: 0\n"
                ":END:\n"
                "* TODO Invalid\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: invalid\n"
                ":TIME_SINCE: yesterday\n"
                ":TIME_SINCE_TARGET_DAYS: 2.5\n"
                ":END:\n"
                "* TODO Not tracked\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: untracked\n"
                ":TIME_SINCE_TARGET_DAYS: 10\n"
                ":END:\n",
                encoding="utf-8",
            )
            client = create_app(Settings(todo_directory=directory, enable_cors=False)).test_client()

            response = client.get("/time-since")

            self.assertEqual(response.status_code, 200)
            self.assertEqual(
                response.get_json(),
                {
                    "items": [
                        {
                            "uid": "empty",
                            "name": "Never completed",
                            "source_file": "home.org",
                            "last_done": None,
                            "target_days": 30,
                        },
                        {
                            "uid": "complete",
                            "name": "Completed",
                            "source_file": "home.org",
                            "last_done": "2026-08-08T19:30:00Z",
                            "target_days": None,
                        },
                        {
                            "uid": "invalid",
                            "name": "Invalid",
                            "source_file": "home.org",
                            "last_done": None,
                            "target_days": None,
                        },
                    ]
                },
            )

            generic_task = client.get("/tasks").get_json()["tasks"][0]
            self.assertNotIn("time_since", generic_task)
            self.assertNotIn("source_properties", generic_task)

    def test_time_since_order_is_source_path_then_heading_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            nested = directory / "nested"
            nested.mkdir()
            (directory / "z.org").write_text(
                "* TODO Zed\n:PROPERTIES:\n:CALDAV_UID: zed\n:TIME_SINCE:\n:END:\n",
                encoding="utf-8",
            )
            (nested / "a.org").write_text(
                "* TODO First\n:PROPERTIES:\n:TIME_SINCE:\n:END:\n"
                "* TODO Second\n:PROPERTIES:\n:CALDAV_UID: second\n:TIME_SINCE:\n:END:\n",
                encoding="utf-8",
            )
            client = create_app(Settings(todo_directory=directory, enable_cors=False)).test_client()

            items = client.get("/time-since").get_json()["items"]

            self.assertEqual([item["name"] for item in items], ["First", "Second", "Zed"])
            self.assertTrue(items[0]["uid"])
            self.assertIn(":CALDAV_UID:", (nested / "a.org").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
