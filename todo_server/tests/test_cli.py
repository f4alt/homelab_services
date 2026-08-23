import logging
import unittest
from datetime import datetime, timezone
from io import StringIO
from types import SimpleNamespace
from unittest.mock import patch

from todo_sync.cli import DEFAULT_SYNC_INTERVAL_SECONDS, build_parser, run_server, run_sync
from todo_sync.sync import SyncResult


class CliTest(unittest.TestCase):
    def test_watch_sync_defaults_to_fifteen_minutes(self):
        args = build_parser().parse_args(["sync", "--watch"])

        self.assertEqual(DEFAULT_SYNC_INTERVAL_SECONDS, 15 * 60)
        self.assertEqual(args.interval, DEFAULT_SYNC_INTERVAL_SECONDS)

    def test_watch_sync_rejects_non_positive_intervals(self):
        for interval in ("0", "-1"):
            with self.subTest(interval=interval):
                with patch("sys.stderr", new=StringIO()), self.assertRaises(SystemExit):
                    build_parser().parse_args(["sync", "--watch", "--interval", interval])

    def test_one_shot_sync_reports_success(self):
        result = SyncResult(task_count=2, synced_at=datetime(2026, 8, 23, tzinfo=timezone.utc))
        args = SimpleNamespace(env_file=None, watch=False)

        with (
            patch("todo_sync.cli.Settings.from_env"),
            patch("todo_sync.cli.SyncService") as service_type,
            patch("builtins.print") as print_mock,
        ):
            service_type.return_value.run_once.return_value = result
            run_sync(args)

        print_mock.assert_called_once_with(
            "Synced 2 todos [2026-08-23T00:00:00+00:00]",
            flush=True,
        )

    def test_watch_sync_does_not_log_successful_cycles(self):
        result = SyncResult(task_count=2, synced_at=datetime(2026, 8, 23, tzinfo=timezone.utc))
        args = SimpleNamespace(env_file=None, watch=True, interval=300)

        with (
            patch("todo_sync.cli.Settings.from_env"),
            patch("todo_sync.cli.SyncService") as service_type,
            patch("todo_sync.cli.time.sleep", side_effect=StopIteration),
            patch("builtins.print") as print_mock,
            self.assertRaises(StopIteration),
        ):
            service_type.return_value.run_once.return_value = result
            run_sync(args)

        print_mock.assert_not_called()

    def test_watch_sync_preserves_failure_diagnostics(self):
        args = SimpleNamespace(env_file=None, watch=True, interval=300)

        with (
            patch("todo_sync.cli.Settings.from_env"),
            patch("todo_sync.cli.SyncService") as service_type,
            patch("todo_sync.cli.time.sleep", side_effect=StopIteration),
            patch("todo_sync.cli.traceback.print_exc") as print_exception,
            patch("builtins.print") as print_mock,
            self.assertRaises(StopIteration),
        ):
            service_type.return_value.run_once.side_effect = RuntimeError("sync failed")
            run_sync(args)

        print_mock.assert_called_once_with("Sync failed; retrying after interval.", flush=True)
        print_exception.assert_called_once_with()

    def test_server_suppresses_routine_access_logs(self):
        args = SimpleNamespace(env_file=None, debug=False)

        with (
            patch("todo_sync.cli.logging.getLogger") as get_logger,
            patch("todo_sync.cli.Settings.from_env"),
            patch("todo_sync.api.create_app") as create_app,
        ):
            run_server(args)

        get_logger.assert_called_once_with("werkzeug")
        get_logger.return_value.setLevel.assert_called_once_with(logging.WARNING)
        create_app.return_value.run.assert_called_once()


if __name__ == "__main__":
    unittest.main()
