from __future__ import annotations

import re
from datetime import datetime, timezone

from icalendar import Calendar, Todo

from .models import Task, parse_aware_datetime


COMPLETED_PROPERTY_RE = re.compile(
    r"^COMPLETED(?:;[^:\r\n]*)?:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*(?:\r?\n|$)",
    flags=re.IGNORECASE | re.MULTILINE,
)


def _first_value(component, key):
    value = component.get(key)
    if value is None:
        return None
    if isinstance(value, list):
        value = value[0]
    if hasattr(value, "dt"):
        return value.dt
    return value


def _text(component, key, default=""):
    value = _first_value(component, key)
    if value is None:
        return default
    return str(value)


def _categories(component):
    value = component.get("categories")
    if value is None:
        return []
    if not isinstance(value, list):
        value = [value]
    tags = []
    for item in value:
        cats = getattr(item, "cats", None)
        if cats is not None:
            tags.extend(str(cat) for cat in cats)
        else:
            tags.extend(part.strip() for part in str(item).split(",") if part.strip())
    return tags


def task_to_ical(task: Task):
    calendar = Calendar()
    calendar.add("prodid", "-//todo-sync-server//caldav bridge//EN")
    calendar.add("version", "2.0")

    todo = Todo()
    todo.add("uid", task.uid)
    todo.add("summary", task.content)
    todo.add("status", "COMPLETED" if task.status == "DONE" else "NEEDS-ACTION")
    todo.add("last-modified", datetime.now(timezone.utc))
    if task.description:
        todo.add("description", task.description)
    if task.tags:
        todo.add("categories", task.tags)
    if task.priority is not None:
        todo.add("priority", task.priority)
    if task.scheduled is not None:
        todo.add("dtstart", task.scheduled)
    if task.deadline is not None:
        todo.add("due", task.deadline)
    if task.completed_at is not None:
        todo.add("completed", task.completed_at)
    elif task.status == "DONE":
        todo.add("completed", datetime.now(timezone.utc))
    if task.percent_complete is not None:
        todo.add("percent-complete", task.percent_complete)
    if task.parent_uid:
        todo.add("related-to", task.parent_uid)
    if task.source_file:
        todo.add("x-org-source-file", task.source_file)
    if task.collection:
        todo.add("x-org-collection", task.collection)

    calendar.add_component(todo)
    return calendar.to_ical().decode("utf-8")


def task_from_ical(ical_data, source_file=None, collection=None, meta=None):
    try:
        calendar = Calendar.from_ical(ical_data)
    except ValueError:
        text = ical_data.decode("utf-8") if isinstance(ical_data, bytes) else ical_data
        sanitized, removed_count = COMPLETED_PROPERTY_RE.subn("", text)
        if removed_count == 0:
            raise
        calendar = Calendar.from_ical(sanitized)
    todo = next((component for component in calendar.walk() if component.name == "VTODO"), None)
    if todo is None:
        return None

    status = _text(todo, "status", "NEEDS-ACTION").upper()
    source = source_file or _text(todo, "x-org-source-file", "")
    coll = collection or _text(todo, "x-org-collection", source)
    priority = _first_value(todo, "priority")
    percent_complete = _first_value(todo, "percent-complete")

    return Task(
        level=1,
        status="DONE" if status == "COMPLETED" else "TODO",
        content=_text(todo, "summary", "Untitled"),
        source_file=source,
        uid=_text(todo, "uid"),
        description=_text(todo, "description"),
        tags=_categories(todo),
        priority=int(priority) if priority is not None else None,
        scheduled=_first_value(todo, "dtstart"),
        deadline=_first_value(todo, "due"),
        completed_at=parse_aware_datetime(_first_value(todo, "completed")),
        percent_complete=int(percent_complete) if percent_complete is not None else None,
        parent_uid=_text(todo, "related-to") or None,
        collection=coll,
        meta=meta or {},
    )
