import { Router } from "express";
import { sendError, sendOk } from "../platform/responses.js";

const router = Router();

// /metar?stations=Kxxx,Kxxx,...
router.get("/metar", async (req, res) => {
  try {
    // make sure we have stations requested
    const stationsParam = req.query.stations;
    if (!stationsParam) {
      return sendError(res, 400, "validation_error", "Missing ?stations=KXXX,KYYY.");
    }

    // normalize ICAO list
    const stations = stationsParam
      .split(",")
      .map(s => s.trim().toUpperCase())
      .filter(s => s.length >= 3 && s.length <= 4);

    if (!stations.length) {
      return sendError(res, 400, "validation_error", "No valid station IDs provided.");
    }

    // build upstream request to aviationweather.gov
    const awcUrl =
      "https://aviationweather.gov/api/data/metar" +
      "?ids=" + encodeURIComponent(stations.join(",")) +
      "&format=json";

    const upstreamResp = await fetch(awcUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "dashboard-gateway/0.1 (self-hosted home dashboard)"
      },
      signal: AbortSignal.timeout(6000)
    });

    // 204 No Content means "no recent obs"
    if (upstreamResp.status === 204) {
      // return an object for each requested station with an error flag
      const emptyMap = {};
      for (const stn of stations) {
        emptyMap[stn] = {
          error: "no recent data",
          station: stn,
          rawOb: ""
        };
      }
      return sendOk(res, { stations: emptyMap });
    }

    if (!upstreamResp.ok) {
      return sendError(res, 502, "upstream_error", "METAR upstream fetch failed.", {
        status: upstreamResp.status,
        statusText: upstreamResp.statusText
      });
    }

    // parse upstream JSON safely
    let awcArray = [];
    const bodyText = await upstreamResp.text();
    if (bodyText && bodyText.trim().length) {
      try {
        awcArray = JSON.parse(bodyText);
      } catch (e) {
        console.warn("metar upstream parse error:", e);
        awcArray = [];
      }
    }

    // build a lookup map keyed by ICAO so frontend can do ordered render
    // we DO NOT rename or massage fields. We just drop them in
    const stationMap = {};
    for (const entry of awcArray) {
      const icao = (entry.icaoId || "").toUpperCase();
      if (!icao) continue;
      stationMap[icao] = entry;
    }

    // for any requested station missing from response, stub an error entry
    for (const stn of stations) {
      if (!stationMap[stn]) {
        stationMap[stn] = {
          error: "no data",
          station: stn,
          rawOb: ""
        };
      }
    }

    return sendOk(res, { stations: stationMap });
  } catch (err) {
    console.error("METAR proxy error:", err);
    return sendError(res, 500, "internal_error", "Internal METAR proxy error.", {
      error: String(err?.message || err)
    });
  }
});

export default router;
