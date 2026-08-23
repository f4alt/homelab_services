#!/usr/bin/env node

import vm from "node:vm";
import { validateDashboardConfig } from "../dashboard/platform/config-validator.mjs";

const CONFIG_EVALUATION_TIMEOUT_MS = 1_000;
const REQUEST_TIMEOUT_MS = 10_000;
const baseUrl = normalizeBaseUrl(
  process.env.DASHBOARD_BASE_URL || process.argv[2] || "http://localhost:8080"
);

const checks = [];

function normalizeBaseUrl(value) {
  return String(value || "").replace(/\/+$/, "");
}

function check(name, fn) {
  checks.push({ name, fn });
}

async function request(path, options = {}) {
  const {
    headers = {},
    signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    ...requestOptions
  } = options;
  const response = await fetch(`${baseUrl}${path}`, {
    ...requestOptions,
    headers: {
      Accept: "application/json",
      ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
      ...headers
    },
    signal
  });

  const text = await response.text();
  let json = null;
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
  }

  return { response, text, json };
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

check("dashboard shell is served", async () => {
  const { response, text } = await request("/", {
    headers: { Accept: "text/html" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(text.includes('<main id="grid"'), "dashboard grid shell missing");
  assert(text.includes('src="/config.js"'), "config script reference missing");
  assert(text.includes('src="/platform/dashboard.js"'), "dashboard module reference missing");
});

check("dashboard config loads as browser script", async () => {
  const { response, text } = await request("/config.js", {
    headers: { Accept: "application/javascript" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  const sandbox = { window: {} };
  vm.runInNewContext(text, sandbox, {
    filename: "dashboard/config.js",
    timeout: CONFIG_EVALUATION_TIMEOUT_MS
  });

  const cfg = sandbox.window.DASH_CONFIG;
  assert(cfg && typeof cfg === "object", "window.DASH_CONFIG was not created");
  const validation = validateDashboardConfig(cfg);
  assert(validation.ok, `DASH_CONFIG validation failed: ${validation.errors.join("; ")}`);
});

check("platform ES modules use JavaScript MIME type", async () => {
  const { response } = await request("/platform/config-validator.mjs", {
    headers: { Accept: "application/javascript" }
  });

  const contentType = response.headers.get("content-type") || "";
  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(
    contentType.includes("javascript"),
    `expected JavaScript content-type, got ${contentType || "(none)"}`
  );
});

check("config editor page is served", async () => {
  const { response, text } = await request("/platform/config-editor.html", {
    headers: { Accept: "text/html" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(text.includes('id="source"'), "config editor textarea missing");
  assert(text.includes("/api/config"), "config editor API reference missing");
  assert(text.includes("Reset from Saved Config"), "config editor reset action missing");
  assert(!text.includes('id="validate"'), "config editor should not expose a separate validate button");
});

check("short config editor URL serves editor page", async () => {
  const { response, text } = await request("/config", {
    headers: { Accept: "text/html" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(!response.redirected, "/config should directly serve the editor page");
  assert(text.includes('id="source"'), "short editor URL did not resolve to editor page");
});

check("config API returns current source", async () => {
  const { response, text } = await request("/api/config", {
    headers: { Accept: "application/javascript" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(text.includes("window.DASH_CONFIG"), "config API source missing DASH_CONFIG");
});

check("config API rejects malformed source", async () => {
  const { response, json } = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ source: "window.DASH_CONFIG = {" })
  });

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "malformed config should report ok=false");
  assert(json?.error?.code === "validation_error", "malformed config error code mismatch");
});

check("config API rejects invalid save without changing source", async () => {
  const before = await request("/api/config", {
    headers: { Accept: "application/javascript" }
  });
  const save = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ source: "window.DASH_CONFIG = { widgets: [] };" })
  });
  const after = await request("/api/config", {
    headers: { Accept: "application/javascript" }
  });

  assert(save.response.status === 400, `expected HTTP 400, got ${save.response.status}`);
  assert(save.json?.ok === false, "invalid save should report ok=false");
  assert(
    save.json?.error?.code === "validation_error",
    "invalid config error code mismatch"
  );
  assert(after.text === before.text, "invalid save changed config source");
});

check("config API saves valid current source", async () => {
  const current = await request("/api/config", {
    headers: { Accept: "application/javascript" }
  });
  const { response, json } = await request("/api/config", {
    method: "PUT",
    body: JSON.stringify({ source: current.text })
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "valid save did not report ok=true");

  const served = await request("/config.js", {
    headers: { Accept: "application/javascript" }
  });
  assert(served.text === current.text, "nginx-served config did not match saved source");
});

check("network ping route works through gateway", async () => {
  const { response, json } = await request("/api/net/ping?target=localhost");

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "ping response did not report ok=true");
  assert(json?.error === null, "ping response should not include an error");
  assert(json?.data?.target === "localhost", "ping target did not round-trip");
  assert(!Object.hasOwn(json?.data || {}, "ok"), "ping data should not repeat the envelope ok flag");
});

check("network ping route rejects disallowed targets", async () => {
  const { response, json } = await request("/api/net/ping?target=example.invalid");

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "disallowed ping should report ok=false");
  assert(json?.error?.code === "target_not_allowed", "disallowed ping error code mismatch");
});

check("system health route returns core host readings", async () => {
  const { response, json } = await request("/api/system-health");

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "system health response did not report ok=true");
  assert(Number.isFinite(json?.data?.cpu?.usagePercent), "CPU usage was unavailable");
  assert(Number.isFinite(json?.data?.memory?.usedPercent), "memory usage was unavailable");
  assert(Number.isFinite(json?.data?.disk?.usedPercent), "disk usage was unavailable");
  assert(Number.isFinite(json?.data?.uptimeSeconds), "uptime was unavailable");
  assert(typeof json?.data?.sampledAt === "string", "sample timestamp was unavailable");
});

check("removed platform API routes stay absent", async () => {
  const checks = await Promise.all([
    request("/api/health"),
    request("/api/config/validate", {
      method: "POST",
      body: JSON.stringify({ source: "window.DASH_CONFIG = {};" })
    })
  ]);

  for (const { response } of checks) {
    assert(response.status === 404, `expected HTTP 404, got ${response.status}`);
  }
});

check("status route validates an empty provider list", async () => {
  const { response, json } = await request("/api/statuschecks", {
    method: "POST",
    body: JSON.stringify({ providers: [] })
  });

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "empty statuschecks response should report ok=false");
  assert(json?.error?.code === "validation_error", "empty statuschecks error code mismatch");
});

check("status route probes a browser-facing dashboard host target", async () => {
  const target = new URL("/config.js", `${baseUrl}/`).toString();
  const { response, json } = await request("/api/statuschecks", {
    method: "POST",
    body: JSON.stringify({
      providers: [{ type: "http", url: target }]
    })
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "statuschecks response did not report ok=true");
  assert(json?.data?.results?.[0]?.indicator === "passing", "allowed target was not reachable");
  assert(json.data.results[0].detail.startsWith("HTTP 200"), "unexpected allowed target status");
  assert(json.data.results[0].href === target, "browser target URL was not preserved");
});

check("status route rejects disallowed target hosts", async () => {
  const { response, json } = await request("/api/statuschecks", {
    method: "POST",
    body: JSON.stringify({
      providers: [{ type: "http", url: "example.invalid" }]
    })
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "statuschecks batch should complete");
  assert(
    json?.data?.results?.[0]?.indicator === "attention",
    "disallowed target should fail per-check"
  );
  assert(
    json.data.results[0]?.detail.includes("not allowed"),
    "disallowed target detail mismatch"
  );
});

let failed = 0;
console.log(`Smoke target: ${baseUrl}`);

for (const { name, fn } of checks) {
  try {
    await fn();
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${name}`);
    console.error(`  ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`[FAIL] ${failed} smoke check(s) failed.`);
  process.exit(1);
}

console.log("[PASS] All smoke checks passed.");
