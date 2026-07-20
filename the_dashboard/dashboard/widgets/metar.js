import { createStack, createTile, fetchJson, setStateMessage } from "../platform/global.js";
import { formatMetarEntry, metarGatewayFailure } from "./metar-domain.js";

(function () {
  function ensureStyles() {
    if (document.getElementById("metar-widget-styles")) return;
    const s = document.createElement("style");
    s.id = "metar-widget-styles";
    s.textContent = `
    .metar-tile {
      align-items: center;
      display: grid;
      gap: 6px 10px;
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
    document.head.appendChild(s);
  }

  function createMetarTile(stationId) {
    const tile = createTile("metar-tile");

    // Kxxx
    const station = document.createElement("div");
    station.className = "label metar-field metar-station";
    station.textContent = stationId;

    // ddhhmmZ
    const timestampSpan = document.createElement("span");
    timestampSpan.className = "label-info metar-field metar-time";

    // 123@45KT
    const windSpan = document.createElement("span");
    windSpan.className = "label-info metar-field metar-wind";

    // 10+SM
    const visSpan = document.createElement("span");
    visSpan.className = "label-info metar-field metar-visibility";

    // (optional) RA | HZ
    const wxSpan = document.createElement("span");
    wxSpan.className = "label-info metar-field metar-weather";

    // SCR123 FEW456
    const skySpan = document.createElement("span");
    skySpan.className = "label-info metar-field metar-sky";

    // 12°C
    const tempSpan = document.createElement("span");
    tempSpan.className = "label-info metar-field metar-temperature";

    // A2992
    const altSpan = document.createElement("span");
    altSpan.className = "label-info metar-field metar-altimeter";

    // RMK blah
    const remarksSpan = document.createElement("span");
    remarksSpan.className = "label-info metar-field metar-remarks";

    tile.appendChild(station);
    tile.appendChild(timestampSpan);
    tile.appendChild(windSpan);
    tile.appendChild(visSpan);
    tile.appendChild(wxSpan);
    tile.appendChild(skySpan);
    tile.appendChild(tempSpan);
    tile.appendChild(altSpan);
    tile.appendChild(remarksSpan);

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

  function populateMetarTile(dom, data) {
    dom.tile.classList.toggle("error", data.state === "error");
    dom.tile.classList.toggle("metar-no-data", data.state === "no-data");

    // fill data into spans
    dom.station.textContent       = data.station   || "????";
    dom.timestampSpan.textContent = data.timestamp || "";
    dom.windSpan.textContent      = data.wind      || "";
    dom.visSpan.textContent       = data.vis       || "";
    dom.wxSpan.textContent        = data.wx        || "";
    dom.skySpan.textContent       = data.sky       || "";
    dom.tempSpan.textContent      = data.temp      || "";
    dom.altSpan.textContent       = data.alt       || "";
    dom.remarksSpan.textContent   = data.remarks   || "";
  }

  async function fetchMetars(stations) {
    if (!stations || !stations.length)
      return {};

    const url = `/metar?stations=${encodeURIComponent(stations.join(","))}`;

    const data = await fetchJson(url);
    return data?.stations || {};
  }

  window.DASH.registerWidget("metar", {
    mount(root, { props = {} }) {
      ensureStyles();

      const stations = Array.isArray(props?.stations)
        ? props.stations.map(s => String(s).trim().toUpperCase()).filter(Boolean)
        : [];

      const grid = createStack();
      root.replaceChildren(grid);
      if (!stations.length) {
        setStateMessage(grid, "No METAR stations configured.", "empty");
        return { root, grid, stations, rows: {} };
      }

      const rows = {};
      stations.forEach((stn) => {
        const dom = createMetarTile(stn);
        rows[stn] = dom;
        grid.appendChild(dom.tile);
      });

      return {
        root,
        grid,
        stations,
        rows
      };
    },

    async update(instance) {
      try {
        const dataByStation = await fetchMetars(instance.stations);
        for (const stn of instance.stations) {
          const dom = instance.rows[stn];
          if (!dom) continue;
          populateMetarTile(dom, formatMetarEntry(dataByStation[stn], stn));
        }
      } catch (error) {
        for (const stn of instance.stations) {
          const dom = instance.rows[stn];
          if (!dom) continue;
          populateMetarTile(dom, metarGatewayFailure(stn, error));
        }
      }
    }
  });
})();
