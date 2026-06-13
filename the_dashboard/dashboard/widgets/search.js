import { createStack } from "../platform/global.js";

(function () {
  function ensureStyles() {
    if (document.getElementById("search-widget-styles")) return;
    const s = document.createElement("style");
    s.id = "search-widget-styles";
    s.textContent = `
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
      border-top-right-radius: var(--radius);
      border-bottom-right-radius: var(--radius);
    }

    .search-engine-menu.popup-menu-open {
      right: 0;
      top: calc(100% + 6px);
      background: transparent;
    }
    `;
    document.head.appendChild(s);
  }

  function getEnginesFromProps(props) {
    if (Array.isArray(props?.engines) && props.engines.length) {
      return props.engines;
    }
    // fallback
    return [
      {
        name: "Google",
        buildUrl: (q) =>
          "https://www.google.com/search?q=" + encodeURIComponent(q)
      }
    ];
  }

  function openPopupForUrl(targetUrl, titleText) {
    const w = window.open(
      targetUrl,
      "_blank",
      "noopener,noreferrer,width=1200,height=800"
    );
    if (w && titleText) {
      try {
        w.document.title = titleText;
      } catch {
        /* cross-origin -> ignore */
      }
    }
  }

  window.DASH.registerWidget("search", {
    mount(root, { props }) {
      ensureStyles();
      root.classList.add("search-widget");

      const engines = getEnginesFromProps(props);
      const state = {
        engines,
        currentIdx: 0,
        menuOpen: false
      };

      const wrapper = createStack();

      // pill
      const pill = document.createElement("div");
      pill.className = "surface-control search-pill";

      // input
      const input = document.createElement("input");
      input.className = "input-basic search-input";
      input.type = "text";
      input.placeholder = props?.placeholder || "Search…";

      // engine button
      const engineBtn = document.createElement("button");
      engineBtn.className = "search-engine-btn menu-button";
      engineBtn.type = "button";
      engineBtn.textContent = engines[state.currentIdx].name;

      // dropdown menu
      const menu = document.createElement("div");
      menu.className = "popup popup-menu search-engine-menu";

      // populate engine list
      engines.forEach((eng, idx) => {
        const item = document.createElement("button");
        item.className = "clickable popup-menu-item";
        item.type = "button";

        const nm = document.createElement("span");
        nm.className = "label";
        nm.textContent = eng.name;

        item.appendChild(nm);

        item.addEventListener("click", (e) => {
          e.stopPropagation();
          state.currentIdx = idx;
          engineBtn.textContent = eng.name;
          closeMenu();
          // DO NOT activate border here; border = input focus only
          input.focus();
        });

        menu.appendChild(item);
      });

      function activateBorder() {
        pill.classList.add("search-pill-active");
      }

      function deactivateBorder() {
        pill.classList.remove("search-pill-active");
      }

      function openMenu() {
        state.menuOpen = true;
        root.classList.add("search-menu-open");
        menu.classList.add("popup-menu-open");

        document.addEventListener("click", outsideHandler);
      }

      function closeMenu() {
        state.menuOpen = false;
        root.classList.remove("search-menu-open");
        menu.classList.remove("popup-menu-open");
        document.removeEventListener("click", outsideHandler);
      }

      // Outside click closes menu, but doesn't touch border
      function outsideHandler(ev) {
        if (pill.contains(ev.target)) return;
        closeMenu();
      }

      engineBtn.addEventListener("click", (evt) => {
        evt.stopPropagation();
        if (state.menuOpen) {
          closeMenu();
        } else {
          openMenu();
        }
      });

      function submitQuery() {
        const q = input.value.trim();
        if (!q) return;
        const eng = engines[state.currentIdx];

        // We don't *force* the glow here anymore;
        // if user hits Enter, they're already focused so it's already on.
        const targetUrl = eng.buildUrl(q);
        const titleText = `${eng.name} search for "${q}"`;
        openPopupForUrl(targetUrl, titleText);
        input.value = "";
      }

      input.addEventListener("keydown", (evt) => {
        if (evt.key === "Enter") {
          evt.preventDefault();
          submitQuery();
        } else if (evt.key === "Escape") {
          if (state.menuOpen) {
            closeMenu();
          } else {
            // leaving focus will drop the active border via blur handler
            input.blur();
          }
        }
      });

      // focus/blur = add/remove active class
      input.addEventListener("focus", () => {
        activateBorder();
      });

      input.addEventListener("blur", () => {
        deactivateBorder();
      });

      // Clicking anywhere on the pill (except the engine button / menu)
      // should focus the text box (and that triggers border via focus)
      pill.addEventListener("click", (evt) => {
        if (evt.target === engineBtn || menu.contains(evt.target)) return;
        input.focus();
      });

      pill.appendChild(input);
      pill.appendChild(engineBtn);
      pill.appendChild(menu);

      wrapper.appendChild(pill);

      root.replaceChildren(wrapper);

      return {
        root,
        wrapper,
        pill,
        input,
        engineBtn,
        menu,
        state
      };
    },

    async update() {
      // Static interactive widget; no polling needed.
    }
  });
})();
