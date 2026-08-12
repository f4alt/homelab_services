import {
  createElement,
  createStack,
  createTile,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";

const DAY_SECONDS = 86_400;
const HOUR_SECONDS = 3_600;
const MINUTE_SECONDS = 60;
const DEFAULT_STALE_AFTER_MS = 90_000;
const DEFAULT_THRESHOLDS = Object.freeze({
  cpuWarnPercent: 85,
  diskWarnPercent: 85,
  ioWaitWarnPercent: 20,
  memoryWarnPercent: 85,
  swapWarnPercent: 20,
  temperatureWarnCelsius: 80
});
const METRICS = Object.freeze([
  { key: "cpu", label: "CPU" },
  { key: "memory", label: "RAM" },
  { key: "disk", label: "Disk" },
  { key: "temperature", label: "Temp" },
  { key: "uptime", label: "Uptime" }
]);
const SYSTEM_HEALTH_STYLE_ID = "system-health-styles";

const SYSTEM_HEALTH_STYLES = `
    .system-health-tile {
      --system-health-metric-min: 6rem;

      align-content: center;
      display: flex;
      flex: 1 1 auto;
      flex-wrap: wrap;
      gap: var(--space-sm) var(--gap);
    }

    .system-health-metrics {
      display: grid;
      flex: 1 1 100%;
      gap: var(--space-sm) var(--gap);
      grid-template-columns: repeat(
        auto-fit,
        minmax(min(100%, var(--system-health-metric-min)), 1fr)
      );
    }

    .system-health-metric {
      align-items: baseline;
      display: flex;
      gap: var(--space-xs);
      justify-content: center;
      min-width: 0;
    }

    .system-health-warning {
      flex: 1 1 100%;
    }
  `;

function finiteNumber(value) {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function threshold(value, fallback) {
  const number = finiteNumber(value);
  return number !== null && number > 0 ? number : fallback;
}

function normalizeProps(props) {
  const source = props && typeof props === "object" ? props : {};
  const thresholds = Object.fromEntries(
    Object.entries(DEFAULT_THRESHOLDS).map(([name, fallback]) => [
      name,
      threshold(source[name], fallback)
    ])
  );

  return {
    staleAfterMs: threshold(source.staleAfterMs, DEFAULT_STALE_AFTER_MS),
    thresholds
  };
}

function formatNumber(value) {
  const number = finiteNumber(value);
  if (number === null) return "—";
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

function formatPercent(value) {
  const formatted = formatNumber(value);
  return formatted === "—" ? formatted : `${formatted}%`;
}

function formatUptime(value) {
  const seconds = finiteNumber(value);
  if (seconds === null || seconds < 0) return "—";
  if (seconds >= DAY_SECONDS) return `${Math.floor(seconds / DAY_SECONDS)}d`;

  const hours = Math.floor(seconds / HOUR_SECONDS);
  if (hours >= 1) return `${hours}h`;
  return `${Math.floor(seconds / MINUTE_SECONDS)}m`;
}

function requiredSnapshotValuesArePresent(snapshot) {
  return snapshot
    && finiteNumber(snapshot.cpu?.usagePercent) !== null
    && finiteNumber(snapshot.memory?.usedPercent) !== null
    && finiteNumber(snapshot.disk?.usedPercent) !== null
    && finiteNumber(snapshot.uptimeSeconds) !== null;
}

function evaluateSnapshot(snapshot, props) {
  const warnings = [];
  const thresholds = props.thresholds;
  const cpuUsage = finiteNumber(snapshot.cpu?.usagePercent);
  const memoryUsage = finiteNumber(snapshot.memory?.usedPercent);
  const diskUsage = finiteNumber(snapshot.disk?.usedPercent);
  const temperature = finiteNumber(snapshot.temperature?.celsius);
  const ioWait = finiteNumber(snapshot.cpu?.ioWaitPercent);
  const swapUsage = finiteNumber(snapshot.memory?.swapUsedPercent);

  if (cpuUsage >= thresholds.cpuWarnPercent) warnings.push("CPU high");
  if (memoryUsage >= thresholds.memoryWarnPercent) warnings.push("Memory high");
  if (diskUsage >= thresholds.diskWarnPercent) warnings.push("Disk nearly full");
  if (temperature === null) {
    warnings.push("Temperature unavailable");
  } else if (temperature >= thresholds.temperatureWarnCelsius) {
    warnings.push("Temperature high");
  }
  if (ioWait !== null && ioWait >= thresholds.ioWaitWarnPercent) {
    warnings.push("I/O wait high");
  }
  if (swapUsage !== null && swapUsage >= thresholds.swapWarnPercent) {
    warnings.push("Swap in use");
  }

  const sampledAt = Date.parse(snapshot.sampledAt);
  if (!Number.isFinite(sampledAt)) {
    warnings.push("Telemetry timestamp unavailable");
  } else if (Date.now() - sampledAt > props.staleAfterMs) {
    warnings.push("Telemetry is stale");
  }

  return warnings;
}

function setSeverity(state, severity) {
  state.tile.classList.remove("severity-warn", "severity-error");
  if (severity) state.tile.classList.add(`severity-${severity}`);
}

function renderSnapshot(state, snapshot) {
  if (state.grid.children[0] !== state.tile) state.grid.replaceChildren(state.tile);
  state.grid.classList.remove("is-loading", "is-empty", "is-error");

  state.values.cpu.textContent = formatPercent(snapshot.cpu?.usagePercent);
  state.values.memory.textContent = formatPercent(snapshot.memory?.usedPercent);
  state.values.disk.textContent = formatPercent(snapshot.disk?.usedPercent);
  const temperature = finiteNumber(snapshot.temperature?.celsius);
  state.values.temperature.textContent = temperature === null
    ? "—"
    : `${formatNumber(temperature)}°C`;
  state.values.uptime.textContent = formatUptime(snapshot.uptimeSeconds);

  const warnings = evaluateSnapshot(snapshot, state.props);
  setSeverity(state, warnings.length > 0 ? "warn" : "");
  state.snapshotWarnings = warnings;
  state.warning.textContent = warnings.join(" · ");
  state.hasSnapshot = true;
}

function showRefreshFailure(state, message) {
  if (!state.hasSnapshot) {
    setStateMessage(state.grid, message, "error");
    return;
  }

  const refreshWarning = `${message} Showing the previous snapshot.`;
  setSeverity(state, "error");
  state.warning.textContent = [...state.snapshotWarnings, refreshWarning].join(" · ");
}

window.DASH.registerWidget("system-health", {
  mount(root, { props = {} }) {
    installWidgetStyles(SYSTEM_HEALTH_STYLE_ID, SYSTEM_HEALTH_STYLES);

    const normalizedProps = normalizeProps(props);
    const grid = createStack();
    const tile = createTile("ui-tile--compact system-health-tile");
    const metrics = createElement("dl", "system-health-metrics");
    const values = {};

    for (const metric of METRICS) {
      const field = createElement("div", "system-health-metric");
      const label = createElement("dt", "label-info", metric.label);
      const value = createElement("dd", "value-large", "—");
      values[metric.key] = value;
      field.append(label, value);
      metrics.appendChild(field);
    }

    const warning = createElement(
      "div",
      "label-info system-health-warning widget-status"
    );
    warning.setAttribute("aria-live", "polite");
    warning.setAttribute("role", "status");
    tile.append(metrics, warning);

    root.replaceChildren(grid);
    setStateMessage(grid, "Loading system health…", "loading");

    return {
      aborter: null,
      grid,
      hasSnapshot: false,
      props: normalizedProps,
      snapshotWarnings: [],
      tile,
      values,
      warning
    };
  },

  async update(state) {
    state.aborter?.abort();
    const aborter = new AbortController();
    state.aborter = aborter;

    let snapshot;
    try {
      snapshot = await fetchJson("/system-health", {
        fetchOptions: { signal: aborter.signal }
      });
      if (state.aborter !== aborter || aborter.signal.aborted) return;
      if (!requiredSnapshotValuesArePresent(snapshot)) {
        throw new Error("System health response was incomplete.");
      }
    } catch (error) {
      if (state.aborter !== aborter || aborter.signal.aborted) return;
      showRefreshFailure(
        state,
        String(error?.message || "Unable to load system health.")
      );
      return;
    } finally {
      if (state.aborter === aborter) state.aborter = null;
    }

    renderSnapshot(state, snapshot);
  }
});
