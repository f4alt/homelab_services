import assert from "node:assert/strict";
import test from "node:test";

import { fetchJson } from "../dashboard/platform/global.js";
import { withPatchedGlobals } from "./helpers/test-utils.mjs";

class CallerSignal extends EventTarget {
  constructor() {
    super();
    this.aborted = false;
    this.reason = undefined;
    this.listenerCount = 0;
  }

  addEventListener(type, listener, options) {
    if (type === "abort") this.listenerCount += 1;
    super.addEventListener(type, listener, options);
  }

  removeEventListener(type, listener, options) {
    if (type === "abort") this.listenerCount -= 1;
    super.removeEventListener(type, listener, options);
  }

  abort(reason = new DOMException("Caller aborted", "AbortError")) {
    if (this.aborted) return;
    this.aborted = true;
    this.reason = reason;
    this.dispatchEvent(new Event("abort"));
  }
}

test("fetchJson returns envelope data and cleans up after a successful request", async () => {
  const callerSignal = new CallerSignal();
  const timerToken = Symbol("timer");
  let clearedTimer;
  let request;

  await withPatchedGlobals({
    clearTimeout(token) {
      clearedTimer = token;
    },
    async fetch(url, options) {
      request = { url, options };
      return {
        ok: true,
        async json() {
          return { ok: true, data: { value: 42 }, error: null };
        }
      };
    },
    setTimeout: () => timerToken,
    window: { DASH_CONFIG: { apiBase: "/api" } }
  }, async () => {
    const data = await fetchJson("/probe", {
      fetchOptions: {
        body: JSON.stringify({ ready: true }),
        headers: { "X-Test": "request" },
        method: "POST",
        signal: callerSignal
      }
    });

    assert.deepEqual(data, { value: 42 });
    assert.equal(request.url, "/api/probe");
    assert.equal(request.options.method, "POST");
    assert.deepEqual(request.options.headers, {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Test": "request"
    });
    assert.equal(request.options.signal.aborted, false);
    assert.equal(clearedTimer, timerToken);
    assert.equal(callerSignal.listenerCount, 0);
  });
});

test("fetchJson keeps its timeout when the caller supplies a cancellation signal", async () => {
  const callerSignal = new CallerSignal();
  const timerToken = Symbol("timer");
  let clearedTimer;
  let fireTimeout;

  await withPatchedGlobals({
    clearTimeout(token) {
      clearedTimer = token;
    },
    async fetch(_url, options) {
      fireTimeout();
      if (options.signal.aborted) throw options.signal.reason;
      return {
        ok: true,
        async json() {
          return { ok: true, data: { reachedNetwork: true } };
        }
      };
    },
    setTimeout(callback) {
      fireTimeout = callback;
      return timerToken;
    },
    window: { DASH_CONFIG: { apiBase: "/api" } }
  }, async () => {
    await assert.rejects(
      fetchJson("/probe", {
        timeoutMs: 25,
        fetchOptions: { signal: callerSignal }
      }),
      { name: "AbortError" }
    );
    assert.equal(clearedTimer, timerToken);
    assert.equal(callerSignal.listenerCount, 0);
  });
});

test("fetchJson aborts when the caller cancels and removes the caller listener", async () => {
  const callerSignal = new CallerSignal();
  const cancellation = new DOMException("Navigation changed", "AbortError");
  let cleared = false;

  await withPatchedGlobals({
    clearTimeout() {
      cleared = true;
    },
    async fetch(_url, options) {
      callerSignal.abort(cancellation);
      if (options.signal.aborted) throw options.signal.reason;
      throw new Error("The request signal was not cancelled.");
    },
    setTimeout: () => Symbol("timer"),
    window: { DASH_CONFIG: { apiBase: "/api" } }
  }, async () => {
    await assert.rejects(
      fetchJson("/probe", { fetchOptions: { signal: callerSignal } }),
      (error) => error === cancellation
    );
    assert.equal(cleared, true);
    assert.equal(callerSignal.listenerCount, 0);
  });
});
