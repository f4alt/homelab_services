import assert from "node:assert/strict";
import test from "node:test";

import {
  getTimeSince,
  normalizeTimeSincePayload
} from "../gateway/widget-routes/todos.js";
import {
  createGatewayResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

test("time-since Gateway projection always returns an item collection", () => {
  const items = [{ uid: "stable-uid" }];

  assert.deepEqual(normalizeTimeSincePayload({ items }), { items });
  assert.deepEqual(normalizeTimeSincePayload({ items: null }), { items: [] });
  assert.deepEqual(normalizeTimeSincePayload(null), { items: [] });
});

test("time-since Gateway handler proxies the upstream path in the stable envelope", async () => {
  let upstreamPath;

  await withPatchedGlobals({
    async fetch(url) {
      upstreamPath = new URL(url).pathname;
      return {
        ok: true,
        status: 200,
        async json() {
          return { items: null };
        }
      };
    }
  }, async () => {
    const response = createGatewayResponse();
    await getTimeSince({}, response);

    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
      ok: true,
      data: { items: [] },
      error: null
    });
    assert.equal(upstreamPath, "/time-since");
  });
});

test("time-since Gateway handler translates upstream failures consistently", async () => {
  await withPatchedGlobals({
    fetch: async () => ({
      ok: false,
      status: 503,
      async json() {
        return { error: "Todo server offline" };
      }
    })
  }, async () => {
    const response = createGatewayResponse();
    await getTimeSince({}, response);

    assert.equal(response.statusCode, 502);
    assert.deepEqual(response.body, {
      ok: false,
      data: null,
      error: {
        code: "todo_upstream_error",
        message: "Unable to load time-since activities.",
        details: {
          status: 503,
          error: "Todo server offline",
          upstream: { error: "Todo server offline" }
        }
      }
    });
  });
});
