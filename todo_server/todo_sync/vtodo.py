from __future__ import annotations

from datetime import date, datetime, timezone

from .models import Task

try:
    from icalendar import Calendar, Todo
except ImportError:  # pragma: no cover - fallback keeps local tests runnable before deps install
    Calendar = None
    Todo = None


def _escape(value):
    return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace(",", "\\,").replace(";", "\\;")


def _unescape(value):
    return value.replace("\\n", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def _format_ical_date(value):
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    if isinstance(value, date):
        return value.strftime("%Y%m%d")
    return str(value)


def _parse_ical_date(value):
    if not value:
        return None
    if value.endswith("Z"):
        return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
    if "T" in value:
        return datetime.strptime(value, "%Y%m%dT%H%M%S")
    return datetime.strptime(value, "%Y%m%d").date()


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


def _task_to_icalendar(task):
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


def _task_to_plain_ical(task):
    lines = [
        "BEGIN:VCALENDAR",
        "PRODID:-//todo-sync-server//caldav bridge//EN",
        "VERSION:2.0",
        "BEGIN:VTODO",
        f"UID:{_escape(task.uid)}",
        f"SUMMARY:{_escape(task.content)}",
        f"STATUS:{'COMPLETED' if task.status == 'DONE' else 'NEEDS-ACTION'}",
        f"LAST-MODIFIED:{_format_ical_date(datetime.now(timezone.utc))}",
    ]
    if task.description:
        lines.append(f"DESCRIPTION:{_escape(task.description)}")
    if task.tags:
        lines.append(f"CATEGORIES:{','.join(_escape(tag) for tag in task.tags)}")
    if task.priority is not None:
        lines.append(f"PRIORITY:{task.priority}")
    if task.scheduled is not None:
        lines.append(f"DTSTART:{_format_ical_date(task.scheduled)}")
    if task.deadline is not None:
        lines.append(f"DUE:{_format_ical_date(task.deadline)}")
    if task.completed_at is not None:
        lines.append(f"COMPLETED:{_format_ical_date(task.completed_at)}")
    elif task.status == "DONE":
        lines.append(f"COMPLETED:{_format_ical_date(datetime.now(timezone.utc))}")
    if task.percent_complete is not None:
        lines.append(f"PERCENT-COMPLETE:{task.percent_complete}")
    if task.parent_uid:
        lines.append(f"RELATED-TO:{_escape(task.parent_uid)}")
    if task.source_file:
        lines.append(f"X-ORG-SOURCE-FILE:{_escape(task.source_file)}")
    if task.collection:
        lines.append(f"X-ORG-COLLECTION:{_escape(task.collection)}")
    lines.extend(["END:VTODO", "END:VCALENDAR", ""])
    return "\r\n".join(lines)


def task_to_ical(task: Task):
    if Calendar is not None:
        return _task_to_icalendar(task)
    return _task_to_plain_ical(task)


def _task_from_icalendar(ical_data, source_file=None, collection=None, meta=None):
    calendar = Calendar.from_ical(ical_data)
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
        completed_at=_first_value(todo, "completed"),
        percent_complete=int(percent_complete) if percent_complete is not None else None,
        parent_uid=_text(todo, "related-to") or None,
        collection=coll,
        meta=meta or {},
    )


def _parse_plain_ical(ical_data):
    values = {}
    in_todo = False
    for raw_line in ical_data.replace("\r\n", "\n").split("\n"):
        line = raw_line.strip()
        if line == "BEGIN:VTODO":
            in_todo = True
            continue
        if line == "END:VTODO":
            break
        if not in_todo or ":" not in line:
            continue
        key, value = line.split(":", 1)
        values[key.upper().split(";", 1)[0]] = _unescape(value)
    return values


def _task_from_plain_ical(ical_data, source_file=None, collection=None, meta=None):
    values = _parse_plain_ical(ical_data)
    if not values:
        return None
    status = values.get("STATUS", "NEEDS-ACTION").upper()
    source = source_file or values.get("X-ORG-SOURCE-FILE", "")
    coll = collection or values.get("X-ORG-COLLECTION", source)
    return Task(
        level=1,
        status="DONE" if status == "COMPLETED" else "TODO",
        content=values.get("SUMMARY", "Untitled"),
        source_file=source,
        uid=values.get("UID"),
        description=values.get("DESCRIPTION", ""),
        tags=[tag for tag in values.get("CATEGORIES", "").split(",") if tag],
        priority=int(values["PRIORITY"]) if values.get("PRIORITY") else None,
        scheduled=_parse_ical_date(values.get("DTSTART")),
        deadline=_parse_ical_date(values.get("DUE")),
        completed_at=_parse_ical_date(values.get("COMPLETED")),
        percent_complete=int(values["PERCENT-COMPLETE"]) if values.get("PERCENT-COMPLETE") else None,
        parent_uid=values.get("RELATED-TO"),
        collection=coll,
        meta=meta or {},
    )


def task_from_ical(ical_data, source_file=None, collection=None, meta=None):
    if Calendar is not None:
        return _task_from_icalendar(ical_data, source_file=source_file, collection=collection, meta=meta)
    return _task_from_plain_ical(ical_data, source_file=source_file, collection=collection, meta=meta)
