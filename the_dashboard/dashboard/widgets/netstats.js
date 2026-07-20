import { fetchJson, createElement } from "../platform/global.js";

(function () {
  function ensureStyles() {
    if (document.getElementById("netstats-styles")) return;
    const s = document.createElement("style");
    s.id = "netstats-styles";
    s.textContent = `
    .net-chart-overlay{
      font-size:42px;
      opacity:0.3;
      transition:opacity .15s ease;
    }
    .net-chart {
      height: 110px;
      width: 100%;
    }
    .netstats-graph-labels {
      display: flex;
      justify-content: space-between;
      padding: 0 10px;
    }
    .netstats-speed-block {
      display: flex;
      flex-direction: column;
      font: inherit;
      gap: var(--gap);
      text-align: initial;
      width: 100%;
    }
    .netstats-chart-button {
      appearance: none;
      color: inherit;
      font: inherit;
      position: relative;
      width: 100%;
    }
    .netstats-status {
      display: block;
      margin-top: 4px;
      white-space: normal;
    }
    .netstats-status:empty {
      display: none;
    }
    .netstats-stale {
      border-color: var(--warn-muted) !important;
    }
    `;
    document.head.appendChild(s);
  }

  function createMetricRow(label, value = "-", tagName = "div") {
    const childTag = tagName === "span" ? "span" : "div";
    const row = createElement(tagName, "metric-row metric-row--nowrap");
    const labelEl = createElement(childTag, "label", label);
    const valueEl = createElement(childTag, "label-info", value);
    row.append(labelEl, valueEl);
    return { row, labelEl, valueEl };
  }

  function createStatus() {
    const status = createElement("span", "label-info netstats-status");
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    return status;
  }

  function setAvailability(surface, status, stale, message = "") {
    surface.classList.toggle("netstats-stale", stale);
    status.textContent = message;
  }

  function formatMillis(ms) {
    const value = Number(ms);
    return Number.isFinite(value) ? `${Math.round(value)} ms` : "-";
  }

  function formatMbps(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return "-";
    if (n >= 100) return `${n.toFixed(0)} Mbps`;
    if (n >= 10) return `${n.toFixed(1)} Mbps`;
    return `${n.toFixed(2)} Mbps`;
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
    if (!samples.length)
      return 0;
    const mean = samples.reduce((a,b)=>a+b,0)/samples.length;
    const varSum = samples.reduce((a,b)=>a + (b-mean)*(b-mean), 0) / samples.length;
    return Math.round(Math.sqrt(varSum));
  }

  function niceMax(x) {
    if (x <= 0)
      return 10;
    const exp = Math.floor(Math.log10(x));
    const f = x / Math.pow(10, exp);
    return (f <= 2 ? 2 : f <= 5 ? 5 : 10) * Math.pow(10, exp);
  }

  function renderSparkline(svg, samples) {
    if (!samples.length)
      return;

    const w = svg.clientWidth;
    const h = svg.clientHeight;
    svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
    while (svg.firstChild)
      svg.removeChild(svg.firstChild);

    const padL = 28, padR = 6, padT = 16, padB = 16;
    const minVal = 0;
    const maxVal = niceMax(Math.max(10, ...samples));

    const gAxes = elementInSVGNamespace("g");
    svg.appendChild(gAxes);

    // graph left-axis [min max/2 max]
    const ticks = [minVal, Math.round(maxVal/2), maxVal];
    for (const t of ticks) {
      const y = mapY(t);

      // create the label for the axis
      const label = elementInSVGNamespace("text");
      label.setAttribute("x", padL-4);
      label.setAttribute("y", y+3);
      label.setAttribute("fill", "var(--muted)");
      label.setAttribute("font-size", "10px");
      label.setAttribute("text-anchor", "end");
      label.textContent = String(t);
      gAxes.appendChild(label);

      // create a dotted reference line
      const dottedLine = elementInSVGNamespace("line");
      dottedLine.setAttribute("x1", padL); // start at padding
      dottedLine.setAttribute("x2", w);    // end at width
      dottedLine.setAttribute("y1", y);    // vertical at y height
      dottedLine.setAttribute("y2", y);
      dottedLine.setAttribute("stroke", "var(--muted-low-opac)");
      dottedLine.setAttribute("stroke-width", 1);
      dottedLine.setAttribute("stroke-dasharray", "2,3");
      gAxes.appendChild(dottedLine);
    }

    // convert points into svg path syntax
    const pts = [];
    const n = samples.length;
    const dx = (w - padL - padR) / Math.max(1,(n-1));
    for (let i = 0; i < n; i++) {
      const x = padL + i*dx;
      const y = mapY(samples[i]);
      pts.push(i===0 ? `M ${x} ${y}` : `L ${x} ${y}`);
    }
    const path = elementInSVGNamespace("path");
    path.setAttribute("d", pts.join(" "));
    path.setAttribute("fill","none");
    // color line depending on current max value
    if (maxVal > 200)     path.setAttribute("stroke", "var(--err)");
    else if (maxVal > 75) path.setAttribute("stroke", "var(--warn)");
    else                  path.setAttribute("stroke", "var(--ok)");
    path.setAttribute("stroke-width","2");
    svg.appendChild(path);

    // HELPER FUNCTIONS
    function mapY(v) {
      const t=(v-minVal)/(maxVal-minVal||1);
      return (h-padB) - t*(h-padT-padB);
    }
    function elementInSVGNamespace(n) {
      return document.createElementNS("http://www.w3.org/2000/svg", n);
    }
  }

  async function runBothSpeeds(state) {
    if (state.running) return;
    state.running = true;

    // pause ping polling while running speed test
    const wasPaused = state.paused;
    state.paused = true;

    state.speedBlock.setAttribute("aria-busy", "true");
    state.speedStatus.textContent = "Running speed test…";

    try {
      const data = await fetchJson("/net/speedtest", { timeoutMs: 185000 });
      state.valDL.textContent = formatMbps(data.download_mbps);
      state.valUL.textContent = formatMbps(data.upload_mbps);
      state.valPing.textContent = formatMillis(data.ping_ms);
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

  function attachSpeedBlockHandlers(state) {
    const handler = () => runBothSpeeds(state);
    state.speedBlock.addEventListener("click", handler);
  }

  function attachChartHandlers(state) {
    const togglePause = () => {
      state.paused = !state.paused;
      if (state.paused) {
        state.svg.classList.add("paused");
        state.overlay.textContent = "⏸";
        state.chartWrap.setAttribute("aria-label", "Resume latency polling");
      } else {
        state.svg.classList.remove("paused");
        state.overlay.textContent = "";
        state.chartWrap.setAttribute("aria-label", "Pause latency polling");
      }
      state.chartWrap.setAttribute("aria-pressed", String(state.paused));
    };

    state.chartWrap.addEventListener("click", togglePause);
  }

  async function refreshIp(state) {
    if (state.ipInFlight) return;
    state.ipInFlight = true;
    state.rowIP.setAttribute("aria-busy", "true");

    try {
      state.valIP.textContent = await fetchClientIP();
      state.hasIpResult = true;
      setAvailability(state.rowIP, state.ipStatus, false);
    } catch {
      const message = state.hasIpResult
        ? "Public IP unavailable; showing previous value."
        : "Public IP unavailable.";
      setAvailability(state.rowIP, state.ipStatus, true, message);
    } finally {
      state.rowIP.setAttribute("aria-busy", "false");
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
      if (state.samples.length > state.cfg.maxSamples) {
        state.samples.shift();
      }
      renderSparkline(state.svg, state.samples);
      state.rJitter.textContent = `jitter: ${computeJitter(state.samples)} ms`;
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

  function startIpPolling(state) {
    void refreshIp(state);
    state.ipTimer = setInterval(() => void refreshIp(state), state.cfg.ipRefreshMs);
  }

  function startPingPolling(state) {
    state.pingTimer = setInterval(() => void refreshPing(state), state.cfg.pingIntervalMs);
  }

  window.DASH.registerWidget("netstats", {
    mount(root, { props = {} }) {
      ensureStyles();

      const cfg = {
        ipRefreshMs:      (props?.ipRefreshMs      ?? 600000),
        pingIntervalMs:   (props?.pingIntervalMs   ?? 5000),
        maxSamples:       (props?.maxSamples       ?? 60)
      };

      // parent wrapper
      const wrap = document.createElement("div");
      wrap.className = "panel-split";

      // LEFT - IP, download/upload speeds
      const left = document.createElement("div");
      left.className = "panel-sidebar";

      // IP row
      const { row: rowIP, valueEl: valIP } = createMetricRow("Public IP", "—");
      const ipStatus = createStatus();

      // clickable block for download / upload speed
      const speedBlock = document.createElement("button");
      speedBlock.type = "button";
      speedBlock.className = "netstats-speed-block clickable";
      speedBlock.setAttribute("aria-busy", "false");
      speedBlock.setAttribute("aria-label", "Run network speed test");

      const { row: rowDL, valueEl: valDL } = createMetricRow("Download", "-", "span");
      const { row: rowUL, valueEl: valUL } = createMetricRow("Upload", "-", "span");
      const { row: rowPing, valueEl: valPing } = createMetricRow("Ping", "-", "span");
      const speedStatus = createStatus();

      speedBlock.appendChild(rowDL);
      speedBlock.appendChild(rowUL);
      speedBlock.appendChild(rowPing);
      speedBlock.appendChild(speedStatus);

      left.appendChild(rowIP);
      left.appendChild(ipStatus);
      left.appendChild(speedBlock);

      // RIGHT - latency graph
      const right = document.createElement("div");
      right.className = "panel-main";

      // labels
      const labels = document.createElement("div");
      labels.className = "netstats-graph-labels";
      const rTitle = document.createElement("div");
      rTitle.className = "label-info";
      rTitle.textContent = "Latency (ms)";
      const rJitter = document.createElement("div");
      rJitter.className = "label-info";
      rJitter.textContent = "jitter: —";
      labels.appendChild(rTitle);
      labels.appendChild(rJitter);

      // latency graph
      const chartWrap = document.createElement("button");
      chartWrap.type = "button";
      chartWrap.className = "net-chart-wrap netstats-chart-button clickable";
      chartWrap.setAttribute("aria-busy", "false");
      chartWrap.setAttribute("aria-label", "Pause latency polling");
      chartWrap.setAttribute("aria-pressed", "false");
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("net-chart");
      const overlay = document.createElement("span");
      overlay.className = "center-overlay net-chart-overlay";
      overlay.textContent = "";
      chartWrap.appendChild(svg);
      chartWrap.appendChild(overlay);
      const pingStatus = createStatus();

      right.appendChild(chartWrap);
      right.appendChild(labels);
      right.appendChild(pingStatus);

      // assemble
      wrap.appendChild(left);
      wrap.appendChild(right);
      root.replaceChildren(wrap);

      return {
        cfg, root, wrap,
        rowIP, valIP, ipStatus,
        speedBlock, valDL, valUL, valPing, speedStatus,
        chartWrap, svg, overlay, rJitter, pingStatus,
        ipTimer: null, pingTimer: null,
        samples: [],
        paused: false,
        running: false,
        ipInFlight: false,
        pingInFlight: false,
        hasIpResult: false,
        hasPingResult: false,
        hasSpeedResult: false
      };
    },

    async update(state) {
      if (state.ipTimer !== null)
        return;   // only attach once

      attachSpeedBlockHandlers(state);
      attachChartHandlers(state);
      startIpPolling(state);
      startPingPolling(state);
    }
  });
})();
