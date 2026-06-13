import { createStack, fetchJson, setStateMessage } from "../platform/global.js";

(function () {
  function ensureStyles() {
    if (document.getElementById("metar-widget-styles")) return;
    const s = document.createElement("style");
    s.id = "metar-widget-styles";
    s.textContent = `
    .metar-tile {
      background-color: var(--tile);
      display: grid;
      grid-template-columns: 6ch 6ch 10ch 6ch 5ch .4fr 5ch 6ch 1fr;
      align-items: center;
      padding: var(--widget-padding);
      border-radius: var(--radius);
      overflow: auto;
    }
    `;
    document.head.appendChild(s);
  }

  // Wind -> "DDD@SSGggKT" or "CALM"
  function fmtWind(dirDeg, spdKt, gustKt /* optional */) {
    const spd = Math.round(Number(spdKt));
    const gst = Math.round(Number(gustKt));

    // speeds calm
    if (spd === 0 || spd === 1)
      return "CALM";

    // direction (or VRB)
    const dir = !isNaN(dirDeg)
      ? String(Math.round(Number(dirDeg))).padStart(3, "0")
      : "VRB";

    // speed string
    const ss = String(Math.max(0, spd || 0)).padStart(2, "0");

    // gust string
    const gg = gst
      ? `G${String(Math.max(0, gst)).padStart(2, "0")}`
      : "";

    return `${dir}@${ss}${gg}KT`;
  }

  // altim (hPa-ish) -> A####
  function fmtAltFromHectoPascal(hPaVal) {
    if (!hPaVal)
      return "";

    const hPa = Number(hPaVal);
    const inHg = hPa * 0.0295299830714;
    const hundredths = Math.round(inHg * 100);
    return `A${String(hundredths).padStart(4, "0")}`;
  }

  function extractMetarReturn(entry) {
    if (!entry || !entry?.rawOb || entry?.error) {
       return {
        station: (entry?.icaoId || "????").toUpperCase(),
        timestamp: "ERR",
        wind: "",
        vis: "",
        wx: "",
        sky: "",
        temp: "",
        alt: "",
        remarks: entry?.error || "no data",
        isError: true
      };
    }

    // raw METAR line; drop METAR / SPECI prefix
    const raw = (entry.rawOb).replace(/^(METAR|SPECI)\s+/i, "").trim();

    // tokenize
    const tokens = raw.split(/\s+/);
    let i = 0;

    // first token should be ICAO
    let station = entry.icaoId;
    i++;  // skip

    // second token should be zulu timestamp
    let timestamp = "";
    if (tokens[i] && /^\d{6}Z$/i.test(tokens[i])) {
      timestamp = tokens[i].toUpperCase();
      i++;
    }

    // split off remarks at end (everything after RMK)
    let remarks = "";
    const rmkIndex = tokens.findIndex(t => t.toUpperCase() === "RMK");
    let remainingTokens = tokens;
    if (rmkIndex !== -1) {
      remainingTokens = tokens.slice(i, rmkIndex);
      remarks = tokens.slice(rmkIndex + 1).join(" ");
    }

    // everything left has potentially non-uniform arrangement;
    // use regex to categorize
    const windRe = /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/i;
    const visRe  = /^P?\d+(?:\/\d+)?SM$/i;                     // 10SM, 1/2SM, P6SM, etc.
    const tempRe = /^M?\d{1,2}\/M?\d{1,2}$/i;                  // 24/08, M02/M05
    const altRe  = /^A\d{4}$/i;                                // A3007
    const skyRe  = /^(FEW|SCT|BKN|OVC)\d{3}.*$|^(CLR|SKC)$/i;  // FEW020, SCT050, BKN250, CLR, SKC
    const wxCodeRe = /^(\+|-)?(RA|DZ|SN|SG|PL|IC|PE|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS|TS)[A-Z]*$/i;

    // see what we can get from parsing the METAR line
    let windToken = "";
    let visToken = "";
    let tempToken = "";
    let altToken = "";
    const wxParts = [];
    const skyParts = [];
    // iterate
    remainingTokens.forEach((tok) => {
      const curr = tok.toUpperCase();

      if (!windToken && windRe.test(curr)) {
        windToken = curr;
        return;
      }

      if (!visToken && visRe.test(curr)) {
        visToken = curr;
        return;
      }

      if (!tempToken && tempRe.test(curr)) {
        tempToken = curr;
        return;
      }

      if (!altToken && altRe.test(curr)) {
        altToken = curr;
        return;
      }

      if (skyRe.test(curr)) {
        skyParts.push(curr);
        return;
      }

      if (wxCodeRe.test(curr)) {
        wxParts.push(curr);
        return;
      }
    });

    // fallback; get values from entry json
    const prettyWind = fmtWind(entry.wdir, entry.wspd, entry.wgst);
    const alt = altToken || fmtAltFromHectoPascal(entry.altim);
    const temp = tempToken || `${entry.temp}/${entry.dewp}`;
    const vis = visToken || `${entry.visib}SM`;

    return {
      station,
      timestamp,
      wind:    prettyWind,
      vis:     vis || "",
      wx:      wxParts.join(" ") || "",
      sky:     skyParts.join(" ") || "",
      temp:    temp || "",
      alt:     alt || "",
      remarks: remarks.trim(),
      isError: false
    };
  }

  function createMetarTile(stationId) {
    const tile = document.createElement("div");
    tile.className = "metar-tile";

    // Kxxx
    const station = document.createElement("div");
    station.className = "label";
    station.textContent = stationId;

    // ddhhmmZ
    const timestampSpan = document.createElement("span");
    timestampSpan.className = "label-info";

    // 123@45KT
    const windSpan = document.createElement("span");
    windSpan.className = "label-info";

    // 10+SM
    const visSpan = document.createElement("span");
    visSpan.className = "label-info";

    // (optional) RA | HZ
    const wxSpan = document.createElement("span");
    wxSpan.className = "label-info";

    // SCR123 FEW456
    const skySpan = document.createElement("span");
    skySpan.className = "label-info";

    // 12°C
    const tempSpan = document.createElement("span");
    tempSpan.className = "label-info";

    // A2992
    const altSpan = document.createElement("span");
    altSpan.className = "label-info";

    // RMK blah
    const remarksSpan = document.createElement("span");
    remarksSpan.className = "label-info";

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
    data.isError ? dom.tile.classList.add("error") : dom.tile.classList.remove("error");

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

    try {
      const data = await fetchJson(url);
      return data?.stations || {};
    } catch (err) {
      console.warn("[fetchMetars] metar fetch error", err);
      return {};
    }
  }

  window.DASH.registerWidget("metar", {
    mount(root, { props = {} }) {
      ensureStyles();

      const stations = Array.isArray(props?.stations)
        ? props.stations.map(s => String(s).trim().toUpperCase()).filter(Boolean)
        : [];

      const refreshMs = typeof props?.refreshMs === "number" ? props.refreshMs : 60000;

      const grid = createStack();
      root.replaceChildren(grid);
      if (!stations.length) {
        setStateMessage(grid, "No METAR stations configured.", "empty");
        return { root, grid, stations, rows: {}, refreshMs, lastFetch: 0 };
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
        rows,
        refreshMs,
        lastFetch: 0
      };
    },

    async update(instance) {
      const now = Date.now();

      // need to refresh?
      if (now - instance.lastFetch < instance.refreshMs)
        return;
      instance.lastFetch = now;

      // hit backend for data
      const dataByStation = await fetchMetars(instance.stations);

      for (const stn of instance.stations) {
        const dom = instance.rows[stn];
        if (!dom)
          continue;

        const rawEntry = dataByStation[stn];
        const data = extractMetarReturn(rawEntry);
        populateMetarTile(dom, data);
      }
    }
  });
})();
