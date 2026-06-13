import argparse
import time
import traceback

from .config import Settings
from .sync import SyncService


def run_sync(args):
    settings = Settings.from_env(args.env_file)
    service = SyncService(settings)

    while True:
        try:
            result = service.run_once()
            print(f"Synced {result.task_count} todos [{result.synced_at.isoformat()}]", flush=True)
        except Exception:
            if not args.watch:
                raise
            print("Sync failed; retrying after interval.", flush=True)
            traceback.print_exc()
        if not args.watch:
            return
        time.sleep(args.interval)


def run_server(args):
    from .api import create_app

    settings = Settings.from_env(args.env_file)
    app = create_app(settings)
    app.run(host=settings.api_host, port=settings.api_port, debug=args.debug)


def build_parser():
    parser = argparse.ArgumentParser(description="Sync local org todo files with CalDAV VTODO.")
    parser.add_argument("--env-file", help="Path to a dotenv file to load before reading config.")

    subparsers = parser.add_subparsers(dest="command", required=True)

    sync_parser = subparsers.add_parser("sync", help="Run one sync cycle.")
    sync_parser.add_argument("--watch", action="store_true", help="Run sync repeatedly.")
    sync_parser.add_argument("--interval", type=int, default=300, help="Seconds between syncs in watch mode.")
    sync_parser.set_defaults(func=run_sync)

    server_parser = subparsers.add_parser("serve", help="Run the HTTP API.")
    server_parser.add_argument("--debug", action="store_true", help="Enable Flask debug mode.")
    server_parser.set_defaults(func=run_server)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    args.func(args)


if __name__ == "__main__":
    main()
