from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from .caldav_client import CalDavStore
from .config import Settings
from .models import (
    COMPLETED_PERCENTAGE,
    DONE_STATUS,
    TODO_STATUS,
    format_utc_datetime,
    parse_aware_datetime,
    resolve_completion_time,
)
from .org_files import REPLACE_META_KEY, LocalFiles, collection_slug, merge_task_update


COMPLETION_STATE_KEY = "completion"
COMPLETION_SIGNATURE_KEY = "signature"
COMPLETION_EFFECTIVE_AT_KEY = "effective_at"
JSON_INDENT = 2


def utc_now():
    return datetime.now(timezone.utc)


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
        self._dirty = False
        self._load()

    def _load(self):
        if not self.path.exists():
            return
        data = json.loads(self.path.read_text(encoding="utf-8"))
        self.records = data.get("records", {})
        self.tombstones = data.get("tombstones", {})

    def save(self):
        if not self._dirty:
            return False

        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "records": self.records,
            "tombstones": self.tombstones,
            "saved_at": utc_now().isoformat(),
        }
        temporary_path = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self.path.parent,
                prefix=f".{self.path.name}.",
                suffix=".tmp",
                delete=False,
            ) as temporary_file:
                json.dump(payload, temporary_file, indent=JSON_INDENT, sort_keys=True)
                temporary_file.write("\n")
                temporary_path = Path(temporary_file.name)
            os.replace(temporary_path, self.path)
        except Exception:
            if temporary_path is not None:
                temporary_path.unlink(missing_ok=True)
            raise

        self._dirty = False
        return True

    def record(self, task, remote_etag=None):
        if not task.uid:
            return
        remote_hash = task.meta.get("remote_hash") or task.content_hash()
        record = {
            "local_hash": task.content_hash(),
            "remote_hash": remote_hash,
            "remote_etag": remote_etag or task.meta.get("etag"),
            "source_file": task.source_file,
            "collection": task.collection,
        }
        existing_completion = self.records.get(task.uid, {}).get(COMPLETION_STATE_KEY)
        if existing_completion is not None:
            record[COMPLETION_STATE_KEY] = existing_completion
        if self.records.get(task.uid) != record or task.uid in self.tombstones:
            self.records[task.uid] = record
            self.tombstones.pop(task.uid, None)
            self._dirty = True

    def observe_remote_completion(self, task, observed_at):
        if not task.uid:
            raise ValueError("A remote completion requires a UID")

        signature = self._completion_signature(task)
        current_record = self.records.get(task.uid, {})
        current_completion = current_record.get(COMPLETION_STATE_KEY, {})
        if current_completion.get(COMPLETION_SIGNATURE_KEY) == signature:
            effective_at = parse_aware_datetime(current_completion.get(COMPLETION_EFFECTIVE_AT_KEY))
            if effective_at is not None:
                return effective_at

        effective_at = resolve_completion_time(task.completed_at, observed_at)

        completion = {
            COMPLETION_SIGNATURE_KEY: signature,
            COMPLETION_EFFECTIVE_AT_KEY: format_utc_datetime(effective_at),
        }
        updated_record = current_record.copy()
        updated_record[COMPLETION_STATE_KEY] = completion
        self.records[task.uid] = updated_record
        self._dirty = True
        return effective_at

    @staticmethod
    def _completion_signature(task):
        remote_etag = task.meta.get("etag")
        if remote_etag:
            return f"etag:{remote_etag}"
        return f"hash:{task.content_hash()}"

    def delete_record(self, uid, source="sync"):
        existing_tombstone = self.tombstones.get(uid)
        if uid not in self.records and existing_tombstone and existing_tombstone.get("source") == source:
            return
        self.records.pop(uid, None)
        self.tombstones[uid] = {"source": source, "deleted_at": utc_now().isoformat()}
        self._dirty = True


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

    def get_time_since_items(self):
        items = []
        for task in sorted(self.get_local_tasks(), key=lambda candidate: candidate.source_file):
            time_since = task.time_since
            if time_since is None:
                continue
            items.append(
                {
                    "uid": task.uid,
                    "name": task.content,
                    "source_file": task.source_file,
                    "last_done": (
                        format_utc_datetime(time_since.last_done) if time_since.last_done is not None else None
                    ),
                    "target_days": time_since.target_days,
                }
            )
        return items

    def update_local_task(self, uid, status):
        local_files = self.local_files()
        task = local_files.find_task(uid)
        if task is None:
            return None

        observed_at = utc_now()
        updated = task.copy_with(status=status)
        if status == DONE_STATUS and task.time_since is not None:
            updated = updated.consume_completion(observed_at, observed_at)
        elif status == DONE_STATUS and updated.completed_at is None:
            updated = updated.copy_with(
                completed_at=observed_at,
                percent_complete=COMPLETED_PERCENTAGE,
            )
        elif status == TODO_STATUS:
            updated = updated.copy_with(completed_at=None, percent_complete=None)
        local_files.update([updated], allow_reopen=True)
        return updated

    def run_once(self):
        local_files = self.local_files()
        local_by_file = local_files.get_tasks_by_file(ensure_uids=True)
        observed_at = utc_now()
        local_by_file = self._consume_local_completions(local_by_file, local_files, observed_at)
        collections = {
            source_file: tasks[0].collection if tasks else collection_slug(source_file)
            for source_file, tasks in local_by_file.items()
        }

        remote_store = self.remote_store()
        remote_tasks = remote_store.get_tasks(collections)
        state = SyncState(self.settings.sync_state_file)

        local_tasks = [task for tasks in local_by_file.values() for task in tasks if task.uid]
        local = {task.uid: task for task in local_tasks}
        remote = {task.uid: task for task in remote_tasks if task.uid}
        preserve_local_when_remote_empty = bool(local) and not remote and bool(state.records)

        for uid in sorted(set(local) | set(remote) | set(state.records)):
            if uid in state.tombstones and uid not in local and uid not in remote:
                continue

            local_task = local.get(uid)
            remote_task = remote.get(uid)
            previous = state.records.get(uid)

            if local_task and remote_task:
                self._sync_existing(
                    local_task,
                    remote_task,
                    previous,
                    local_files,
                    remote_store,
                    state,
                    observed_at,
                )
            elif local_task:
                self._sync_local_only(
                    uid,
                    local_task,
                    previous,
                    remote_store,
                    local_files,
                    state,
                    preserve_local_when_remote_empty,
                )
            elif remote_task:
                self._sync_remote_only(uid, remote_task, previous, local_files, remote_store, state)
            elif previous:
                state.delete_record(uid, source="both-missing")

        state.save()
        return SyncResult(task_count=len(local_files.get_tasks()), synced_at=utc_now())

    @staticmethod
    def _consume_local_completions(local_by_file, local_files, observed_at):
        settled_by_uid = {}
        for tasks in local_by_file.values():
            for task in tasks:
                if task.status == DONE_STATUS and task.time_since is not None:
                    settled_by_uid[task.uid] = task.consume_completion(task.completed_at, observed_at)

        if settled_by_uid:
            local_files.update(list(settled_by_uid.values()), allow_reopen=True)

        return {
            source_file: [settled_by_uid.get(task.uid, task) for task in tasks]
            for source_file, tasks in local_by_file.items()
        }

    def _sync_existing(
        self,
        local_task,
        remote_task,
        previous,
        local_files,
        remote_store,
        state,
        observed_at,
    ):
        if local_task.time_since is not None and remote_task.status == DONE_STATUS:
            self._consume_remote_completion(
                local_task,
                remote_task,
                local_files,
                remote_store,
                state,
                observed_at,
            )
            return

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
            remote_task.meta[REPLACE_META_KEY] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        if remote_changed:
            remote_task.meta[REPLACE_META_KEY] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        if local_changed:
            if not remote_store.put_task(local_task, previous.get("remote_etag") if previous else None):
                refreshed = self._refetch_remote_task(remote_store, local_task)
                if refreshed:
                    refreshed.meta[REPLACE_META_KEY] = True
                    refreshed.meta["remote_hash"] = refreshed.content_hash()
                    local_files.update([refreshed], allow_reopen=True)
                    state.record(refreshed, refreshed.meta.get("etag"))
                    return
            local_task.meta["remote_hash"] = local_task.content_hash()
            state.record(local_task, local_task.meta.get("etag"))
            return

        state.record(local_task, remote_task.meta.get("etag"))

    @staticmethod
    def _consume_remote_completion(
        local_task,
        remote_task,
        local_files,
        remote_store,
        state,
        observed_at,
    ):
        remote_task.meta[REPLACE_META_KEY] = True
        merged = merge_task_update(
            local_task,
            remote_task,
            local_task.source_file,
            local_task.collection,
        )
        effective_at = state.observe_remote_completion(remote_task, observed_at)
        # Persist the chosen time before side effects so a failed reopen cannot advance it on retry.
        state.save()

        settled = merged.consume_completion(effective_at, observed_at)
        local_files.write_merged([settled])
        settled.meta.pop(REPLACE_META_KEY, None)
        if not remote_store.put_task(settled, remote_task.meta.get("etag")):
            return

        settled.meta["remote_hash"] = settled.content_hash()
        state.record(settled, settled.meta.get("etag"))

    def _sync_local_only(self, uid, local_task, previous, remote_store, local_files, state, preserve_local=False):
        if previous is None:
            remote_store.put_task(local_task)
            local_task.meta["remote_hash"] = local_task.content_hash()
            state.record(local_task, local_task.meta.get("etag"))
            return

        if preserve_local:
            remote_store.put_task(local_task, previous.get("remote_etag"))
            local_task.meta["remote_hash"] = local_task.content_hash()
            state.record(local_task, local_task.meta.get("etag"))
            return

        # Remote deletion wins over unchanged or changed local state in v1.
        local_files.delete(previous.get("source_file") or local_task.source_file, uid)
        state.delete_record(uid, source="remote-delete")

    def _sync_remote_only(self, uid, remote_task, previous, local_files, remote_store, state):
        if previous is None:
            remote_task.meta[REPLACE_META_KEY] = True
            local_files.update([remote_task], allow_reopen=True)
            state.record(remote_task, remote_task.meta.get("etag"))
            return

        remote_task.meta["remote_hash"] = remote_task.content_hash()
        if "remote_hash" not in previous:
            remote_changed = False
        else:
            remote_changed = previous.get("remote_hash") != remote_task.content_hash()
        if remote_changed:
            remote_task.meta[REPLACE_META_KEY] = True
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
