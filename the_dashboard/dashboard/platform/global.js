export function apiBase() {
  return (window.DASH_CONFIG?.apiBase ?? "").replace(/\/+$/, "");
}

export function apiUrl(path) {
  const base = apiBase();
  const cleanPath = String(path || "").replace(/^\/+/, "");
  return cleanPath ? `${base}/${cleanPath}` : base;
}

export async function fetchJson(pathOrUrl, options = {}) {
  const {
    timeoutMs = 8000,
    envelope = true,
    fetchOptions = {}
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const rawUrl = String(pathOrUrl);
  const base = apiBase();
  const isAbsolute = /^https?:\/\//i.test(rawUrl);
  const isApiRootRelative = base && rawUrl.startsWith(`${base}/`);
  const url = isAbsolute || isApiRootRelative ? rawUrl : apiUrl(rawUrl);

  try {
    const response = await fetch(url, {
      cache: "no-store",
      ...fetchOptions,
      headers: {
        Accept: "application/json",
        ...(fetchOptions.body ? { "Content-Type": "application/json" } : {}),
        ...(fetchOptions.headers || {})
      },
      signal: fetchOptions.signal || controller.signal
    });
    const json = await response.json().catch(() => null);

    if (!response.ok) {
      const message = json?.error?.message || json?.error || `HTTP ${response.status}`;
      throw new Error(message);
    }
    if (envelope) {
      if (json?.ok === false) {
        throw new Error(json?.error?.message || json?.error || "Request failed.");
      }
      return json?.data ?? json;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createWidgetMessage(message, className = "") {
  return createElement("div", `widget-message label-info ${className}`.trim(), message);
}

export function setStateMessage(container, message, state = "") {
  container.classList.remove("is-loading", "is-empty", "is-error");
  if (state) container.classList.add(`is-${state}`);
  container.replaceChildren(createWidgetMessage(message));
}

export function createResponsiveGrid(props = {}, className = "list-tiled") {
  const grid = createElement("div", className);

  if (props?.tile_columns)
    grid.style.setProperty("--tile-columns", props.tile_columns);
  if (props?.tile_gap)
    grid.style.setProperty("--tile-gap", `${props.tile_gap}px`);
  if (props?.tile_minWidth)
    grid.style.setProperty("--tile-min", `${props.tile_minWidth}px`);

  return grid;
}

export function createStack() {
  return createElement("div", "list-fullWidth");
}

export function createTile(className = "") {
  return createElement("div", `ui-tile ${className}`.trim());
}

export function createStyledIcon(icon) {
  const iconBox = createElement("div", "icon");

  if (!icon) {
    iconBox.textContent = "-";
    return iconBox;
  }

  if (String(icon).startsWith("/") || String(icon).startsWith("http")) {
    const img = document.createElement("img");
    img.src = icon;
    img.alt = "icon";
    iconBox.appendChild(img);
    return iconBox;
  }

  iconBox.textContent = icon;
  return iconBox;
}
