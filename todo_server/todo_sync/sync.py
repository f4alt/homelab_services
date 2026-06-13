from __future__ import annotations

import json
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .caldav_client import CalDavStore
from .config import Settings
from .models import Task
from .org_files import LocalFiles


@dataclass
class SyncResult:
    task_count: int
    synced_at: datetime

    def to_dict(self):
        return {
            "task_count": self.task_count,
            "synced_at": self.synced_at.isoformat(),
        }


class SyncState:
    def __init__(self, path):
        self.path = Path(path)
        self.records = {}
        self.tombstones = {}
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.records = data.get("records", {})
        self.tombstones = data.get("tombstones", {})

    def save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "records": self.records,
            "tombstones": self.tombstones,
            "saved_at": datetime.now(timezone.utc).isoformat(),
        }
        self.path.write_text(json.dumps(payload, indent=2, sort_keys=True), encoding="utf-8")

    def record(self, task, remote_etag=None):
        if not task.uid:
            return
        remote_hash = task.meta.get("remote_hash") or task.content_hash()
        self.records[task.uid] = {
            "local_hash": task.content_hash(),
            "remote_hash": remote_hash,
            "remote_etag": remote_etag or task.meta.get("etag"),
            "source_file": task.source_file,
            "collection": task.collection,
        }
        self.tombstones.pop(task.uid, None)

    def delete_record(self, uid, source="sync"):
        self.records.pop(uid, None)
        self.tombstones[uid] = {"source": source, "deleted_at": datetime.now(timezone.utc).isoformat()}


class SyncService:
    def __init__(self, settings: Settings):
        self.settings = settings

    def local_files(self):
        return LocalFiles(self.settings.todo_directory)

    def remote_store(self):
        return CalDavStore(
            self.settings.caldav_url,
            self.settings.caldav_username,
            self.settings.caldav_password,
            self.settings.caldav_collection_prefix,
            self.settings.caldav_verify_ssl,
        )

    def get_local_tasks(self):
        return self.local_files().get_tasks()

    def update_local_task(self, content=None, status=None, source_file=None, uid=None):
        local_files = self.local_files()
        task = local_files.find_task(content=content, source_file=source_file, uid=uid)
        if task is None:
            return None

        updated = task.copy_with(status=status)
        if status == "DONE" and updated.completed_at is None:
            updated = updated.copy_with(completed_at=datetime.now(timezone.utc), percent_complete=100)
        elif status == "TODO":
            updated = updated.copy_with(completed_at=None, percent_complete=None)
        local_files.update([updated], allow_reopen=True)
        return updated

    def run_once(self):
        local_files = self.local_files()
        local_by_file = local_files.get_tasks_by_file(ensure_uids=True)
        collections = {
            source_file: tasks[0].collection
            for source_file, tasks in local_by_file.items()
            if tasks
        }
        for source_file, todo_file in local_files.files.items():
            collections.setdefault(source_file, todo_file.collection)

        remote_store = self.remote_store()
        remote_tasks = remote_store.get_tasks(collections)
        state = SyncState(self.settings.sync_state_file)

        local_tasks = [task for tasks in local_by_file.values() for task in tasks if task.uid]
        local = {task.uid: task for task in local_tasks}
        remote = {task.uid: task for task in remote_tasks if task.uid}

        for uid in sorted(set(local) | set(remote) | set(state.records)):
            if uid in state.tombstones and uid not in local and uid not in remote:
                continue

            local_task = local.get(uid)
            remote_task = remote.get(uid)
            previous = state.records.get(uid)

            if local_task and remote_task:
                self._sync_existing(uid, local_task, remote_task, previous, local_files, remote_store, state)
            elif local_task:
                self._sync_local_only(uid, local_task, previous, remote_store, local_files, state)
            elif remote_task:
                self._sync_remote_only(uid, remote_task, previous, local_files, remote_store, state)
            elif previous:
                state.delete_record(uid, source="both-missing")

        state.save()
        return SyncResult(task_count=len(self.get_local_tasks()), synced_at=datetime.now(timezone.utc))

    def _sync_existing(self, uid, local_task, remote_task, previous, local_files, remote_store, state):
        local_changed = previous is None or previous.get("local_hash") != local_task.content_hash()
        remote_hash = remote_task.content_hash()
        remote_task.meta["remote_hash"] = remote_hash
        if previous is None:
            remote_changed = True
        elif "remote_hash" not in previous:
            remote_changed = False
        else:
            remote_changed = previous.get("remote_hash") != remote_hash

        if local_changed and remote_changed:
            remote_task.meta["replace"] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        if remote_changed:
            remote_task.meta["replace"] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        if local_changed:
            if not remote_store.put_task(local_task, previous.get("remote_etag") if previous else None):
                refreshed = self._refetch_remote_task(remote_store, local_task)
                if refreshed:
                    refreshed.meta["replace"] = True
                    refreshed.meta["remote_hash"] = refreshed.content_hash()
                    local_files.update([refreshed], allow_reopen=True)
                    state.record(refreshed, refreshed.meta.get("etag"))
                    return
            local_task.meta["remote_hash"] = local_task.content_hash()
            state.record(local_task, local_task.meta.get("etag"))
            return

        state.record(local_task, remote_task.meta.get("etag"))

    def _sync_local_only(self, uid, local_task, previous, remote_store, local_files, state):
        if previous is None:
            remote_store.put_task(local_task)
            local_task.meta["remote_hash"] = local_task.content_hash()
            state.record(local_task, local_task.meta.get("etag"))
            return

        # Remote deletion wins over unchanged or changed local state in v1.
        local_files.delete(previous.get("source_file") or local_task.source_file, uid)
        state.delete_record(uid, source="remote-delete")

    def _sync_remote_only(self, uid, remote_task, previous, local_files, remote_store, state):
        if previous is None:
            remote_task.meta["replace"] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        remote_task.meta["remote_hash"] = remote_task.content_hash()
        if "remote_hash" not in previous:
            remote_changed = False
        else:
            remote_changed = previous.get("remote_hash") != remote_task.content_hash()
        if remote_changed:
            remote_task.meta["replace"] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        if remote_store.delete_task(remote_task, previous.get("remote_etag")):
            state.delete_record(uid, source="local-delete")

    @staticmethod
    def _refetch_remote_task(remote_store, task):
        collections = {task.source_file: task.collection}
        for refreshed in remote_store.get_tasks(collections):
            if refreshed.uid == task.uid:
                return refreshed
        return None
