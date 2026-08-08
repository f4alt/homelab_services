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
      gap: 10px;
      grid-template-columns: minmax(0, 1fr) auto auto;
      line-height: 1.2;
      padding: 6px 4px;
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
      background: transparent;
      border: 1px solid var(--card-border);
      border-radius: 6px;
      color: var(--fg);
      cursor: pointer;
      font: inherit;
      font-size: 11px;
      line-height: 1.2;
      padding: 3px 6px;
      white-space: nowrap;
    }

    .time-since-done-button:hover,
    .time-since-done-button:focus-visible {
      border-color: var(--clickable-hover-border);
    }

    .time-since-done-button:disabled {
      cursor: wait;
      opacity: .55;
    }
  `;
  document.head.appendChild(styles);
}

function availableSources(items) {
  return [...new Set(items.map((item) => item.source_file))];
}

function renderMenu(state) {
  state.menu.replaceChildren();

  for (const sourceFile of [ALL_SOURCES, ...state.sources]) {
    const menuItem = document.createElement("button");
    menuItem.type = "button";
    menuItem.className = "clickable popup-menu-item time-since-menu-item";
    menuItem.textContent = sourceFile || ALL_SOURCES_LABEL;
    menuItem.title = sourceFile || ALL_SOURCES_LABEL;
    menuItem.setAttribute("role", "option");
    menuItem.setAttribute("aria-selected", String(sourceFile === state.selectedSource));
    menuItem.addEventListener("click", () => {
      state.selectedSource = sourceFile;
      state.menuController.close();
      render(state);
      state.sourceButton.focus();
    });
    state.menu.appendChild(menuItem);
  }
}

function createRow(state, item) {
  const presentation = getTimeSincePresentation(item, Date.now(), state.approachingRatio);
  const row = createElement("div", "ui-row time-since-row");
  row.title = presentation.tooltip;

  const name = createElement("span", "label truncate time-since-name", item.name);
  const age = createElement("span", "label-info time-since-age");
  const ageToken = createElement(
    "span",
    `time-since-age-token time-since-age-token--${presentation.classification}`,
    presentation.ageToken
  );
  const ageSuffix = presentation.agePhrase.slice(presentation.ageToken.length);
  age.append(ageToken, createElement("span", "time-since-age-unit", ageSuffix));

  const doneButton = document.createElement("button");
  doneButton.type = "button";
  doneButton.className = "time-since-done-button";
  doneButton.textContent = "Done now";
  doneButton.disabled = state.pendingUids.has(item.uid);
  doneButton.setAttribute("aria-label", `Mark ${item.name} done now`);
  doneButton.addEventListener("click", () => completeNow(state, item, doneButton));

  row.append(name, age, doneButton);
  return row;
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
  state.list.replaceChildren();

  const visibleItems = state.selectedSource
    ? state.items.filter((item) => item.source_file === state.selectedSource)
    : state.items;
  if (visibleItems.length === 0) {
    setStateMessage(state.list, "No tracked activities found.", "empty");
    return;
  }

  for (const item of visibleItems) {
    state.list.appendChild(createRow(state, item));
  }
}

async function loadItems(state) {
  const requestVersion = ++state.requestVersion;
  try {
    const data = await fetchJson("/todos/time-since");
    if (requestVersion !== state.requestVersion) return;

    state.items = normalizeTimeSinceItems(data?.items);
    render(state);
  } catch (error) {
    if (requestVersion === state.requestVersion) throw error;
  }
}

async function completeNow(state, item, button) {
  const previousItems = state.items;
  button.disabled = true;
  state.pendingUids.add(item.uid);
  state.items = state.items.map((currentItem) => currentItem.uid === item.uid
    ? { ...currentItem, last_done: new Date().toISOString() }
    : currentItem
  );
  render(state);

  try {
    await fetchJson("/todos/tasks/update", {
      fetchOptions: {
        method: "POST",
        body: JSON.stringify({ uid: item.uid, status: "DONE" })
      }
    });
    await loadItems(state);
    state.pendingUids.delete(item.uid);
    render(state);
  } catch (error) {
    state.pendingUids.delete(item.uid);
    state.items = previousItems;
    render(state);
    setStateMessage(
      state.list,
      String(error?.message || "Unable to mark activity done."),
      "error"
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
      requestVersion: 0,
      pendingUids: new Set()
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
