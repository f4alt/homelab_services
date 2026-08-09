import {
  createElement,
  createResponsiveGrid,
  createTile,
  fetchJson,
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
  { key: "uptime", label: "Uptime" },
  { key: "containers", label: "Containers" }
]);
const STYLE_ELEMENT_ID = "system-health-styles";

function ensureStyles() {
  if (document.getElementById(STYLE_ELEMENT_ID)) return;

  const style = document.createElement("style");
  style.id = STYLE_ELEMENT_ID;
  style.textContent = `
    .system-health-tile {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }

    .system-health-metrics {
      display: grid;
      gap: var(--gap);
      grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    .system-health-metric {
      min-width: 0;
    }

    .system-health-warning {
      white-space: normal;
    }

    .system-health-warning:empty {
      display: none;
    }

  `;
  document.head.appendChild(style);
}

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
  const label = String(source.label || "").trim();
  const thresholds = Object.fromEntries(
    Object.entries(DEFAULT_THRESHOLDS).map(([name, fallback]) => [
      name,
      threshold(source[name], fallback)
    ])
  );

  return {
    label: label || "System",
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

function formatContainers(containers) {
  const running = finiteNumber(containers?.running);
  const total = finiteNumber(containers?.total);
  return running === null || total === null ? "—" : `${running}/${total}`;
}

function requiredSnapshotValuesArePresent(snapshot) {
  return snapshot
    && finiteNumber(snapshot.cpu?.usagePercent) !== null
    && finiteNumber(snapshot.memory?.usedPercent) !== null
    && finiteNumber(snapshot.disk?.usedPercent) !== null
    && finiteNumber(snapshot.uptimeSeconds) !== null;
}

function pluralized(count, singular) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function evaluateSnapshot(snapshot, props) {
  const warnings = [];
  let severity = "ok";
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

  const containers = snapshot.containers;
  if (!containers) {
    warnings.push("Container health unavailable");
  } else {
    const unhealthy = Math.max(0, finiteNumber(containers.unhealthy) || 0);
    const restarting = Math.max(0, finiteNumber(containers.restarting) || 0);
    const exited = Math.max(0, finiteNumber(containers.exited) || 0);
    const paused = Math.max(0, finiteNumber(containers.paused) || 0);
    const other = Math.max(0, finiteNumber(containers.other) || 0);

    if (unhealthy > 0) {
      warnings.push(`${pluralized(unhealthy, "container")} unhealthy`);
      severity = "error";
    }
    if (restarting > 0) {
      warnings.push(`${pluralized(restarting, "container")} restarting`);
    }
    if (exited > 0) {
      warnings.push(`${pluralized(exited, "container")} exited`);
      severity = "error";
    }
    if (paused > 0) warnings.push(`${pluralized(paused, "container")} paused`);
    if (other > 0) {
      warnings.push(`${pluralized(other, "container")} not running`);
      severity = "error";
    }
  }

  const sampledAt = Date.parse(snapshot.sampledAt);
  if (!Number.isFinite(sampledAt)) {
    warnings.push("Telemetry timestamp unavailable");
  } else if (Date.now() - sampledAt > props.staleAfterMs) {
    warnings.push("Telemetry is stale");
  }

  if (warnings.length > 0 && severity === "ok") severity = "warn";
  return { severity, warnings };
}

function setSeverity(state, severity) {
  state.severity = severity;
  state.tile.classList.remove("severity-ok", "severity-warn", "severity-error");
  state.tile.classList.add(`severity-${severity}`);
  state.dot.className = `dot dot--${severity === "error" ? "err" : severity}`;
  state.status.textContent = severity === "ok"
    ? "Healthy"
    : severity === "error"
      ? "Unhealthy"
      : "Attention";
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
  state.values.containers.textContent = formatContainers(snapshot.containers);

  const { severity, warnings } = evaluateSnapshot(snapshot, state.props);
  setSeverity(state, severity);
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
  setSeverity(state, state.severity === "error" ? "error" : "warn");
  state.warning.textContent = [...state.snapshotWarnings, refreshWarning].join(" · ");
}

window.DASH.registerWidget("system-health", {
  mount(root, { props = {} }) {
    ensureStyles();

    const normalizedProps = normalizeProps(props);
    const grid = createResponsiveGrid(props);
    const tile = createTile("system-health-tile");
    const header = createElement("div", "widget-header");
    const title = createElement("div", "label", normalizedProps.label);
    const summary = createElement("div", "ui-row");
    const dot = createElement("span", "dot dot--warn");
    const status = createElement("span", "label-info system-health-state", "Loading");
    const metrics = createElement("dl", "system-health-metrics");
    const values = {};

    dot.setAttribute("aria-hidden", "true");
    summary.append(dot, status);
    header.append(title, summary);

    for (const metric of METRICS) {
      const field = createElement("div", "system-health-metric");
      const label = createElement("dt", "label-info", metric.label);
      const value = createElement("dd", "value-large", "—");
      values[metric.key] = value;
      field.append(label, value);
      metrics.appendChild(field);
    }

    const warning = createElement("div", "label-info system-health-warning");
    warning.setAttribute("aria-live", "polite");
    warning.setAttribute("role", "status");
    tile.append(header, metrics, warning);

    root.replaceChildren(grid);
    setStateMessage(grid, "Loading system health…", "loading");

    return {
      aborter: null,
      dot,
      grid,
      hasSnapshot: false,
      props: normalizedProps,
      severity: "warn",
      snapshotWarnings: [],
      status,
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
    } catch (error) {
      if (state.aborter !== aborter || aborter.signal.aborted) return;
      showRefreshFailure(
        state,
        String(error?.message || "Unable to load system health.")
      );
      return;
    }

    if (state.aborter !== aborter || aborter.signal.aborted) return;
    if (!requiredSnapshotValuesArePresent(snapshot)) {
      throw new Error("System health response was incomplete.");
    }
    renderSnapshot(state, snapshot);
  }
});
