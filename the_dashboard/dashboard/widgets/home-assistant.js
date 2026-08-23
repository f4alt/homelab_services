import {
  createDismissalController,
  createElement,
  createResponsiveGrid,
  createStack,
  createWidgetMessage,
  fetchJson,
  installWidgetStyles,
  prepareFlippableTile,
  setFlippableTileState
} from "../platform/global.js";

const HOME_ASSISTANT_STYLE_ID = "home-assistant-widget-styles";
const HOME_ASSISTANT_STYLES = `
    .home-assistant-tile {
      appearance: none;
      background: transparent;
      border: 0;
      color: inherit;
      cursor: pointer;
      font: inherit;
      padding: 0;
      text-align: center;
    }

    .home-assistant-tile.is-error {
      border: 0 !important;
      padding: 0;
    }

    .home-assistant-tile.is-error .home-assistant-face--back {
      border-color: var(--err-muted) !important;
    }

    .home-assistant-face {
      align-items: center;
      color: inherit;
      display: flex;
      justify-content: center;
      overflow-wrap: anywhere;
    }

    .home-assistant-tile:focus-visible .home-assistant-face--front {
      border-color: var(--clickable-hover-border);
      box-shadow: var(--shadow-surface-hover);
    }

    .home-assistant-tile:disabled {
      color: var(--muted);
      cursor: wait;
    }

    .home-assistant-tile:disabled .home-assistant-face--front {
      cursor: wait;
    }
  `;

function isPlainObject(value) {
  if (!value || typeof value !== "object") return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeButtons(buttons) {
  if (!Array.isArray(buttons)) return [];

  return buttons.flatMap((button) => {
    if (!isPlainObject(button)) return [];
    if (typeof button.name !== "string" || typeof button.api !== "string") return [];

    const name = button.name.trim();
    const api = button.api.trim();
    return name && api ? [{ name, api }] : [];
  });
}

function syncTileFlipState(tileView, flipped) {
  setFlippableTileState(tileView, flipped);
  tileView.tile.setAttribute("aria-expanded", String(flipped));
}

function closeActionResult(state, restoreFocus = false) {
  const tileView = state.openTileView;
  if (!tileView) return;

  syncTileFlipState(tileView, false);
  tileView.tile.classList.remove("is-error");
  state.openTileView = null;
  state.resultDismissal.deactivate();
  if (restoreFocus) tileView.tile.focus();
}

function showActionResult(state, tileView, message, isError) {
  closeActionResult(state);
  tileView.tile.classList.toggle("is-error", isError);
  state.openTileView = tileView;
  syncTileFlipState(tileView, true);
  tileView.back.textContent = message;
  state.resultDismissal.activate();
}

function createActionTile(state, action) {
  const tile = createElement(
    "button",
    "flippable-tile home-assistant-tile"
  );
  tile.type = "button";
  const flipper = createElement("span", "flippable-tile-inner");
  const front = createElement(
    "span",
    "ui-tile flippable-tile-face flippable-tile-face--front home-assistant-face home-assistant-face--front",
    action.name
  );
  const back = createElement("span");
  back.className = [
    "ui-tile",
    "flippable-tile-face",
    "flippable-tile-face--back",
    "home-assistant-face",
    "home-assistant-face--back"
  ].join(" ");
  back.setAttribute("aria-live", "polite");
  flipper.append(front, back);
  tile.appendChild(flipper);

  const tileView = { back, front, pending: false, tile };
  prepareFlippableTile(tileView);
  syncTileFlipState(tileView, false);

  tile.addEventListener("click", async () => {
    if (state.openTileView === tileView) {
      closeActionResult(state);
      return;
    }
    if (tileView.pending) return;

    tileView.pending = true;
    tile.disabled = true;
    back.textContent = "";

    try {
      await fetchJson("/home-assistant/actions", {
        fetchOptions: {
          method: "POST",
          body: JSON.stringify({ api: action.api })
        }
      });
      showActionResult(state, tileView, `Ran ${action.name}.`, false);
    } catch (error) {
      showActionResult(
        state,
        tileView,
        String(error?.message || `Unable to run ${action.name}.`),
        true
      );
    } finally {
      tileView.pending = false;
      tile.disabled = false;
    }
  });

  return tile;
}

window.DASH.registerWidget("home-assistant", {
  mount(root, { props = {} }) {
    installWidgetStyles(HOME_ASSISTANT_STYLE_ID, HOME_ASSISTANT_STYLES);

    const shell = createStack();
    shell.classList.add("widget-body");

    const actions = createResponsiveGrid(props);
    const state = { openTileView: null, resultDismissal: null };
    state.resultDismissal = createDismissalController({
      containsTarget: (target) => state.openTileView?.tile.contains(target) || false,
      onDismiss: ({ restoreFocus }) => closeActionResult(state, restoreFocus)
    });
    const configuredActions = normalizeButtons(props.buttons);
    for (const action of configuredActions) {
      actions.appendChild(createActionTile(state, action));
    }
    if (configuredActions.length === 0) {
      actions.appendChild(
        createWidgetMessage("No Home Assistant actions configured.")
      );
    }

    shell.appendChild(actions);
    root.replaceChildren(shell);
  }
});
