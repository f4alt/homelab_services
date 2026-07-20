import assert from "node:assert/strict";
import test from "node:test";

import { fetchJson } from "../dashboard/platform/global.js";

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
  const previous = {
    clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    window: globalThis.window
  };
  const callerSignal = new CallerSignal();
  const timerToken = Symbol("timer");
  let clearedTimer;
  let request;

  globalThis.window = { DASH_CONFIG: { apiBase: "/api" } };
  globalThis.setTimeout = () => timerToken;
  globalThis.clearTimeout = (token) => {
    clearedTimer = token;
  };
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      async json() {
        return { ok: true, data: { value: 42 }, error: null };
      }
    };
  };

  try {
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
  } finally {
    globalThis.clearTimeout = previous.clearTimeout;
    globalThis.fetch = previous.fetch;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.window = previous.window;
  }
});

test("fetchJson keeps its timeout when the caller supplies a cancellation signal", async () => {
  const previous = {
    clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    window: globalThis.window
  };
  const callerSignal = new CallerSignal();
  const timerToken = Symbol("timer");
  let clearedTimer;
  let fireTimeout;

  globalThis.window = { DASH_CONFIG: { apiBase: "/api" } };
  globalThis.setTimeout = (callback) => {
    fireTimeout = callback;
    return timerToken;
  };
  globalThis.clearTimeout = (token) => {
    clearedTimer = token;
  };
  globalThis.fetch = async (_url, options) => {
    fireTimeout();
    if (options.signal.aborted) throw options.signal.reason;
    return {
      ok: true,
      async json() {
        return { ok: true, data: { reachedNetwork: true } };
      }
    };
  };

  try {
    await assert.rejects(
      fetchJson("/probe", {
        timeoutMs: 25,
        fetchOptions: { signal: callerSignal }
      }),
      { name: "AbortError" }
    );
    assert.equal(clearedTimer, timerToken);
    assert.equal(callerSignal.listenerCount, 0);
  } finally {
    globalThis.clearTimeout = previous.clearTimeout;
    globalThis.fetch = previous.fetch;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.window = previous.window;
  }
});

test("fetchJson aborts when the caller cancels and removes the caller listener", async () => {
  const previous = {
    clearTimeout: globalThis.clearTimeout,
    fetch: globalThis.fetch,
    setTimeout: globalThis.setTimeout,
    window: globalThis.window
  };
  const callerSignal = new CallerSignal();
  const cancellation = new DOMException("Navigation changed", "AbortError");
  let cleared = false;

  globalThis.window = { DASH_CONFIG: { apiBase: "/api" } };
  globalThis.setTimeout = () => Symbol("timer");
  globalThis.clearTimeout = () => {
    cleared = true;
  };
  globalThis.fetch = async (_url, options) => {
    callerSignal.abort(cancellation);
    if (options.signal.aborted) throw options.signal.reason;
    throw new Error("The request signal was not cancelled.");
  };

  try {
    await assert.rejects(
      fetchJson("/probe", { fetchOptions: { signal: callerSignal } }),
      (error) => error === cancellation
    );
    assert.equal(cleared, true);
    assert.equal(callerSignal.listenerCount, 0);
  } finally {
    globalThis.clearTimeout = previous.clearTimeout;
    globalThis.fetch = previous.fetch;
    globalThis.setTimeout = previous.setTimeout;
    globalThis.window = previous.window;
  }
});
