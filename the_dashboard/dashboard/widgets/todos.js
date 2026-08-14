import {
  createDismissibleMenu,
  createElement,
  createWidgetMessage,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";

const TODOS_STYLE_ID = "todos-widget-styles";
const TODOS_STYLES = `
    .todos-item {
      align-items: flex-start;
      display: grid;
      gap: var(--space-sm);
      grid-template-columns: 16px minmax(0, 1fr);
      line-height: 1.25;
      padding: var(--space-compact) var(--space-xs);
      text-align: left;
      width: 100%;
    }

    .todos-dot {
      margin-left: 10%;
    }
  `;

function listKey(task) {
  return String(task?.source_file || task?.collection || "todos").trim() || "todos";
}

function listName(key) {
  const clean = String(key || "todos");
  return clean.split(/[\\/]/).filter(Boolean).pop() || clean;
}

function taskKey(task) {
  return task?.uid || `${task?.source_file || ""}:${task?.content || ""}`;
}

function normalizeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : [])
    .filter((task) => task && typeof task.content === "string" && task.content.trim())
    .map((task) => ({ ...task, status: task.status === "DONE" ? "DONE" : "TODO" }));
}

function availableLists(tasks) {
  const keys = [...new Set(tasks.map(listKey))];
  keys.sort((left, right) => (
    listName(left).localeCompare(listName(right), undefined, { sensitivity: "base" })
  ));
  return keys;
}

function resolveListName(lists, preferred) {
  const raw = String(preferred || "").trim();
  if (!raw) return "";

  const exact = lists.find((key) => key === raw || listName(key) === raw);
  if (exact) return exact;

  const wanted = raw.toLowerCase();
  return lists.find((key) => (
    key.toLowerCase() === wanted || listName(key).toLowerCase() === wanted
  )) || "";
}

function renderMenu(state) {
  state.menu.replaceChildren();

  for (const key of state.lists) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "popup-menu-item clickable label";
    item.textContent = listName(key);
    item.title = key;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(key === state.selectedList));
    item.addEventListener("click", () => {
      state.selectedList = key;
      state.menuController.close();
      render(state);
      state.listButton.focus();
    });
    state.menu.appendChild(item);
  }
}

function createTaskButton(state, task) {
  const nextStatus = task.status === "DONE" ? "TODO" : "DONE";
  const button = document.createElement("button");
  button.type = "button";
  button.className = `clickable todos-item ${task.status === "DONE" ? "muted" : ""}`.trim();
  button.setAttribute(
    "aria-label",
    `${task.content} is ${task.status.toLowerCase()}. Mark ${nextStatus.toLowerCase()}.`
  );

  const dotClass = `dot todos-dot ${task.status === "DONE" ? "dot--ok dot--inset" : ""}`.trim();
  const dot = createElement("span", dotClass);
  dot.setAttribute("aria-hidden", "true");

  const text = createElement("span", "label-info", task.content.trim());
  button.append(dot, text);

  button.addEventListener("click", async () => {
    const previousTasks = state.tasks;
    state.tasks = state.tasks.map((item) => (
      taskKey(item) === taskKey(task) ? { ...item, status: nextStatus } : item
    ));
    render(state);

    try {
      await fetchJson("/todos/tasks/update", {
        fetchOptions: {
          method: "POST",
          body: JSON.stringify({
            uid: task.uid,
            content: task.content,
            source_file: task.source_file,
            status: nextStatus
          })
        }
      });
      await loadTasks(state);
    } catch (error) {
      state.tasks = previousTasks;
      render(state);
      setStateMessage(
        state.list,
        String(error?.message || "Unable to update todo."),
        "error"
      );
    }
  });

  return button;
}

function render(state) {
  state.lists = availableLists(state.tasks);
  if (!state.lists.length) {
    state.currentName.textContent = "todos";
    state.menu.replaceChildren();
    setStateMessage(state.list, "No todos found.", "empty");
    return;
  }

  if (!state.lists.includes(state.selectedList)) {
    state.selectedList = resolveListName(state.lists, state.props.defaultList) || state.lists[0];
  }

  state.currentName.textContent = listName(state.selectedList);
  state.listButton.title = state.selectedList;
  renderMenu(state);

  const visibleTasks = state.tasks
    .filter((task) => listKey(task) === state.selectedList)
    .filter((task) => state.showAll || task.status !== "DONE");

  state.list.classList.remove("is-loading", "is-empty", "is-error");
  state.list.replaceChildren();

  if (!visibleTasks.length) {
    state.list.appendChild(createWidgetMessage(
      state.showAll ? "This list is empty." : "No open todos."
    ));
    return;
  }

  for (const task of visibleTasks) {
    state.list.appendChild(createTaskButton(state, task));
  }
}

async function loadTasks(state) {
  const data = await fetchJson("/todos/tasks");
  state.tasks = normalizeTasks(data?.tasks);
  render(state);
}

window.DASH.registerWidget("todos", {
  mount(root, { props = {} }) {
    installWidgetStyles(TODOS_STYLE_ID, TODOS_STYLES);

    const shell = createElement("div", "widget-body");
    const header = createElement("div", "widget-header");
    const picker = createElement("div");
    const listButton = document.createElement("button");
    listButton.type = "button";
    listButton.className = "menu-button";
    listButton.setAttribute("aria-haspopup", "listbox");
    listButton.setAttribute("aria-expanded", "false");

    const currentName = createElement("span", "truncate", "todos");
    listButton.append(currentName);

    const menu = createElement("div", "popup popup-menu");
    menu.setAttribute("role", "listbox");
    picker.append(listButton, menu);

    const showAllLabel = createElement("label", "inline-toggle");
    const showAllInput = document.createElement("input");
    showAllInput.type = "checkbox";
    const showAllText = createElement("span", "", "show all");
    showAllLabel.append(showAllInput, showAllText);

    const list = createElement("div", "list-scroll");
    header.append(picker, showAllLabel);
    shell.append(header, list);
    root.replaceChildren(shell);

    const state = {
      props,
      listButton,
      currentName,
      menu,
      list,
      tasks: [],
      lists: [],
      selectedList: "",
      showAll: props.showAll !== false
    };

    showAllInput.checked = state.showAll;
    state.menuController = createDismissibleMenu({
      trigger: listButton,
      menu,
      containsTarget: (target) => shell.contains(target)
    });
    listButton.addEventListener("click", () => {
      state.menuController.toggle();
    });
    showAllInput.addEventListener("change", () => {
      state.showAll = showAllInput.checked;
      render(state);
    });
    setStateMessage(list, "Loading todos...", "loading");
    return state;
  },

  async update(state) {
    try {
      await loadTasks(state);
    } catch (error) {
      setStateMessage(
        state.list,
        String(error?.message || "Unable to load todos."),
        "error"
      );
    }
  }
});
