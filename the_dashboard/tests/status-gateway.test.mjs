import assert from "node:assert/strict";
import test from "node:test";

import { createStatusProbe } from "../gateway/widget-routes/status.js";

const FIXED_TIMESTAMP = "2026-08-09T18:00:00.000Z";
const LOCAL_TARGETS = Object.freeze([
  "http://localhost:8123/health",
  "http://127.0.0.1:8123/health",
  "http://[::1]:8123/health"
]);

function createProbe(fetchImpl, allowedHosts = []) {
  const clockReadings = [10, 25];
  return createStatusProbe({
    allowedHosts,
    fetchImpl,
    monotonicNow: () => clockReadings.shift(),
    now: () => new Date(FIXED_TIMESTAMP),
    signalForTimeout: () => "timeout-signal",
    timeoutMs: 5000
  });
}

test("status probes local browser targets through the Docker host", async () => {
  for (const target of LOCAL_TARGETS) {
    const requests = [];
    const probe = createProbe(async (url, options) => {
      requests.push({ url: url.toString(), options });
      return { status: 204 };
    });

    const result = await probe(target);

    const expectedTransportUrl = new URL(target);
    expectedTransportUrl.hostname = "host.docker.internal";
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, expectedTransportUrl.toString());
    assert.equal(requests[0].options.method, "GET");
    assert.equal(requests[0].options.redirect, "manual");
    assert.equal(requests[0].options.signal, "timeout-signal");
    assert.deepEqual(result, {
      ok: true,
      target,
      final_url: target,
      status: 204,
      latency_ms: 15,
      timestamp: FIXED_TIMESTAMP
    });
  }
});

test("status keeps external targets behind the configured allowlist", async () => {
  let requestCount = 0;
  const probe = createProbe(async () => {
    requestCount += 1;
    return { status: 200 };
  });

  const result = await probe("http://localhost.example.test:8123/health");

  assert.equal(requestCount, 0);
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "target_not_allowed");
});

test("status probes allowlisted external targets without rewriting them", async () => {
  const requests = [];
  const target = "https://service.example.test/health";
  const probe = createProbe(async (url) => {
    requests.push(url.toString());
    return { status: 200 };
  }, ["service.example.test"]);

  const result = await probe(target);

  assert.deepEqual(requests, [target]);
  assert.equal(result.ok, true);
  assert.equal(result.final_url, target);
});
