import {
  createStack,
  createTile,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";
import { formatMetarEntry, metarGatewayFailure } from "./metar-domain.js";

const METAR_STYLE_ID = "metar-widget-styles";
const METAR_FIELD_DEFINITIONS = Object.freeze([
  {
    dataKey: "station",
    elementKey: "station",
    fallback: "????",
    labelClass: "label",
    tagName: "div"
  },
  { dataKey: "timestamp", elementKey: "timestampSpan" },
  { dataKey: "wind", elementKey: "windSpan" },
  { dataKey: "vis", elementKey: "visSpan" },
  { dataKey: "wx", elementKey: "wxSpan" },
  { dataKey: "sky", elementKey: "skySpan", selectorClass: "metar-sky" },
  { dataKey: "temp", elementKey: "tempSpan" },
  { dataKey: "alt", elementKey: "altSpan" },
  { dataKey: "remarks", elementKey: "remarksSpan", selectorClass: "metar-remarks" }
]);
const METAR_STYLES = `
    .metar-tile {
      align-items: center;
      display: grid;
      gap: var(--space-compact) var(--space-control);
      grid-template-columns:
        minmax(5ch, .55fr)
        minmax(7ch, .7fr)
        minmax(11ch, 1fr)
        minmax(6ch, .65fr)
        minmax(4ch, .55fr)
        minmax(7ch, 1fr)
        minmax(6ch, .65fr)
        minmax(6ch, .65fr)
        minmax(8ch, 1.4fr);
    }

    .metar-field {
      min-width: 0;
    }

    .metar-remarks,
    .metar-sky {
      overflow-wrap: anywhere;
      white-space: normal;
    }

    @media (max-width: 720px) {
      .metar-tile {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }

      .metar-remarks {
        grid-column: 1 / -1;
      }
    }

    @media (max-width: 560px) {
      .metar-tile {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
    }
  `;

function createMetarTile(stationId) {
  const tile = createTile("metar-tile");
  const elements = { tile };

  for (const definition of METAR_FIELD_DEFINITIONS) {
    const field = document.createElement(definition.tagName ?? "span");
    field.className = [
      definition.labelClass ?? "label-info",
      "metar-field",
      definition.selectorClass
    ]
      .filter(Boolean)
      .join(" ");
    elements[definition.elementKey] = field;
    tile.appendChild(field);
  }

  elements.station.textContent = stationId;
  return elements;
}

function populateMetarTile(elements, data) {
  elements.tile.classList.toggle("severity-error", data.state === "error");

  for (const definition of METAR_FIELD_DEFINITIONS) {
    elements[definition.elementKey].textContent =
      data[definition.dataKey] || definition.fallback || "";
  }
}

async function fetchMetars(stations) {
  if (!stations || !stations.length) return {};

  const url = `/metar?stations=${encodeURIComponent(stations.join(","))}`;

  const data = await fetchJson(url);
  return data?.stations || {};
}

window.DASH.registerWidget("metar", {
  mount(root, { props = {} }) {
    installWidgetStyles(METAR_STYLE_ID, METAR_STYLES);

    const stations = Array.isArray(props?.stations)
      ? props.stations.map((station) => String(station).trim().toUpperCase()).filter(Boolean)
      : [];

    const grid = createStack();
    root.replaceChildren(grid);
    if (!stations.length) {
      setStateMessage(grid, "No METAR stations configured.", "empty");
      return { stations, rows: {} };
    }

    const rows = {};
    stations.forEach((station) => {
      const elements = createMetarTile(station);
      rows[station] = elements;
      grid.appendChild(elements.tile);
    });

    return { stations, rows };
  },

  async update(instance) {
    try {
      const dataByStation = await fetchMetars(instance.stations);
      for (const station of instance.stations) {
        const elements = instance.rows[station];
        if (!elements) continue;
        populateMetarTile(elements, formatMetarEntry(dataByStation[station], station));
      }
    } catch (error) {
      for (const station of instance.stations) {
        const elements = instance.rows[station];
        if (!elements) continue;
        populateMetarTile(elements, metarGatewayFailure(station, error));
      }
    }
  }
});
