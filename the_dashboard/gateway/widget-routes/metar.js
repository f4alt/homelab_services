import { Router } from "express";
import { errorMessage, sendError, sendOk } from "../platform/responses.js";

const router = Router();
const MAX_STATION_ID_LENGTH = 4;
const METAR_API_URL = "https://aviationweather.gov/api/data/metar";
const METAR_UPSTREAM_TIMEOUT_MS = 6000;
const MIN_STATION_ID_LENGTH = 3;

router.get("/metar", async (req, res) => {
  try {
    const stationsParameter = req.query.stations;
    if (!stationsParameter) {
      return sendError(res, 400, "validation_error", "Missing ?stations=KXXX,KYYY.");
    }

    const stations = stationsParameter
      .split(",")
      .map((station) => station.trim().toUpperCase())
      .filter((station) => (
        station.length >= MIN_STATION_ID_LENGTH
        && station.length <= MAX_STATION_ID_LENGTH
      ));

    if (!stations.length) {
      return sendError(res, 400, "validation_error", "No valid station IDs provided.");
    }

    const upstreamUrl =
      METAR_API_URL +
      "?ids=" + encodeURIComponent(stations.join(",")) +
      "&format=json";

    const upstreamResponse = await fetch(upstreamUrl, {
      headers: {
        "Accept": "application/json",
        "User-Agent": "dashboard-gateway/0.1 (self-hosted home dashboard)"
      },
      signal: AbortSignal.timeout(METAR_UPSTREAM_TIMEOUT_MS)
    });

    const noRecentObservations = upstreamResponse.status === 204;

    if (!noRecentObservations && !upstreamResponse.ok) {
      return sendError(res, 502, "upstream_error", "METAR upstream fetch failed.", {
        status: upstreamResponse.status,
        statusText: upstreamResponse.statusText
      });
    }

    let observations = [];
    if (!noRecentObservations) {
      const bodyText = await upstreamResponse.text();
      if (bodyText && bodyText.trim().length) {
        try {
          observations = JSON.parse(bodyText);
        } catch (parseError) {
          console.warn("metar upstream parse error:", parseError);
        }
      }
    }

    // Preserve upstream fields so the client can render observations without
    // maintaining a second field translation contract.
    const stationMap = {};
    for (const entry of observations) {
      const icao = (entry.icaoId || "").toUpperCase();
      if (!icao) continue;
      stationMap[icao] = entry;
    }

    const missingDataMessage = noRecentObservations ? "no recent data" : "no data";
    for (const station of stations) {
      if (!stationMap[station]) {
        stationMap[station] = {
          error: missingDataMessage,
          station,
          rawOb: ""
        };
      }
    }

    return sendOk(res, { stations: stationMap });
  } catch (error) {
    console.error("METAR proxy error:", error);
    return sendError(res, 500, "internal_error", "Internal METAR proxy error.", {
      error: errorMessage(error)
    });
  }
});

export default router;
