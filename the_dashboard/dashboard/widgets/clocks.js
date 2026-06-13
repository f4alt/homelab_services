import { createResponsiveGrid, createTile, setStateMessage } from "../platform/global.js";

(function () {
  function ensureStyles() {
    if (document.getElementById("clocks-widget-styles")) return;
    const s = document.createElement("style");
    s.id = "clocks-widget-styles";
    s.textContent = `
    .clock-tile {
      display: grid;
      grid-template-columns: 1fr auto;
    }

    .clock-time {
      font-size: 25px;
      font-weight: 500;
    }
    `;
    document.head.appendChild(s);
  }

  // Time formatting helpers
  function formatForZone(date, tz) {
    const timeZone = (tz === "local" ? undefined : tz);

    // time HH:MM:SS
    const timeFmt = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone
    });

    // YYYY-MM-DD
    const dateFmt = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      timeZone
    });

    // Offset like "UTC+00:00" or "GMT-05:00"
    const offFmt = new Intl.DateTimeFormat("en-US", {
      hour: "2-digit",
      // minute: "2-digit",
      timeZone,
      timeZoneName: "shortOffset",
      hour12: false
    });

    const timeStr  = timeFmt.format(date);
    const dateStr  = dateFmt.format(date);
    const offFull  = offFmt.format(date); // e.g. "13:47 GMT-05:00"
    let offsetOnly = offFull;
    const spIdx = offFull.indexOf(" ");
    if (spIdx !== -1) offsetOnly = offFull.slice(spIdx + 1); // "GMT-05:00"

    return { timeStr, dateStr, offsetOnly };
  }

  function createClockCard(zoneSpec) {
    const card = createTile("clock-tile");

    const timeEl = document.createElement("div");
    timeEl.className = "label clock-time";

    const labelEl = document.createElement("div");
    labelEl.className = "label";
    labelEl.textContent = zoneSpec.label || zoneSpec.tz || "Clock";

    const metaEl = document.createElement("div");
    metaEl.className = "label-info";

    card.appendChild(timeEl);
    card.appendChild(labelEl);
    card.appendChild(metaEl);

    return { card, timeEl, labelEl, metaEl };
  }

  window.DASH.registerWidget("clocks", {
    mount(root, { props = {} }) {
      ensureStyles();

      const grid = createResponsiveGrid(props);
      root.replaceChildren(grid);

      const zones = Array.isArray(props?.zones) ? props.zones : [];
      if (!zones.length) {
        setStateMessage(grid, "No clocks configured.", "empty");
      }
      const cards = [];

      for (const z of zones) {
        const { card, timeEl, labelEl, metaEl } = createClockCard(z);
        grid.appendChild(card);
        cards.push({ spec: z, timeEl, labelEl, metaEl });
      }

      return {
        root,
        cards,
        timerId: null
      };
    },

    async update(state) {
      // only create the 1-second ticker once
      if (state.timerId !== null) return;

      function tick() {
        const now = new Date();
        for (const c of state.cards) {
          const { timeStr, dateStr, offsetOnly } = formatForZone(now, c.spec.tz);
          c.timeEl.textContent = timeStr;
          // labelEl is static from mount (zone name)
          c.metaEl.textContent = `${dateStr} • ${offsetOnly}`;
        }
      }

      tick();
      state.timerId = setInterval(tick, 1000);
    }
  });
})();
