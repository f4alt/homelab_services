import {
  createStack,
  createTile,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";
import { formatMetarEntry, metarGatewayFailure } from "./metar-domain.js";

const METAR_STYLE_ID = "metar-widget-styles";
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

  const station = document.createElement("div");
  station.className = "label metar-field metar-station";
  station.textContent = stationId;

  const timestampSpan = document.createElement("span");
  timestampSpan.className = "label-info metar-field metar-time";

  const windSpan = document.createElement("span");
  windSpan.className = "label-info metar-field metar-wind";

  const visSpan = document.createElement("span");
  visSpan.className = "label-info metar-field metar-visibility";

  const wxSpan = document.createElement("span");
  wxSpan.className = "label-info metar-field metar-weather";

  const skySpan = document.createElement("span");
  skySpan.className = "label-info metar-field metar-sky";

  const tempSpan = document.createElement("span");
  tempSpan.className = "label-info metar-field metar-temperature";

  const altSpan = document.createElement("span");
  altSpan.className = "label-info metar-field metar-altimeter";

  const remarksSpan = document.createElement("span");
  remarksSpan.className = "label-info metar-field metar-remarks";

  tile.append(
    station,
    timestampSpan,
    windSpan,
    visSpan,
    wxSpan,
    skySpan,
    tempSpan,
    altSpan,
    remarksSpan
  );

  return {
    tile,
    station,
    timestampSpan,
    windSpan,
    visSpan,
    wxSpan,
    skySpan,
    tempSpan,
    altSpan,
    remarksSpan
  };
}

function populateMetarTile(elements, data) {
  elements.tile.classList.toggle("error", data.state === "error");

  elements.station.textContent = data.station || "????";
  elements.timestampSpan.textContent = data.timestamp || "";
  elements.windSpan.textContent = data.wind || "";
  elements.visSpan.textContent = data.vis || "";
  elements.wxSpan.textContent = data.wx || "";
  elements.skySpan.textContent = data.sky || "";
  elements.tempSpan.textContent = data.temp || "";
  elements.altSpan.textContent = data.alt || "";
  elements.remarksSpan.textContent = data.remarks || "";
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
