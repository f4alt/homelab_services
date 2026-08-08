import {
  createDismissibleMenu,
  createElement,
  fetchJson,
  setStateMessage
} from "../platform/global.js";
import {
  getTimeSincePresentation,
  normalizeApproachingRatio,
  normalizeTimeSinceItems
} from "./time-since-domain.js";

const ALL_SOURCES = "";
const ALL_SOURCES_LABEL = "All";

function ensureStyles() {
  if (document.getElementById("time-since-widget-styles")) return;

  const styles = document.createElement("style");
  styles.id = "time-since-widget-styles";
  styles.textContent = `
    .time-since-source-button {
      border-radius: var(--radius);
    }

    .time-since-row {
      display: grid;
      gap: var(--gap);
      grid-template-columns: minmax(0, 1fr) auto auto;
    }

    .time-since-age {
      white-space: nowrap;
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

    .time-since-done-button {
      appearance: none;
      color: var(--fg);
      cursor: pointer;
      font: inherit;
      white-space: nowrap;
    }

    .time-since-done-button:hover,
    .time-since-done-button:focus-visible {
      border-color: var(--clickable-hover-border);
    }

    .time-since-done-button:disabled {
      color: var(--muted);
      cursor: wait;
    }
  `;
  document.head.appendChild(styles);
}

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

function createRow(state, item) {
  const row = createElement("div", "ui-row time-since-row");
  const name = createElement("span", "label truncate time-since-name", item.name);
  const age = createElement("span", "label-info time-since-age");
  const ageToken = createElement("span", "time-since-age-token");
  const ageUnit = createElement("span", "time-since-age-unit");
  age.append(ageToken, ageUnit);

  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "ui-tile ui-tile--compact time-since-done-button";
  doneButton.textContent = "Done now";

  row.append(name, age, doneButton);
  const rowView = { row, name, ageToken, ageUnit, doneButton, item };
  doneButton.addEventListener("click", () => completeNow(state, rowView.item, doneButton));
  updateRow(state, rowView, item);
  return rowView;
}

function updateRow(state, rowView, item) {
  const pendingCompletion = state.pendingCompletions.get(item.uid);
  const presentedItem = pendingCompletion
    ? { ...item, last_done: pendingCompletion.optimisticLastDone }
    : item;
  const presentation = getTimeSincePresentation(
    presentedItem,
    Date.now(),
    state.approachingRatio
  );

  rowView.item = item;
  rowView.row.title = presentation.tooltip;
  rowView.name.textContent = item.name;
  rowView.ageToken.className =
    `time-since-age-token time-since-age-token--${presentation.classification}`;
  rowView.ageToken.textContent = presentation.ageToken;
  rowView.ageUnit.textContent = presentation.agePhrase.slice(presentation.ageToken.length);
  rowView.doneButton.disabled = Boolean(pendingCompletion);
  rowView.doneButton.setAttribute("aria-label", `Mark ${item.name} done now`);
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

  state.list.classList.remove("is-loading", "is-empty", "is-error");

  const visibleItems = state.selectedSource
    ? state.items.filter((item) => item.source_file === state.selectedSource)
    : state.items;

  const currentUids = new Set(state.items.map((item) => item.uid));
  for (const uid of state.rowViews.keys()) {
    if (!currentUids.has(uid)) state.rowViews.delete(uid);
  }

  if (visibleItems.length === 0) {
    setStateMessage(state.list, "No tracked activities found.", "empty");
    return;
  }

  const visibleRows = [];
  for (const item of visibleItems) {
    let rowView = state.rowViews.get(item.uid);
    if (!rowView) {
      rowView = createRow(state, item);
      state.rowViews.set(item.uid, rowView);
    } else {
      updateRow(state, rowView, item);
    }
    visibleRows.push(rowView.row);
  }
  replaceChildrenWhenChanged(state.list, visibleRows);
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
  render(state);
  setStateMessage(
    state.list,
    String(error?.message || fallbackMessage),
    "error"
  );
}

async function completeNow(state, item, button) {
  if (state.pendingCompletions.has(item.uid)) return;

  const previousIndex = state.items.findIndex((currentItem) => currentItem.uid === item.uid);
  button.disabled = true;
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
    ensureStyles();

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
    header.appendChild(picker);
    shell.append(header, list);
    root.replaceChildren(shell);

    const state = {
      approachingRatio: normalizeApproachingRatio(props.approachingRatio),
      sourceButton,
      currentSource,
      menu,
      list,
      items: [],
      sources: [],
      selectedSource: ALL_SOURCES,
      loadPromise: null,
      reloadRequested: false,
      menuSources: [],
      menuItems: new Map(),
      rowViews: new Map(),
      pendingCompletions: new Map()
    };

    state.menuController = createDismissibleMenu({
      trigger: sourceButton,
      menu,
      containsTarget: (target) => shell.contains(target)
    });
    sourceButton.addEventListener("click", () => state.menuController.toggle());
    setStateMessage(list, "Loading tracked activities...", "loading");
    return state;
  },

  async update(state) {
    try {
      await loadItems(state);
    } catch (error) {
      setStateMessage(
        state.list,
        String(error?.message || "Unable to load tracked activities."),
        "error"
      );
    }
  }
});
