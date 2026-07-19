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

test("dashboard config keeps network status and intentional placeholders", async () => {
  const source = await readFile(new URL("../dashboard/config.js", import.meta.url), "utf8");
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);

  const widgets = context.window.DASH_CONFIG.widgets;
  const status = widgets.find((widget) => widget.id === "status");
  assert.deepEqual(
    Array.from(status.props.services, (service) => service.name),
    ["Router"]
  );

  const placeholderIds = widgets
    .filter((widget) => widget.type === "text")
    .map((widget) => widget.id);
  assert.deepEqual(Array.from(placeholderIds), ["calendar_stub", "github_ci_stub", "HA_stub"]);
});
