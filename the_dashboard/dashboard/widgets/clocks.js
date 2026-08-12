import {
  createResponsiveGrid,
  createTile,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";

const CLOCK_STYLE_ID = "clocks-widget-styles";
const CLOCK_TICK_INTERVAL_MS = 1_000;
const CLOCK_STYLES = `
    .clock-tile {
      align-content: center;
      display: grid;
      grid-template-columns: 1fr auto;
    }
  `;

function formatForZone(date, configuredTimeZone) {
  const timeZone = configuredTimeZone === "local" ? undefined : configuredTimeZone;
  const timeFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZone
  });
  const dateFormatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone
  });
  const offsetFormatter = new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    timeZone,
    timeZoneName: "shortOffset",
    hour12: false
  });

  const timeText = timeFormatter.format(date);
  const dateText = dateFormatter.format(date);
  const offsetWithTime = offsetFormatter.format(date);
  const separatorIndex = offsetWithTime.indexOf(" ");
  const offsetText = separatorIndex === -1
    ? offsetWithTime
    : offsetWithTime.slice(separatorIndex + 1);

  return { timeText, dateText, offsetText };
}

function createClockCard(zone) {
  const card = createTile("clock-tile");
  const timeElement = document.createElement("div");
  timeElement.className = "value-large";

  const labelElement = document.createElement("div");
  labelElement.className = "label";
  labelElement.textContent = zone.label || zone.tz || "Clock";

  const metadataElement = document.createElement("div");
  metadataElement.className = "label-info";
  card.append(timeElement, labelElement, metadataElement);

  return { card, timeElement, metadataElement };
}

window.DASH.registerWidget("clocks", {
  mount(root, { props = {} }) {
    installWidgetStyles(CLOCK_STYLE_ID, CLOCK_STYLES);

    const grid = createResponsiveGrid(props, "list-tiled list-tiled--fill");
    root.replaceChildren(grid);

    const zones = Array.isArray(props?.zones) ? props.zones : [];
    if (!zones.length) {
      setStateMessage(grid, "No clocks configured.", "empty");
    }
    const cards = [];

    for (const zone of zones) {
      const { card, timeElement, metadataElement } = createClockCard(zone);
      grid.appendChild(card);
      cards.push({ zone, timeElement, metadataElement });
    }

    return { cards, timerId: null };
  },

  update(state) {
    if (state.timerId !== null) return;

    function tick() {
      const now = new Date();
      for (const card of state.cards) {
        const { timeText, dateText, offsetText } = formatForZone(now, card.zone.tz);
        card.timeElement.textContent = timeText;
        card.metadataElement.textContent = `${dateText} • ${offsetText}`;
      }
    }

    tick();
    state.timerId = setInterval(tick, CLOCK_TICK_INTERVAL_MS);
  }
});
