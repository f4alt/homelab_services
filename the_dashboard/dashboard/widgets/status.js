import {
  bindHoverPopup,
  createResponsiveGrid,
  createStyledIcon,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";

const STATUS_STYLE_ID = "status-inline-styles";
const STATUS_STYLES = `
    .status-tile {
      align-items: center;
      display: grid;
      gap: var(--space-sm) var(--space-control);
      grid-template-columns: auto auto 1fr;
    }

    .status-popup-target {
      --dot-size: 16px;
      --popup-transform: translate(-20%, -90%);
    }
  `;

async function tryStatusChecks(services, signal) {
  const data = await fetchJson("/statuschecks", {
    fetchOptions: {
      method: "POST",
      body: JSON.stringify({
        targets: services.map((service) => ({ url: service.url }))
      }),
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
    installWidgetStyles(STATUS_STYLE_ID, STATUS_STYLES);

    const grid = createResponsiveGrid(props);
    root.replaceChildren(grid);

    const services = Array.isArray(props?.services) ? props.services : [];
    if (!services.length) {
      setStateMessage(grid, "No status checks configured.", "empty");
    }
    const tiles = [];

    for (const service of services) {
      const link = document.createElement("a");
      link.className = "clickable";
      link.href = linkForTarget(service.url);
      link.target = "_blank";
      link.rel = "noopener noreferrer";

      const tile = document.createElement("div");
      tile.className = "status-tile";
      const dotWrap = document.createElement("div");
      dotWrap.className = "popup-on-hover status-popup-target";

      const dot = document.createElement("div");
      dot.className = "dot dot--warn";
      dot.setAttribute("tabindex", "0");
      dot.setAttribute("role", "img");
      dot.setAttribute("aria-label", `${service.name || service.url} status unknown`);
      dot.dataset.tip = "checking…";

      const popup = document.createElement("div");
      popup.className = "popup label-info";
      popup.textContent = dot.dataset.tip;
      const iconBox = createStyledIcon(service.icon);
      const name = document.createElement("div");
      name.className = "label";
      name.textContent = service.name || service.url;

      dotWrap.append(dot, popup);
      bindHoverPopup(dotWrap, popup);
      tile.append(dotWrap, iconBox, name);
      link.appendChild(tile);
      grid.appendChild(link);
      tiles.push({ service, dot, link, popup });
    }

    return { services, tiles, aborter: null };
  },

  async update(state) {
    const { services, tiles } = state;
    if (!services.length) return;

    state.aborter?.abort();
    const aborter = new AbortController();
    state.aborter = aborter;

    try {
      const results = await tryStatusChecks(services, aborter.signal);
      if (state.aborter !== aborter || aborter.signal.aborted) return;

      const resultsByTarget = new Map(results.map((result) => [result.target, result]));
      for (const { service, dot, link, popup } of tiles) {
        const result = resultsByTarget.get(service.url);
        if (!result) {
          dot.className = "dot dot--warn";
          const tip = "no data";
          dot.dataset.tip = tip;
          dot.setAttribute("aria-label", `${service.name || service.url} status unknown`);
          popup.textContent = tip;
          link.href = linkForTarget(service.url);
          continue;
        }

        if (result.ok) {
          dot.className = "dot dot--ok";
          const code = result.status ?? 0;
          const milliseconds = result.latency_ms ?? 0;
          const tip = `HTTP ${code} • ${milliseconds}ms`;
          dot.dataset.tip = tip;
          dot.setAttribute("aria-label", `${service.name || service.url} up — ${tip}`);
          popup.textContent = tip;
          link.href = result.final_url ? result.final_url : linkForTarget(service.url);
        } else {
          dot.className = "dot dot--err";
          const message = (result.error?.message || result.error || "down")
            .replace(/^Error:\s*/i, "");
          dot.dataset.tip = message;
          dot.setAttribute("aria-label", `${service.name || service.url} down — ${message}`);
          popup.textContent = message;
          link.href = linkForTarget(service.url);
        }
      }
    } catch {
      if (state.aborter !== aborter || aborter.signal.aborted) return;

      for (const { service, dot, link, popup } of tiles) {
        dot.className = "dot dot--warn";
        const tip = "gateway unreachable";
        dot.dataset.tip = tip;
        dot.setAttribute(
          "aria-label",
          `${service.name || service.url} status unknown (gateway)`
        );
        popup.textContent = tip;
        link.href = linkForTarget(service.url);
      }
    } finally {
      if (state.aborter === aborter) state.aborter = null;
    }
  }
});
