#!/usr/bin/env node

import vm from "node:vm";
import { validateDashboardConfig } from "../dashboard/platform/config-validator.mjs";

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
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    }
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
    timeout: 1000
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
  const { response, text } = await request("/editor", {
    headers: { Accept: "text/html" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(text.includes('id="source"'), "short editor URL did not resolve to editor page");
});

check("config API returns current source", async () => {
  const { response, text } = await request("/api/config", {
    headers: { Accept: "application/javascript" }
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(text.includes("window.DASH_CONFIG"), "config API source missing DASH_CONFIG");
});

check("config API validates current source", async () => {
  const current = await request("/api/config", {
    headers: { Accept: "application/javascript" }
  });
  const { response, json } = await request("/api/config/validate", {
    method: "POST",
    body: JSON.stringify({ source: current.text })
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "config validation did not report ok=true");
});

check("config API rejects malformed source", async () => {
  const { response, json } = await request("/api/config/validate", {
    method: "POST",
    body: JSON.stringify({ source: "window.DASH_CONFIG = {" })
  });

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "malformed config should report ok=false");
  assert(json?.error?.code === "validation_error", "malformed config error code mismatch");
});

check("config API rejects invalid dashboard config", async () => {
  const { response, json } = await request("/api/config/validate", {
    method: "POST",
    body: JSON.stringify({ source: "window.DASH_CONFIG = { widgets: [] };" })
  });

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "invalid config should report ok=false");
  assert(json?.error?.code === "validation_error", "invalid config error code mismatch");
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

check("gateway health reports netstats dependency", async () => {
  const { response, json } = await request("/api/health");

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "gateway health did not report ok=true");
  assert(json?.error === null, "gateway health should not include an error");
  assert(json?.data?.dependencies?.netstats?.ok === true, "netstats dependency is not healthy");
});

check("netstats ping route works through gateway", async () => {
  const { response, json } = await request("/api/net/ping?target=localhost");

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "ping response did not report ok=true");
  assert(json?.error === null, "ping response should not include an error");
  assert(json?.data?.target === "localhost", "ping target did not round-trip");
});

check("netstats ping route rejects disallowed targets", async () => {
  const { response, json } = await request("/api/net/ping?target=example.invalid");

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "disallowed ping should report ok=false");
  assert(json?.error?.code === "target_not_allowed", "disallowed ping error code mismatch");
});

check("status route validates empty target list", async () => {
  const { response, json } = await request("/api/statuschecks", {
    method: "POST",
    body: JSON.stringify({ targets: [] })
  });

  assert(response.status === 400, `expected HTTP 400, got ${response.status}`);
  assert(json?.ok === false, "empty statuschecks response should report ok=false");
  assert(json?.error?.code === "validation_error", "empty statuschecks error code mismatch");
});

check("status route can probe internal service health", async () => {
  const { response, json } = await request("/api/statuschecks", {
    method: "POST",
    body: JSON.stringify({
      targets: [{ url: "localhost:3000/api/health" }]
    })
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "statuschecks response did not report ok=true");
  assert(json?.error === null, "statuschecks response should not include an error");
  assert(Array.isArray(json?.data?.results), "statuschecks results missing");
  assert(json.data.results[0]?.ok === true, "internal netstats probe failed");
});

check("status route rejects disallowed target hosts", async () => {
  const { response, json } = await request("/api/statuschecks", {
    method: "POST",
    body: JSON.stringify({
      targets: [{ url: "example.invalid" }]
    })
  });

  assert(response.ok, `expected HTTP 2xx, got ${response.status}`);
  assert(json?.ok === true, "statuschecks batch should complete");
  assert(json?.data?.results?.[0]?.ok === false, "disallowed target should fail per-target");
  assert(
    json.data.results[0]?.error?.code === "target_not_allowed",
    "disallowed target error code mismatch"
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
