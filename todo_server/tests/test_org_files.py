import tempfile
import unittest
from pathlib import Path

from todo_sync.models import Task
from todo_sync.org_files import LocalFiles, TodoFile, collection_slug


class TodoFileTest(unittest.TestCase):
    def test_loads_simple_org_headings_and_creates_uid_drawer(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text("* TODO Pay bill\nNotes stay untouched\n** DONE Old task\n", encoding="utf-8")

            todo_file = TodoFile(path)
            tasks = {task.content: task for task in todo_file.get_tasks()}

            self.assertEqual(tasks["Pay bill"].status, "TODO")
            self.assertEqual(tasks["Old task"].level, 2)
            self.assertIsNotNone(tasks["Pay bill"].uid)
            self.assertIn(":CALDAV_UID:", path.read_text(encoding="utf-8"))

    def test_existing_uid_survives_content_edits(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text(
                "* TODO Pay bill\n:PROPERTIES:\n:CALDAV_UID: fixed\n:END:\n",
                encoding="utf-8",
            )
            todo_file = TodoFile(path)
            self.assertEqual(todo_file.get_tasks()[0].uid, "fixed")

            path.write_text(
                "* TODO Pay electric bill\n:PROPERTIES:\n:CALDAV_UID: fixed\n:END:\n",
                encoding="utf-8",
            )

            self.assertEqual(todo_file.get_tasks()[0].uid, "fixed")
            self.assertEqual(todo_file.get_tasks()[0].content, "Pay electric bill")

    def test_parses_rich_org_fields(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text(
                "* TODO [#A] Pay bill [50%] :money:home:\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":END:\n"
                "SCHEDULED: <2026-06-08> DEADLINE: <2026-06-09>\n"
                "First note line\n"
                "Second note line\n",
                encoding="utf-8",
            )

            task = TodoFile(path).get_tasks()[0]

            self.assertEqual(task.priority, 1)
            self.assertEqual(task.tags, ["money", "home"])
            self.assertEqual(task.percent_complete, 50)
            self.assertEqual(task.scheduled.isoformat(), "2026-06-08")
            self.assertEqual(task.deadline.isoformat(), "2026-06-09")
            self.assertEqual(task.description, "First note line\nSecond note line")

    def test_nested_heading_sets_parent_uid(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text(
                "* TODO Parent\n:PROPERTIES:\n:CALDAV_UID: parent\n:END:\n"
                "** TODO Child\n:PROPERTIES:\n:CALDAV_UID: child\n:END:\n",
                encoding="utf-8",
            )

            tasks = {task.uid: task for task in TodoFile(path).get_tasks()}

            self.assertEqual(tasks["child"].parent_uid, "parent")

    def test_update_by_uid_preserves_unrelated_notes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text(
                "* TODO Pay bill\n:PROPERTIES:\n:CALDAV_UID: fixed\n:END:\nNotes stay untouched\n",
                encoding="utf-8",
            )

            TodoFile(path).update([Task(1, "DONE", "Pay bill", "home.org", uid="fixed")], allow_reopen=True)

            text = path.read_text(encoding="utf-8")
            self.assertIn("* DONE Pay bill\n", text)
            self.assertIn("Notes stay untouched\n", text)

    def test_reopen_by_uid_preserves_uid_and_clears_completed_property(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text(
                "* DONE Pay bill\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":CALDAV_COMPLETED: 2026-06-07T19:31:44+00:00\n"
                ":END:\n",
                encoding="utf-8",
            )

            TodoFile(path).update([Task(1, "TODO", "Pay bill", "home.org", uid="fixed")], allow_reopen=True)

            text = path.read_text(encoding="utf-8")
            self.assertIn("* TODO Pay bill\n", text)
            self.assertIn(":CALDAV_UID: fixed\n", text)
            self.assertNotIn("CALDAV_COMPLETED", text)

    def test_manual_reopen_cleans_stale_completed_property_on_scan(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text(
                "* TODO Pay bill\n"
                ":PROPERTIES:\n"
                ":CALDAV_UID: fixed\n"
                ":CALDAV_COMPLETED: 2026-06-07T19:31:44+00:00\n"
                ":END:\n",
                encoding="utf-8",
            )

            task = TodoFile(path).get_tasks()[0]

            self.assertEqual(task.uid, "fixed")
            self.assertEqual(task.status, "TODO")
            self.assertIsNone(task.completed_at)
            self.assertNotIn("CALDAV_COMPLETED", path.read_text(encoding="utf-8"))

    def test_update_appends_remote_only_task(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text("* TODO Existing\n:PROPERTIES:\n:CALDAV_UID: existing\n:END:\n", encoding="utf-8")

            TodoFile(path).update(
                [Task(1, "TODO", "Remote task", "home.org", uid="remote", collection="home")],
                allow_reopen=True,
            )

            text = path.read_text(encoding="utf-8")
            self.assertIn("* TODO Existing\n", text)
            self.assertIn("* TODO Remote task\n", text)
            self.assertIn(":CALDAV_UID: remote\n", text)

    def test_reload_clears_deleted_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "home.org"
            path.write_text("* TODO Pay bill\n", encoding="utf-8")
            todo_file = TodoFile(path)
            self.assertEqual(len(todo_file.get_tasks()), 1)

            path.write_text("", encoding="utf-8")

            self.assertEqual(todo_file.get_tasks(), [])


class LocalFilesTest(unittest.TestCase):
    def test_scans_all_org_files_including_master_as_ordinary_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "home.org").write_text("* TODO Pay bill\n", encoding="utf-8")
            (directory / "master.org").write_text("* TODO Aggregate but ordinary\n", encoding="utf-8")
            (directory / "notes.txt").write_text("* TODO Ignore me\n", encoding="utf-8")

            tasks = LocalFiles(directory).get_tasks()

            self.assertEqual({task.source_file for task in tasks}, {"home.org", "master.org"})

    def test_collection_slug_is_stable_for_nested_files(self):
        self.assertEqual(collection_slug("Work/Client Todos.org"), "work-client-todos")


if __name__ == "__main__":
    unittest.main()
