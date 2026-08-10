import {
  createDismissibleMenu,
  createElement,
  createResponsiveGrid,
  createTile,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";
import {
  getTimeSincePresentation,
  normalizeApproachingRatio,
  normalizeTimeSinceItems
} from "./time-since-domain.js";

const ALL_SOURCES = "";
const ALL_SOURCES_LABEL = "All";
const TIME_SINCE_STYLE_ID = "time-since-widget-styles";

const TIME_SINCE_STYLES = `
    .time-since-tile {
      align-items: center;
      display: grid;
      gap: var(--space-sm);
      justify-items: center;
      text-align: center;
    }

    .time-since-name {
      width: 100%;
    }

    .time-since-age-token--normal {
      color: var(--fg);
    }

    .time-since-age-token--approaching,
    .time-since-age-token--unknown {
      color: var(--warn);
    }

    .time-since-age-token--overdue {
      color: var(--err);
    }

    .time-since-tooltip {
      --popup-transform: translateY(-50%);

      left: var(--space-xs);
      right: var(--space-xs);
      text-align: left;
      top: 50%;
      white-space: normal;
    }

    .time-since-reset-button:disabled {
      color: var(--muted);
      cursor: wait;
    }
  `;

function availableSources(items) {
  return [...new Set(items.map((item) => item.source_file))];
}

function arraysEqual(left, right) {
  return left.length === right.length &&
    Array.from(left).every((value, index) => value === right[index]);
}

function renderMenu(state) {
  const menuSources = [ALL_SOURCES, ...state.sources];
  if (!arraysEqual(menuSources, state.menuSources)) {
    state.menuSources = menuSources;
    state.menuItems = new Map();
    state.menu.replaceChildren();

    for (const sourceFile of menuSources) {
      const menuItem = document.createElement("button");
      menuItem.type = "button";
      menuItem.className = "clickable popup-menu-item time-since-menu-item";
      menuItem.textContent = sourceFile || ALL_SOURCES_LABEL;
      menuItem.title = sourceFile || ALL_SOURCES_LABEL;
      menuItem.setAttribute("role", "option");
      menuItem.addEventListener("click", () => {
        state.selectedSource = sourceFile;
        state.menuController.close();
        render(state);
        state.sourceButton.focus();
      });
      state.menuItems.set(sourceFile, menuItem);
      state.menu.appendChild(menuItem);
    }
  }

  for (const [sourceFile, menuItem] of state.menuItems) {
    menuItem.setAttribute("aria-selected", String(sourceFile === state.selectedSource));
  }
}

function createTileView(state, item) {
  const tile = createTile("popup-on-hover time-since-tile");
  const name = createElement("span", "label truncate time-since-name", item.name);
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  const popup = createElement("div", "popup label-info time-since-tooltip");
  popup.setAttribute("role", "tooltip");

  tile.append(resetButton, name, popup);
  const tileView = { tile, name, popup, resetButton, item };
  resetButton.addEventListener("click", () => completeNow(state, tileView.item));
  updateTileView(state, tileView, item);
  return tileView;
}

function updateTileView(state, tileView, item) {
  const pendingCompletion = state.pendingCompletions.get(item.uid);
  const presentedItem = pendingCompletion
    ? { ...item, last_done: pendingCompletion.optimisticLastDone }
    : item;
  const presentation = getTimeSincePresentation(
    presentedItem,
    Date.now(),
    state.approachingRatio
  );

  tileView.item = item;
  tileView.name.textContent = item.name;
  tileView.popup.textContent = presentation.tooltip;
  tileView.resetButton.className = [
    "clickable",
    "clickable--compact",
    "value-large",
    "time-since-reset-button",
    "time-since-age-token",
    `time-since-age-token--${presentation.classification}`
  ].join(" ");
  tileView.resetButton.textContent = presentation.ageToken;
  tileView.resetButton.disabled = Boolean(pendingCompletion);
  tileView.resetButton.setAttribute(
    "aria-label",
    `Reset days for ${item.name}. ${presentation.tooltip}`
  );
}

function replaceChildrenWhenChanged(container, children) {
  if (arraysEqual(container.children, children)) return;
  container.replaceChildren(...children);
}

function render(state) {
  state.sources = availableSources(state.items);
  if (state.selectedSource && !state.sources.includes(state.selectedSource)) {
    state.selectedSource = ALL_SOURCES;
  }

  state.currentSource.textContent = state.selectedSource || ALL_SOURCES_LABEL;
  state.sourceButton.title = state.currentSource.textContent;
  renderMenu(state);

  state.grid.classList.remove("is-loading", "is-empty", "is-error");

  const visibleItems = state.selectedSource
    ? state.items.filter((item) => item.source_file === state.selectedSource)
    : state.items;

  const currentUids = new Set(state.items.map((item) => item.uid));
  for (const uid of state.tileViews.keys()) {
    if (!currentUids.has(uid)) state.tileViews.delete(uid);
  }

  if (visibleItems.length === 0) {
    setStateMessage(state.grid, "No tracked activities found.", "empty");
    return;
  }

  const visibleTiles = [];
  for (const item of visibleItems) {
    let tileView = state.tileViews.get(item.uid);
    if (!tileView) {
      tileView = createTileView(state, item);
      state.tileViews.set(item.uid, tileView);
    } else {
      updateTileView(state, tileView, item);
    }
    visibleTiles.push(tileView.tile);
  }
  replaceChildrenWhenChanged(state.grid, visibleTiles);
}

async function runLoadQueue(state) {
  while (state.reloadRequested) {
    state.reloadRequested = false;
    const data = await fetchJson("/todos/time-since");
    state.items = normalizeTimeSinceItems(data?.items);
    render(state);
  }
}

async function loadItems(state) {
  state.reloadRequested = true;
  if (!state.loadPromise) {
    state.loadPromise = runLoadQueue(state).finally(() => {
      state.loadPromise = null;
    });
  }
  return state.loadPromise;
}

function replaceOrInsertItem(state, uid, replacement, preferredIndex) {
  const currentIndex = state.items.findIndex((currentItem) => currentItem.uid === uid);
  if (currentIndex >= 0) {
    state.items = state.items.map((currentItem) => currentItem.uid === uid
      ? replacement
      : currentItem
    );
    return;
  }

  const insertionIndex = Math.min(Math.max(preferredIndex, 0), state.items.length);
  const restoredItems = [...state.items];
  restoredItems.splice(insertionIndex, 0, replacement);
  state.items = restoredItems;
}

function showCompletionError(state, error, fallbackMessage) {
  setStateMessage(
    state.grid,
    String(error?.message || fallbackMessage),
    "error"
  );
}

async function completeNow(state, item) {
  if (state.pendingCompletions.has(item.uid)) return;

  const previousIndex = state.items.findIndex((currentItem) => currentItem.uid === item.uid);
  state.pendingCompletions.set(item.uid, {
    optimisticLastDone: new Date().toISOString(),
    previousIndex,
    previousItem: item
  });
  render(state);

  try {
    await fetchJson("/todos/tasks/update", {
      fetchOptions: {
        method: "POST",
        body: JSON.stringify({ uid: item.uid, status: "DONE" })
      }
    });
  } catch (error) {
    const pendingCompletion = state.pendingCompletions.get(item.uid);
    state.pendingCompletions.delete(item.uid);
    replaceOrInsertItem(
      state,
      item.uid,
      pendingCompletion.previousItem,
      pendingCompletion.previousIndex
    );
    showCompletionError(state, error, "Unable to mark activity done.");
    return;
  }

  try {
    await loadItems(state);
    state.pendingCompletions.delete(item.uid);
    render(state);
  } catch (error) {
    const pendingCompletion = state.pendingCompletions.get(item.uid);
    state.pendingCompletions.delete(item.uid);
    const currentItem = state.items.find((candidate) => candidate.uid === item.uid) ||
      pendingCompletion.previousItem;
    replaceOrInsertItem(
      state,
      item.uid,
      { ...currentItem, last_done: pendingCompletion.optimisticLastDone },
      pendingCompletion.previousIndex
    );
    showCompletionError(
      state,
      error,
      "Completion recorded, but the latest timestamp could not be loaded."
    );
  }
}

window.DASH.registerWidget("time-since", {
  mount(root, { props = {} }) {
    installWidgetStyles(TIME_SINCE_STYLE_ID, TIME_SINCE_STYLES);

    const shell = createElement("div", "widget-body time-since-widget");
    const header = createElement("div", "widget-header");
    const picker = createElement("div", "time-since-source-picker");
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.className = "menu-button time-since-source-button";
    sourceButton.setAttribute("aria-haspopup", "listbox");
    sourceButton.setAttribute("aria-expanded", "false");

    const currentSource = createElement("span", "truncate", ALL_SOURCES_LABEL);
    sourceButton.appendChild(currentSource);

    const menu = createElement("div", "popup popup-menu time-since-menu");
    menu.setAttribute("role", "listbox");
    picker.append(sourceButton, menu);

    const list = createElement("div", "list-scroll time-since-list");
    const grid = createResponsiveGrid(props);
    list.appendChild(grid);
    header.appendChild(picker);
    shell.append(header, list);
    root.replaceChildren(shell);

    const state = {
      approachingRatio: normalizeApproachingRatio(props.approachingRatio),
      sourceButton,
      currentSource,
      menu,
      grid,
      items: [],
      sources: [],
      selectedSource: ALL_SOURCES,
      loadPromise: null,
      reloadRequested: false,
      menuSources: [],
      menuItems: new Map(),
      tileViews: new Map(),
      pendingCompletions: new Map()
    };

    state.menuController = createDismissibleMenu({
      trigger: sourceButton,
      menu,
      containsTarget: (target) => shell.contains(target)
    });
    sourceButton.addEventListener("click", () => state.menuController.toggle());
    setStateMessage(grid, "Loading tracked activities...", "loading");
    return state;
  },

  async update(state) {
    try {
      await loadItems(state);
    } catch (error) {
      setStateMessage(
        state.grid,
        String(error?.message || "Unable to load tracked activities."),
        "error"
      );
    }
  }
});
