import assert from "node:assert/strict";
import test from "node:test";

import { FakeElement } from "./helpers/fake-dom.mjs";
import {
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

const CHART_HEIGHT_PX = 110;
const CHART_WIDTH_PX = 500;

class NetstatsElement extends FakeElement {
  constructor(tagName) {
    super(tagName);
    this.clientHeight = CHART_HEIGHT_PX;
    this.clientWidth = CHART_WIDTH_PX;
  }
}

function responseFor(url) {
  const data = url.includes("/myip")
    ? { ip: "203.0.113.10" }
    : url.includes("/ping")
      ? { target: "localhost", ms: 20 }
      : { ping_ms: 20, download_mbps: 100, upload_mbps: 25 };
  return createSuccessResponse(data);
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

function createNetstatsDocument(head) {
  return {
    createElement: (tagName) => new NetstatsElement(tagName),
    createElementNS: (_namespace, tagName) => new NetstatsElement(tagName),
    getElementById: () => null,
    head
  };
}

function createWidgetWindow(registerWidget) {
  return {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: { registerWidget }
  };
}

test("netstats starts paused when configured and prevents overlapping work", async () => {
  const head = new NetstatsElement("head");
  const intervalCallbacks = [];
  const pending = [];
  const requestCounts = { ip: 0, ping: 0, speed: 0 };
  let registration;

  await withPatchedGlobals({
    document: createNetstatsDocument(head),
    fetch(url) {
      const kind = url.includes("/myip") ? "ip" : url.includes("/ping") ? "ping" : "speed";
      requestCounts[kind] += 1;
      return new Promise((resolve) => pending.push(() => resolve(responseFor(url))));
    },
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    window: createWidgetWindow((type, implementation) => {
      registration = { type, implementation };
    })
  }, async () => {
    try {
      await import(`../dashboard/widgets/netstats.js?test=${Date.now()}`);
      const root = new NetstatsElement("section");
      const instance = registration.implementation.mount(root, {
        props: {
          ipRefreshMs: 1000,
          pingIntervalMs: 1000,
          maxSamples: 5,
          startPaused: true
        }
      });
      await registration.implementation.update(instance);

      intervalCallbacks[0]();
      intervalCallbacks[0]();
      intervalCallbacks[1]();
      intervalCallbacks[1]();
      assert.deepEqual(requestCounts, { ip: 1, ping: 0, speed: 0 });
      assert.equal(instance.chartWrap.getAttribute("aria-pressed"), "true");
      assert.equal(instance.chartWrap.getAttribute("aria-label"), "Resume latency polling");
      assert.equal(instance.overlay.textContent, "⏸");

      instance.chartWrap.fire("click");
      intervalCallbacks[1]();
      intervalCallbacks[1]();
      instance.speedBlock.fire("click");
      instance.speedBlock.fire("click");

      assert.deepEqual(requestCounts, { ip: 1, ping: 1, speed: 1 });
    } finally {
      pending.forEach((resolve) => resolve());
      await new Promise((resolve) => setImmediate(resolve));
    }
  });
});

test("netstats preserves readings through failures and clears stale state after recovery", async () => {
  const head = new NetstatsElement("head");
  const intervalCallbacks = [];
  const responses = {
    ip: [
      createSuccessResponse({ ip: "203.0.113.10" }),
      new Error("IP offline"),
      createSuccessResponse({ ip: "203.0.113.11" })
    ],
    ping: [
      createSuccessResponse({ target: "localhost", ms: 20 }),
      new Error("Ping offline"),
      createSuccessResponse({ target: "localhost", ms: 30 })
    ],
    speed: [
      createSuccessResponse({ ping_ms: 15, download_mbps: 100, upload_mbps: 25 }),
      new Error("Speed offline"),
      createSuccessResponse({ ping_ms: 18, download_mbps: 120, upload_mbps: 30 })
    ]
  };
  let registration;

  await withPatchedGlobals({
    document: createNetstatsDocument(head),
    async fetch(url) {
      const kind = url.includes("/myip") ? "ip" : url.includes("/ping") ? "ping" : "speed";
      const response = responses[kind].shift();
      if (response instanceof Error) throw response;
      return response;
    },
    setInterval(callback) {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    },
    window: createWidgetWindow((type, implementation) => {
      registration = { type, implementation };
    })
  }, async () => {
    await import(`../dashboard/widgets/netstats.js?recovery=${Date.now()}`);
    const root = new NetstatsElement("section");
    const instance = registration.implementation.mount(root, {
      props: { ipRefreshMs: 1000, pingIntervalMs: 1000, maxSamples: 5 }
    });
    await registration.implementation.update(instance);
    intervalCallbacks[1]();
    instance.speedBlock.fire("click");
    await flushAsyncWork();

    assert.equal(instance.speedBlock.tagName, "button");
    assert.equal(instance.speedBlock.type, "button");
    assert.equal(instance.chartWrap.tagName, "button");
    assert.equal(instance.chartWrap.getAttribute("aria-pressed"), "false");
    assert.equal(instance.ipValue.textContent, "203.0.113.10");
    assert.equal(instance.downloadValue.textContent, "100 Mbps");
    assert.deepEqual(instance.samples, [20]);

    intervalCallbacks[0]();
    intervalCallbacks[1]();
    instance.speedBlock.fire("click");
    await flushAsyncWork();

    assert.equal(instance.ipValue.textContent, "203.0.113.10");
    assert.equal(instance.downloadValue.textContent, "100 Mbps");
    assert.deepEqual(instance.samples, [20]);
    assert.match(instance.ipStatus.textContent, /showing previous value/);
    assert.match(instance.pingStatus.textContent, /showing previous samples/);
    assert.match(instance.speedStatus.textContent, /showing previous result/);
    assert.equal(instance.ipRow.classList.contains("warn"), true);
    assert.equal(instance.chartWrap.classList.contains("warn"), true);
    assert.equal(instance.speedBlock.classList.contains("warn"), true);
    assert.equal(instance.speedBlock.getAttribute("aria-busy"), "false");

    intervalCallbacks[0]();
    intervalCallbacks[1]();
    instance.speedBlock.fire("click");
    await flushAsyncWork();

    assert.equal(instance.ipValue.textContent, "203.0.113.11");
    assert.equal(instance.downloadValue.textContent, "120 Mbps");
    assert.deepEqual(instance.samples, [20, 30]);
    assert.equal(instance.ipStatus.textContent, "");
    assert.equal(instance.pingStatus.textContent, "");
    assert.equal(instance.speedStatus.textContent, "");
    assert.equal(instance.ipRow.classList.contains("warn"), false);
    assert.equal(instance.chartWrap.classList.contains("warn"), false);
    assert.equal(instance.speedBlock.classList.contains("warn"), false);

    instance.chartWrap.fire("click");
    assert.equal(instance.chartWrap.getAttribute("aria-pressed"), "true");
    assert.equal(instance.chartWrap.getAttribute("aria-label"), "Resume latency polling");
    instance.chartWrap.fire("click");
    assert.equal(instance.chartWrap.getAttribute("aria-pressed"), "false");
    assert.equal(instance.chartWrap.getAttribute("aria-label"), "Pause latency polling");
  });
});
