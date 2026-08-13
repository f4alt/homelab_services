const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const POPUP_ANCHOR_PREFIX = "--dashboard-popup-anchor";
const POPUP_ANCHOR_SUPPORT_QUERIES = Object.freeze([
  `anchor-name: ${POPUP_ANCHOR_PREFIX}`,
  `position-anchor: ${POPUP_ANCHOR_PREFIX}`,
  "top: anchor(top)",
  "left: anchor(50%)",
  "width: anchor-size(width)"
]);
let nextPopupAnchorIndex = 0;

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

function prepareFloatingPopup(trigger, popup) {
  if (
    typeof CSS === "undefined" ||
    typeof CSS.supports !== "function" ||
    !POPUP_ANCHOR_SUPPORT_QUERIES.every((query) => CSS.supports(query)) ||
    typeof popup.showPopover !== "function" ||
    typeof popup.hidePopover !== "function"
  ) {
    return false;
  }

  nextPopupAnchorIndex += 1;
  const anchorName = `${POPUP_ANCHOR_PREFIX}-${nextPopupAnchorIndex}`;

  trigger.style.setProperty("anchor-name", anchorName);
  popup.style.setProperty("position-anchor", anchorName);
  popup.setAttribute("popover", "manual");
  popup.classList.add("popup--floating");
  return true;
}

export function bindHoverPopup(trigger, popup) {
  if (!prepareFloatingPopup(trigger, popup)) return false;

  let focused = false;
  let hovered = false;
  let open = false;

  function syncVisibility() {
    const shouldOpen = focused || hovered;
    if (shouldOpen === open) return;

    if (shouldOpen) popup.showPopover();
    else popup.hidePopover();
    open = shouldOpen;
  }

  trigger.addEventListener("mouseenter", () => {
    hovered = true;
    syncVisibility();
  });
  trigger.addEventListener("mouseleave", () => {
    hovered = false;
    syncVisibility();
  });
  trigger.addEventListener("focusin", () => {
    focused = true;
    syncVisibility();
  });
  trigger.addEventListener("focusout", () => {
    focused = false;
    syncVisibility();
  });
  return true;
}

export function createDismissalController({ containsTarget, onDismiss }) {
  let active = false;

  function deactivate() {
    if (!active) return;

    active = false;
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onDocumentKeydown);
  }

  function dismiss(restoreFocus) {
    deactivate();
    onDismiss({ restoreFocus });
  }

  function onDocumentClick(event) {
    if (!containsTarget(event.target)) dismiss(false);
  }

  function onDocumentKeydown(event) {
    if (event.key === "Escape") dismiss(true);
  }

  function activate() {
    if (active) return;

    active = true;
    document.addEventListener("click", onDocumentClick);
    document.addEventListener("keydown", onDocumentKeydown);
  }

  return Object.freeze({ activate, deactivate });
}

export function createDismissibleMenu({
  trigger,
  menu,
  containsTarget = (target) => trigger.contains(target) || menu.contains(target),
  onOpenChange = () => {}
}) {
  let open = false;
  const floating = prepareFloatingPopup(trigger, menu);
  const dismissalController = createDismissalController({
    containsTarget,
    onDismiss: ({ restoreFocus }) => {
      close();
      if (restoreFocus) trigger.focus();
    }
  });

  function setOpen(nextOpen) {
    const next = Boolean(nextOpen);
    if (next === open) return;

    open = next;
    trigger.setAttribute("aria-expanded", String(open));

    if (open) {
      menu.classList.add("popup-menu-open");
      if (floating) menu.showPopover();
      dismissalController.activate();
    } else {
      if (floating) menu.hidePopover();
      menu.classList.remove("popup-menu-open");
      dismissalController.deactivate();
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
