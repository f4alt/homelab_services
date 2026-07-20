import assert from "node:assert/strict";
import test from "node:test";

import {
  formatMetarEntry,
  metarGatewayFailure
} from "../dashboard/widgets/metar-domain.js";

test("METAR uses a valid raw wind token when structured wind fields are absent", () => {
  const observation = formatMetarEntry({
    icaoId: "KDFW",
    rawOb: "METAR KDFW 191753Z 18012G20KT 10SM -RA SCT020 31/22 A2992 RMK AO2"
  }, "KDFW");

  assert.equal(observation.station, "KDFW");
  assert.equal(observation.wind, "180@12G20KT");
  assert.equal(observation.vis, "10SM");
  assert.equal(observation.temp, "31/22");
  assert.equal(observation.alt, "A2992");
  assert.equal(observation.remarks, "AO2");
  assert.equal(observation.state, "observation");
});

test("METAR preserves structured wind while parsing the remaining raw observation", () => {
  const observation = formatMetarEntry({
    icaoId: "KIAH",
    rawOb: "KIAH 191753Z 18012KT P6SM BKN025 30/20 A3000",
    wdir: 200,
    wspd: 14,
    wgst: 22,
    altim: 1016
  }, "KIAH");

  assert.deepEqual(observation, {
    station: "KIAH",
    timestamp: "191753Z",
    wind: "200@14G22KT",
    vis: "P6SM",
    wx: "",
    sky: "BKN025",
    temp: "30/20",
    alt: "A3000",
    remarks: "",
    state: "observation",
    isError: false
  });
});

test("METAR leaves absent optional measurements empty", () => {
  const observation = formatMetarEntry({
    icaoId: "KSEA",
    rawOb: "KSEA 191753Z VRB03KT CLR"
  }, "KSEA");

  assert.equal(observation.vis, "");
  assert.equal(observation.temp, "");
  assert.equal(observation.alt, "");
  assert.equal(JSON.stringify(observation).includes("undefined"), false);
});

test("METAR no-data records retain the requested or Gateway station identity", () => {
  const gatewayNoData = formatMetarEntry({
    station: "kdal",
    error: "no recent data",
    rawOb: ""
  }, "KDAL");
  const missingStation = formatMetarEntry(undefined, "KAFW");

  assert.equal(gatewayNoData.station, "KDAL");
  assert.equal(gatewayNoData.timestamp, "N/A");
  assert.equal(gatewayNoData.remarks, "no recent data");
  assert.equal(gatewayNoData.state, "no-data");
  assert.equal(gatewayNoData.isError, false);
  assert.equal(missingStation.station, "KAFW");
  assert.equal(missingStation.remarks, "no data");
  assert.equal(missingStation.state, "no-data");
});

test("METAR Gateway failures are distinct from valid no-data observations", () => {
  const failure = metarGatewayFailure("KDAL", new Error("Gateway offline"));
  const noData = formatMetarEntry(undefined, "KDAL");

  assert.equal(failure.station, "KDAL");
  assert.equal(failure.timestamp, "ERR");
  assert.equal(failure.remarks, "Gateway unavailable: Gateway offline");
  assert.equal(failure.state, "error");
  assert.equal(failure.isError, true);
  assert.equal(noData.state, "no-data");
  assert.equal(noData.isError, false);
});
