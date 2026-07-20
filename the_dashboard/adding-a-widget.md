# Adding a Widget

This guide defines the expected shape of a new dashboard widget. Its purpose is
to keep widget work local, make widgets look and behave like one product, and
prevent feature work from gradually reshaping the platform.

The default rule is:

> Add the frontend under `dashboard/widgets/`, add an optional backend companion
> under `gateway/widget-routes/`, and reuse the platform that already exists.

If a widget appears to require a new lifecycle, config schema, backend service,
or styling system, treat that as a separate platform design decision rather than
part of adding the widget.

## Expected Touch Points

| Path | When a widget change may touch it |
| --- | --- |
| `dashboard/widgets/<type>.js` | Always. This owns the widget's rendering and domain behavior. |
| `dashboard/config.js` | To enable or demonstrate the widget with non-secret runtime configuration. |
| `gateway/widget-routes/<type>.js` | When the widget needs secrets, an upstream proxy, host access, command execution, or server-side aggregation. |
| `gateway/gateway.js` | Only to import and mount a new companion router under `/api`. |
| `tests/` | To cover domain parsing, lifecycle behavior, validation, and any Gateway contract added by the widget. |
| `.env.example`, `docker-compose.yml`, `gateway/platform/config.js` | Only when a companion route needs a new environment setting. Document a safe example and pass it into the existing Gateway service. |
| `dashboard/platform/global.js`, `dashboard/platform/global.css` | Only to add or extract a genuinely reusable helper or visual primitive. Update existing duplicate users in the same change. |

The following are **not normal widget touch points**:

- `dashboard/platform/dashboard.js`
- `dashboard/platform/config-validator.mjs`
- `dashboard/platform/index.html`
- `gateway/platform/routes/`
- `nginx/`
- new Compose services, ports, or top-level directories

Widget-specific props are validated and defaulted by the widget, not added to
the platform config validator. Widget APIs belong in `gateway/widget-routes/`,
not `gateway/platform/routes/`. Nginx already serves widget modules and proxies
all `/api/` requests to the Gateway.

## Conformity Before New Code

Before implementing a helper or CSS rule, search
`dashboard/platform/global.js`, `dashboard/platform/global.css`, and the other
widgets for the same concept.

1. Use an existing global helper or class when it expresses the same concept.
2. Keep truly domain-specific behavior and layout in the widget module.
3. If the new widget would be the second implementation of an existing local
   helper or style, extract the generic form to `global.js` or `global.css` and
   update both widgets to use it.
4. Do not create a global abstraction for hypothetical future use. A shared
   primitive should have a domain-neutral name and at least two real consumers.

Current reusable JavaScript primitives include:

- `apiBase()`, `apiUrl()`, and `fetchJson()` for same-origin Gateway calls and
  the standard response envelope
- `createElement()` and `createWidgetMessage()` for safe, concise DOM
  construction
- `setStateMessage()` for loading, empty, and recoverable error states
- `createResponsiveGrid()` and `createStack()` for widget-internal layout
- `createTile()` for the standard tile surface
- `createStyledIcon()` for text, emoji, or image icons

Current reusable CSS covers widget and tile surfaces, tiled/full-width/scrolling
lists, headers, split panels, metric rows, state and severity colors, clickable
surfaces, menus, inputs, popups, toggles, status dots, progress bars, icons, and
the standard `label`, `label-info`, and `value-large` typography.

## Frontend Contract

Create `dashboard/widgets/<type>.js` and register the exact same type name:

```js
import {
  createElement,
  createResponsiveGrid,
  createTile,
  fetchJson,
  setStateMessage
} from "../platform/global.js";

function render(state) {
  state.grid.classList.remove("is-loading", "is-empty", "is-error");
  state.grid.replaceChildren();

  if (state.items.length === 0) {
    setStateMessage(state.grid, "No examples found.", "empty");
    return;
  }

  for (const item of state.items) {
    const tile = createTile();
    tile.appendChild(
      createElement("div", "label", String(item?.name || "Unnamed example"))
    );
    state.grid.appendChild(tile);
  }
}

window.DASH.registerWidget("example", {
  mount(root, { id, type, props = {} }) {
    const grid = createResponsiveGrid(props);
    root.replaceChildren(grid);
    setStateMessage(grid, "Loading examples...", "loading");
    return { root, grid, props, items: [] };
  },

  async update(state) {
    try {
      const query = encodeURIComponent(state.props.query || "recent");
      const data = await fetchJson(`/example/items?q=${query}`);
      state.items = Array.isArray(data?.items) ? data.items : [];
      render(state);
    } catch (error) {
      setStateMessage(
        state.grid,
        String(error?.message || "Unable to load examples."),
        "error"
      );
    }
  }
});
```

Follow these lifecycle rules:

- `mount(root, context)` is required. Replace the shell's skeleton with the
  widget DOM and return all per-instance state needed by `update`.
- `context` contains `{ id, type, props }`. Default missing props and tolerate
  an empty configuration with a useful empty state.
- `update(state)` is optional. Omit it for a static or event-driven widget; do
  not add a no-op update.
- When present, `update` is called once immediately after mounting. The shell
  also schedules it at `refreshMs` when `refreshMs > 0`.
- Use `fetchJson()` for frontend network requests. Raw `fetch()` should not
  create a second timeout, header, API-base, or error-handling convention.
- Prefer shell-managed `refreshMs` over a widget-owned interval. A widget-owned
  timer is justified only for multiple independent cadences or sub-refresh UI
  updates such as a ticking clock. Initialize it once and store its handle in
  instance state.
- Prevent stale or overlapping network work when an update can outlive its
  refresh period. Store an `AbortController` or an in-flight guard in instance
  state.
- Keep mutable state per mounted instance. The same type may appear more than
  once in config, so module-global mutable state must not couple instances.
- There is currently no unmount hook. Avoid persistent document/window
  listeners and background timers when the shell lifecycle can do the work.
- Let unexpected mount/update failures reach the shell so it can isolate the
  failed tile. Render expected loading, empty, offline, and validation states
  inside the widget with `setStateMessage()`.

Widget modules are native browser ES modules. An IIFE is optional and adds no
isolation beyond module scope. No frontend build or bundling step is expected.

## Configuration Contract

Enable the widget in `dashboard/config.js`:

```js
{
  type: "example",
  id: "example_primary",
  width: 1,
  refreshMs: 60000,
  props: {
    tile_minWidth: 220,
    query: "recent"
  }
}
```

- `id` must be unique. `id` and `type` may contain only letters, numbers,
  underscores, and hyphens.
- `type` must match both the module filename and registered type.
- `width` is a positive integer or `"all"`.
- `refreshMs` is a non-negative number. Use `0` or omit it when shell polling is
  not needed.
- `props` is an optional object owned by the widget. Use names consistent with
  existing shared layout props such as `tile_minWidth`, `tile_columns`, and
  `tile_gap`.
- Put only live, non-secret display configuration in `config.js`. Secrets and
  infrastructure settings belong in Gateway environment variables.

## Styling and DOM Rules

- Compose the widget from global classes and CSS variables first. Use
  `var(--fg)`, `var(--muted)`, severity colors, spacing, padding, radius, card,
  and tile tokens instead of introducing parallel literals.
- Use `createResponsiveGrid()` or `createStack()` for the widget's main content
  and `createTile()` for ordinary tile surfaces. A custom surface should be
  justified by genuinely different semantics or layout.
- Use `label`, `label-info`, and `value-large` for the established type scale.
- Widget-specific CSS may be injected by the widget with an idempotent
  `ensureStyles()` function and a unique style element ID. Scope selectors with
  a widget-specific class and keep only the rules that cannot be expressed by
  global primitives.
- Move a widget-specific class to `global.css` when another widget needs the
  same visual concept; update both consumers rather than copying the rule.
- Build user- or upstream-controlled content with DOM nodes and `textContent`.
  Do not interpolate it into `innerHTML`.
- Use semantic links, buttons, inputs, and labels. Preserve keyboard operation,
  visible focus, useful accessible names, and `noopener noreferrer` on external
  links.
- Keep DOM references in instance state and update existing nodes. Do not
  replace the whole widget on every refresh unless the collection structure
  actually changed.

## Optional Gateway Companion

Browser code should use the same-origin `/api` Gateway when an integration
needs private credentials, avoids CORS, reaches the LAN, invokes a local
command, or requires server-side validation/aggregation. Extend the existing
Gateway rather than adding another service.

Create `gateway/widget-routes/<type>.js`:

```js
import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { sendError, sendOk } from "../platform/responses.js";

const router = Router();

router.get("/example/items", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) {
    return sendError(res, 400, "validation_error", "Missing example query.");
  }
  if (query.length > 100) {
    return sendError(res, 400, "validation_error", "Example query is too long.");
  }

  try {
    const upstream = new URL("https://api.example.invalid/items");
    upstream.searchParams.set("q", query);
    const response = await fetch(upstream, {
      signal: AbortSignal.timeout(CONFIG.upstreamTimeoutMs)
    });
    if (!response.ok) {
      return sendError(res, 502, "upstream_error", "Example upstream failed.");
    }
    const payload = await response.json();
    return sendOk(res, {
      items: Array.isArray(payload?.items) ? payload.items : []
    });
  } catch {
    return sendError(res, 502, "upstream_unreachable", "Example upstream was unreachable.");
  }
});

export default router;
```

Then import it in `gateway/gateway.js` and mount it with `app.use("/api", router)`.
Do not add a widget-specific Nginx location.

Gateway routes must:

- use `sendOk()` and `sendError()` so `fetchJson()` can consume the standard
  `{ ok, data, error }` envelope
- namespace widget-domain endpoints under the widget type where practical
- validate and normalize all params, query values, and request bodies
- apply request size, item count, host allowlist, concurrency, and timeout limits
  appropriate to the operation
- keep secrets and protected upstream URLs server-side
- use `execFile` with fixed commands/arguments rather than shell interpolation
  if a local command is unavoidable
- translate upstream failures into stable status codes and error codes without
  exposing secrets
- read deployment-specific values through `gateway/platform/config.js`, with a
  safe example in `.env.example` and wiring into the existing Gateway service

## Tests and Definition of Done

At minimum, verify the config and existing lifecycle contracts from
`the_dashboard/`:

```sh
node tests/validate-dashboard-config.mjs
node --test tests/*.test.mjs
docker compose config
```

When behavior warrants it, add focused tests for:

- prop normalization and domain parsing, including empty and malformed data
- static versus updating lifecycle behavior
- Gateway input rejection, host policy, timeout/upstream failure, and response
  envelope
- safe repeated updates and multiple instances of the same widget type

For a Gateway or serving change, also build and run the stack, then execute the
smoke tests:

```sh
docker compose up --build
node tests/smoke.mjs
```

A widget is done when its module loads independently, mount replaces the
skeleton, static widgets omit `update`, polling widgets refresh without
duplicating handlers/timers, normal empty/error states remain usable, its config
contains no secrets, its API follows the shared envelope, and its visuals use
the shared primitives.

## Current Exceptions and Cleanup Candidates

These existing widgets do not fully follow the preferred mold. They explain the
current codebase, but they are not precedents to copy blindly.

| Widget | Difference from the preferred pattern | Guidance for new work |
| --- | --- | --- |
| `clocks` | Owns a one-second interval while `refreshMs` is `0`; its `.clock-time` CSS also duplicates the global `value-large` type scale. | The timer is a reasonable sub-refresh exception. Reuse `value-large` rather than copying its typography when touching this widget. |
| `netstats` | Owns separate IP and ping polling timers, uses silent error catches in places, and its backend lives in `gateway/platform/routes/`. | Multiple cadences justify local timers, but initialization must remain guarded and failures should have visible state. New widget-domain routes belong in `widget-routes/`. Its Gateway placement is historical infrastructure ownership. |
| `status` | Its backend also lives in `gateway/platform/routes/` even though it has a frontend widget. | Treat status probing and its host policy as existing platform infrastructure. Do not place a new domain route there. |
| `metar` | Recreates much of the normal tile surface in `.metar-tile` instead of using `createTile()`/`.ui-tile`; fetch failures are collapsed into per-row "no data" output. | Prefer the shared tile primitive and distinguish an unreachable Gateway from valid empty upstream data. |
| `text` | Can fetch an arbitrary URL directly from the browser and opts out of the Gateway envelope. | Keep this as a lightweight generic/legacy capability. A purpose-built remote integration should use a Gateway companion and the standard envelope. |
| `search` and `todos` | Attach document-level click listeners, and the platform has no unmount lifecycle to remove them. | Prefer instance-local focus/blur or event handling. Add global listeners only when necessary, once per instance, and do not use them as a general pattern. |
| `countdown` | Has substantial widget-local visual CSS and overrides some shared tile shadow/padding behavior. | Its domain-specific progress visualization is appropriate locally; shared surface and spacing rules should still be used wherever the design is not countdown-specific. |

Two placement facts are easy to misread: `todos` is already a proper
`gateway/widget-routes/` companion, while `status` and `netstats` are the
historical platform-route exceptions. New widget work should follow `todos` and
`metar` for route placement, and the shared response helpers used by all of
them.
