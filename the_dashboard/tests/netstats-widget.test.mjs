import assert from "node:assert/strict";
import test from "node:test";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  contains(value) {
    return this.values.has(value);
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }

  toggle(value, force) {
    const enabled = force ?? !this.contains(value);
    if (enabled) this.add(value);
    else this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.clientHeight = 110;
    this.clientWidth = 500;
    this.events = new Map();
    this.textContent = "";
  }

  set className(value) {
    this.classList.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classList.values].join(" ");
  }

  get firstChild() {
    return this.children[0] || null;
  }

  addEventListener(type, listener) {
    const listeners = this.events.get(type) || new Set();
    listeners.add(listener);
    this.events.set(type, listeners);
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  fire(type) {
    for (const listener of this.events.get(type) || []) listener({ target: this });
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index !== -1) this.children.splice(index, 1);
  }

  replaceChildren(...children) {
    this.children = children;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function responseFor(url) {
  const data = url.includes("/myip")
    ? { ip: "203.0.113.10" }
    : url.includes("/ping")
      ? { target: "localhost", ms: 20 }
      : { ping_ms: 20, download_mbps: 100, upload_mbps: 25 };
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, data, error: null };
    }
  };
}

function successResponse(data) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { ok: true, data, error: null };
    }
  };
}

async function flushAsyncWork() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

test("netstats prevents overlapping work for each polling operation", async () => {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    window: globalThis.window
  };
  const head = new FakeElement("head");
  const intervalCallbacks = [];
  const pending = [];
  const requestCounts = { ip: 0, ping: 0, speed: 0 };
  let registration;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    getElementById: () => null,
    head
  };
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return intervalCallbacks.length;
  };
  globalThis.fetch = (url) => {
    const kind = url.includes("/myip") ? "ip" : url.includes("/ping") ? "ping" : "speed";
    requestCounts[kind] += 1;
    return new Promise((resolve) => pending.push(() => resolve(responseFor(url))));
  };
  globalThis.window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    await import(`../dashboard/widgets/netstats.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const instance = registration.implementation.mount(root, {
      props: { ipRefreshMs: 1000, pingIntervalMs: 1000, maxSamples: 5 }
    });
    await registration.implementation.update(instance);

    intervalCallbacks[0]();
    intervalCallbacks[0]();
    intervalCallbacks[1]();
    intervalCallbacks[1]();
    instance.speedBlock.fire("click");
    instance.speedBlock.fire("click");

    assert.deepEqual(requestCounts, { ip: 1, ping: 1, speed: 1 });
  } finally {
    pending.forEach((resolve) => resolve());
    await new Promise((resolve) => setImmediate(resolve));
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.setInterval = previous.setInterval;
    globalThis.window = previous.window;
  }
});

test("netstats preserves readings through failures and clears stale state after recovery", async () => {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    window: globalThis.window
  };
  const head = new FakeElement("head");
  const intervalCallbacks = [];
  const responses = {
    ip: [
      successResponse({ ip: "203.0.113.10" }),
      new Error("IP offline"),
      successResponse({ ip: "203.0.113.11" })
    ],
    ping: [
      successResponse({ target: "localhost", ms: 20 }),
      new Error("Ping offline"),
      successResponse({ target: "localhost", ms: 30 })
    ],
    speed: [
      successResponse({ ping_ms: 15, download_mbps: 100, upload_mbps: 25 }),
      new Error("Speed offline"),
      successResponse({ ping_ms: 18, download_mbps: 120, upload_mbps: 30 })
    ]
  };
  let registration;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    createElementNS: (_namespace, tagName) => new FakeElement(tagName),
    getElementById: () => null,
    head
  };
  globalThis.setInterval = (callback) => {
    intervalCallbacks.push(callback);
    return intervalCallbacks.length;
  };
  globalThis.fetch = async (url) => {
    const kind = url.includes("/myip") ? "ip" : url.includes("/ping") ? "ping" : "speed";
    const response = responses[kind].shift();
    if (response instanceof Error) throw response;
    return response;
  };
  globalThis.window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    await import(`../dashboard/widgets/netstats.js?recovery=${Date.now()}`);
    const root = new FakeElement("section");
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
    assert.equal(instance.valIP.textContent, "203.0.113.10");
    assert.equal(instance.valDL.textContent, "100 Mbps");
    assert.deepEqual(instance.samples, [20]);

    intervalCallbacks[0]();
    intervalCallbacks[1]();
    instance.speedBlock.fire("click");
    await flushAsyncWork();

    assert.equal(instance.valIP.textContent, "203.0.113.10");
    assert.equal(instance.valDL.textContent, "100 Mbps");
    assert.deepEqual(instance.samples, [20]);
    assert.match(instance.ipStatus.textContent, /showing previous value/);
    assert.match(instance.pingStatus.textContent, /showing previous samples/);
    assert.match(instance.speedStatus.textContent, /showing previous result/);
    assert.equal(instance.rowIP.classList.contains("netstats-stale"), true);
    assert.equal(instance.chartWrap.classList.contains("netstats-stale"), true);
    assert.equal(instance.speedBlock.classList.contains("netstats-stale"), true);
    assert.equal(instance.speedBlock.getAttribute("aria-busy"), "false");

    intervalCallbacks[0]();
    intervalCallbacks[1]();
    instance.speedBlock.fire("click");
    await flushAsyncWork();

    assert.equal(instance.valIP.textContent, "203.0.113.11");
    assert.equal(instance.valDL.textContent, "120 Mbps");
    assert.deepEqual(instance.samples, [20, 30]);
    assert.equal(instance.ipStatus.textContent, "");
    assert.equal(instance.pingStatus.textContent, "");
    assert.equal(instance.speedStatus.textContent, "");
    assert.equal(instance.rowIP.classList.contains("netstats-stale"), false);
    assert.equal(instance.chartWrap.classList.contains("netstats-stale"), false);
    assert.equal(instance.speedBlock.classList.contains("netstats-stale"), false);

    instance.chartWrap.fire("click");
    assert.equal(instance.chartWrap.getAttribute("aria-pressed"), "true");
    assert.equal(instance.chartWrap.getAttribute("aria-label"), "Resume latency polling");
    instance.chartWrap.fire("click");
    assert.equal(instance.chartWrap.getAttribute("aria-pressed"), "false");
    assert.equal(instance.chartWrap.getAttribute("aria-label"), "Pause latency polling");
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.setInterval = previous.setInterval;
    globalThis.window = previous.window;
  }
});
