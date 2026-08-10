import {
  createDismissibleMenu,
  createStack,
  installWidgetStyles
} from "../platform/global.js";

const SEARCH_STYLE_ID = "search-widget-styles";
const SEARCH_STYLES = `
    .search-pill {
      position: relative;
      display: flex;
      align-items: stretch;
      width: 100%;
      isolation: isolate;
      overflow: visible; /* let the glow shadow breathe */
    }

    .widget.search-menu-open {
      position: relative;
      z-index: 50;
    }

    .search-pill-active {
      border-color: rgba(var(--ok-rgb), 0.8);
      box-shadow:
        0 0 4px 1px rgba(var(--ok-rgb), 0.6),
        0 0 12px 4px rgba(var(--ok-rgb), 0.25),
        0 0 28px 12px rgba(var(--ok-rgb), 0.12),
        0 4px 24px rgba(var(--card-shadow), .25);
    }

    .search-input {
      flex: 1 1 auto;
    }

    .search-engine-btn {
      flex: 0 0 auto;
      border-left: 1px solid var(--tile-border);
      border-radius: 0 var(--radius) var(--radius) 0;
    }

    .search-engine-menu.popup-menu-open {
      right: 0;
      top: calc(100% + 6px);
      background: transparent;
    }
  `;

function getEnginesFromProps(props) {
  if (Array.isArray(props?.engines) && props.engines.length) {
    return props.engines;
  }
  return [
    {
      name: "Google",
      buildUrl: (query) =>
        `https://www.google.com/search?q=${encodeURIComponent(query)}`
    }
  ];
}

function openUrlInNewTab(targetUrl) {
  window.open(targetUrl, "_blank", "noopener,noreferrer");
}

window.DASH.registerWidget("search", {
  mount(root, { id, props }) {
    installWidgetStyles(SEARCH_STYLE_ID, SEARCH_STYLES);

    const engines = getEnginesFromProps(props);
    let currentEngineIndex = 0;
    const wrapper = createStack();
    const pill = document.createElement("div");
    pill.className = "surface-control search-pill";

    const input = document.createElement("input");
    input.className = "input-basic search-input";
    input.type = "text";
    input.placeholder = props?.placeholder || "Search…";

    const engineButton = document.createElement("button");
    engineButton.className = "search-engine-btn menu-button";
    engineButton.type = "button";
    engineButton.textContent = engines[currentEngineIndex].name;
    engineButton.setAttribute("aria-haspopup", "listbox");

    const menu = document.createElement("div");
    menu.className = "popup popup-menu search-engine-menu";
    menu.id = `${id}-engine-menu`;
    menu.setAttribute("role", "listbox");
    engineButton.setAttribute("aria-controls", menu.id);

    const menuController = createDismissibleMenu({
      trigger: engineButton,
      menu,
      containsTarget: (target) => pill.contains(target),
      onOpenChange: (isOpen) => root.classList.toggle("search-menu-open", isOpen)
    });

    const menuItems = engines.map((engine, engineIndex) => {
      const item = document.createElement("button");
      item.className = "clickable popup-menu-item";
      item.type = "button";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", String(engineIndex === currentEngineIndex));

      const name = document.createElement("span");
      name.className = "label";
      name.textContent = engine.name;
      item.appendChild(name);

      item.addEventListener("click", (event) => {
        event.stopPropagation();
        currentEngineIndex = engineIndex;
        engineButton.textContent = engine.name;
        menuItems.forEach((menuItem, menuIndex) => {
          menuItem.setAttribute(
            "aria-selected",
            String(menuIndex === currentEngineIndex)
          );
        });
        menuController.close();
        input.focus();
      });

      menu.appendChild(item);
      return item;
    });

    engineButton.addEventListener("click", (event) => {
      event.stopPropagation();
      menuController.toggle();
    });

    function submitQuery() {
      const query = input.value.trim();
      if (!query) return;
      const engine = engines[currentEngineIndex];
      openUrlInNewTab(engine.buildUrl(query));
      input.value = "";
    }

    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        submitQuery();
      } else if (event.key === "Escape") {
        if (menuController.isOpen()) menuController.close();
        else input.blur();
      }
    });

    input.addEventListener("focus", () => {
      pill.classList.add("search-pill-active");
    });
    input.addEventListener("blur", () => {
      pill.classList.remove("search-pill-active");
    });
    pill.addEventListener("click", (event) => {
      if (event.target === engineButton || menu.contains(event.target)) return;
      input.focus();
    });

    pill.append(input, engineButton, menu);
    wrapper.appendChild(pill);
    root.replaceChildren(wrapper);
  }
});
