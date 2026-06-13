import { validateDashboardConfig } from "./config-validator.mjs";

// Global registry (widgets do: window.DASH.registerWidget(...))
const REGISTRY = new Map();
const LOADED_TYPES = new Set();
function registerWidget(type, impl){ REGISTRY.set(type, impl); }
window.DASH = Object.freeze({ registerWidget, get config(){ return window.DASH_CONFIG; } });

function renderMessage(grid, { title, lines = [], className = "" }) {
  const element = document.createElement("section");
  element.className = `widget ${className}`.trim();

  const heading = document.createElement("div");
  heading.className = "label";
  heading.textContent = title;
  element.appendChild(heading);

  for (const line of lines) {
    const item = document.createElement("div");
    item.className = "label-info";
    item.textContent = line;
    element.appendChild(item);
  }

  grid.replaceChildren(element);
}

function renderWidgetError(element, message) {
  element.classList.add("error");
  element.replaceChildren();

  const heading = document.createElement("div");
  heading.className = "label";
  heading.textContent = "Widget unavailable";

  const detail = document.createElement("div");
  detail.className = "label-info";
  detail.textContent = message;

  element.append(heading, detail);
}

// Dynamic import of ../widgets/<type>.js
async function ensureWidgetTypeLoaded(type) {
  if (REGISTRY.has(type) || LOADED_TYPES.has(type))
    // already loaded
    return;

  if (!/^[a-z0-9_-]+$/i.test(type))
    // filter characters
    throw new Error(`Invalid widget type: ${type}`);
  
  // looks valid; load
  await import(`../widgets/${type}.js`);
  LOADED_TYPES.add(type);
}

// Grid helpers (JS sets CSS variables; CSS @media can override)
function applyGrid(gridElement, opts) {
  const config_grid = opts?.grid ?? {};

  // grid gap requested?
  if (Number.isFinite(config_grid.gap))
    gridElement.style.setProperty('--grid-gap', `${config_grid.gap}px`);
 
  // grid min column width requested?
  if (Number.isFinite(config_grid.minColWidth))
    gridElement.style.setProperty('--grid-min-col', `${config_grid.minColWidth}px`);

  // grid overall width requested?
  if (config_grid.width)
    gridElement.style.setProperty('--grid-width', config_grid.width);

  // grid number of columns requested?
  const cols = config_grid.columns ?? "auto";
  const template = (cols === "auto")
    ? `repeat(auto-fill, minmax(var(--grid-min-col), 1fr))`
    : `repeat(${Math.max(1, +cols || 1)}, 1fr)`;
  gridElement.style.setProperty('--grid-columns', template);
}

// clamp requestedAmt < total; special case "all"
function clampOrAll(requested, total) {
  return requested === "all" ? total : Math.min(Math.max(1, +requested||1), total);
}

// helper on load: create a minimal shell with a skeleton placeholder
function skeletonShell({ id }){
  const element = document.createElement('section');
  element.className = 'widget';
  element.id = `w-${id}`;
  const content = document.createElement('div');
  content.className = 'content--pending';
  const skel = document.createElement('div');
  skel.className = 'skeleton';
  skel.innerHTML = `
    <div class="skeleton-row skeleton-wide"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  `;
  content.appendChild(skel);
  element.appendChild(content);
  return { element };
}

async function start(){
  const grid = document.getElementById('grid');
  const cfg = window.DASH_CONFIG || { widgets: [] };
  const validation = validateDashboardConfig(cfg);

  if (!validation.ok) {
    renderMessage(grid, {
      title: "Dashboard configuration error",
      lines: validation.errors,
      className: "error"
    });
    return;
  }

  // apply config requested grid options to css
  applyGrid(grid, cfg.options);
  // check against actual css as to what we're using
  const cssCols = getComputedStyle(grid).gridTemplateColumns || "";
  // clamp
  let totalCols = Math.max(1, cssCols.split(/\s+(?![^()]*\))/).filter(Boolean).length);

  // create skeletons immediately
  const mounted = [];
  for (const widg of cfg.widgets){
    const { element } = skeletonShell(widg);

    // have skeletons mirror actual config layout
    const requested_width = (widg.width === 'all') ? 'all' : String(widg.width ?? '1');
    element.dataset.requestedSpan = requested_width;
    element.style.gridColumn = `span ${clampOrAll(requested_width, totalCols)}`;
    grid.appendChild(element);

    mounted.push({ widg, element });
  }

  if (mounted.length === 0) {
    renderMessage(grid, {
      title: "Dashboard shell ready",
      lines: validation.warnings.length ? validation.warnings : ["No widgets are enabled."]
    });
    return;
  }

  for (const { widg, element } of mounted){
    try {
      await ensureWidgetTypeLoaded(widg.type);
    } catch (e) {
      renderWidgetError(element, `Failed to load type "${widg.type}": ${String(e?.message || e)}`);
      continue;
    }

    const impl = REGISTRY.get(widg.type);
    if (!impl) {
      renderWidgetError(element, `Missing widget type: ${widg.type}`);
      continue;
    }
  
    let instance;
    // try to mount into the same content node (widget decides if it needs to keep the skeleton for a minute)
    try {
      instance = impl.mount(element, {
        id: widg.id,
        type: widg.type,
        props: widg.props
      });
    } catch (e) {
      renderWidgetError(element, `Mount failed: ${String(e?.message || e)}`);
      continue;
    }

    const refresh = async () => {
      try {
        await impl.update(instance);
      } catch (e) {
        renderWidgetError(element, `Update failed: ${String(e?.message || e)}`);
      }
    };
    await refresh();

    // update refresh interval if set
    if (widg.refreshMs > 0)
      setInterval(refresh, widg.refreshMs);
  }
}

// add entry point
window.addEventListener('DOMContentLoaded', start);
