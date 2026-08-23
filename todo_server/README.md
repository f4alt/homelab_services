# Todo Sync Server

Bridge for syncing local orgmode todo files to devices through CalDAV VTODO.

The app watches local `.org` files, maps each file to one [Radicale](https://radicale.org/) backed CalDAV task collection, and exposes a small JSON API for programmatic updates. Radicale handles the CalDAV protocol; this repo handles org parsing, task identity, sync state, and API reads/updates.

## How It Fits Together

- `todo_sync/org_files.py`: scans `.org` files, parses TODO/DONE headings, writes `CALDAV_UID` property drawers, and preserves local notes where possible.
- `todo_sync/vtodo.py`: converts between internal tasks and iCalendar `VTODO`.
- `todo_sync/caldav_client.py`: talks to Radicale over CalDAV HTTP methods.
- `todo_sync/sync.py`: compares local hashes, remote hashes, ETags, and tombstones to decide what to push or pull.
- `todo_sync/api.py`: serves `/health`, `/tasks`, `/time-since`, `/sync`, and `/tasks/update`.
- `radicale/`: local Radicale config, users file, and a staging directory for externally managed TLS certificates.

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
`RADICALE_CERT_HOST_PATH` must contain externally managed `cert.pem` and
`key.pem` files before Radicale starts. Both files must be readable by the
unprivileged Radicale container user; the caller or certificate manager must
set suitable ownership, permissions, and host security labels. For example:

```sh
RADICALE_CERT_HOST_PATH=/etc/caddy/radicale docker compose up -d --build
```

Services:

- `todo_api`: dashboard/API server on port `5000`.
- `todo_sync_worker`: periodic org ↔ CalDAV sync loop.
- `radicale`: HTTPS CalDAV server on port `5232`.

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
- `CALDAV_VERIFY_SSL`: bridge certificate verification, default `false` for the internal Radicale service connection.
- `CALDAV_COLLECTION_PREFIX`: optional prefix for generated collection names.
- `TODO_FILES_HOST_PATH`: host directory mounted at `/data/todo_files`, default `../todo_files`.
- `API_HOST_PORT`: host port published to the API container's port `5000`, default `5000`.
- `RADICALE_HOST_PORT`: host port published to the Radicale container's port `5232`, default `5232`.
- `RADICALE_CONFIG_HOST_PATH`: host Radicale config file mounted at `/config/config`, default `./radicale/config`.
- `RADICALE_USERS_HOST_PATH`: host Radicale users file mounted at `/config/users`, default `./radicale/users`.
- `RADICALE_CERT_HOST_PATH`: host certificate directory mounted read-only at `/config/certs`, default `./radicale/generated-certs`. A caller or external certificate manager must provide `cert.pem` and `key.pem` here unless `RADICALE_CONFIG_HOST_PATH` points at a config with different filenames.
- `API_PORT`: local non-Docker API port, default `5000`; Docker Compose host publishing uses `API_HOST_PORT`.

Credential coupling: Radicale reads users from `radicale/users`, while the bridge reads `CALDAV_USERNAME` and `CALDAV_PASSWORD`. If you change credentials, update both.

TLS coupling: clients connect to the host IP and `RADICALE_HOST_PORT`, while containers connect to `https://radicale:5232/`. The bridge disables TLS verification by default. The caller or certificate manager is responsible for issuing, renewing, and installing a certificate that clients trust.

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

### Time-since tracking

Add an empty `TIME_SINCE` property to opt a heading into time-since tracking. An optional positive-integer target provides presentation guidance without creating a due date or schedule:

```org
* TODO Change the AC filter
:PROPERTIES:
:CALDAV_UID: 3a0f...
:TIME_SINCE:
:TIME_SINCE_TARGET_DAYS: 30
:END:
```

After an explicit completion, the server records the latest completion at second precision in UTC and immediately reopens the same task:

```org
:TIME_SINCE: 2026-08-08T19:30:00Z
```

`TIME_SINCE` presence is the sole opt-in. Removing that property opts the heading out, even if `TIME_SINCE_TARGET_DAYS` remains. Empty or malformed timestamps remain tracked but project without a last-completed time. Missing, malformed, fractional, zero, or negative target values project without a target.

For a tracked task, `DONE` is an input event rather than a lasting state. Explicit `DONE` from Org, `STATUS:COMPLETED` from CalDAV, and `POST /tasks/update` record the newest completion and settle the task back to `TODO` with the same UID. `PERCENT-COMPLETE:100` alone is not a completion event. The sync worker polls, so direct Org and CalDAV changes are eventually consistent within the configured polling interval.

## API

- `GET /health`: health check.
- `GET /tasks`: list local tasks from all org files.
- `GET /time-since`: list the compact time-since projection.
- `POST /sync`: run sync immediately.
- `POST /tasks/update`: update local task status by CalDAV UID.

Time-since response:

```json
{
  "items": [
    {
      "uid": "3a0f...",
      "name": "Change the AC filter",
      "source_file": "homelab.org",
      "last_done": "2026-08-08T19:30:00Z",
      "target_days": 30
    }
  ]
}
```

`last_done` and `target_days` are nullable. The endpoint returns source facts and does not calculate elapsed days or urgency.

Update payload:

```json
{
  "uid": "task-caldav-uid",
  "status": "DONE"
}
```

Sending `DONE` through this existing update route resets the time-since clock for a tracked task. The response contains the task already settled back to `TODO`.

## Sync Notes

The sync state file stores local hashes, remote hashes, ETags, deletion tombstones, and remote-completion retry mechanics. This lets the bridge distinguish real remote changes from harmless ETag churn and consume a timestamp-less completion only once. The file is rewritten only after a material state change, through an atomic sibling-file replacement; no-op polling cycles leave it untouched.

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
todo-sync --env-file .env sync --watch
```

Watch mode reconciles every 15 minutes by default. Use `--interval` to choose a
different positive number of seconds for an interactive or custom deployment.
