import { validateDashboardConfig } from "./config-validator.mjs";

const REGISTRY = new Map();
function registerWidget(type, implementation) {
  REGISTRY.set(type, implementation);
}
window.DASH = Object.freeze({ registerWidget });

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

async function ensureWidgetTypeLoaded(type) {
  if (REGISTRY.has(type)) return;

  // Configuration validation constrains type to a safe import-path identifier.
  await import(`../widgets/${type}.js`);
}

function applyGrid(gridElement, options) {
  const gridOptions = options?.grid ?? {};

  if (Number.isFinite(gridOptions.gap))
    gridElement.style.setProperty("--grid-gap", `${gridOptions.gap}px`);
 
  if (Number.isFinite(gridOptions.minColWidth))
    gridElement.style.setProperty("--grid-min-col", `${gridOptions.minColWidth}px`);

  if (gridOptions.width)
    gridElement.style.setProperty("--grid-width", gridOptions.width);

  const columns = gridOptions.columns ?? "auto";
  const template = columns === "auto"
    ? `repeat(auto-fill, minmax(var(--grid-min-col), 1fr))`
    : `repeat(${Math.max(1, Number(columns) || 1)}, 1fr)`;
  gridElement.style.setProperty("--grid-columns", template);
}

function clampOrAll(requested, total) {
  return requested === "all"
    ? total
    : Math.min(Math.max(1, Number(requested) || 1), total);
}

function createSkeletonShell({ id }) {
  const element = document.createElement("section");
  element.className = "widget";
  element.id = `w-${id}`;
  const content = document.createElement("div");
  content.className = "content--pending";
  const skeleton = document.createElement("div");
  skeleton.className = "skeleton";
  skeleton.innerHTML = `
    <div class="skeleton-row skeleton-wide"></div>
    <div class="skeleton-row"></div>
    <div class="skeleton-row"></div>
  `;
  content.appendChild(skeleton);
  element.appendChild(content);
  return element;
}

async function startDashboard() {
  const grid = document.getElementById("grid");
  const config = window.DASH_CONFIG || { widgets: [] };
  const validation = validateDashboardConfig(config);

  if (!validation.ok) {
    renderMessage(grid, {
      title: "Dashboard configuration error",
      lines: validation.errors,
      className: "error"
    });
    return;
  }

  applyGrid(grid, config.options);
  // CSS media queries can override the configured grid before spans are clamped.
  const renderedColumns = getComputedStyle(grid).gridTemplateColumns || "";
  const totalCols = Math.max(
    1,
    renderedColumns.split(/\s+(?![^()]*\))/).filter(Boolean).length
  );

  const mounted = [];
  for (const widgetConfig of config.widgets) {
    const element = createSkeletonShell(widgetConfig);

    const requestedWidth = widgetConfig.width === "all"
      ? "all"
      : String(widgetConfig.width ?? "1");
    element.style.gridColumn = `span ${clampOrAll(requestedWidth, totalCols)}`;
    grid.appendChild(element);

    mounted.push({ widgetConfig, element });
  }

  if (mounted.length === 0) {
    renderMessage(grid, {
      title: "Dashboard shell ready",
      lines: validation.warnings.length ? validation.warnings : ["No widgets are enabled."]
    });
    return;
  }

  for (const { widgetConfig, element } of mounted) {
    try {
      await ensureWidgetTypeLoaded(widgetConfig.type);
    } catch (error) {
      renderWidgetError(
        element,
        `Failed to load type "${widgetConfig.type}": ${String(error?.message || error)}`
      );
      continue;
    }

    const implementation = REGISTRY.get(widgetConfig.type);
    if (!implementation) {
      renderWidgetError(element, `Missing widget type: ${widgetConfig.type}`);
      continue;
    }

    let instance;
    try {
      instance = implementation.mount(element, {
        id: widgetConfig.id,
        type: widgetConfig.type,
        props: widgetConfig.props
      });
    } catch (error) {
      renderWidgetError(element, `Mount failed: ${String(error?.message || error)}`);
      continue;
    }

    if (typeof implementation.update === "function") {
      const refresh = async () => {
        try {
          await implementation.update(instance);
        } catch (error) {
          renderWidgetError(element, `Update failed: ${String(error?.message || error)}`);
        }
      };
      await refresh();

      if (widgetConfig.refreshMs > 0)
        setInterval(refresh, widgetConfig.refreshMs);
    }
  }
}

window.addEventListener("DOMContentLoaded", startDashboard);
