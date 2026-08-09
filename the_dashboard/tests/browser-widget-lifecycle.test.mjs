import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

class FakeClassList {
  constructor() {
    this.values = new Set();
  }

  add(...values) {
    values.forEach((value) => this.values.add(value));
  }

  remove(...values) {
    values.forEach((value) => this.values.delete(value));
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.classList = new FakeClassList();
    this.dataset = {};
    this.style = {
      setProperty: () => {}
    };
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  append(...children) {
    this.children.push(...children);
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

test("the shell only calls and schedules widgets that implement update", async () => {
  const previous = {
    document: globalThis.document,
    getComputedStyle: globalThis.getComputedStyle,
    setInterval: globalThis.setInterval,
    window: globalThis.window
  };

  const grid = new FakeElement("main");
  let onDomContentLoaded;
  let intervalCalls = 0;
  let mountCalls = 0;
  let updateCalls = 0;

  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: (id) => id === "grid" ? grid : null
  };
  globalThis.getComputedStyle = () => ({ gridTemplateColumns: "100px" });
  globalThis.setInterval = () => {
    intervalCalls += 1;
  };
  globalThis.window = {
    DASH_CONFIG: {
      apiBase: "/api",
      widgets: [
        { id: "static_test", type: "static_test", refreshMs: 1000 },
        { id: "updating_test", type: "updating_test", refreshMs: 1000 }
      ]
    },
    addEventListener(event, handler) {
      if (event === "DOMContentLoaded") onDomContentLoaded = handler;
    }
  };

  try {
    await import(`../dashboard/platform/dashboard.js?test=${Date.now()}`);
    window.DASH.registerWidget("static_test", {
      mount() {
        mountCalls += 1;
        return {};
      }
    });
    window.DASH.registerWidget("updating_test", {
      mount() {
        mountCalls += 1;
        return {};
      },
      update() {
        updateCalls += 1;
      }
    });

    await onDomContentLoaded();

    assert.equal(mountCalls, 2);
    assert.equal(updateCalls, 1);
    assert.equal(intervalCalls, 1);
  } finally {
    globalThis.document = previous.document;
    globalThis.getComputedStyle = previous.getComputedStyle;
    globalThis.setInterval = previous.setInterval;
    globalThis.window = previous.window;
  }
});

test("Search registers as a static widget without a no-op update", async () => {
  const previousWindow = globalThis.window;
  let registration;
  globalThis.window = {
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    await import(`../dashboard/widgets/search.js?test=${Date.now()}`);
    assert.equal(registration.type, "search");
    assert.equal(typeof registration.implementation.update, "undefined");
  } finally {
    globalThis.window = previousWindow;
  }
});

test("Text renders configured text without registering network updates", async () => {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    window: globalThis.window
  };
  let fetchCalls = 0;
  let registration;

  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName)
  };
  globalThis.fetch = async () => {
    fetchCalls += 1;
    throw new Error("Text widgets must not fetch.");
  };
  globalThis.window = {
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    await import(`../dashboard/widgets/text.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, {
      props: { text: "Calendar placeholder", fetchUrl: "https://example.invalid/feed" }
    });

    assert.equal(registration.type, "text");
    assert.equal(typeof registration.implementation.update, "undefined");
    assert.equal(state.body.textContent, "Calendar placeholder");
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
});

test("Clocks use the shared large-value typography for time", async () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window
  };
  let registration;
  const head = new FakeElement("head");
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: () => null,
    head
  };
  globalThis.window = {
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    await import(`../dashboard/widgets/clocks.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, {
      props: { zones: [{ label: "UTC", tz: "UTC" }] }
    });

    assert.equal(registration.type, "clocks");
    assert.match(state.cards[0].timeEl.className, /(^|\s)value-large(\s|$)/);
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});

test("dashboard config keeps service status, calendar, Home Assistant, and intentional placeholders", async () => {
  const source = await readFile(new URL("../dashboard/config.js", import.meta.url), "utf8");
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);

  const widgets = context.window.DASH_CONFIG.widgets;
  const status = widgets.find((widget) => widget.id === "status");
  assert.deepEqual(
    Array.from(status.props.services, (service) => service.name),
    ["Router", "Pi-hole"]
  );

  const pihole = status.props.services.find((service) => service.name === "Pi-hole");
  assert.equal(pihole.url, "http://192.168.1.36/admin/");

  const placeholderIds = widgets
    .filter((widget) => widget.type === "text")
    .map((widget) => widget.id);
  assert.deepEqual(Array.from(placeholderIds), ["github_ci_stub"]);

  const calendar = widgets.find((widget) => widget.id === "calendar");
  assert.equal(calendar.type, "calendar");
  assert.equal(calendar.width, 1);
  assert.equal(calendar.refreshMs, 300000);
  assert.match(calendar.props.feedUrl, /^https:\/\//);

  const homeAssistant = widgets.find((widget) => widget.id === "home_assistant");
  assert.equal(homeAssistant.type, "home-assistant");
  assert.equal(homeAssistant.refreshMs, 0);
  assert.deepEqual(Array.from(homeAssistant.props.buttons), []);
});
