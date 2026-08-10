import {
  createElement,
  createResponsiveGrid,
  createStack,
  createWidgetMessage,
  fetchJson
} from "../platform/global.js";

function normalizeDashboardUrl(value) {
  if (typeof value !== "string") return "";
  const dashboardUrl = value.trim();
  if (!dashboardUrl) return "";

  try {
    const url = new URL(dashboardUrl);
    return url.protocol === "http:" || url.protocol === "https:"
      ? dashboardUrl
      : "";
  } catch {
    return "";
  }
}

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

function createActionButton(action, status) {
  const button = createElement("button", "clickable", action.name);
  button.type = "button";
  let pending = false;

  button.addEventListener("click", async () => {
    if (pending) return;

    pending = true;
    button.disabled = true;
    status.textContent = "";

    try {
      await fetchJson("/home-assistant/actions", {
        fetchOptions: {
          method: "POST",
          body: JSON.stringify({ api: action.api })
        }
      });
      status.textContent = `Ran ${action.name}.`;
    } catch (error) {
      status.textContent = String(error?.message || `Unable to run ${action.name}.`);
    } finally {
      pending = false;
      button.disabled = false;
    }
  });

  return button;
}

window.DASH.registerWidget("home-assistant", {
  mount(root, { props = {} }) {
    const shell = createStack();
    shell.classList.add("widget-body");

    const dashboardAction = createElement("div", "widget-header");
    const dashboardUrl = normalizeDashboardUrl(props.dashboardUrl);
    if (dashboardUrl) {
      const dashboardLink = createElement(
        "a",
        "clickable",
        "Open Home Assistant"
      );
      dashboardLink.href = dashboardUrl;
      dashboardLink.target = "_blank";
      dashboardLink.rel = "noopener noreferrer";
      dashboardAction.appendChild(dashboardLink);
    } else {
      dashboardAction.appendChild(
        createWidgetMessage("Home Assistant dashboard URL is not configured.")
      );
    }

    const status = createWidgetMessage("", "widget-status");
    status.setAttribute("aria-live", "polite");
    const actions = createResponsiveGrid(props);
    const configuredActions = normalizeButtons(props.buttons);
    for (const action of configuredActions) {
      actions.appendChild(createActionButton(action, status));
    }
    if (configuredActions.length === 0) {
      actions.appendChild(
        createWidgetMessage("No Home Assistant actions configured.")
      );
    }

    shell.append(dashboardAction, actions, status);
    root.replaceChildren(shell);
  }
});
