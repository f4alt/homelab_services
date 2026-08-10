const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;

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
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    envelope = true,
    fetchOptions = {}
  } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const callerSignal = fetchOptions.signal;
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }
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
      signal: controller.signal
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
    callerSignal?.removeEventListener("abort", abortFromCaller);
  }
}

export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function installWidgetStyles(styleId, cssText) {
  if (document.getElementById(styleId)) return;

  const style = createElement("style");
  style.id = styleId;
  style.textContent = cssText;
  document.head.appendChild(style);
}

export function createWidgetMessage(message, className = "") {
  return createElement("div", `widget-message label-info ${className}`.trim(), message);
}

export function setStateMessage(container, message, state = "") {
  container.classList.remove("is-loading", "is-empty", "is-error");
  if (state) container.classList.add(`is-${state}`);
  container.replaceChildren(createWidgetMessage(message));
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function createResponsiveGrid(props = {}, className = "list-tiled") {
  const grid = createElement("div", className);
  const tileColumns = positiveInteger(props?.tileColumns);

  if (tileColumns !== null) {
    grid.classList.add("list-tiled--preferred-columns");
    grid.style.setProperty("--tile-columns", String(tileColumns));
    grid.style.setProperty("--tile-column-gaps", String(tileColumns - 1));
  }
  if (Number.isFinite(props?.tileGap) && props.tileGap >= 0) {
    grid.style.setProperty("--tile-gap", `${props.tileGap}px`);
  }
  if (Number.isFinite(props?.tileMinWidth) && props.tileMinWidth > 0) {
    grid.style.setProperty("--tile-min", `${props.tileMinWidth}px`);
  }

  return grid;
}

export function createStack() {
  return createElement("div", "list-fullWidth");
}

export function createTile(className = "") {
  return createElement("div", `ui-tile ${className}`.trim());
}

export function createDismissibleMenu({
  trigger,
  menu,
  containsTarget = (target) => trigger.contains(target) || menu.contains(target),
  onOpenChange = () => {}
}) {
  let open = false;

  function onDocumentClick(event) {
    if (!containsTarget(event.target)) close();
  }

  function onDocumentKeydown(event) {
    if (event.key !== "Escape") return;
    close();
    trigger.focus();
  }

  function setOpen(nextOpen) {
    const next = Boolean(nextOpen);
    if (next === open) return;

    open = next;
    trigger.setAttribute("aria-expanded", String(open));
    menu.classList.toggle("popup-menu-open", open);

    if (open) {
      document.addEventListener("click", onDocumentClick);
      document.addEventListener("keydown", onDocumentKeydown);
    } else {
      document.removeEventListener("click", onDocumentClick);
      document.removeEventListener("keydown", onDocumentKeydown);
    }

    onOpenChange(open);
  }

  function close() {
    setOpen(false);
  }

  trigger.setAttribute("aria-expanded", "false");
  menu.classList.remove("popup-menu-open");

  return Object.freeze({
    close,
    isOpen: () => open,
    open: () => setOpen(true),
    toggle: () => setOpen(!open)
  });
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
