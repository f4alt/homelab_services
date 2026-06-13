from __future__ import annotations

import os
import re
import threading
import uuid
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path

from .models import Task


TODO_HEADING_RE = re.compile(
    r"^(?P<stars>\*+)\s+(?P<status>TODO|DONE)\s+"
    r"(?:(?P<priority>\[#([A-C])\])\s+)?"
    r"(?P<title>.*?)(?:\s+:(?P<tags>[A-Za-z0-9_@#%:.-]+):)?\s*$"
)
ANY_HEADING_RE = re.compile(r"^(?P<stars>\*+)\s+")
PROPERTY_RE = re.compile(r"^\s*:(?P<key>[A-Z0-9_]+):\s*(?P<value>.*?)\s*$")
PLANNING_RE = re.compile(r"(SCHEDULED|DEADLINE):\s*<([^>]+)>")
PERCENT_RE = re.compile(r"\[(?P<percent>\d{1,3})%\]")


ORG_PRIORITY_TO_VTODO = {"A": 1, "B": 5, "C": 9}
VTODO_PRIORITY_TO_ORG = {1: "A", 5: "B", 9: "C"}


@dataclass
class TaskBlock:
    task: Task
    start: int
    end: int
    properties_start: int | None = None
    properties_end: int | None = None
    planning_end: int | None = None
    has_completed_property: bool = False


def collection_slug(relative_path):
    stem = str(relative_path).replace("\\", "/")
    stem = re.sub(r"\.org$", "", stem)
    slug = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-").lower()
    return slug or "todos"


def parse_org_date(value):
    value = value.split()[0]
    parsed = datetime.strptime(value, "%Y-%m-%d").date()
    return parsed


def format_org_date(value):
    if value is None:
        return None
    if isinstance(value, datetime):
        value = value.date()
    return f"<{value.isoformat()}>"


def split_title_and_tags(title):
    match = re.match(r"^(?P<title>.*?)(?:\s+:(?P<tags>[A-Za-z0-9_@#%:.-]+):)?\s*$", title)
    if not match:
        return title.strip(), []
    tags = [tag for tag in (match.group("tags") or "").split(":") if tag]
    return match.group("title").strip(), tags


class TodoFile:
    def __init__(self, fullpath, relative_path=None):
        self.fullpath = Path(fullpath)
        self.relative_path = relative_path or self.fullpath.name
        self.collection = collection_slug(self.relative_path)
        self.tasks = {}
        self.blocks = {}
        self.lock = threading.Lock()
        self._load_tasks_from_file()

    def _ensure_file(self):
        self.fullpath.parent.mkdir(parents=True, exist_ok=True)
        self.fullpath.touch(exist_ok=True)

    def _read_lines(self):
        self._ensure_file()
        return self.fullpath.read_text(encoding="utf-8").splitlines(keepends=True)

    def _write_lines(self, lines):
        self.fullpath.write_text("".join(lines), encoding="utf-8")

    def _load_tasks_from_file(self, ensure_uids=False):
        lines = self._read_lines()
        blocks = self._parse_blocks(lines)
        if ensure_uids:
            changed = False
            for block in blocks:
                if block.task.uid is None:
                    block.task.uid = str(uuid.uuid4())
                    changed = True
                if block.task.status == "TODO" and block.has_completed_property:
                    changed = True
            if changed:
                lines = self._render_blocks_into_lines(lines, blocks)
                self._write_lines(lines)
                blocks = self._parse_blocks(lines)

        self.tasks = {block.task.uid: [block.task, block.start] for block in blocks if block.task.uid}
        self.blocks = {block.task.uid: block for block in blocks if block.task.uid}
        return blocks

    def _parse_blocks(self, lines):
        heading_indexes = []
        for index, line in enumerate(lines):
            match = TODO_HEADING_RE.match(line.rstrip("\n"))
            if match:
                heading_indexes.append((index, len(match.group("stars")), match))

        blocks = []
        parent_stack = []
        for position, (start, level, match) in enumerate(heading_indexes):
            end = heading_indexes[position + 1][0] if position + 1 < len(heading_indexes) else len(lines)

            while parent_stack and parent_stack[-1][0] >= level:
                parent_stack.pop()
            parent_uid = parent_stack[-1][1] if parent_stack else None

            block = self._parse_block(lines, start, end, match, parent_uid)
            blocks.append(block)
            if block.task.uid:
                parent_stack.append((level, block.task.uid))

        return blocks

    def _parse_block(self, lines, start, end, match, parent_uid):
        properties = {}
        properties_start = None
        properties_end = None
        cursor = start + 1
        if cursor < end and lines[cursor].strip() == ":PROPERTIES:":
            properties_start = cursor
            cursor += 1
            while cursor < end:
                if lines[cursor].strip() == ":END:":
                    properties_end = cursor
                    cursor += 1
                    break
                prop_match = PROPERTY_RE.match(lines[cursor].rstrip("\n"))
                if prop_match:
                    properties[prop_match.group("key")] = prop_match.group("value")
                cursor += 1

        scheduled = None
        deadline = None
        planning_end = cursor
        while planning_end < end:
            stripped = lines[planning_end].strip()
            if not stripped:
                planning_end += 1
                continue
            found = list(PLANNING_RE.finditer(stripped))
            if not found:
                break
            for planning_match in found:
                parsed = parse_org_date(planning_match.group(2))
                if planning_match.group(1) == "SCHEDULED":
                    scheduled = parsed
                else:
                    deadline = parsed
            planning_end += 1

        description_lines = []
        for line in lines[planning_end:end]:
            if ANY_HEADING_RE.match(line):
                break
            description_lines.append(line.rstrip("\n"))
        description = "\n".join(description_lines).strip()

        priority_letter = match.group(4)
        content, tags = split_title_and_tags(match.group("title"))
        if match.group("tags"):
            tags = [tag for tag in match.group("tags").split(":") if tag]
        percent_match = PERCENT_RE.search(content)
        percent_complete = None
        if percent_match:
            percent_complete = int(percent_match.group("percent"))

        completed_at = None
        completed_value = properties.get("CALDAV_COMPLETED")
        if completed_value and match.group("status") == "DONE":
            completed_at = datetime.fromisoformat(completed_value)

        task = Task(
            level=len(match.group("stars")),
            status=match.group("status"),
            content=content,
            source_file=self.relative_path,
            uid=properties.get("CALDAV_UID"),
            description=description,
            tags=tags,
            priority=ORG_PRIORITY_TO_VTODO.get(priority_letter),
            scheduled=scheduled,
            deadline=deadline,
            completed_at=completed_at,
            percent_complete=percent_complete,
            parent_uid=properties.get("CALDAV_PARENT_UID") or parent_uid,
            collection=self.collection,
        )
        return TaskBlock(
            task,
            start,
            end,
            properties_start,
            properties_end,
            planning_end,
            "CALDAV_COMPLETED" in properties,
        )

    def _render_blocks_into_lines(self, lines, blocks):
        rendered = []
        cursor = 0
        for block in blocks:
            rendered.extend(lines[cursor : block.start])
            rendered.extend(self._render_task_block(block.task))
            cursor = block.end
        rendered.extend(lines[cursor:])
        return rendered

    def _render_task_block(self, task):
        stars = "*" * task.level
        priority = ""
        if task.priority is not None:
            priority = f" [#{VTODO_PRIORITY_TO_ORG.get(task.priority, 'B')}]"
        tags = f" :{':'.join(task.tags)}:" if task.tags else ""
        lines = [f"{stars} {task.status}{priority} {task.content}{tags}\n"]

        properties = {"CALDAV_UID": task.uid or str(uuid.uuid4())}
        if task.parent_uid:
            properties["CALDAV_PARENT_UID"] = task.parent_uid
        if task.completed_at:
            properties["CALDAV_COMPLETED"] = task.completed_at.isoformat()
        lines.append(":PROPERTIES:\n")
        for key, value in properties.items():
            lines.append(f":{key}: {value}\n")
        lines.append(":END:\n")

        planning = []
        scheduled = format_org_date(task.scheduled)
        deadline = format_org_date(task.deadline)
        if scheduled:
            planning.append(f"SCHEDULED: {scheduled}")
        if deadline:
            planning.append(f"DEADLINE: {deadline}")
        if planning:
            lines.append(" ".join(planning) + "\n")
        if task.description:
            lines.extend(f"{line}\n" for line in task.description.splitlines())
        return lines

    def get_tasks(self, ensure_uids=True):
        return [block.task for block in self._load_tasks_from_file(ensure_uids=ensure_uids)]

    def find_task(self, content=None, source_file=None, uid=None):
        for task in self.get_tasks():
            if uid and task.uid == uid:
                return task
            if content and task.content == content and (source_file is None or task.source_file == source_file):
                return task
        return None

    def update(self, tasks, allow_reopen=False):
        with self.lock:
            blocks = self._load_tasks_from_file(ensure_uids=True)
            lines = self._read_lines()
            by_uid = {block.task.uid: block for block in blocks if block.task.uid}
            changed = False

            relevant = [
                task
                for task in tasks
                if task.source_file in {self.relative_path, "ANY"} or task.collection == self.collection
            ]
            for task in relevant:
                if not task.uid:
                    continue
                current = by_uid.get(task.uid)
                if current is None:
                    changed = True
                    appended = task.copy_with(source_file=self.relative_path, collection=self.collection)
                    start = len(lines)
                    rendered = self._render_task_block(appended)
                    lines.extend(rendered)
                    by_uid[appended.uid] = TaskBlock(appended, start, start + len(rendered))
                    continue

                if task.status != current.task.status and not (task.status == "DONE" or allow_reopen):
                    continue
                replacement = self._merge_task_update(current.task, task)
                if replacement.normalized_dict() != current.task.normalized_dict():
                    changed = True
                    current.task = replacement

            if changed:
                blocks = list(by_uid.values())
                lines = self._render_blocks_into_lines(lines, blocks)
                self._write_lines(lines)

    def delete(self, uid):
        with self.lock:
            blocks = self._load_tasks_from_file(ensure_uids=True)
            lines = self._read_lines()
            block = next((item for item in blocks if item.task.uid == uid), None)
            if block is None:
                return False
            del lines[block.start : block.end]
            self._write_lines(lines)
            return True

    def _merge_task_update(self, current, incoming):
        replace = incoming.meta.get("replace", False)
        if replace:
            return incoming.copy_with(source_file=self.relative_path, collection=self.collection)
        completed_at = incoming.completed_at if incoming.completed_at is not None else current.completed_at
        percent_complete = incoming.percent_complete if incoming.percent_complete is not None else current.percent_complete
        if incoming.status == "TODO":
            completed_at = None
            percent_complete = None
        return current.copy_with(
            status=incoming.status,
            content=incoming.content or current.content,
            uid=incoming.uid or current.uid,
            description=incoming.description or current.description,
            tags=list(incoming.tags) or list(current.tags),
            priority=incoming.priority if incoming.priority is not None else current.priority,
            scheduled=incoming.scheduled if incoming.scheduled is not None else current.scheduled,
            deadline=incoming.deadline if incoming.deadline is not None else current.deadline,
            completed_at=completed_at,
            percent_complete=percent_complete,
            parent_uid=incoming.parent_uid or current.parent_uid,
            source_file=self.relative_path,
            collection=self.collection,
        )


class LocalFiles:
    TODO_EXTENSION = ".org"

    def __init__(self, directory):
        self.directory = Path(directory)
        self.files = {}
        self._scan_todo_files()

    def _scan_todo_files(self):
        self.directory.mkdir(parents=True, exist_ok=True)
        self.files = {}

        for root, _dirs, files in os.walk(self.directory):
            for filename in files:
                if not filename.endswith(self.TODO_EXTENSION):
                    continue

                file_path = Path(root) / filename
                relative_path = str(file_path.relative_to(self.directory))
                self.files[relative_path] = TodoFile(file_path, relative_path)

    def get_tasks(self, ensure_uids=True):
        self._scan_todo_files()
        tasks = []
        for todo_file in self.files.values():
            tasks.extend(todo_file.get_tasks(ensure_uids=ensure_uids))
        return tasks

    def get_tasks_by_file(self, ensure_uids=True):
        self._scan_todo_files()
        return {
            relative_path: todo_file.get_tasks(ensure_uids=ensure_uids)
            for relative_path, todo_file in self.files.items()
        }

    def find_task(self, content=None, source_file=None, uid=None):
        self._scan_todo_files()
        matches = []
        for todo_file in self.files.values():
            task = todo_file.find_task(content=content, source_file=source_file, uid=uid)
            if task is not None:
                matches.append(task)

        if uid:
            return matches[0] if matches else None
        if len(matches) == 1:
            return matches[0]
        return None

    def update(self, tasks, allow_reopen=False):
        self._scan_todo_files()
        tasks_by_file = {}
        for task in tasks:
            if task.source_file == "ANY":
                for todo_file in self.files.values():
                    tasks_by_file.setdefault(todo_file.relative_path, []).append(task)
                continue

            tasks_by_file.setdefault(task.source_file, []).append(task)

        for relative_path, grouped_tasks in tasks_by_file.items():
            todo_file = self.files.get(relative_path)
            if todo_file is None:
                fullpath = self.directory / relative_path
                todo_file = TodoFile(fullpath, relative_path)
                self.files[relative_path] = todo_file
            todo_file.update(grouped_tasks, allow_reopen=allow_reopen)

    def delete(self, source_file, uid):
        self._scan_todo_files()
        todo_file = self.files.get(source_file)
        if todo_file is None:
            return False
        return todo_file.delete(uid)
