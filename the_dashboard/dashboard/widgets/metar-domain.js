const INCHES_MERCURY_PER_HECTOPASCAL = 0.0295299830714;

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

function formatWind(directionDegrees, speedKnots, gustKnots) {
  if (!hasValue(speedKnots) || !Number.isFinite(Number(speedKnots))) return "";

  const speed = Math.round(Number(speedKnots));
  const gust = Math.round(Number(gustKnots));
  if (speed <= 1) return "CALM";

  const direction = hasValue(directionDegrees) && Number.isFinite(Number(directionDegrees))
    ? String(Math.round(Number(directionDegrees))).padStart(3, "0")
    : "VRB";
  const speedText = String(Math.max(0, speed)).padStart(2, "0");
  const gustText = Number.isFinite(gust) && gust > 0
    ? `G${String(gust).padStart(2, "0")}`
    : "";
  return `${direction}@${speedText}${gustText}KT`;
}

function formatRawWind(token) {
  const match = String(token || "").match(/^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?KT$/i);
  if (!match) return "";
  return formatWind(match[1] === "VRB" ? undefined : match[1], match[2], match[3]);
}

function formatAltimeter(hectoPascals) {
  if (!hasValue(hectoPascals) || !Number.isFinite(Number(hectoPascals))) return "";
  const hundredths = Math.round(
    Number(hectoPascals) * INCHES_MERCURY_PER_HECTOPASCAL * 100
  );
  return `A${String(hundredths).padStart(4, "0")}`;
}

function stationIdentity(entry, requestedStation, rawStation = "") {
  return String(entry?.icaoId || entry?.station || requestedStation || rawStation || "????")
    .trim()
    .toUpperCase();
}

export function formatMetarEntry(entry, requestedStation = "") {
  if (!entry || !entry.rawOb || entry.error) {
    return {
      station: stationIdentity(entry, requestedStation),
      timestamp: "N/A",
      wind: "",
      vis: "",
      wx: "",
      sky: "",
      temp: "",
      alt: "",
      remarks: String(entry?.error || "no data"),
      state: "no-data"
    };
  }

  const raw = String(entry.rawOb).replace(/^(METAR|SPECI)\s+/i, "").trim();
  const tokens = raw.split(/\s+/);
  const rawStation = tokens.shift() || "";
  let timestamp = "";
  if (tokens[0] && /^\d{6}Z$/i.test(tokens[0])) {
    timestamp = tokens.shift().toUpperCase();
  }

  let remarks = "";
  const remarksIndex = tokens.findIndex((token) => token.toUpperCase() === "RMK");
  const observationTokens = remarksIndex === -1 ? tokens : tokens.slice(0, remarksIndex);
  if (remarksIndex !== -1) remarks = tokens.slice(remarksIndex + 1).join(" ");

  const windPattern = /^(\d{3}|VRB)\d{2,3}(G\d{2,3})?KT$/i;
  const visibilityPattern = /^P?\d+(?:\/\d+)?SM$/i;
  const temperaturePattern = /^M?\d{1,2}\/M?\d{1,2}$/i;
  const altimeterPattern = /^A\d{4}$/i;
  const skyPattern = /^(FEW|SCT|BKN|OVC)\d{3}.*$|^(CLR|SKC)$/i;
  const weatherPattern = /^(\+|-)?(RA|DZ|SN|SG|PL|IC|PE|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS|TS)[A-Z]*$/i;
  let windToken = "";
  let visibilityToken = "";
  let temperatureToken = "";
  let altimeterToken = "";
  const weather = [];
  const sky = [];

  for (const token of observationTokens) {
    const normalized = token.toUpperCase();
    if (!windToken && windPattern.test(normalized)) windToken = normalized;
    else if (!visibilityToken && visibilityPattern.test(normalized)) visibilityToken = normalized;
    else if (!temperatureToken && temperaturePattern.test(normalized)) temperatureToken = normalized;
    else if (!altimeterToken && altimeterPattern.test(normalized)) altimeterToken = normalized;
    else if (skyPattern.test(normalized)) sky.push(normalized);
    else if (weatherPattern.test(normalized)) weather.push(normalized);
  }

  const structuredTemperature = hasValue(entry.temp) && hasValue(entry.dewp)
    ? `${entry.temp}/${entry.dewp}`
    : "";
  const structuredVisibility = hasValue(entry.visib) ? `${entry.visib}SM` : "";
  const wind = hasValue(entry.wspd)
    ? formatWind(entry.wdir, entry.wspd, entry.wgst)
    : formatRawWind(windToken);

  return {
    station: stationIdentity(entry, requestedStation, rawStation),
    timestamp,
    wind,
    vis: visibilityToken || structuredVisibility,
    wx: weather.join(" "),
    sky: sky.join(" "),
    temp: temperatureToken || structuredTemperature,
    alt: altimeterToken || formatAltimeter(entry.altim),
    remarks: remarks.trim(),
    state: "observation"
  };
}

export function metarGatewayFailure(requestedStation, error) {
  const detail = String(error?.message || error || "Request failed");
  return {
    station: stationIdentity(null, requestedStation),
    timestamp: "ERR",
    wind: "",
    vis: "",
    wx: "",
    sky: "",
    temp: "",
    alt: "",
    remarks: `Gateway unavailable: ${detail}`,
    state: "error"
  };
}
