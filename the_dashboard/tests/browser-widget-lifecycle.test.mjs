import assert from "node:assert/strict";
import test from "node:test";

import { FakeDocument, FakeElement } from "./helpers/fake-dom.mjs";
import { withPatchedGlobals } from "./helpers/test-utils.mjs";

test("the shell only calls and schedules widgets that implement update", async () => {
  const grid = new FakeElement("main");
  let onDomContentLoaded;
  let intervalCalls = 0;
  let mountCalls = 0;
  let updateCalls = 0;

  await withPatchedGlobals({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      getElementById: (id) => id === "grid" ? grid : null
    },
    getComputedStyle: () => ({ gridTemplateColumns: "100px" }),
    setInterval() {
      intervalCalls += 1;
    },
    window: {
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
    }
  }, async () => {
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
  });
});

test("shared widget styles are installed once per document", async () => {
  const document = new FakeDocument();

  await withPatchedGlobals({ document }, async () => {
    const { installWidgetStyles } = await import(
      `../dashboard/platform/global.js?styles=${Date.now()}`
    );

    installWidgetStyles("example-widget-styles", ".example { color: red; }");
    installWidgetStyles("example-widget-styles", ".example { color: blue; }");

    assert.equal(document.head.children.length, 1);
    assert.equal(document.head.children[0].textContent, ".example { color: red; }");
  });
});

test("Search registers as a static widget without a no-op update", async () => {
  let registration;
  await withPatchedGlobals({
    window: {
      DASH: {
        registerWidget(type, implementation) {
          registration = { type, implementation };
        }
      }
    }
  }, async () => {
    await import(`../dashboard/widgets/search.js?test=${Date.now()}`);
    assert.equal(registration.type, "search");
    assert.equal(typeof registration.implementation.update, "undefined");
  });
});

test("Text renders configured text without registering network updates", async () => {
  let fetchCalls = 0;
  let registration;

  await withPatchedGlobals({
    document: {
      createElement: (tagName) => new FakeElement(tagName)
    },
    async fetch() {
      fetchCalls += 1;
      throw new Error("Text widgets must not fetch.");
    },
    window: {
      DASH: {
        registerWidget(type, implementation) {
          registration = { type, implementation };
        }
      }
    }
  }, async () => {
    await import(`../dashboard/widgets/text.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      props: { text: "Calendar placeholder", fetchUrl: "https://example.invalid/feed" }
    });

    assert.equal(registration.type, "text");
    assert.equal(typeof registration.implementation.update, "undefined");
    assert.equal(root.children[0].textContent, "Calendar placeholder");
    assert.equal(fetchCalls, 0);
  });
});

test("Clocks use the shared large-value typography for time", async () => {
  let registration;
  const head = new FakeElement("head");
  await withPatchedGlobals({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      getElementById: () => null,
      head
    },
    window: {
      DASH: {
        registerWidget(type, implementation) {
          registration = { type, implementation };
        }
      }
    }
  }, async () => {
    await import(`../dashboard/widgets/clocks.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, {
      props: { zones: [{ label: "UTC", tz: "UTC" }] }
    });

    assert.equal(registration.type, "clocks");
    assert.match(state.cards[0].timeElement.className, /(^|\s)value-large(\s|$)/);
  });
});
