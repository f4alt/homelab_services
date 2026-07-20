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
    this.children = [];
    this.classList = new FakeClassList();
    this.textContent = "";
  }

  set className(value) {
    this.classList.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classList.values].join(" ");
  }

  appendChild(child) {
    this.children.push(child);
    return child;
  }

  replaceChildren(...children) {
    this.children = children;
  }
}

test("METAR renders Gateway failure details and recovers the existing station row", async () => {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    window: globalThis.window
  };
  const head = new FakeElement("head");
  let registration;
  let requestCount = 0;
  globalThis.document = {
    createElement: (tagName) => new FakeElement(tagName),
    getElementById: () => null,
    head
  };
  globalThis.fetch = async () => {
    requestCount += 1;
    if (requestCount === 1) {
      return {
        ok: false,
        status: 502,
        async json() {
          return {
            ok: false,
            data: null,
            error: { code: "upstream_error", message: "Gateway offline" }
          };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          ok: true,
          data: {
            stations: {
              KDFW: {
                icaoId: "KDFW",
                rawOb: "KDFW 191753Z 18012KT 10SM CLR 31/22 A2992 RMK AO2"
              }
            }
          },
          error: null
        };
      }
    };
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
    await import(`../dashboard/widgets/metar.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const instance = registration.implementation.mount(root, {
      props: { stations: ["KDFW"] }
    });
    const originalRow = instance.rows.KDFW;

    await registration.implementation.update(instance);
    assert.equal(originalRow.station.textContent, "KDFW");
    assert.equal(originalRow.timestampSpan.textContent, "ERR");
    assert.equal(originalRow.remarksSpan.textContent, "Gateway unavailable: Gateway offline");
    assert.equal(originalRow.tile.classList.contains("error"), true);

    await registration.implementation.update(instance);
    assert.equal(instance.rows.KDFW, originalRow);
    assert.equal(originalRow.station.textContent, "KDFW");
    assert.equal(originalRow.timestampSpan.textContent, "191753Z");
    assert.equal(originalRow.windSpan.textContent, "180@12KT");
    assert.equal(originalRow.remarksSpan.textContent, "AO2");
    assert.equal(originalRow.tile.classList.contains("error"), false);
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
});
