import unittest
from datetime import date, datetime, timezone

from todo_sync.models import Task
from todo_sync.vtodo import task_from_ical, task_to_ical


class VTodoTest(unittest.TestCase):
    def test_round_trips_rich_fields(self):
        task = Task(
            level=2,
            status="DONE",
            content="Pay bill",
            source_file="home.org",
            uid="fixed",
            description="A note",
            tags=["money", "home"],
            priority=1,
            scheduled=date(2026, 6, 8),
            deadline=date(2026, 6, 9),
            completed_at=datetime(2026, 6, 10, tzinfo=timezone.utc),
            percent_complete=100,
            parent_uid="parent",
            collection="home",
        )

        parsed = task_from_ical(task_to_ical(task), source_file="home.org", collection="home")

        self.assertEqual(parsed.uid, "fixed")
        self.assertEqual(parsed.status, "DONE")
        self.assertEqual(parsed.content, "Pay bill")
        self.assertEqual(parsed.description, "A note")
        self.assertEqual(parsed.tags, ["money", "home"])
        self.assertEqual(parsed.priority, 1)
        self.assertEqual(parsed.scheduled.isoformat(), "2026-06-08")
        self.assertEqual(parsed.deadline.isoformat(), "2026-06-09")
        self.assertEqual(parsed.percent_complete, 100)
        self.assertEqual(parsed.parent_uid, "parent")


if __name__ == "__main__":
    unittest.main()
