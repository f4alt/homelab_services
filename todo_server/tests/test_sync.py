import tempfile
import unittest
import json
from pathlib import Path

from todo_sync.config import Settings
from todo_sync.models import Task
from todo_sync.sync import SyncService


class FakeRemoteStore:
    def __init__(self, tasks):
        self.tasks = {task.uid: task for task in tasks}
        self.puts = []
        self.deletes = []

    def get_tasks(self, collections):
        return list(self.tasks.values())

    def put_task(self, task, etag=None):
        self.puts.append((task, etag))
        self.tasks[task.uid] = task.copy_with(meta={"etag": "new-etag"})
        return True

    def delete_task(self, task, etag=None):
        self.deletes.append((task, etag))
        self.tasks.pop(task.uid, None)
        return True


class FakeSyncService(SyncService):
    def __init__(self, settings, remote):
        super().__init__(settings)
        self.remote = remote

    def remote_store(self):
        return self.remote


class SyncServiceTest(unittest.TestCase):
    def test_remote_change_wins_when_both_sides_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state_file = directory / ".state.json"
            uid = "same-uid"
            (directory / "home.org").write_text(
                "* TODO Local original\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":END:\n",
                encoding="utf-8",
            )

            settings = Settings(todo_directory=directory, sync_state_file=state_file)
            first_remote = FakeRemoteStore(
                [Task(1, "TODO", "Local original", "home.org", uid=uid, collection="home", meta={"etag": "1"})]
            )
            FakeSyncService(settings, first_remote).run_once()

            (directory / "home.org").write_text(
                "* TODO Local edit\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":END:\n",
                encoding="utf-8",
            )
            second_remote = FakeRemoteStore(
                [Task(1, "TODO", "Remote edit", "home.org", uid=uid, collection="home", meta={"etag": "2"})]
            )

            FakeSyncService(settings, second_remote).run_once()

            self.assertIn("Remote edit", (directory / "home.org").read_text(encoding="utf-8"))

    def test_local_done_pushes_when_only_remote_etag_drifted(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state_file = directory / ".state.json"
            uid = "same-uid"
            (directory / "home.org").write_text(
                "* DONE Local completion\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":END:\n",
                encoding="utf-8",
            )
            state_file.write_text(
                json.dumps(
                    {
                        "records": {
                            uid: {
                                "local_hash": "old-local-hash",
                                "remote_etag": "old-etag",
                                "source_file": "home.org",
                                "collection": "home",
                            }
                        },
                        "tombstones": {},
                    }
                ),
                encoding="utf-8",
            )

            remote = FakeRemoteStore(
                [Task(1, "TODO", "Local completion", "home.org", uid=uid, collection="home", meta={"etag": "new-etag"})]
            )
            settings = Settings(todo_directory=directory, sync_state_file=state_file)

            FakeSyncService(settings, remote).run_once()

            self.assertEqual(remote.puts[0][0].status, "DONE")
            self.assertIn("* DONE Local completion\n", (directory / "home.org").read_text(encoding="utf-8"))

    def test_local_reopen_pushes_same_uid(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state_file = directory / ".state.json"
            uid = "same-uid"
            done_task = Task(1, "DONE", "Reopen me", "home.org", uid=uid, collection="home")
            (directory / "home.org").write_text(
                "* DONE Reopen me\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":CALDAV_COMPLETED: 2026-06-07T19:31:44+00:00\n"
                ":END:\n",
                encoding="utf-8",
            )
            state_file.write_text(
                json.dumps(
                    {
                        "records": {
                            uid: {
                                "local_hash": done_task.content_hash(),
                                "remote_hash": done_task.content_hash(),
                                "remote_etag": "old-etag",
                                "source_file": "home.org",
                                "collection": "home",
                            }
                        },
                        "tombstones": {},
                    }
                ),
                encoding="utf-8",
            )
            (directory / "home.org").write_text(
                "* TODO Reopen me\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":END:\n",
                encoding="utf-8",
            )
            remote = FakeRemoteStore([done_task.copy_with(meta={"etag": "old-etag"})])
            settings = Settings(todo_directory=directory, sync_state_file=state_file)

            FakeSyncService(settings, remote).run_once()

            self.assertEqual(remote.puts[0][0].uid, uid)
            self.assertEqual(remote.puts[0][0].status, "TODO")
            self.assertIn("* TODO Reopen me\n", (directory / "home.org").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
