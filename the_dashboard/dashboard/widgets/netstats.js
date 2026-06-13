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
      gap: var(--gap);
    }
    `;
    document.head.appendChild(s);
  }

  function createMetricRow(label, value = "-") {
    const row = createElement("div", "metric-row metric-row--nowrap");
    const labelEl = createElement("div", "label", label);
    const valueEl = createElement("div", "label-info", value);
    row.append(labelEl, valueEl);
    return { row, labelEl, valueEl };
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


  async function fetchClientIP(signal) {
    try {
      const data = await fetchJson("/net/myip", { fetchOptions: { signal } });
      return data?.ip || "—";
    } catch {}

    return "—";
  }

  async function wanPingOnce() {
    const data = await fetchJson("/net/ping");
    return Number(data?.ms ?? data?.ping_ms ?? 1000);
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
    let ping_running = state.paused;
    state.paused = true;
  
    const block = state.speedBlock;
  
    block.setAttribute("aria-busy", "true");
    state.valDL.textContent = "...";
    state.valUL.textContent = "...";
    state.valPing.textContent = "...";
  
    try {
      state.speedBlock.classList.remove("error");
      const j = await fetchJson("/net/speedtest", { timeoutMs: 185000 });
  
      const dl = Number(j.download_mbps);
      const ul = Number(j.upload_mbps);
  
      state.valDL.textContent = formatMbps(dl);
      state.valUL.textContent = formatMbps(ul);
      state.valPing.textContent = formatMillis(j.ping_ms);
    } catch (err) {
      state.valDL.textContent = "err";
      state.valUL.textContent = "err";
      state.valPing.textContent = "err";
      state.speedBlock.classList.add("error");
    } finally {
      block.setAttribute("aria-busy", "false");
      state.running = false;
      state.paused = ping_running;
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
      } else {
        state.svg.classList.remove("paused");
        state.overlay.textContent = "";
      }
    };

    state.chartWrap.addEventListener("click", togglePause);
  }

  function startIpPolling(state) {
    // initial fetch
    (async () => {
      try {
        state.valIP.textContent = await fetchClientIP();
      } catch {
        state.valIP.textContent = "—";
      }
    })();

    state.ipTimer = setInterval(async () => {
      try {
        state.valIP.textContent = await fetchClientIP();
      } catch {
        // ignore
      }
    }, state.cfg.ipRefreshMs);
  }

  function startPingPolling(state) {
    state.pingTimer = setInterval(async () => {
      try {
        if (state.paused) return;
        const ms = await wanPingOnce();
        state.samples.push(ms);
        if (state.samples.length > state.cfg.maxSamples) {
          state.samples.shift();
        }
        renderSparkline(state.svg, state.samples);
        state.rJitter.textContent = "jitter: " + computeJitter(state.samples) + " ms";
      } catch {
        // drop sample on error
      }
    }, state.cfg.pingIntervalMs);
  }

  window.DASH.registerWidget("netstats", {
    mount(root, { props = {} }) {
      ensureStyles();

      const cfg = {
        ipRefreshMs:      (props?.ipRefreshMs      ?? 600000),
        pingIntervalMs:   (props?.pingIntervalMs   ?? 5000),
        dlBytes:          (props?.dlBytes          ?? 40 * 1024 * 1024),
        ulBytes:          (props?.ulBytes          ?? 12 * 1024 * 1024),
        maxSamples:       (props?.maxSamples       ?? 60),
        dlParallel:       (props?.dlParallel       ?? 4)
      };

      // parent wrapper
      const wrap = document.createElement("div");
      wrap.className = "panel-split";

      // LEFT - IP, download/upload speeds
      const left = document.createElement("div");
      left.className = "panel-sidebar";

      // IP row
      const { row: rowIP, valueEl: valIP } = createMetricRow("Public IP", "—");

      // clickable block for download / upload speed
      const speedBlock = document.createElement("div");
      speedBlock.className = "netstats-speed-block clickable";
      speedBlock.setAttribute("role","button");
      speedBlock.tabIndex = 0;

      const { row: rowDL, valueEl: valDL } = createMetricRow("Download", "-");
      const { row: rowUL, valueEl: valUL } = createMetricRow("Upload", "-");
      const { row: rowPing, valueEl: valPing } = createMetricRow("Ping", "-");

      speedBlock.appendChild(rowDL);
      speedBlock.appendChild(rowUL);
      speedBlock.appendChild(rowPing);

      left.appendChild(rowIP);
      left.appendChild(speedBlock);

      // RIGHT - latency graph
      const right = document.createElement("div");
      right.className = "panel-main clickable";

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
      const chartWrap = document.createElement("div");
      chartWrap.className = "net-chart-wrap";
      chartWrap.tabIndex = 0;
      const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.classList.add("net-chart");
      const overlay = document.createElement("div");
      overlay.className = "center-overlay net-chart-overlay";
      overlay.textContent = "";
      chartWrap.appendChild(svg);
      chartWrap.appendChild(overlay);

      right.appendChild(chartWrap);
      right.appendChild(labels);

      // assemble
      wrap.appendChild(left);
      wrap.appendChild(right);
      root.replaceChildren(wrap);

      return {
        cfg, root, wrap,
        valIP, speedBlock, valDL, valUL, valPing,
        chartWrap, svg, overlay, rJitter,
        ipTimer: null, pingTimer: null,
        samples: [],
        paused: false,
        running: false
      };
    },

    async update(state) {
      if (state.ipTimer)
        return;   // only attach once

      attachSpeedBlockHandlers(state);
      attachChartHandlers(state);
      startIpPolling(state);
      startPingPolling(state);
    }
  });
})();
