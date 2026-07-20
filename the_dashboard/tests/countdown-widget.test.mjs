import assert from "node:assert/strict";
import test from "node:test";

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

  toggle(value, force) {
    const enabled = force ?? !this.values.has(value);
    if (enabled) this.add(value);
    else this.remove(value);
    return enabled;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.classList = new FakeClassList();
    this.style = { setProperty() {} };
    this.textContent = "";
  }

  set className(value) {
    this.classList.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  append(...children) {
    children.forEach((child) => this.appendChild(child));
  }

  appendChild(child) {
    const currentIndex = this.children.indexOf(child);
    if (currentIndex !== -1) this.children.splice(currentIndex, 1);
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
}

test("countdown reorders existing tiles when relevance changes after midnight", async () => {
  const previous = {
    Date: globalThis.Date,
    document: globalThis.document,
    window: globalThis.window
  };
  let now = new previous.Date(2026, 6, 19, 23, 59).getTime();
  let registration;
  class FixedDate extends previous.Date {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }
  const head = new FakeElement("head");
  globalThis.Date = FixedDate;
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
    await import(`../dashboard/widgets/countdown.js?rollover=${previous.Date.now()}`);
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, {
      props: {
        includeFederal: false,
        events: [
          { label: "July 19", date: "2026-07-19T12:00:00" },
          { label: "July 20", date: "2026-07-20T12:00:00" }
        ]
      }
    });

    registration.implementation.update(state);
    assert.deepEqual(state.tiles.map((tile) => tile.evLabel), ["July 19", "July 20"]);

    now = new previous.Date(2026, 6, 20, 0, 1).getTime();
    registration.implementation.update(state);

    assert.deepEqual(state.tiles.map((tile) => tile.evLabel), ["July 20", "July 19"]);
    assert.equal(state.wrap.children[0], state.tiles[0].card);
    assert.equal(state.wrap.children[1], state.tiles[1].card);
  } finally {
    globalThis.Date = previous.Date;
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});
