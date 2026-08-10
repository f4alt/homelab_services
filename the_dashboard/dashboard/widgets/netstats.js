import {
  createElement,
  fetchJson,
  installWidgetStyles
} from "../platform/global.js";

const DEFAULT_CHART_MAX_MS = 10;
const DEFAULT_IP_REFRESH_MS = 600_000;
const DEFAULT_MAX_SAMPLES = 60;
const DEFAULT_PING_INTERVAL_MS = 5_000;
const LATENCY_ERROR_THRESHOLD_MS = 200;
const LATENCY_WARNING_THRESHOLD_MS = 75;
const NETSTATS_STYLE_ID = "netstats-styles";
const SPEED_TEST_TIMEOUT_MS = 185_000;
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const NETSTATS_STYLES = `
    .net-chart-overlay {
      font-size: 42px;
      opacity: .3;
    }

    .net-chart {
      height: 110px;
      width: 100%;
    }

    .netstats-graph-labels {
      display: flex;
      justify-content: space-between;
      padding: 0 var(--space-control);
    }

    .netstats-speed-block {
      display: flex;
      flex-direction: column;
      gap: var(--gap);
      text-align: initial;
      width: 100%;
    }

    .netstats-chart-button {
      position: relative;
      width: 100%;
    }

    .netstats-status {
      display: block;
      margin-top: var(--space-xs);
    }
  `;

function createMetricRow(label, value = "-", tagName = "div") {
  const childTag = tagName === "span" ? "span" : "div";
  const row = createElement(tagName, "metric-row metric-row--nowrap");
  const labelElement = createElement(childTag, "label", label);
  const valueElement = createElement(childTag, "label-info", value);
  row.append(labelElement, valueElement);
  return { row, valueElement };
}

function createStatus() {
  const status = createElement("span", "label-info netstats-status widget-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  return status;
}

function setAvailability(surface, status, stale, message = "") {
  surface.classList.toggle("warn", stale);
  status.textContent = message;
}

function formatMillis(milliseconds) {
  const value = Number(milliseconds);
  return Number.isFinite(value) ? `${Math.round(value)} ms` : "-";
}

function formatMbps(value) {
  const megabitsPerSecond = Number(value);
  if (!Number.isFinite(megabitsPerSecond)) return "-";
  if (megabitsPerSecond >= 100) return `${megabitsPerSecond.toFixed(0)} Mbps`;
  if (megabitsPerSecond >= 10) return `${megabitsPerSecond.toFixed(1)} Mbps`;
  return `${megabitsPerSecond.toFixed(2)} Mbps`;
}

async function fetchClientIP() {
  const data = await fetchJson("/net/myip");
  if (!data?.ip) throw new Error("Public IP was unavailable.");
  return data.ip;
}

async function wanPingOnce() {
  const data = await fetchJson("/net/ping");
  const milliseconds = Number(data?.ms ?? data?.ping_ms);
  if (!Number.isFinite(milliseconds)) throw new Error("Latency was unavailable.");
  return milliseconds;
}

function computeJitter(samples) {
  if (!samples.length) return 0;

  const mean = samples.reduce((total, sample) => total + sample, 0) / samples.length;
  const variance = samples.reduce(
    (total, sample) => total + ((sample - mean) * (sample - mean)),
    0
  ) / samples.length;
  return Math.round(Math.sqrt(variance));
}

function niceMax(value) {
  if (value <= 0) return DEFAULT_CHART_MAX_MS;

  const exponent = Math.floor(Math.log10(value));
  const fraction = value / Math.pow(10, exponent);
  const factor = fraction <= 2 ? 2 : fraction <= 5 ? 5 : 10;
  return factor * Math.pow(10, exponent);
}

function renderSparkline(svg, samples) {
  if (!samples.length) return;

  const width = svg.clientWidth;
  const height = svg.clientHeight;
  const leftPadding = 28;
  const rightPadding = 6;
  const topPadding = 16;
  const bottomPadding = 16;
  const minimumValue = 0;
  const maximumValue = niceMax(Math.max(DEFAULT_CHART_MAX_MS, ...samples));

  function mapY(value) {
    const position = (value - minimumValue) / (maximumValue - minimumValue || 1);
    return (height - bottomPadding) - position * (height - topPadding - bottomPadding);
  }

  function createSvgElement(tagName) {
    return document.createElementNS(SVG_NAMESPACE, tagName);
  }

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const axes = createSvgElement("g");
  svg.appendChild(axes);
  const ticks = [minimumValue, Math.round(maximumValue / 2), maximumValue];
  for (const tick of ticks) {
    const verticalPosition = mapY(tick);
    const label = createSvgElement("text");
    label.setAttribute("x", leftPadding - 4);
    label.setAttribute("y", verticalPosition + 3);
    label.setAttribute("fill", "var(--muted)");
    label.setAttribute("font-size", "10px");
    label.setAttribute("text-anchor", "end");
    label.textContent = String(tick);
    axes.appendChild(label);

    const referenceLine = createSvgElement("line");
    referenceLine.setAttribute("x1", leftPadding);
    referenceLine.setAttribute("x2", width);
    referenceLine.setAttribute("y1", verticalPosition);
    referenceLine.setAttribute("y2", verticalPosition);
    referenceLine.setAttribute("stroke", "var(--muted-low-opac)");
    referenceLine.setAttribute("stroke-width", 1);
    referenceLine.setAttribute("stroke-dasharray", "2,3");
    axes.appendChild(referenceLine);
  }

  const sampleCount = samples.length;
  const horizontalStep = (width - leftPadding - rightPadding) /
    Math.max(1, sampleCount - 1);
  const points = samples.map((sample, index) => {
    const horizontalPosition = leftPadding + index * horizontalStep;
    const verticalPosition = mapY(sample);
    return index === 0
      ? `M ${horizontalPosition} ${verticalPosition}`
      : `L ${horizontalPosition} ${verticalPosition}`;
  });

  const path = createSvgElement("path");
  path.setAttribute("d", points.join(" "));
  path.setAttribute("fill", "none");
  if (maximumValue > LATENCY_ERROR_THRESHOLD_MS) {
    path.setAttribute("stroke", "var(--err)");
  } else if (maximumValue > LATENCY_WARNING_THRESHOLD_MS) {
    path.setAttribute("stroke", "var(--warn)");
  } else {
    path.setAttribute("stroke", "var(--ok)");
  }
  path.setAttribute("stroke-width", "2");
  svg.appendChild(path);
}

async function runBothSpeeds(state) {
  if (state.running) return;
  state.running = true;

  // Ping polling would compete with the speed test for the same connection.
  const wasPaused = state.paused;
  state.paused = true;
  state.speedBlock.setAttribute("aria-busy", "true");
  state.speedStatus.textContent = "Running speed test…";

  try {
    const data = await fetchJson("/net/speedtest", {
      timeoutMs: SPEED_TEST_TIMEOUT_MS
    });
    state.downloadValue.textContent = formatMbps(data.download_mbps);
    state.uploadValue.textContent = formatMbps(data.upload_mbps);
    state.speedPingValue.textContent = formatMillis(data.ping_ms);
    state.hasSpeedResult = true;
    setAvailability(state.speedBlock, state.speedStatus, false);
  } catch {
    const message = state.hasSpeedResult
      ? "Speed test unavailable; showing previous result."
      : "Speed test unavailable.";
    setAvailability(state.speedBlock, state.speedStatus, true, message);
  } finally {
    state.speedBlock.setAttribute("aria-busy", "false");
    state.running = false;
    state.paused = wasPaused;
  }
}

function setChartPaused(state, paused) {
  state.paused = paused;
  state.overlay.textContent = paused ? "⏸" : "";
  state.chartWrap.setAttribute(
    "aria-label",
    paused ? "Resume latency polling" : "Pause latency polling"
  );
  state.chartWrap.setAttribute("aria-pressed", String(paused));
}

async function refreshIp(state) {
  if (state.ipInFlight) return;
  state.ipInFlight = true;
  state.ipRow.setAttribute("aria-busy", "true");

  try {
    state.ipValue.textContent = await fetchClientIP();
    state.hasIpResult = true;
    setAvailability(state.ipRow, state.ipStatus, false);
  } catch {
    const message = state.hasIpResult
      ? "Public IP unavailable; showing previous value."
      : "Public IP unavailable.";
    setAvailability(state.ipRow, state.ipStatus, true, message);
  } finally {
    state.ipRow.setAttribute("aria-busy", "false");
    state.ipInFlight = false;
  }
}

async function refreshPing(state) {
  if (state.paused || state.pingInFlight) return;
  state.pingInFlight = true;
  state.chartWrap.setAttribute("aria-busy", "true");

  try {
    const milliseconds = await wanPingOnce();
    state.samples.push(milliseconds);
    if (state.samples.length > state.settings.maxSamples) state.samples.shift();
    renderSparkline(state.svg, state.samples);
    state.jitterLabel.textContent = `jitter: ${computeJitter(state.samples)} ms`;
    state.hasPingResult = true;
    setAvailability(state.chartWrap, state.pingStatus, false);
  } catch {
    const message = state.hasPingResult
      ? "Latency unavailable; showing previous samples."
      : "Latency unavailable.";
    setAvailability(state.chartWrap, state.pingStatus, true, message);
  } finally {
    state.chartWrap.setAttribute("aria-busy", "false");
    state.pingInFlight = false;
  }
}

window.DASH.registerWidget("netstats", {
  mount(root, { props = {} }) {
    installWidgetStyles(NETSTATS_STYLE_ID, NETSTATS_STYLES);

    const settings = {
      ipRefreshMs: props?.ipRefreshMs ?? DEFAULT_IP_REFRESH_MS,
      pingIntervalMs: props?.pingIntervalMs ?? DEFAULT_PING_INTERVAL_MS,
      maxSamples: props?.maxSamples ?? DEFAULT_MAX_SAMPLES,
      startPaused: props?.start_paused === true
    };
    const wrap = document.createElement("div");
    wrap.className = "panel-split";
    const left = document.createElement("div");
    left.className = "panel-sidebar";

    const { row: ipRow, valueElement: ipValue } = createMetricRow("Public IP", "—");
    const ipStatus = createStatus();
    const speedBlock = document.createElement("button");
    speedBlock.type = "button";
    speedBlock.className = "netstats-speed-block clickable";
    speedBlock.setAttribute("aria-busy", "false");
    speedBlock.setAttribute("aria-label", "Run network speed test");

    const { row: downloadRow, valueElement: downloadValue } = createMetricRow(
      "Download",
      "-",
      "span"
    );
    const { row: uploadRow, valueElement: uploadValue } = createMetricRow(
      "Upload",
      "-",
      "span"
    );
    const { row: speedPingRow, valueElement: speedPingValue } = createMetricRow(
      "Ping",
      "-",
      "span"
    );
    const speedStatus = createStatus();
    speedBlock.append(downloadRow, uploadRow, speedPingRow, speedStatus);
    left.append(ipRow, ipStatus, speedBlock);

    const right = document.createElement("div");
    right.className = "panel-main";
    const labels = document.createElement("div");
    labels.className = "netstats-graph-labels";
    const title = document.createElement("div");
    title.className = "label-info";
    title.textContent = "Latency (ms)";
    const jitterLabel = document.createElement("div");
    jitterLabel.className = "label-info";
    jitterLabel.textContent = "jitter: —";
    labels.append(title, jitterLabel);

    const chartWrap = document.createElement("button");
    chartWrap.type = "button";
    chartWrap.className = "net-chart-wrap netstats-chart-button clickable";
    chartWrap.setAttribute("aria-busy", "false");
    const svg = document.createElementNS(SVG_NAMESPACE, "svg");
    svg.classList.add("net-chart");
    const overlay = document.createElement("span");
    overlay.className = "center-overlay net-chart-overlay";
    chartWrap.append(svg, overlay);
    const pingStatus = createStatus();
    right.append(chartWrap, labels, pingStatus);
    wrap.append(left, right);
    root.replaceChildren(wrap);

    const state = {
      settings,
      ipRow,
      ipValue,
      ipStatus,
      speedBlock,
      downloadValue,
      uploadValue,
      speedPingValue,
      speedStatus,
      chartWrap,
      svg,
      overlay,
      jitterLabel,
      pingStatus,
      ipTimer: null,
      samples: [],
      paused: false,
      running: false,
      ipInFlight: false,
      pingInFlight: false,
      hasIpResult: false,
      hasPingResult: false,
      hasSpeedResult: false
    };
    setChartPaused(state, settings.startPaused);
    return state;
  },

  update(state) {
    if (state.ipTimer !== null) return;

    state.speedBlock.addEventListener("click", () => runBothSpeeds(state));
    state.chartWrap.addEventListener("click", () => {
      setChartPaused(state, !state.paused);
    });
    void refreshIp(state);
    state.ipTimer = setInterval(() => void refreshIp(state), state.settings.ipRefreshMs);
    setInterval(() => void refreshPing(state), state.settings.pingIntervalMs);
  }
});
