import assert from "node:assert/strict";
import test from "node:test";

import { createHomeAssistantActionHandler } from "../gateway/widget-routes/home-assistant.js";
import { createGatewayResponse } from "./helpers/test-utils.mjs";

const ACTION_API = "/api/services/script/dashboard_office_focus";
const BASE_URL = "http://home-assistant.example.test:8123";
const TOKEN = "test-token";
const UPSTREAM_TIMEOUT_MS = 4321;

function createConfig(overrides = {}) {
  return {
    upstreamTimeoutMs: UPSTREAM_TIMEOUT_MS,
    homeAssistant: {
      baseUrl: BASE_URL,
      token: TOKEN,
      ...overrides
    }
  };
}

test("a reserved Home Assistant script action is invoked through the stable Gateway contract", async () => {
  const requests = [];
  const expectedSignal = AbortSignal.abort();
  let requestedTimeout;
  const handler = createHomeAssistantActionHandler({
    config: createConfig(),
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: true, status: 200 };
    },
    signalForTimeout(timeoutMs) {
      requestedTimeout = timeoutMs;
      return expectedSignal;
    }
  });
  const response = createGatewayResponse();

  await handler({ body: { api: ACTION_API } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: { api: ACTION_API },
    error: null
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.toString(), `${BASE_URL}${ACTION_API}`);
  assert.deepEqual(requests[0].options.headers, {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json"
  });
  assert.equal(requests[0].options.method, "POST");
  assert.equal(requests[0].options.body, "{}");
  assert.equal(requests[0].options.signal, expectedSignal);
  assert.equal(requestedTimeout, UPSTREAM_TIMEOUT_MS);
});

test("untrusted Home Assistant action shapes are rejected before any upstream request", async () => {
  const invalidActions = [
    undefined,
    null,
    "",
    "   ",
    "http://home-assistant.example.test:8123/api/services/script/dashboard_example",
    "/api/services/light/turn_on",
    "/api/services/script/not_dashboard_scoped",
    "/api/services/script/dashboard_example?return_response",
    "/api/services/script/dashboard_example#fragment",
    "/api/services/script/../script/dashboard_example"
  ];
  let fetchCalls = 0;
  const handler = createHomeAssistantActionHandler({
    config: createConfig(),
    fetchImpl: async () => {
      fetchCalls += 1;
      return { ok: true, status: 200 };
    }
  });

  for (const api of invalidActions) {
    const response = createGatewayResponse();
    await handler({ body: { api } }, response);

    assert.equal(response.statusCode, 400, `expected ${String(api)} to be rejected`);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, "invalid_home_assistant_action");
  }

  assert.equal(fetchCalls, 0);
});

test("missing Home Assistant Gateway configuration is recoverable and does not call upstream", async () => {
  let fetchCalls = 0;

  for (const homeAssistant of [
    { baseUrl: "", token: TOKEN },
    { baseUrl: BASE_URL, token: "" }
  ]) {
    const handler = createHomeAssistantActionHandler({
      config: createConfig(homeAssistant),
      fetchImpl: async () => {
        fetchCalls += 1;
        return { ok: true, status: 200 };
      }
    });
    const response = createGatewayResponse();

    await handler({ body: { api: ACTION_API } }, response);

    assert.equal(response.statusCode, 503);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, "home_assistant_not_configured");
  }

  assert.equal(fetchCalls, 0);
});

test("Home Assistant network failures map to a safe recoverable Gateway error", async () => {
  const handler = createHomeAssistantActionHandler({
    config: createConfig(),
    fetchImpl: async () => {
      throw new Error(`connection failed with ${TOKEN}`);
    }
  });
  const response = createGatewayResponse();

  await handler({ body: { api: ACTION_API } }, response);

  assert.equal(response.statusCode, 502);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.error.code, "home_assistant_unreachable");
  assert.equal(JSON.stringify(response.body).includes(TOKEN), false);
});

test("Home Assistant error responses expose only the upstream status", async () => {
  const secretUpstreamBody = `sensitive upstream detail containing ${TOKEN}`;

  for (const upstreamStatus of [401, 403, 500]) {
    const handler = createHomeAssistantActionHandler({
      config: createConfig(),
      fetchImpl: async () => ({
        ok: false,
        status: upstreamStatus,
        async text() {
          throw new Error(`Gateway must not read ${secretUpstreamBody}`);
        }
      })
    });
    const response = createGatewayResponse();

    await handler({ body: { api: ACTION_API } }, response);

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      ok: false,
      data: null,
      error: {
        code: "home_assistant_upstream_error",
        message: "Home Assistant rejected the action.",
        details: { status: upstreamStatus }
      }
    });
    assert.equal(JSON.stringify(response.body).includes(TOKEN), false);
    assert.equal(JSON.stringify(response.body).includes(secretUpstreamBody), false);
  }
});
