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

    def test_local_time_since_properties_are_not_serialized_to_vtodo(self):
        task = Task(
            level=1,
            status="TODO",
            content="Change filter",
            source_file="home.org",
            uid="fixed",
            source_properties={
                "CALDAV_UID": "fixed",
                "TIME_SINCE": "2026-08-08T19:30:00Z",
                "TIME_SINCE_TARGET_DAYS": "30",
            },
        )

        serialized = task_to_ical(task)

        self.assertNotIn("TIME_SINCE", serialized)

    def test_invalid_completed_values_are_treated_as_missing(self):
        invalid_properties = [
            "COMPLETED:20260808T193000",
            "COMPLETED;VALUE=DATE:20260808",
            "COMPLETED:not-a-timestamp",
        ]
        calendar_template = (
            "BEGIN:VCALENDAR\n"
            "VERSION:2.0\n"
            "BEGIN:VTODO\n"
            "UID:fixed\n"
            "SUMMARY:Change filter\n"
            "STATUS:COMPLETED\n"
            "{completed_property}\n"
            "END:VTODO\n"
            "END:VCALENDAR\n"
        )

        for completed_property in invalid_properties:
            with self.subTest(completed_property=completed_property):
                task = task_from_ical(
                    calendar_template.format(completed_property=completed_property),
                    source_file="home.org",
                    collection="home",
                )

                self.assertEqual(task.status, "DONE")
                self.assertIsNone(task.completed_at)


if __name__ == "__main__":
    unittest.main()
