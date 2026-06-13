from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Any


VALID_STATUSES = {"TODO", "DONE"}


def _serialize_temporal(value):
    if value is None:
        return None
    return value.isoformat()


@dataclass
class Task:
    level: int
    status: str
    content: str
    source_file: str
    uid: str | None = None
    description: str = ""
    tags: list[str] = field(default_factory=list)
    priority: int | None = None
    scheduled: date | datetime | None = None
    deadline: date | datetime | None = None
    completed_at: datetime | None = None
    percent_complete: int | None = None
    parent_uid: str | None = None
    collection: str | None = None
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        if self.status not in VALID_STATUSES:
            raise ValueError(f"Unsupported task status: {self.status}")
        if self.collection is None:
            self.collection = self.source_file
        if self.status == "DONE" and self.percent_complete is None:
            self.percent_complete = 100
        if self.status == "TODO":
            self.completed_at = None
        if self.percent_complete is not None:
            self.percent_complete = max(0, min(100, int(self.percent_complete)))

    @property
    def key(self):
        return self.uid or f"{self.source_file}:{self.content}"

    def copy_with(self, **changes):
        values = {
            "level": self.level,
            "status": self.status,
            "content": self.content,
            "source_file": self.source_file,
            "uid": self.uid,
            "description": self.description,
            "tags": list(self.tags),
            "priority": self.priority,
            "scheduled": self.scheduled,
            "deadline": self.deadline,
            "completed_at": self.completed_at,
            "percent_complete": self.percent_complete,
            "parent_uid": self.parent_uid,
            "collection": self.collection,
            "meta": self.meta.copy(),
        }
        values.update(changes)
        return Task(**values)

    def done_copy(self):
        return self.copy_with(status="DONE")

    def normalized_dict(self):
        return {
            "uid": self.uid,
            "status": self.status,
            "content": self.content,
            "source_file": self.source_file,
            "description": self.description,
            "tags": sorted(self.tags),
            "priority": self.priority,
            "scheduled": _serialize_temporal(self.scheduled),
            "deadline": _serialize_temporal(self.deadline),
            "completed_at": _serialize_temporal(self.completed_at),
            "percent_complete": self.percent_complete,
            "parent_uid": self.parent_uid,
            "collection": self.collection,
        }

    def content_hash(self):
        encoded = repr(sorted(self.normalized_dict().items())).encode("utf-8")
        return hashlib.sha256(encoded).hexdigest()

    def to_dict(self):
        return {
            "level": self.level,
            "status": self.status,
            "content": self.content,
            "source_file": self.source_file,
            "uid": self.uid,
            "description": self.description,
            "tags": list(self.tags),
            "priority": self.priority,
            "scheduled": _serialize_temporal(self.scheduled),
            "deadline": _serialize_temporal(self.deadline),
            "completed_at": _serialize_temporal(self.completed_at),
            "percent_complete": self.percent_complete,
            "parent_uid": self.parent_uid,
            "collection": self.collection,
            "meta": self.meta,
        }
