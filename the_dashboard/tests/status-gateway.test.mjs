import assert from "node:assert/strict";
import test from "node:test";

import { createHttpStatusProvider } from "../gateway/status-providers/http.js";
import { createStatusChecksHandler } from "../gateway/widget-routes/status.js";
import {
  createGatewayResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

const LOCAL_TARGETS = Object.freeze([
  "http://localhost/admin/",
  "http://localhost:18086",
  "http://localhost:8123",
  "http://127.0.0.1:8123/health",
  "http://[::1]:8123/health"
]);

test("HTTP status checks probe local browser URLs through the Docker host", async () => {
  for (const target of LOCAL_TARGETS) {
    const requests = [];
    const clockReadings = [10, 25];
    const provider = createHttpStatusProvider({
      fetchImpl: async (url, options) => {
        requests.push({ url: url.toString(), options });
        return { status: 204 };
      },
      monotonicNow: () => clockReadings.shift(),
      signalForTimeout: () => "timeout-signal",
      timeoutMs: 5_000
    });

    const result = await provider.check({ url: target });

    const expectedTransportUrl = new URL(target);
    expectedTransportUrl.hostname = "host.docker.internal";
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, expectedTransportUrl.toString());
    assert.equal(requests[0].options.method, "GET");
    assert.equal(requests[0].options.redirect, "manual");
    assert.equal(requests[0].options.signal, "timeout-signal");
    assert.deepEqual(result, {
      indicator: "passing",
      detail: "HTTP 204 • 15ms",
      href: new URL(target).toString()
    });
  }
});

test("HTTP status checks normalize the current Router bare-host configuration", async () => {
  const requests = [];
  const provider = createHttpStatusProvider({
    allowedHosts: ["192.168.1.*"],
    fetchImpl: async (url) => {
      requests.push(url.toString());
      return { status: 200 };
    },
    monotonicNow: () => 10
  });

  const result = await provider.check({ url: "192.168.1.1" });

  assert.deepEqual(requests, ["http://192.168.1.1/"]);
  assert.deepEqual(result, {
    indicator: "passing",
    detail: "HTTP 200 • 0ms",
    href: "http://192.168.1.1/"
  });
});

test("HTTP status checks keep external targets behind the configured allowlist", async () => {
  let requestCount = 0;
  const provider = createHttpStatusProvider({
    allowedHosts: [],
    fetchImpl: async () => {
      requestCount += 1;
      return { status: 200 };
    }
  });

  const result = await provider.check({
    url: "http://localhost.example.test:8123/health"
  });

  assert.equal(requestCount, 0);
  assert.deepEqual(result, {
    indicator: "attention",
    detail: "Target host \"localhost.example.test\" is not allowed.",
    href: null
  });
});

test("HTTP status checks probe allowlisted external URLs without rewriting them", async () => {
  const requests = [];
  const target = "https://service.example.test/health";
  const clockReadings = [10, 25];
  const provider = createHttpStatusProvider({
    allowedHosts: ["service.example.test"],
    fetchImpl: async (url) => {
      requests.push(url.toString());
      return { status: 200 };
    },
    monotonicNow: () => clockReadings.shift()
  });

  const result = await provider.check({ url: target });

  assert.deepEqual(requests, [target]);
  assert.deepEqual(result, {
    indicator: "passing",
    detail: "HTTP 200 • 15ms",
    href: target
  });
});

test("HTTP status checks map the response status boundaries", async () => {
  const target = "https://service.example.test/health";
  const scenarios = [
    { status: 200, indicator: "passing" },
    { status: 399, indicator: "passing" },
    { status: 400, indicator: "attention" },
    { status: 503, indicator: "attention" }
  ];

  for (const { status, indicator } of scenarios) {
    const provider = createHttpStatusProvider({
      allowedHosts: ["service.example.test"],
      fetchImpl: async () => ({ status }),
      monotonicNow: () => 10
    });

    assert.deepEqual(await provider.check({ url: target }), {
      indicator,
      detail: `HTTP ${status} • 0ms`,
      href: target
    });
  }
});

test("HTTP status checks map transport failures to attention", async () => {
  const target = "https://service.example.test/health";
  const provider = createHttpStatusProvider({
    allowedHosts: ["service.example.test"],
    fetchImpl: async () => {
      throw new Error("connection refused");
    }
  });

  assert.deepEqual(await provider.check({ url: target }), {
    indicator: "attention",
    detail: "No response from target.",
    href: target
  });
});

test("HTTP status checks do not misreport local processing errors as network failures", async () => {
  let clockReadCount = 0;
  const provider = createHttpStatusProvider({
    allowedHosts: ["service.example.test"],
    fetchImpl: async () => ({ status: 200 }),
    monotonicNow() {
      clockReadCount += 1;
      if (clockReadCount === 1) return 10;
      throw new Error("clock failed");
    }
  });

  await assert.rejects(
    provider.check({ url: "https://service.example.test/health" }),
    /clock failed/
  );
});

test("status check batches preserve descriptor order and return one result per input", async () => {
  const providers = {
    example: {
      async check(config) {
        return {
          indicator: config.indicator,
          detail: config.detail,
          href: null
        };
      }
    }
  };
  const handler = createStatusChecksHandler({
    concurrency: 2,
    maxChecks: 10,
    providers
  });
  const response = createGatewayResponse();
  const descriptors = [
    { type: "example", indicator: "passing", detail: "First" },
    { type: "example", indicator: "other", detail: "Second" },
    { type: "example", indicator: "passing", detail: "First" }
  ];

  await handler({ body: { providers: descriptors } }, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: {
      count: 3,
      results: [
        { indicator: "passing", detail: "First", href: null },
        { indicator: "other", detail: "Second", href: null },
        { indicator: "passing", detail: "First", href: null }
      ]
    },
    error: null
  });
});

test("status check batches return an attention result for an unknown provider", async () => {
  const handler = createStatusChecksHandler({ providers: {} });
  const response = createGatewayResponse();

  await handler({ body: { providers: [{ type: "unknown" }] } }, response);

  assert.deepEqual(response.body.data.results, [{
    indicator: "attention",
    detail: "Unknown status provider \"unknown\".",
    href: null
  }]);
});

test("status check batches normalize an omitted optional href to null", async () => {
  const handler = createStatusChecksHandler({
    providers: {
      example: {
        check: async () => ({ indicator: "other", detail: "No destination" })
      }
    }
  });
  const response = createGatewayResponse();

  await handler({ body: { providers: [{ type: "example" }] } }, response);

  assert.deepEqual(response.body.data.results, [{
    indicator: "other",
    detail: "No destination",
    href: null
  }]);
});

test("status check batches return provider configuration failures as attention results", async () => {
  const handler = createStatusChecksHandler({
    providers: { http: createHttpStatusProvider({ allowedHosts: [] }) }
  });
  const response = createGatewayResponse();

  await handler({ body: { providers: [{ type: "http" }] } }, response);

  assert.deepEqual(response.body.data.results, [{
    indicator: "attention",
    detail: "URL must be a hostname, IP, or HTTP(S) URL.",
    href: null
  }]);
});

test("status check batches isolate adapter exceptions and malformed results", async () => {
  const handler = createStatusChecksHandler({
    providers: {
      throwing: { check: async () => { throw new Error("secret failure"); } },
      malformed: { check: async () => ({ indicator: "passing", detail: "" }) },
      valid: {
        check: async () => ({ indicator: "other", detail: "Still running", href: null })
      }
    }
  });
  const response = createGatewayResponse();

  await handler({
    body: {
      providers: [
        { type: "throwing" },
        { type: "malformed" },
        { type: "valid" }
      ]
    }
  }, response);

  assert.deepEqual(response.body.data.results, [
    { indicator: "attention", detail: "Status provider failed.", href: null },
    {
      indicator: "attention",
      detail: "Status provider returned an invalid result.",
      href: null
    },
    { indicator: "other", detail: "Still running", href: null }
  ]);
  assert.equal(JSON.stringify(response.body).includes("secret failure"), false);
});

test("the default status provider registry dispatches GitHub Actions checks", async () => {
  await withPatchedGlobals({
    fetch: async () => ({
      ok: true,
      status: 200,
      async json() {
        return {
          workflow_runs: [{
            status: "completed",
            conclusion: "success",
            html_url: "https://github.com/BRL-CAD/brlcad/actions/runs/42"
          }]
        };
      }
    })
  }, async () => {
    const handler = createStatusChecksHandler();
    const response = createGatewayResponse();

    await handler({
      body: {
        providers: [{
          type: "github-actions",
          repository: "BRL-CAD/brlcad",
          workflow: "push.yml",
          branch: "main"
        }]
      }
    }, response);

    assert.equal(response.body.data.results[0].indicator, "passing");
  });
});

test("status check batches bound provider concurrency", async () => {
  const providerConfigs = Array.from(
    { length: 5 },
    (_, index) => ({ type: "controlled", index })
  );
  const releases = [];
  let activeChecks = 0;
  let maximumActiveChecks = 0;
  let startedChecks = 0;
  const handler = createStatusChecksHandler({
    concurrency: 2,
    providers: {
      controlled: {
        async check(config) {
          activeChecks += 1;
          startedChecks += 1;
          maximumActiveChecks = Math.max(maximumActiveChecks, activeChecks);
          return new Promise((resolve) => {
            releases.push(() => {
              activeChecks -= 1;
              resolve({ indicator: "passing", detail: `Check ${config.index}`, href: null });
            });
          });
        }
      }
    }
  });
  const response = createGatewayResponse();

  const pendingResponse = handler({ body: { providers: providerConfigs } }, response);
  assert.equal(startedChecks, 2);

  while (startedChecks < providerConfigs.length || releases.length > 0) {
    for (const release of releases.splice(0)) release();
    await Promise.resolve();
    await Promise.resolve();
  }
  await pendingResponse;

  assert.equal(maximumActiveChecks, 2);
  assert.equal(response.body.data.results.length, providerConfigs.length);
});

test("status check batches return ordered attention results at the Gateway deadline", async () => {
  const providerDelayMs = 25;
  const handler = createStatusChecksHandler({
    batchDeadlineMs: 1,
    concurrency: 1,
    providers: {
      slow: {
        async check() {
          await new Promise((resolve) => setTimeout(resolve, providerDelayMs));
          return { indicator: "passing", detail: "Too late", href: null };
        }
      }
    }
  });
  const response = createGatewayResponse();

  await handler({
    body: { providers: [{ type: "slow" }, { type: "slow" }] }
  }, response);

  assert.deepEqual(response.body.data.results, [
    { indicator: "attention", detail: "Status check timed out.", href: null },
    { indicator: "attention", detail: "Status check timed out.", href: null }
  ]);
});
