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
and Netstats are internal-only services on the Compose network.

## Project Shape

| Path | Purpose |
| --- | --- |
| `dashboard/config.js` | User-editable live dashboard config. |
| `dashboard/platform/` | Dashboard shell, shared CSS, helpers, and config validation. |
| `dashboard/widgets/` | Frontend widget implementations. |
| `gateway/gateway.js` | Express app setup and route mounting surface. |
| `gateway/widget-routes/` | Backend companion routes for widgets. |
| `gateway/platform/` | Gateway env parsing, response helpers, and platform-owned routes. |
| `netstats/` | Internal network diagnostics service. |
| `nginx/` | Static serving and `/api` reverse proxy config. |
| `tests/` | Smoke and validation checks. |

## Configuration

Use `.env` or shell environment variables for infrastructure knobs and secrets.
Use `dashboard/config.js` for the live non-secret dashboard layout. Keep real
local values out of git.

Important environment knobs are documented in `.env.example`, including:

- `DASHBOARD_HTTP_PORT`
- `GATEWAY_UPSTREAM_TIMEOUT_MS`
- `TODO_API_BASE_URL`
- `STATUS_PROBE_TIMEOUT_MS`
- `STATUS_PROBE_MAX_TARGETS`
- `STATUS_PROBE_CONCURRENCY`
- `STATUS_PROBE_ALLOWED_HOSTS`
- `NETSTATS_PING_TARGET`

The default status-probe allowlist is intentionally minimal: `localhost`. Add
LAN hosts or patterns locally only when a widget needs them.

Gateway and Netstats use fixed internal Compose ports, `3000` and `4000`. They
are not published on the host; only Nginx's `DASHBOARD_HTTP_PORT` is host-facing.

Runtime config files are served with `Cache-Control: no-store` so office tuning
does not get stuck behind browser cache.

### Browser Config Editor

For quick config edits, use `/config` route which should redirect to `localhost:8080/platform/config-editor.html`. This should open a simple config.js editor which can be used for editing. This intentionally is lightweight and has no authentication or protections; do not expose this outside a trusted network.

## API Contract

Platform-owned Gateway routes use this response envelope:

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

Current platform-owned routes include:

- `GET /api/health`
- `GET /api/config`
- `POST /api/config/validate`
- `PUT /api/config`
- `GET /api/net/myip`
- `GET /api/net/ping`
- `GET /api/net/speedtest`
- `POST /api/statuschecks`
- `GET /api/todos/health`
- `GET /api/todos/tasks`
- `POST /api/todos/sync`
- `POST /api/todos/tasks/update`

Mounted widget-domain routes such as METAR use the same envelope.

## Adding A Widget Later

The platform extension model is:

1. Add a frontend widget module at `dashboard/widgets/<type>.js`.
2. Register it with `window.DASH.registerWidget("<type>", impl)`.
3. Add any backend companion route module under `gateway/widget-routes/`.
4. Mount that route in `gateway/gateway.js`.
5. Enable the widget in `dashboard/config.js`.
6. Run validation and smoke checks.

Dashboard config is validated before widgets load. Widget declarations require a
unique `id`, a valid `type`, optional `width`, optional `refreshMs`, optional
object `props`.

Widget modules receive `mount(root, { id, type, props })` and may expose
an async `update(state)` method. Shared widget helpers live in
`dashboard/platform/global.js`; prefer those for API URLs, JSON fetches, common
tile layout, icons, state messages, and formatting before adding local helper
code.

If a widget import, mount, or update fails, the shell renders that failure in the
affected tile instead of breaking the entire dashboard.

## Validation

Run these after platform changes:

```sh
node tests/validate-dashboard-config.mjs
docker compose config
docker compose up --build
```

In another terminal:

```sh
node tests/smoke.mjs
```

## Deferred Widget Work

Remaining widget work is feature-specific:

- Tune the live widget list and layout in `dashboard/config.js` as office needs
  evolve.
- Add focused tests for widget-specific data parsing as each widget becomes more
  important.
