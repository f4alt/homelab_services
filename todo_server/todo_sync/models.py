from __future__ import annotations

import hashlib
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any


TODO_STATUS = "TODO"
DONE_STATUS = "DONE"
VALID_STATUSES = {TODO_STATUS, DONE_STATUS}
TIME_SINCE_PROPERTY = "TIME_SINCE"
TIME_SINCE_TARGET_DAYS_PROPERTY = "TIME_SINCE_TARGET_DAYS"
POSITIVE_INTEGER_RE = re.compile(r"^[0-9]+$")
PERCENT_COMPLETE_RE = re.compile(r"\[(?P<percent>\d{1,3})%\]")
REPEATED_WHITESPACE_RE = re.compile(r"\s{2,}")
COMPLETED_PERCENTAGE = 100


def _serialize_temporal(value):
    if value is None:
        return None
    return value.isoformat()


def parse_aware_datetime(value):
    if not value:
        return None
    if isinstance(value, datetime):
        parsed = value
    else:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except (AttributeError, TypeError, ValueError):
            return None
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        return None
    return parsed


def format_utc_datetime(value):
    return normalize_utc_datetime(value).isoformat().replace("+00:00", "Z")


def normalize_utc_datetime(value):
    return value.astimezone(timezone.utc).replace(microsecond=0)


def resolve_completion_time(candidate_completed_at, observed_at):
    observed_at = parse_aware_datetime(observed_at)
    if observed_at is None:
        raise ValueError("observed_at must be a timezone-aware datetime")

    effective_time = parse_aware_datetime(candidate_completed_at) or observed_at
    return min(effective_time, observed_at)


@dataclass(frozen=True)
class TimeSince:
    last_done: datetime | None
    target_days: int | None

    @classmethod
    def from_properties(cls, properties):
        if TIME_SINCE_PROPERTY not in properties:
            return None

        target_value = properties.get(TIME_SINCE_TARGET_DAYS_PROPERTY)
        target_days = None
        if target_value and POSITIVE_INTEGER_RE.fullmatch(target_value):
            parsed_target = int(target_value)
            if parsed_target > 0:
                target_days = parsed_target

        return cls(
            last_done=parse_aware_datetime(properties[TIME_SINCE_PROPERTY]),
            target_days=target_days,
        )


@dataclass(frozen=True)
class SourceProperty:
    key: str
    value: str
    raw_line: str | None = None


@dataclass
class SourceProperties:
    """Preserve duplicate/raw Org entries while allowing managed fields to change.

    Reads and writes use the effective last entry; removing a managed key clears
    every duplicate so stale completion state cannot survive.
    """

    entries: list[SourceProperty] = field(default_factory=list)

    @classmethod
    def from_value(cls, value):
        if isinstance(value, cls):
            return value.copy()
        if isinstance(value, Mapping):
            return cls([SourceProperty(key, property_value) for key, property_value in value.items()])
        raise TypeError("source_properties must be a mapping or SourceProperties")

    def append(self, key, value, raw_line=None):
        self.entries.append(SourceProperty(key, value, raw_line))

    def copy(self):
        return SourceProperties(list(self.entries))

    def __bool__(self):
        return bool(self.entries)

    def __contains__(self, key):
        return any(entry.key == key for entry in self.entries)

    def __getitem__(self, key):
        for entry in reversed(self.entries):
            if entry.key == key:
                return entry.value
        raise KeyError(key)

    def __setitem__(self, key, value):
        for index in range(len(self.entries) - 1, -1, -1):
            if self.entries[index].key == key:
                self.entries[index] = SourceProperty(key, value)
                return
        self.append(key, value)

    def get(self, key, default=None):
        try:
            return self[key]
        except KeyError:
            return default

    def pop(self, key, default=None):
        matching = [entry for entry in self.entries if entry.key == key]
        if not matching:
            return default
        self.entries = [entry for entry in self.entries if entry.key != key]
        return matching[-1].value

    def render_lines(self):
        lines = []
        for entry in self.entries:
            if entry.raw_line is not None:
                lines.append(entry.raw_line)
                continue
            separator = " " if entry.value else ""
            lines.append(f":{entry.key}:{separator}{entry.value}\n")
        return lines


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
    source_properties: SourceProperties = field(default_factory=SourceProperties, repr=False)
    meta: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self):
        self.source_properties = SourceProperties.from_value(self.source_properties)
        if self.status not in VALID_STATUSES:
            raise ValueError(f"Unsupported task status: {self.status}")
        if self.collection is None:
            self.collection = self.source_file
        if self.status == DONE_STATUS and self.percent_complete is None:
            self.percent_complete = COMPLETED_PERCENTAGE
        if self.status == TODO_STATUS:
            self.completed_at = None
        if self.percent_complete is not None:
            self.percent_complete = max(0, min(COMPLETED_PERCENTAGE, int(self.percent_complete)))

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
            "source_properties": self.source_properties.copy(),
            "meta": self.meta.copy(),
        }
        values.update(changes)
        return Task(**values)

    @property
    def time_since(self):
        return TimeSince.from_properties(self.source_properties)

    def consume_completion(self, candidate_completed_at, observed_at):
        time_since = self.time_since
        if time_since is None:
            return self

        effective_time = resolve_completion_time(candidate_completed_at, observed_at)

        properties = self.source_properties.copy()
        persisted_time = normalize_utc_datetime(effective_time)
        if time_since.last_done is None or persisted_time > time_since.last_done:
            properties[TIME_SINCE_PROPERTY] = format_utc_datetime(effective_time)

        percent_complete = self.percent_complete
        content = self.content
        if percent_complete == COMPLETED_PERCENTAGE:
            percent_complete = None
            content = REPEATED_WHITESPACE_RE.sub(" ", PERCENT_COMPLETE_RE.sub("", content)).strip()
        elif percent_complete is not None and PERCENT_COMPLETE_RE.search(content) is None:
            content = f"{content} [{percent_complete}%]"

        return self.copy_with(
            status=TODO_STATUS,
            content=content,
            completed_at=None,
            percent_complete=percent_complete,
            source_properties=properties,
        )

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
