import { createResponsiveGrid, createStyledIcon, fetchJson, setStateMessage } from "../platform/global.js";

(function () {
  function ensureStyles() {
    if (document.getElementById("status-inline-styles")) return;
    const s = document.createElement("style");
    s.id = "status-inline-styles";
    s.textContent = `
      .status-tile {
        display: grid;
        grid-template-columns: auto auto 1fr;
        align-items: center;
        gap: 8px 10px;
        padding: 0;
      }

      .status-popup-target {
        --dot-size: 16px;
        --popup-transform: translate(-20%, -90%);
      }
    `;
    document.head.appendChild(s);
  }

  async function tryStatusChecks(services, signal) {
    const data = await fetchJson("/statuschecks", {
      fetchOptions: {
        method: "POST",
        body: JSON.stringify({ targets: services.map(s => ({ url: s.url })) }),
        signal
      }
    });
    return Array.isArray(data?.results) ? data.results : [];
  }

  function linkForTarget(target) {
    const value = String(target || "");
    return /^https?:\/\//i.test(value) ? value : `http://${value}`;
  }

  window.DASH.registerWidget("status", {
    mount(root, { props = {} }) {
      ensureStyles();

      const grid = createResponsiveGrid(props);
      root.replaceChildren(grid);

      const services = Array.isArray(props?.services) ? props.services : [];
      if (!services.length) {
        setStateMessage(grid, "No status checks configured.", "empty");
      }
      const tilesByUrl = new Map();

      for (const svc of services) {
        const a = document.createElement("a");
        a.className = "clickable";  // global.css
        a.href = linkForTarget(svc.url);
        a.target = "_blank";
        a.rel = "noopener noreferrer";

        const tile = document.createElement("div");
        tile.className = "status-tile";

        // status dot
        const dotWrap = document.createElement("div");
        dotWrap.className = "popup-on-hover status-popup-target";

        const dot = document.createElement("div");
        dot.className = "dot dot--warn";
        dot.setAttribute("tabindex", "0");
        dot.setAttribute("role", "img");
        dot.setAttribute("aria-label", `${svc.name || svc.url} status unknown`);
        dot.dataset.tip = "checking…";

        // popup using shared .popup styling
        const popup = document.createElement("div");
        popup.className = "popup label-info";
        popup.textContent = dot.dataset.tip;

        // icon
        const iconBox = createStyledIcon(svc.icon);

        // name
        const name = document.createElement("div");
        name.className = "label";
        name.textContent = svc.name || svc.url;

        dotWrap.append(dot, popup);
        tile.append(dotWrap, iconBox, name);
        a.appendChild(tile);
        grid.appendChild(a);

        tilesByUrl.set(svc.url, { svc, dot, a, popup });
      }

      return { root, services, tilesByUrl, aborter: null };
    },

    async update(state) {
      const { services, tilesByUrl } = state;
      if (!services.length)
        return;

      if (state.aborter)
        state.aborter.abort();
      state.aborter = new AbortController();

      let results = [];
      try {
        results = await tryStatusChecks(services, state.aborter.signal);
      } catch {
        for (const { svc, dot, a, popup } of tilesByUrl.values()) {
          dot.className = "dot dot--warn";
          const tip = "gateway unreachable";
          dot.dataset.tip = tip;
          dot.setAttribute("aria-label", `${svc.name || svc.url} status unknown (gateway)`);
          popup.textContent = tip;
          a.href = linkForTarget(svc.url);
        }
        return;
      }

      const byTarget = new Map(results.map(r => [r.target, r]));
      for (const { svc, dot, a, popup } of tilesByUrl.values()) {
        const r = byTarget.get(svc.url);
        if (!r) {
          dot.className = "dot dot--warn";
          const tip = "no data";
          dot.dataset.tip = tip;
          dot.setAttribute("aria-label", `${svc.name || svc.url} status unknown`);
          popup.textContent = tip;
          a.href = linkForTarget(svc.url);
          continue;
        }

        if (r.ok) {
          dot.className = "dot dot--ok";
          const code = r.status ?? 0;
          const ms = r.latency_ms ?? 0;
          const tip = `HTTP ${code} • ${ms}ms`;
          dot.dataset.tip = tip;
          dot.setAttribute("aria-label", `${svc.name || svc.url} up — ${tip}`);
          popup.textContent = tip;
          a.href = r.final_url ? r.final_url : linkForTarget(svc.url);
        } else {
          dot.className = "dot dot--err";
          const msg = (r.error?.message || r.error || "down").replace(/^Error:\s*/i, "");
          dot.dataset.tip = msg;
          dot.setAttribute("aria-label", `${svc.name || svc.url} down — ${msg}`);
          popup.textContent = msg;
          a.href = linkForTarget(svc.url);
        }
      }
    }
  });
})();
