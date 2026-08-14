import {
  createDismissalController,
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
const CLASSIFICATION_PRIORITY = Object.freeze({
  overdue: 0,
  approaching: 1,
  normal: 2,
  unknown: 3
});
const TIME_SINCE_STYLE_ID = "time-since-widget-styles";

const TIME_SINCE_STYLES = `
    .time-since-tile {
      --time-since-flip-duration: 300ms;
      --time-since-flip-perspective: 48rem;

      perspective: var(--time-since-flip-perspective);
      text-align: center;
    }

    .time-since-flipper {
      display: grid;
      transform-style: preserve-3d;
      transition: transform var(--time-since-flip-duration) ease;
      width: 100%;
    }

    .time-since-tile--flipped .time-since-flipper {
      transform: rotateY(180deg);
    }

    .time-since-face {
      backface-visibility: hidden;
      grid-area: 1 / 1;
      min-width: 0;
    }

    .time-since-face--front {
      align-items: center;
      display: grid;
      gap: var(--space-sm);
      justify-items: center;
      transform: rotateY(0deg);
    }

    .time-since-face--back {
      align-content: center;
      appearance: none;
      background: transparent;
      border: 0;
      color: inherit;
      display: grid;
      padding: 0;
      text-align: left;
      transform: rotateY(180deg);
      width: 100%;
    }

    .time-since-name {
      display: block;
      max-width: 100%;
      width: 100%;
    }

    .time-since-name-button {
      appearance: none;
      background: transparent;
      border: 0;
      max-width: 100%;
      min-width: 0;
      padding: 0;
      text-align: center;
    }

    .time-since-name-button:is(:hover, :focus-visible) {
      text-decoration: underline;
      text-underline-offset: var(--space-xs);
    }

    .time-since-details {
      display: grid;
      gap: var(--space-xs);
    }

    .time-since-detail-row {
      display: grid;
      gap: var(--space-sm);
      grid-template-columns: max-content minmax(0, 1fr);
    }

    .time-since-detail-value {
      color: var(--fg);
      overflow-wrap: anywhere;
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

    .time-since-reset-button:disabled {
      color: var(--muted);
    }

    @media (prefers-reduced-motion: reduce) {
      .time-since-flipper {
        transition: none;
      }
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
      menuItem.className = "popup-menu-item clickable label";
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

function syncTileFlipState(tileView, flipped) {
  tileView.tile.classList.toggle("time-since-tile--flipped", flipped);
  tileView.front.setAttribute("aria-hidden", String(flipped));
  tileView.backButton.setAttribute("aria-hidden", String(!flipped));
  tileView.nameButton.setAttribute("aria-expanded", String(flipped));
  tileView.nameButton.setAttribute("tabindex", flipped ? "-1" : "0");
  tileView.resetButton.setAttribute("tabindex", flipped ? "-1" : "0");
  tileView.backButton.setAttribute("tabindex", flipped ? "0" : "-1");
}

function setOpenTileView(state, nextTileView) {
  const previousTileView = state.openTileView;
  if (previousTileView === nextTileView) return;

  if (previousTileView) syncTileFlipState(previousTileView, false);
  state.openTileView = nextTileView;
  if (nextTileView) {
    syncTileFlipState(nextTileView, true);
    nextTileView.backButton.focus();
  }

  if (!previousTileView && nextTileView) {
    state.detailsDismissal.activate();
  } else if (previousTileView && !nextTileView) {
    state.detailsDismissal.deactivate();
  }
}

function closeTileDetails(state, restoreFocus = false) {
  const openTileView = state.openTileView;
  if (!openTileView) return;

  setOpenTileView(state, null);
  if (restoreFocus) openTileView.nameButton.focus();
}

function renderDetails(container, details) {
  const rows = details.map(({ label, value }) => {
    const row = createElement("span", "time-since-detail-row");
    const term = createElement("span", "label-info", label);
    const description = createElement(
      "span",
      "label-info time-since-detail-value",
      value
    );
    row.append(term, description);
    return row;
  });
  container.replaceChildren(...rows);
}

function createTileView(state, item) {
  const tile = createTile("time-since-tile");
  const flipper = createElement("div", "time-since-flipper");
  const front = createElement("div", "time-since-face time-since-face--front");
  const nameButton = document.createElement("button");
  nameButton.type = "button";
  nameButton.className = "label truncate time-since-name time-since-name-button";
  const resetButton = document.createElement("button");
  resetButton.type = "button";
  const backButton = document.createElement("button");
  backButton.type = "button";
  backButton.className = "time-since-face time-since-face--back";
  const details = createElement("span", "time-since-details");

  front.append(resetButton, nameButton);
  backButton.appendChild(details);
  flipper.append(front, backButton);
  tile.appendChild(flipper);

  const tileView = {
    tile,
    front,
    backButton,
    details,
    nameButton,
    resetButton,
    item
  };
  nameButton.addEventListener("click", () => {
    setOpenTileView(state, state.openTileView === tileView ? null : tileView);
  });
  backButton.addEventListener("click", () => closeTileDetails(state, true));
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
  tileView.nameButton.textContent = item.name;
  tileView.nameButton.setAttribute(
    "aria-label",
    `Show details for ${item.name}`
  );
  const accessibleDetails = presentation.details
    .map(({ label, value }) => `${label}: ${value}`)
    .join(". ");
  tileView.backButton.setAttribute(
    "aria-label",
    `Hide details for ${item.name}. ${accessibleDetails}`
  );
  renderDetails(tileView.details, presentation.details);
  tileView.resetButton.className = [
    "clickable",
    "clickable--compact",
    "value-large",
    "time-since-reset-button",
    `time-since-age-token--${presentation.classification}`
  ].join(" ");
  tileView.resetButton.textContent = presentation.ageToken;
  tileView.resetButton.disabled = Boolean(pendingCompletion);
  tileView.resetButton.setAttribute(
    "aria-label",
    `Reset days for ${item.name}`
  );
  syncTileFlipState(tileView, state.openTileView === tileView);
}

function replaceChildrenWhenChanged(container, children) {
  if (arraysEqual(container.children, children)) return;
  container.replaceChildren(...children);
}

function sortByPriority(items, nowMs, approachingRatio) {
  return items
    .map((item, declarationIndex) => ({
      declarationIndex,
      item,
      priority: CLASSIFICATION_PRIORITY[
        getTimeSincePresentation(item, nowMs, approachingRatio).classification
      ]
    }))
    .sort((left, right) => (
      left.priority - right.priority || left.declarationIndex - right.declarationIndex
    ))
    .map(({ item }) => item);
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

  const filteredItems = state.selectedSource
    ? state.items.filter((item) => item.source_file === state.selectedSource)
    : state.items;
  const visibleItems = state.sortByPriority
    ? sortByPriority(filteredItems, Date.now(), state.approachingRatio)
    : filteredItems;
  const visibleUids = new Set(visibleItems.map((item) => item.uid));

  if (state.openTileView && !visibleUids.has(state.openTileView.item.uid)) {
    closeTileDetails(state);
  }

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
  closeTileDetails(state);
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

    const shell = createElement("div", "widget-body");
    const header = createElement("div", "widget-header");
    const picker = createElement("div");
    const sourceButton = document.createElement("button");
    sourceButton.type = "button";
    sourceButton.className = "menu-button";
    sourceButton.setAttribute("aria-haspopup", "listbox");
    sourceButton.setAttribute("aria-expanded", "false");

    const currentSource = createElement("span", "truncate", ALL_SOURCES_LABEL);
    sourceButton.appendChild(currentSource);

    const menu = createElement("div", "popup popup-menu");
    menu.setAttribute("role", "listbox");
    picker.append(sourceButton, menu);

    const priorityLabel = createElement("label", "inline-toggle");
    const priorityInput = document.createElement("input");
    priorityInput.type = "checkbox";
    priorityInput.checked = true;
    const priorityText = createElement("span", "", "priority");
    priorityLabel.append(priorityInput, priorityText);

    const list = createElement("div", "list-scroll");
    const grid = createResponsiveGrid(props);
    list.appendChild(grid);
    header.append(picker, priorityLabel);
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
      sortByPriority: true,
      loadPromise: null,
      reloadRequested: false,
      menuSources: [],
      menuItems: new Map(),
      tileViews: new Map(),
      pendingCompletions: new Map(),
      openTileView: null,
      detailsDismissal: null
    };

    state.detailsDismissal = createDismissalController({
      containsTarget: (target) => Boolean(state.openTileView?.tile.contains(target)),
      onDismiss: ({ restoreFocus }) => closeTileDetails(state, restoreFocus)
    });

    state.menuController = createDismissibleMenu({
      trigger: sourceButton,
      menu,
      containsTarget: (target) => shell.contains(target)
    });
    sourceButton.addEventListener("click", () => state.menuController.toggle());
    priorityInput.addEventListener("change", () => {
      state.sortByPriority = priorityInput.checked;
      render(state);
    });
    setStateMessage(grid, "Loading tracked activities...", "loading");
    return state;
  },

  async update(state) {
    try {
      await loadItems(state);
    } catch (error) {
      closeTileDetails(state);
      setStateMessage(
        state.grid,
        String(error?.message || "Unable to load tracked activities."),
        "error"
      );
    }
  }
});
