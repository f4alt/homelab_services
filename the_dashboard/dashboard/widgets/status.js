import {
  bindHoverPopup,
  createElement,
  createResponsiveGrid,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";

const STATUS_STYLE_ID = "status-inline-styles";
// Gateway batches stop at 90 seconds and Nginx at 100, leaving time for response delivery.
const STATUS_BATCH_TIMEOUT_MS = 2 * 60 * 1000;
const INITIAL_DETAIL = "Checking…";
const GATEWAY_UNAVAILABLE_WARNING = "Gateway unavailable.";
const STALE_RESULTS_WARNING = "Refresh failed; showing previous results.";
const INVALID_CHECKS_WARNING = "Some status checks have invalid configuration.";
const INVALID_RESULTS_WARNING = "Some status results were invalid.";
const INDICATOR_CLASSES = Object.freeze({
  passing: "dot--ok",
  attention: "dot--err",
  other: "dot--warn"
});
const STATUS_STYLES = `
    .status-list {
      --status-line-min-width: var(--tile-min, 12rem);

      display: grid;
      gap: var(--gap);
      grid-template-columns: repeat(
        auto-fit,
        minmax(min(100%, var(--status-line-min-width)), 1fr)
      );
    }

    .status-tile-shell {
      --clickable-background: transparent;
      --clickable-border: transparent;
      --clickable-padding: var(--space-sm) 0;
      --clickable-radius: 0;
      --clickable-shadow: none;
      --status-line-color: var(--card-border);
      --status-line-width: 1px;

      color: inherit;
      display: block;
      padding: var(--clickable-padding);
      text-decoration: none;
    }

    .status-tile-shell.clickable {
      border: 0;
    }

    .status-tile {
      align-items: center;
      display: grid;
      gap: var(--space-sm) var(--space-control);
      grid-template-areas: "icon name line status";
      grid-template-columns:
        auto
        minmax(0, max-content)
        minmax(var(--space-md), 1fr)
        auto;
    }

    .status-tile::after {
      background: var(--status-line-color);
      content: "";
      grid-area: line;
      height: var(--status-line-width);
      transition: background-color .15s ease;
    }

    .status-tile > .icon {
      grid-area: icon;
    }

    .status-tile > .label {
      grid-area: name;
    }

    .status-tile-shell.clickable:is(:hover, :focus-visible) .status-tile::after {
      background: var(--clickable-hover-border);
    }

    .status-popup-target {
      --dot-size: 16px;
      --popup-transform: translate(-80%, -90%);

      grid-area: status;
    }

    .status-refresh-warning {
      color: var(--warn-muted);
    }
  `;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validCheck(check) {
  return isPlainObject(check)
    && typeof check.name === "string"
    && Boolean(check.name.trim())
    && (check.icon === undefined || check.icon === null || typeof check.icon === "string")
    && safeHref(check.href) !== undefined
    && isPlainObject(check.provider);
}

function normalizeCheck(check) {
  return {
    name: check.name.trim(),
    ...(check.icon ? { icon: check.icon } : {}),
    ...(check.href !== undefined ? { href: safeHref(check.href) } : {}),
    provider: check.provider
  };
}

async function tryStatusChecks(checks) {
  const data = await fetchJson("/statuschecks", {
    timeoutMs: STATUS_BATCH_TIMEOUT_MS,
    fetchOptions: {
      method: "POST",
      body: JSON.stringify({
        providers: checks.map((check) => check.provider)
      })
    }
  });
  if (!Array.isArray(data?.results)) {
    throw new Error("Status Gateway returned malformed results.");
  }
  return data.results;
}

function createStyledIcon(icon, checkName) {
  const iconBox = createElement("div", "icon");

  if (!icon) {
    iconBox.textContent = "-";
    return iconBox;
  }

  if (String(icon).startsWith("/") || String(icon).startsWith("http")) {
    const image = document.createElement("img");
    image.src = icon;
    image.alt = `${checkName} icon`;
    iconBox.appendChild(image);
    return iconBox;
  }

  iconBox.textContent = icon;
  return iconBox;
}

function createStatusTile(check) {
  const link = document.createElement("a");
  link.className = "status-tile-shell";
  const tile = createElement("div", "status-tile");
  const dotWrap = createElement("div", "popup-on-hover status-popup-target");
  const dot = createElement("div", "dot");
  const popup = createElement("div", "popup label-info");
  const name = createElement("div", "label", check.name);

  dot.setAttribute("tabindex", "0");
  dot.setAttribute("role", "img");
  dotWrap.append(dot, popup);
  bindHoverPopup(dotWrap, popup);
  tile.append(dotWrap, createStyledIcon(check.icon, check.name), name);
  link.appendChild(tile);

  const statusTile = { check, dot, link, popup };
  applyResult(statusTile, { indicator: "other", detail: INITIAL_DETAIL, href: null });
  return statusTile;
}

function safeHref(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizedResult(result) {
  if (!isPlainObject(result)) return null;

  const indicatorClass = INDICATOR_CLASSES[result.indicator];
  const detail = typeof result.detail === "string" ? result.detail.trim() : "";
  const href = safeHref(result.href);
  if (!indicatorClass || !detail || href === undefined) return null;

  return { indicator: result.indicator, indicatorClass, detail, href };
}

function setLinkHref(link, href) {
  if (href) {
    link.setAttribute("href", href);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    link.classList.add("clickable");
    return;
  }

  link.removeAttribute("href");
  link.removeAttribute("target");
  link.removeAttribute("rel");
  link.classList.remove("clickable");
}

function applyResult(tile, result) {
  const normalized = normalizedResult(result);
  if (!normalized) return false;

  tile.dot.className = `dot ${normalized.indicatorClass}`;
  tile.dot.dataset.tip = normalized.detail;
  tile.dot.setAttribute(
    "aria-label",
    `${tile.check.name}: ${normalized.indicator}. ${normalized.detail}`
  );
  tile.popup.textContent = normalized.detail;
  const href = tile.check.href !== undefined ? tile.check.href : normalized.href;
  setLinkHref(tile.link, href);
  return true;
}

function syncWarning(state) {
  state.warning.textContent = state.refreshWarning || state.configWarning;
}

window.DASH.registerWidget("status", {
  mount(root, { props = {} }) {
    installWidgetStyles(STATUS_STYLE_ID, STATUS_STYLES);

    const configuredChecks = Array.isArray(props.checks) ? props.checks : [];
    const checks = configuredChecks.filter(validCheck).map(normalizeCheck);
    const invalidCheckCount = configuredChecks.length - checks.length;
    const grid = createResponsiveGrid(props, "status-list");
    const warning = createElement("div", "label-info status-refresh-warning widget-status");
    warning.setAttribute("role", "status");
    warning.setAttribute("aria-live", "polite");
    root.replaceChildren(grid, warning);

    if (!checks.length) {
      setStateMessage(grid, "No valid status checks configured.", "empty");
    }

    const tiles = checks.map(createStatusTile);
    for (const tile of tiles) grid.appendChild(tile.link);

    const state = {
      checks,
      configWarning: invalidCheckCount > 0 ? INVALID_CHECKS_WARNING : "",
      hasSuccessfulBatch: false,
      refreshWarning: "",
      tiles,
      updating: false,
      warning
    };
    syncWarning(state);
    return state;
  },

  async update(state) {
    if (!state.checks.length || state.updating) return;
    state.updating = true;

    try {
      let results;
      try {
        results = await tryStatusChecks(state.checks);
      } catch {
        state.refreshWarning = state.hasSuccessfulBatch
          ? STALE_RESULTS_WARNING
          : GATEWAY_UNAVAILABLE_WARNING;
        syncWarning(state);
        return;
      }

      let appliedResultCount = 0;
      for (let index = 0; index < state.tiles.length; index += 1) {
        if (applyResult(state.tiles[index], results[index])) {
          appliedResultCount += 1;
        }
      }
      if (appliedResultCount > 0) state.hasSuccessfulBatch = true;
      state.refreshWarning = appliedResultCount === state.tiles.length
        ? ""
        : INVALID_RESULTS_WARNING;
      syncWarning(state);
    } finally {
      state.updating = false;
    }
  }
});
