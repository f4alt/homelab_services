# Homelab Dashboard

A Compose-first dashboard platform for an office/homelab display. The goal is a
stable shell where widgets and their Gateway routes can be added without
reshaping the underlying build, config, or API contracts.

## Running

The supported build and run entry point is Docker Compose:

```sh
docker compose up --build
```

For detached mode:

```sh
docker compose up --build -d
```

The dashboard is served by Nginx at `http://localhost:8080` by default. Gateway
is the single internal backend service on the Compose network.

The frontend targets browsers with the HTML Popover API and CSS Anchor
Positioning. Older browsers retain usable in-flow popups, but the supported
baseline is required for popups to escape scrolling widget containers.

## Project Shape

| Path | Purpose |
| --- | --- |
| `dashboard/config.js` | Sanitized, tracked dashboard config. |
| `dashboard/config.local.js` | Ignored live config selected with `DASHBOARD_CONFIG_PATH`. |
| `dashboard/platform/` | Dashboard shell, shared CSS, helpers, and config validation. |
| `dashboard/widgets/` | Frontend widget implementations. |
| `gateway/gateway.js` | Express app setup and route mounting surface. |
| `gateway/widget-routes/` | Backend companion routes for widgets. |
| `gateway/platform/` | Gateway env parsing, response helpers, and platform-owned routes. |
| `nginx/` | Static serving and `/api` reverse proxy config. |
| `tests/` | Smoke and validation checks. |

## Configuration

Use `.env` or shell environment variables for infrastructure knobs and secrets.
The tracked `dashboard/config.js` is a safe, runnable default. For live local
values, copy it to the ignored `dashboard/config.local.js` and select that file
from `.env`:

```sh
cp dashboard/config.js dashboard/config.local.js
```

```dotenv
DASHBOARD_CONFIG_PATH=./dashboard/config.local.js
```

Both Nginx and Gateway mount the selected file as `config.js`, so the browser
config editor continues to read and save the active configuration.

Important environment knobs are documented in `.env.example`, including:

- `DASHBOARD_HTTP_PORT`
- `DASHBOARD_CONFIG_PATH`
- `GATEWAY_UPSTREAM_TIMEOUT_MS`
- `HOME_ASSISTANT_BASE_URL`
- `HOME_ASSISTANT_TOKEN`
- `TODO_API_BASE_URL`
- `STATUS_PROBE_TIMEOUT_MS`
- `STATUS_PROBE_MAX_TARGETS`
- `STATUS_PROBE_CONCURRENCY`
- `STATUS_PROBE_ALLOWED_HOSTS`
- `NETSTATS_PING_TARGET`

Status checks treat exact `localhost`, `127.0.0.1`, and `::1` targets as ports
published by the Docker host while preserving those browser-facing URLs. Add
LAN or external hosts and patterns to `STATUS_PROBE_ALLOWED_HOSTS` only when a
widget needs them.

Gateway uses the fixed internal Compose port `3000`. It is not published on the
host; only Nginx's `DASHBOARD_HTTP_PORT` is host-facing. Gateway also runs the
ping and speed-test commands behind `/api/net/*`; those routes report network
behavior, not container health.

Runtime config files are served with `Cache-Control: no-store` so office tuning
does not get stuck behind browser cache.

The `time-since` widget uses the non-secret `props.approachingRatio` display
setting to choose when a tracked activity changes from its normal age color to
the warning color. Values must be greater than `0` and no more than `1`; the
widget defaults invalid values to `0.8`.

Set the `netstats` widget's `props.startPaused` option to `true` to show the
latency graph in its paused state without gathering latency samples until it is
resumed. Public IP refreshes and manually started speed tests remain available.

### Browser Config Editor

For quick config edits, open `/config`. Nginx directly serves the lightweight
`config.js` editor at that canonical short route; there is no `/editor` alias.
The editor intentionally has no authentication or other access protections, so
do not expose it outside a trusted network.

## API Contract

JSON Gateway routes use this response envelope:

```json
{
  "ok": true,
  "data": {},
  "error": null
}
```

Failures use:

```json
{
  "ok": false,
  "data": null,
  "error": {
    "code": "validation_error",
    "message": "Human-readable message"
  }
}
```

Current Gateway routes include:

- `GET /api/config`
- `PUT /api/config`
- `GET /api/calendar/events`
- `GET /api/metar`
- `GET /api/net/myip`
- `GET /api/net/ping`
- `GET /api/net/speedtest`
- `POST /api/statuschecks`
- `GET /api/system-health`
- `POST /api/home-assistant/actions`
- `GET /api/todos/health`
- `GET /api/todos/tasks`
- `GET /api/todos/time-since`
- `POST /api/todos/sync`
- `POST /api/todos/tasks/update`

`GET /api/config` is the intentional exception: it returns the raw JavaScript
configuration source so the editor and static config script can use the same
representation.

Widget-domain companions—including status, netstats, METAR, and todos—live in
`gateway/widget-routes/` and use the same envelope as platform-owned routes.

The `calendar` widget reads one public iCalendar subscription from
`props.feedUrl`. The Gateway validates and pins public DNS destinations,
revalidates redirects, bounds downloads and recurrence expansion, and returns
only normalized event titles and times. Add the feed to the ignored local
configuration; private and credential-bearing feeds are not supported.

The `home-assistant` widget keeps its long-lived access token in the Gateway's
`HOME_ASSISTANT_TOKEN` environment variable. Its configured buttons accept only
relative `/api/services/script/dashboard_*` action paths; expose only dedicated,
low-consequence Home Assistant scripts that use the reserved `dashboard_`
script ID prefix.

The `system-health` widget reads CPU, memory, disk, temperature, and uptime from
the Linux data already visible to the Gateway container. Its compact strip uses
the normal neutral surface when readings are healthy and adds a warning or error
border only when host telemetry needs attention.

The dedicated `time-since` widget shows tracked Todo activities in backend
order, provides local source-file filtering, colors only the elapsed-day value
as a target approaches or passes, and records a completion through the existing
Todo update route when that clickable value is selected.

## Adding a Widget

See [adding-a-widget.md](adding-a-widget.md) for the expected extension points,
frontend lifecycle, shared UI and Gateway conventions, test checklist, and the
existing widgets that deliberately differ from the preferred pattern.

Dashboard config is validated before widgets load. `PUT /api/config` also
validates submitted source before replacing `config.js`; malformed or invalid
source is rejected without changing the saved config.

## Validation

Run these after platform changes:

```sh
node tests/validate-dashboard-config.mjs
node --test tests/*.test.mjs
docker compose config
docker compose up --build
```

In another terminal:

```sh
node tests/smoke.mjs
```

The smoke script saves the currently active config source through the editor
API to verify the complete write path. The contents are unchanged, but file
metadata may be updated.

## Deferred Widget Work

Remaining widget work is feature-specific:

- Tune the live widget list and layout in the selected local config as office
  needs evolve.
- Add focused tests for widget-specific data parsing as each widget becomes more
  important.
