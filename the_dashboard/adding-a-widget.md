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
| `dashboard/config.js`, `dashboard/config.local.js` | Use the tracked file for a sanitized demonstration and the ignored local file for live runtime values. |
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

- `fetchJson()` for same-origin Gateway calls and the standard response
  envelope; it combines its timeout with an optional caller cancellation signal
- `createElement()` and `createWidgetMessage()` for safe, concise DOM
  construction
- `setStateMessage()` for loading, empty, and recoverable error states
- `createResponsiveGrid()` and `createStack()` for widget-internal layout
- `createTile()` for the standard tile surface, with controlled
  `--tile-padding`, `--tile-radius`, and `--tile-box-shadow` overrides
- `setFlippableTileState()` for the shared flip class and front/back ARIA state
- `prepareFlippableTile()` for centered, viewport-anchored reverse faces when
  CSS anchor positioning is available
- `createDismissibleMenu()` for per-instance popup state, ARIA expansion,
  temporary outside-click/Escape listeners, and focus return
- `bindHoverPopup()` for hover/focus tooltip state and top-layer positioning

Current reusable CSS covers widget and tile surfaces, tiled/full-width/scrolling
lists, headers, split panels, metric rows, state and severity colors, clickable
surfaces, menus, inputs, popups, toggles, status dots, progress bars, icons, and
the standard `label`, `label-info`, and `value-large` typography. Tiled lists
fit their children by default; use `list-fullWidth` when each child should fill
the available width and the vertical stack should claim the remaining widget
space. A `flippable-tile` wrapper takes its normal size from the front face;
give both faces the same `ui-tile` surface. The centered back face is never
smaller than the front and can grow over neighboring tiles without changing
the list layout or adding horizontal overflow.

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
- Use `createDismissibleMenu()` for listboxes and popup menus that need outside
  dismissal. Its document listeners exist only while that instance is open.
- Use `bindHoverPopup()` for hover/focus tooltips inside scrolling or capped
  content. It promotes supported popups to the browser top layer so ancestor
  overflow cannot clip them.
- Let unexpected mount/update failures reach the shell so it can isolate the
  failed tile. Render expected loading, empty, offline, and validation states
  inside the widget with `setStateMessage()`.

Widget modules are native browser ES modules. An IIFE is optional and adds no
isolation beyond module scope. No frontend build or bundling step is expected.

For a dismissible popup, create the controller after the trigger and menu exist:

```js
const menuController = createDismissibleMenu({
  trigger: menuButton,
  menu,
  containsTarget: (target) => widgetShell.contains(target),
  onOpenChange: (isOpen) => root.classList.toggle("menu-open", isOpen)
});
```

`containsTarget` and `onOpenChange` are optional. Call `open()`, `close()`, or
`toggle()` from widget interactions and inspect `isOpen()` when widget-specific
keyboard behavior needs the current state. The controller owns
`aria-expanded`, the shared `popup-menu-open` class, outside clicks, Escape,
and focus return on Escape. A selection handler that rebuilds its option nodes
should return focus to a stable trigger or input after rendering.

## Configuration Contract

Enable the widget in the selected dashboard config. Use
`dashboard/config.local.js` for a live local instance:

```js
{
  type: "example",
  id: "example_primary",
  width: 1,
  refreshMs: 60000,
  props: {
    tileMinWidth: 220,
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
  existing shared layout props such as `tileMinWidth`, `tileColumns`, and
  `tileGap`.
- Put live, non-secret display configuration in the ignored local config. Keep
  the tracked default sanitized; secrets and infrastructure settings belong in
  Gateway environment variables.

## Styling and DOM Rules

- Compose the widget from global classes and CSS variables first. Use
  `var(--fg)`, `var(--muted)`, severity colors, spacing, padding, radius, card,
  and tile tokens instead of introducing parallel literals.
- Use `createResponsiveGrid()` or `createStack()` for the widget's main content
  and `createTile()` for ordinary tile surfaces. A custom surface should be
  justified by genuinely different semantics or layout.
- Keep `flippable-tile` wrappers surface-free. Apply the appropriate surface
  class to each face, call `prepareFlippableTile()`, and let the in-flow front
  reserve the closed size. The content-sized back uses a centered absolute
  fallback and a viewport anchor in supported browsers.
- Override a standard tile only through `--tile-padding`, `--tile-radius`, and
  `--tile-box-shadow`. Keep data layout, field grouping, and domain-state
  effects in the widget.
- Use `label`, `label-info`, and `value-large` for the established type scale.
- Install genuinely widget-specific CSS with `installWidgetStyles()`, a unique
  style element ID, and widget-scoped selectors. Keep only rules that cannot be
  expressed by global primitives.
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

## Deliberate Exceptions

The remaining exceptions are constrained by domain or cadence. They are not
general precedents for new widgets.

| Widget | Difference from the preferred pattern | Guidance for new work |
| --- | --- | --- |
| `clocks` | Owns a one-second interval while `refreshMs` is `0`. | The shell cadence is not suitable for a ticking clock. Initialize the timer once per instance and keep clock typography on the shared `value-large` scale. |
| `netstats` | Owns separate IP and latency timers while `refreshMs` is `0`. | Independent cadences justify the timers. Each operation has a per-instance in-flight guard, visible stale/recovery state, and no shared mutable polling state. |
| `calendar` | Keeps its calendar grid plus specialized countdown progress, popup placement, and today/overdue severity glows. | These are domain presentation, while the surface padding and shadow flow through the shared tile customization properties. |

`status`, `netstats`, `metar`, and `todos` all keep their backend companions in
`gateway/widget-routes/`. `text` is intentionally static. Search, todos, and
time-since use the shared dismissible-menu controller rather than persistent
document listeners.
