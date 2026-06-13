# Todo Sync Server

Bridge for syncing local orgmode todo files to devices through CalDAV VTODO.

The app watches local `.org` files, maps each file to one [Radicale](https://radicale.org/) backed CalDAV task collection, and exposes a small JSON API for programatic updates. Radicale handles the CalDAV protocol; this repo handles org parsing, task identity, sync state, and API reads/updates.

## How It Fits Together

- `todo_sync/org_files.py`: scans `.org` files, parses TODO/DONE headings, writes `CALDAV_UID` property drawers, and preserves local notes where possible.
- `todo_sync/vtodo.py`: converts between internal tasks and iCalendar `VTODO`.
- `todo_sync/caldav_client.py`: talks to Radicale over CalDAV HTTP methods.
- `todo_sync/sync.py`: compares local hashes, remote hashes, ETags, and tombstones to decide what to push or pull.
- `todo_sync/api.py`: serves `/health`, `/tasks`, `/sync`, and `/tasks/update`.
- `radicale/`: local Radicale config, users file, and generated self-signed TLS certificate.

## Running

Create or edit `.env` to override defaults:

```sh
cp example.env .env
```

Docker compose handles the stack:

```sh
TODO_FILES_HOST_PATH=/path/to/org/files docker compose up -d --build
```

If `TODO_FILES_HOST_PATH` is omitted, Compose mounts `../todo_files`.

Services:

- `todo_api`: dashboard/API server on port `5000`.
- `todo_sync_worker`: periodic org ↔ CalDAV sync loop.
- `radicale`: HTTPS CalDAV server on port `5232`.
  - `radicale_cert`: helper service for managing automatic SSL certificates.

Useful commands:

```sh
# view docker's running containers
docker compose ps
# view logs
docker compose logs -f radicale todo_sync_worker
# manually sync todos
docker compose exec todo_api todo-sync sync
# manually restart radicale for cert updates
docker compose restart radicale
```

## CalDAV Setup

Default CalDAV URL:

```text
https://<host-lan-ip>:5232/todo/
```

Default credentials:

```text
username: todo
password: todo
```

Radicale also has a browser UI:

```text
https://<host-lan-ip>:5232/
```

## Configuration

Common settings:

- `TODO_DIRECTORY`: container path containing org files, default `/data/todo_files`.
- `SYNC_STATE_FILE`: sync state/tombstone JSON, default `/data/todo_files/.todo-sync-state.json`.
- `CALDAV_URL`: bridge-to-Radicale URL, default `https://radicale:5232/`.
- `CALDAV_USERNAME`: CalDAV username, default `todo`.
- `CALDAV_PASSWORD`: CalDAV password, default `todo`.
- `CALDAV_VERIFY_SSL`: bridge certificate verification, default `false` for the bundled self-signed cert.
- `CALDAV_COLLECTION_PREFIX`: optional prefix for generated collection names.
- `API_PORT`: API port, default `5000`.
- `RADICALE_CERT_DAYS`: generated certificate lifetime, default `825`.
- `RADICALE_CERT_RENEW_BEFORE_DAYS`: regenerate when fewer than this many days remain, default `30`.
- `RADICALE_CERT_CHECK_INTERVAL_SECONDS`: how often the helper checks for IP/expiry drift while the stack is running, default `172800`.
- `RADICALE_CERT_COMMON_NAME`: certificate common name, default `radicale.local`.
- `RADICALE_CERT_EXTRA_SANS`: comma-separated extra certificate SANs, such as `IP:192.168.1.25,DNS:todo.local`.

Credential coupling: Radicale reads users from `radicale/users`, while the bridge reads `CALDAV_USERNAME` and `CALDAV_PASSWORD`. If you change credentials, update both.

TLS coupling: clients connect to the host IP, while containers connect to `https://radicale:5232/`. The bridge disables TLS verification by default, but phones generally need the generated self-signed certificate installed and trusted.

## Org Behavior

Supported heading shape:

```org
* TODO [#A] Pay bill [50%] :money:home:
:PROPERTIES:
:CALDAV_UID: 3a0f...
:END:
SCHEDULED: <2026-06-08> DEADLINE: <2026-06-09>
Notes become VTODO DESCRIPTION.
```

Synced fields:

- heading text ↔ `SUMMARY`
- `TODO` / `DONE` ↔ VTODO status
- `CALDAV_UID` ↔ VTODO `UID`
- notes below planning lines ↔ `DESCRIPTION`
- org tags ↔ `CATEGORIES`
- `[#A]`, `[#B]`, `[#C]` ↔ VTODO priority
- `SCHEDULED` ↔ `DTSTART`
- `DEADLINE` ↔ `DUE`
- `[N%]` ↔ `PERCENT-COMPLETE`
- nested TODO headings ↔ `RELATED-TO`

## API

- `GET /health`: health check.
- `GET /tasks`: list local tasks from all org files.
- `GET|POST /sync`: run sync immediately.
- `POST /tasks/update`: update local task status.

Preferred update payload:

```json
{
  "uid": "task-caldav-uid",
  "status": "DONE"
}
```

Legacy content/source updates still work when unambiguous:

```json
{
  "content": "Pay bill",
  "source_file": "home.org",
  "status": "DONE"
}
```

## Sync Notes

The sync state file stores local hashes, remote hashes, ETags, and deletion tombstones. This lets the bridge distinguish real remote changes from harmless ETag churn.

Conflict policy:

- local-only changes are pushed to CalDAV
- remote-only changes are pulled into org files
- real simultaneous local and remote edits use server-wins behavior
- local and remote deletes are tombstoned to avoid accidental recreation

Known instability: some clients may represent “reopen completed task” as delete-and-create instead of changing the same VTODO UID. The bridge preserves UID when org files or CalDAV clients keep the UID stable, but it cannot infer identity if a client creates a brand-new VTODO UID for the reopened item.

## Local Development

Install and run tests:

```sh
pip install -e .
python -m unittest discover -s tests
```

Run without Docker if Radicale is already available:

```sh
todo-sync --env-file .env sync
todo-sync --env-file .env serve
todo-sync --env-file .env sync --watch --interval 300
```
