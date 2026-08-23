const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const OVERLAY_ANCHOR_PREFIX = "--dashboard-overlay-anchor";
const OVERLAY_ANCHOR_SUPPORT_QUERIES = Object.freeze([
  `anchor-name: ${OVERLAY_ANCHOR_PREFIX}`,
  `position-anchor: ${OVERLAY_ANCHOR_PREFIX}`,
  "top: anchor(top)",
  "left: anchor(50%)",
  "width: anchor-size(width)",
  "height: anchor-size(block)"
]);
let nextOverlayAnchorIndex = 0;

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
  const base = (window.DASH_CONFIG?.apiBase ?? "").replace(/\/+$/, "");
  const isAbsolute = /^https?:\/\//i.test(rawUrl);
  const isApiRootRelative = base && rawUrl.startsWith(`${base}/`);
  const cleanPath = rawUrl.replace(/^\/+/, "");
  const joinedUrl = cleanPath ? `${base}/${cleanPath}` : base;
  const url = isAbsolute || isApiRootRelative ? rawUrl : joinedUrl;

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

function demoteFlippableBack(back) {
  if (!back.matches(":popover-open")) return;

  back.hidePopover();
}

function prefersReducedMotion() {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function constrainFlippableBackToViewport(front, back) {
  if (typeof front.getBoundingClientRect !== "function") return;

  const frontBounds = front.getBoundingClientRect();
  const viewportWidth = document.documentElement?.clientWidth || window.innerWidth;
  if (
    !Number.isFinite(frontBounds.left) ||
    !Number.isFinite(frontBounds.width) ||
    !Number.isFinite(viewportWidth)
  ) {
    return;
  }

  const frontCenter = frontBounds.left + (frontBounds.width / 2);
  const nearestViewportEdge = Math.max(
    0,
    Math.min(frontCenter, viewportWidth - frontCenter)
  );
  const symmetricViewportWidth = nearestViewportEdge * 2;
  const maximumWidth = Math.max(frontBounds.width, symmetricViewportWidth);
  back.style.setProperty("--flippable-tile-max-width", `${maximumWidth}px`);
}

function promoteFlippableBack(front, back) {
  if (!back.classList.contains("flippable-tile-face--floating")) return;

  constrainFlippableBackToViewport(front, back);
  if (back.matches(":popover-open")) return;

  try {
    back.showPopover();
    // Commit the hidden starting face before applying the flipped transform.
    back.getBoundingClientRect?.();
  } catch {
    // Top-layer positioning is an enhancement; keep the centered fallback usable.
    back.classList.remove("flippable-tile-face--floating");
    back.removeAttribute("popover");
  }
}

export function setFlippableTileState({ tile, front, back }, flipped) {
  if (flipped) promoteFlippableBack(front, back);
  tile.classList.toggle("flippable-tile--flipped", flipped);
  front.setAttribute("aria-hidden", String(flipped));
  back.setAttribute("aria-hidden", String(!flipped));
  if (!flipped && prefersReducedMotion()) demoteFlippableBack(back);
}

function anchorOverlay(anchor, overlay) {
  if (
    typeof CSS === "undefined" ||
    typeof CSS.supports !== "function" ||
    !OVERLAY_ANCHOR_SUPPORT_QUERIES.every((query) => CSS.supports(query))
  ) {
    return false;
  }

  nextOverlayAnchorIndex += 1;
  const anchorName = `${OVERLAY_ANCHOR_PREFIX}-${nextOverlayAnchorIndex}`;

  anchor.style.setProperty("anchor-name", anchorName);
  overlay.style.setProperty("position-anchor", anchorName);
  return true;
}

export function prepareFlippableTile({ tile, front, back }) {
  if (
    typeof back.showPopover !== "function" ||
    typeof back.hidePopover !== "function" ||
    !anchorOverlay(front, back)
  ) {
    return false;
  }

  back.setAttribute("popover", "manual");
  back.classList.add("flippable-tile-face--floating");
  const demoteAfterClosing = (event) => {
    if (
      event.target === back &&
      event.propertyName === "transform" &&
      !tile.classList.contains("flippable-tile--flipped")
    ) {
      demoteFlippableBack(back);
    }
  };
  back.addEventListener("transitioncancel", demoteAfterClosing);
  back.addEventListener("transitionend", demoteAfterClosing);
  return true;
}

function prepareFloatingPopup(trigger, popup) {
  if (
    typeof popup.showPopover !== "function" ||
    typeof popup.hidePopover !== "function" ||
    !anchorOverlay(trigger, popup)
  ) {
    return false;
  }

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
