import json
import os
import tempfile
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

from todo_sync.config import Settings
from todo_sync.models import Task
from todo_sync.org_files import LocalFiles
from todo_sync.sync import SyncService, SyncState


class FakeRemoteStore:
    def __init__(self, tasks, put_results=None):
        self.tasks = {task.uid: task for task in tasks}
        self.puts = []
        self.put_results = list(put_results or [])
        self.deletes = []
        self.requested_collections = None

    def get_tasks(self, collections):
        self.requested_collections = collections
        return list(self.tasks.values())

    def put_task(self, task, etag=None):
        self.puts.append((task, etag))
        if self.put_results and not self.put_results.pop(0):
            return False
        task.meta["etag"] = "new-etag"
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
    def test_empty_org_file_still_selects_its_remote_collection(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            (directory / "empty.org").write_text("", encoding="utf-8")
            remote = FakeRemoteStore([])
            settings = Settings(todo_directory=directory, sync_state_file=directory / ".state.json")

            FakeSyncService(settings, remote).run_once()

            self.assertEqual(remote.requested_collections, {"empty.org": "empty"})

    def test_remote_change_wins_when_both_sides_changed(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state_file = directory / ".state.json"
            uid = "same-uid"
            (directory / "home.org").write_text(
                "* TODO Local original\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":OWNER: household\n"
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
                ":OWNER: household\n"
                ":END:\n",
                encoding="utf-8",
            )
            second_remote = FakeRemoteStore(
                [
                    Task(
                        1,
                        "TODO",
                        "Remote edit",
                        "home.org",
                        uid=uid,
                        collection="home",
                        source_properties={"REMOTE_ONLY": "discard"},
                        meta={"etag": "2"},
                    )
                ]
            )

            FakeSyncService(settings, second_remote).run_once()

            text = (directory / "home.org").read_text(encoding="utf-8")
            self.assertIn("Remote edit", text)
            self.assertIn(":OWNER: household\n", text)
            self.assertNotIn("REMOTE_ONLY", text)

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

    def test_empty_remote_does_not_mass_delete_existing_local_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state_file = directory / ".state.json"
            uid = "same-uid"
            task = Task(1, "TODO", "Keep me", "home.org", uid=uid, collection="home")
            (directory / "home.org").write_text(
                "* TODO Keep me\n"
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
                                "local_hash": task.content_hash(),
                                "remote_hash": task.content_hash(),
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
            remote = FakeRemoteStore([])
            settings = Settings(todo_directory=directory, sync_state_file=state_file)

            FakeSyncService(settings, remote).run_once()

            self.assertEqual(remote.puts[0][0].uid, uid)
            self.assertIn("* TODO Keep me\n", (directory / "home.org").read_text(encoding="utf-8"))

    def test_remote_completion_merges_edits_and_reopens_in_the_same_cycle(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            state_file = directory / ".state.json"
            uid = "filter"
            path = directory / "home.org"
            path.write_text(
                "* TODO Old filter title\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":TIME_SINCE:\n"
                ":OWNER: household\n"
                ":END:\n"
                "Old notes\n",
                encoding="utf-8",
            )
            completed_at = datetime(2026, 8, 8, 19, 30, tzinfo=timezone.utc)
            remote_task = Task(
                1,
                "DONE",
                "Changed remotely",
                "home.org",
                uid=uid,
                description="Remote notes",
                tags=["maintenance"],
                completed_at=completed_at,
                percent_complete=100,
                collection="home",
                meta={"etag": "done-etag"},
            )
            remote = FakeRemoteStore([remote_task])
            settings = Settings(todo_directory=directory, sync_state_file=state_file)
            observed_at = completed_at + timedelta(hours=1)

            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                FakeSyncService(settings, remote).run_once()

            settled = LocalFiles(directory).find_task(uid)
            self.assertEqual(settled.status, "TODO")
            self.assertEqual(settled.content, "Changed remotely")
            self.assertEqual(settled.description, "Remote notes")
            self.assertEqual(settled.tags, ["maintenance"])
            self.assertIsNone(settled.completed_at)
            self.assertIsNone(settled.percent_complete)
            self.assertEqual(settled.time_since.last_done, completed_at)
            text = path.read_text(encoding="utf-8")
            self.assertIn(":OWNER: household\n", text)
            self.assertNotIn("CALDAV_COMPLETED", text)
            self.assertEqual(len(remote.puts), 1)
            self.assertEqual(remote.puts[0][0].status, "TODO")
            self.assertIsNone(remote.puts[0][0].completed_at)
            state = json.loads(state_file.read_text(encoding="utf-8"))
            self.assertEqual(state["records"][uid]["completion"]["signature"], "etag:done-etag")
            self.assertEqual(state["records"][uid]["local_hash"], settled.content_hash())
            self.assertEqual(state["records"][uid]["remote_hash"], settled.content_hash())

    def test_remote_completion_without_timestamp_reuses_fallback_after_reopen_failure(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            uid = "filter"
            path = directory / "home.org"
            path.write_text(
                "* TODO Change filter\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":TIME_SINCE:\n"
                ":END:\n",
                encoding="utf-8",
            )
            remote_task = Task(
                1,
                "DONE",
                "Change filter",
                "home.org",
                uid=uid,
                collection="home",
                meta={"etag": "done-etag"},
            )
            remote = FakeRemoteStore([remote_task], put_results=[False, True])
            settings = Settings(todo_directory=directory, sync_state_file=directory / ".state.json")
            first_observation = datetime(2026, 8, 8, 19, 30, tzinfo=timezone.utc)
            second_observation = first_observation + timedelta(hours=2)

            with patch("todo_sync.sync.utc_now", return_value=first_observation):
                FakeSyncService(settings, remote).run_once()
            with patch("todo_sync.sync.utc_now", return_value=second_observation):
                FakeSyncService(settings, remote).run_once()

            settled = LocalFiles(directory).find_task(uid)
            self.assertEqual(settled.time_since.last_done, first_observation)
            self.assertEqual([task.status for task, _etag in remote.puts], ["TODO", "TODO"])
            self.assertEqual(remote.tasks[uid].status, "TODO")

    def test_invalid_remote_completion_times_use_server_fallback(self):
        invalid_values = [
            datetime(2026, 8, 8, 19, 30),
            date(2026, 8, 8),
            "not-a-timestamp",
        ]
        for invalid_value in invalid_values:
            with self.subTest(invalid_value=invalid_value), tempfile.TemporaryDirectory() as tmp:
                directory = Path(tmp)
                uid = "filter"
                (directory / "home.org").write_text(
                    "* TODO Change filter\n"
                    ":PROPERTIES:\n"
                    f":CALDAV_UID: {uid}\n"
                    ":TIME_SINCE:\n"
                    ":END:\n",
                    encoding="utf-8",
                )
                remote_task = Task(
                    1,
                    "DONE",
                    "Change filter",
                    "home.org",
                    uid=uid,
                    completed_at=invalid_value,
                    collection="home",
                    meta={"etag": "invalid-completion"},
                )
                remote = FakeRemoteStore([remote_task])
                settings = Settings(todo_directory=directory, sync_state_file=directory / ".state.json")
                observed_at = datetime(2026, 8, 8, 20, tzinfo=timezone.utc)

                with patch("todo_sync.sync.utc_now", return_value=observed_at):
                    FakeSyncService(settings, remote).run_once()

                self.assertEqual(LocalFiles(directory).find_task(uid).time_since.last_done, observed_at)

    def test_remote_completion_timestamps_are_monotonic_and_future_clamped(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            uid = "filter"
            initial_time = datetime(2026, 8, 8, 12, tzinfo=timezone.utc)
            path = directory / "home.org"
            path.write_text(
                "* TODO Change filter\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                f":TIME_SINCE: {initial_time.isoformat()}\n"
                ":END:\n",
                encoding="utf-8",
            )
            remote = FakeRemoteStore(
                [
                    Task(
                        1,
                        "DONE",
                        "Change filter",
                        "home.org",
                        uid=uid,
                        completed_at=initial_time - timedelta(days=1),
                        collection="home",
                        meta={"etag": "older-completion"},
                    )
                ]
            )
            settings = Settings(todo_directory=directory, sync_state_file=directory / ".state.json")
            observed_at = initial_time + timedelta(days=1)

            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                FakeSyncService(settings, remote).run_once()
            self.assertEqual(LocalFiles(directory).find_task(uid).time_since.last_done, initial_time)

            remote.tasks[uid] = Task(
                1,
                "DONE",
                "Change filter",
                "home.org",
                uid=uid,
                completed_at=observed_at + timedelta(days=5),
                collection="home",
                meta={"etag": "future-completion"},
            )
            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                FakeSyncService(settings, remote).run_once()

            self.assertEqual(LocalFiles(directory).find_task(uid).time_since.last_done, observed_at)

    def test_direct_org_completion_is_consumed_before_sync_comparison(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            uid = "filter"
            path = directory / "home.org"
            path.write_text(
                "* DONE Change filter\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":TIME_SINCE:\n"
                ":OWNER: household\n"
                ":END:\n",
                encoding="utf-8",
            )
            remote_task = Task(1, "TODO", "Change filter", "home.org", uid=uid, collection="home")
            remote = FakeRemoteStore([remote_task])
            settings = Settings(todo_directory=directory, sync_state_file=directory / ".state.json")
            observed_at = datetime(2026, 8, 8, 19, 30, tzinfo=timezone.utc)

            with patch("todo_sync.sync.utc_now", return_value=observed_at):
                FakeSyncService(settings, remote).run_once()

            settled = LocalFiles(directory).find_task(uid)
            self.assertEqual(settled.status, "TODO")
            self.assertEqual(settled.time_since.last_done, observed_at)
            self.assertIn(":OWNER: household\n", path.read_text(encoding="utf-8"))

    def test_percent_complete_without_completed_status_does_not_reset_time_since(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            uid = "filter"
            previous_time = datetime(2026, 8, 1, 12, tzinfo=timezone.utc)
            (directory / "home.org").write_text(
                "* TODO Change filter\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                f":TIME_SINCE: {previous_time.isoformat()}\n"
                ":END:\n",
                encoding="utf-8",
            )
            remote_task = Task(
                1,
                "TODO",
                "Change filter",
                "home.org",
                uid=uid,
                percent_complete=100,
                collection="home",
                meta={"etag": "progress-only"},
            )
            remote = FakeRemoteStore([remote_task])
            settings = Settings(todo_directory=directory, sync_state_file=directory / ".state.json")

            FakeSyncService(settings, remote).run_once()

            task = LocalFiles(directory).find_task(uid)
            self.assertEqual(task.status, "TODO")
            self.assertEqual(task.time_since.last_done, previous_time)

    def test_time_since_only_edit_does_not_push_to_caldav(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            uid = "filter"
            task = Task(1, "TODO", "Change filter", "home.org", uid=uid, collection="home")
            path = directory / "home.org"
            path.write_text(
                "* TODO Change filter\n"
                ":PROPERTIES:\n"
                f":CALDAV_UID: {uid}\n"
                ":TIME_SINCE: 2026-08-08T19:30:00Z\n"
                ":END:\n",
                encoding="utf-8",
            )
            state_file = directory / ".state.json"
            state_file.write_text(
                json.dumps(
                    {
                        "records": {
                            uid: {
                                "local_hash": task.content_hash(),
                                "remote_hash": task.content_hash(),
                                "remote_etag": "etag",
                                "source_file": "home.org",
                                "collection": "home",
                            }
                        },
                        "tombstones": {},
                        "saved_at": "2026-08-01T00:00:00+00:00",
                    }
                ),
                encoding="utf-8",
            )
            original_state = state_file.read_text(encoding="utf-8")
            remote = FakeRemoteStore([task.copy_with(meta={"etag": "etag"})])
            settings = Settings(todo_directory=directory, sync_state_file=state_file)

            FakeSyncService(settings, remote).run_once()

            self.assertEqual(remote.puts, [])
            self.assertEqual(state_file.read_text(encoding="utf-8"), original_state)

    def test_remote_deletion_keeps_existing_behavior_for_tracked_tasks(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            tracked_uid = "tracked"
            remaining_uid = "remaining"
            tracked = Task(1, "TODO", "Tracked", "home.org", uid=tracked_uid, collection="home")
            remaining = Task(1, "TODO", "Remaining", "home.org", uid=remaining_uid, collection="home")
            (directory / "home.org").write_text(
                "* TODO Tracked\n:PROPERTIES:\n"
                f":CALDAV_UID: {tracked_uid}\n:TIME_SINCE:\n:END:\n"
                "* TODO Remaining\n:PROPERTIES:\n"
                f":CALDAV_UID: {remaining_uid}\n:END:\n",
                encoding="utf-8",
            )
            state_file = directory / ".state.json"
            state_file.write_text(
                json.dumps(
                    {
                        "records": {
                            tracked_uid: {
                                "local_hash": tracked.content_hash(),
                                "remote_hash": tracked.content_hash(),
                                "remote_etag": "tracked-etag",
                                "source_file": "home.org",
                                "collection": "home",
                            },
                            remaining_uid: {
                                "local_hash": remaining.content_hash(),
                                "remote_hash": remaining.content_hash(),
                                "remote_etag": "remaining-etag",
                                "source_file": "home.org",
                                "collection": "home",
                            },
                        },
                        "tombstones": {},
                    }
                ),
                encoding="utf-8",
            )
            remote = FakeRemoteStore([remaining.copy_with(meta={"etag": "remaining-etag"})])
            settings = Settings(todo_directory=directory, sync_state_file=state_file)

            FakeSyncService(settings, remote).run_once()

            self.assertIsNone(LocalFiles(directory).find_task(tracked_uid))
            self.assertIsNotNone(LocalFiles(directory).find_task(remaining_uid))


class SyncStateTest(unittest.TestCase):
    def test_completion_without_etag_reuses_hash_signature_fallback(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".state.json"
            task = Task(1, "DONE", "Change filter", "home.org", uid="filter", collection="home")
            first_observation = datetime(2026, 8, 8, 19, 30, tzinfo=timezone.utc)
            later_observation = first_observation + timedelta(hours=2)
            state = SyncState(path)

            effective_at = state.observe_remote_completion(task, first_observation)
            self.assertTrue(state.save())
            reloaded = SyncState(path)
            retried_at = reloaded.observe_remote_completion(task, later_observation)

            self.assertEqual(effective_at, first_observation)
            self.assertEqual(retried_at, first_observation)
            self.assertTrue(reloaded.records["filter"]["completion"]["signature"].startswith("hash:"))
            self.assertFalse(reloaded.save())

    def test_noop_save_does_not_touch_the_state_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".state.json"
            state = SyncState(path)

            self.assertFalse(state.save())
            self.assertFalse(path.exists())

            task = Task(1, "TODO", "Keep", "home.org", uid="keep", collection="home")
            state.record(task, "etag")
            self.assertTrue(state.save())
            original_contents = path.read_text(encoding="utf-8")
            original_modified_at = path.stat().st_mtime_ns

            reloaded = SyncState(path)
            reloaded.record(task, "etag")
            self.assertFalse(reloaded.save())
            self.assertEqual(path.read_text(encoding="utf-8"), original_contents)
            self.assertEqual(path.stat().st_mtime_ns, original_modified_at)

    def test_material_save_uses_atomic_replace_and_reloads(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".state.json"
            state = SyncState(path)
            task = Task(1, "TODO", "Keep", "home.org", uid="keep", collection="home")
            state.record(task, "etag")

            with patch("todo_sync.sync.os.replace", wraps=os.replace) as replace:
                self.assertTrue(state.save())

            replace.assert_called_once()
            self.assertEqual(SyncState(path).records["keep"]["local_hash"], task.content_hash())

    def test_repeated_tombstone_is_not_material(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".state.json"
            state = SyncState(path)
            state.delete_record("missing", source="remote-delete")
            self.assertTrue(state.save())

            reloaded = SyncState(path)
            reloaded.delete_record("missing", source="remote-delete")
            self.assertFalse(reloaded.save())

    def test_legacy_state_loads_without_completion_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / ".state.json"
            path.write_text(
                json.dumps(
                    {
                        "records": {"legacy": {"local_hash": "local", "remote_hash": "remote"}},
                        "tombstones": {},
                        "saved_at": "2026-08-01T00:00:00+00:00",
                    }
                ),
                encoding="utf-8",
            )

            state = SyncState(path)

            self.assertEqual(state.records["legacy"]["local_hash"], "local")
            self.assertFalse(state.save())


if __name__ == "__main__":
    unittest.main()
