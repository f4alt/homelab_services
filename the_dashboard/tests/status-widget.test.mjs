import assert from "node:assert/strict";
import test from "node:test";

import { FakeDocument, FakeElement, findAll } from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

const SERVICE_URL = "https://service.example.test/health";
let widgetImportNumber = 0;

async function withStatusWidget(fetchImplementation, run) {
  let registration;
  const window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  await withPatchedGlobals({
    document: new FakeDocument(),
    fetch: fetchImplementation,
    window
  }, async () => {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/status.js?test=${widgetImportNumber}`);
    await run({ registration });
  });
}

function statusResponse({ latencyMs, ok = true, status = 200 } = {}) {
  return createSuccessResponse({
    results: [{
      error: ok ? null : { message: "maintenance" },
      final_url: SERVICE_URL,
      latency_ms: latencyMs,
      ok,
      status,
      target: SERVICE_URL
    }]
  });
}

test("status lets only the newest request mutate a tile or clear its aborter", async () => {
  const firstResponse = createDeferred();
  const secondResponse = createDeferred();
  const thirdResponse = createDeferred();
  const responses = [firstResponse, secondResponse, thirdResponse];

  await withStatusWidget(
    async () => responses.shift().promise,
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: {
          services: [{ name: "Example service", url: SERVICE_URL }]
        }
      });
      const [tile] = state.tiles;

      const staleUpdate = registration.implementation.update(state);
      const secondUpdate = registration.implementation.update(state);
      secondResponse.resolve(statusResponse({ latencyMs: 12 }));
      await secondUpdate;

      assert.equal(tile.dot.classList.contains("dot--ok"), true);
      assert.equal(tile.popup.textContent, "HTTP 200 • 12ms");

      const newestUpdate = registration.implementation.update(state);
      const newestAborter = state.aborter;
      firstResponse.reject(new Error("stale request failed"));
      await staleUpdate;

      const staleRequestPreservedAborter = state.aborter === newestAborter;
      const classNameAfterStaleRequest = tile.dot.className;
      const popupAfterStaleRequest = tile.popup.textContent;

      thirdResponse.resolve(statusResponse({ latencyMs: 8, ok: false, status: 503 }));
      await newestUpdate;

      assert.equal(staleRequestPreservedAborter, true);
      assert.match(classNameAfterStaleRequest, /(^|\s)dot--ok(\s|$)/);
      assert.equal(popupAfterStaleRequest, "HTTP 200 • 12ms");
      assert.equal(tile.dot.classList.contains("dot--err"), true);
      assert.equal(tile.popup.textContent, "maintenance");
      assert.equal(state.aborter, null);
    }
  );
});

test("status updates every rendered tile when service URLs are duplicated", async () => {
  const services = [
    { name: "Service one", url: "https://one.example.test" },
    { name: "Service two", url: "https://two.example.test" },
    { name: "Service three", url: "https://three.example.test" },
    { name: "Service four", url: "https://four.example.test" }
  ];
  const duplicatedServices = [...services, ...services];
  const results = services.map(({ url }) => ({
    error: null,
    final_url: url,
    latency_ms: 10,
    ok: true,
    status: 200,
    target: url
  }));

  await withStatusWidget(
    async () => createSuccessResponse({ results }),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: { services: duplicatedServices }
      });

      await registration.implementation.update(state);

      const statusDots = findAll(
        root,
        (element) => element.classList.contains("dot")
      );
      assert.equal(statusDots.length, duplicatedServices.length);
      assert.equal(
        statusDots.filter((dot) => dot.classList.contains("dot--ok")).length,
        duplicatedServices.length
      );
    }
  );
});
