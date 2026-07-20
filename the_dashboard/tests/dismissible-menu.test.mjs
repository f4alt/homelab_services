import assert from "node:assert/strict";
import test from "node:test";

import { createDismissibleMenu } from "../dashboard/platform/global.js";

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
  constructor(tagName = "div") {
    this.attributes = new Map();
    this.children = [];
    this.classList = new FakeClassList();
    this.events = new Map();
    this.focusCalls = 0;
    this.tagName = tagName;
    this.textContent = "";
    this.value = "";
  }

  set className(value) {
    this.classList.values = new Set(String(value || "").split(/\s+/).filter(Boolean));
  }

  get className() {
    return [...this.classList.values].join(" ");
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
    child.parentElement = this;
    this.children.push(child);
    return child;
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains(target));
  }

  fire(type, values = {}) {
    const event = {
      target: this,
      key: values.key,
      defaultPrevented: false,
      propagationStopped: false,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      }
    };
    for (const listener of this.events.get(type) || []) listener(event);
    return event;
  }

  focus() {
    this.focusCalls += 1;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
}

class FakeDocument {
  constructor() {
    this.head = new FakeElement("head");
    this.listeners = new Map();
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  listenerCount(type) {
    return this.listeners.get(type)?.size || 0;
  }

  createElement(tagName) {
    return new FakeElement(tagName);
  }

  getElementById(id) {
    function find(element) {
      if (element.id === id) return element;
      for (const child of element.children) {
        const match = find(child);
        if (match) return match;
      }
      return null;
    }
    return find(this.head);
  }

  fire(type, { target, key } = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) {
      listener({ target, key });
    }
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener);
  }
}

test("dismissible menu toggles ARIA state and keeps listeners only while open", () => {
  const previousDocument = globalThis.document;
  const fakeDocument = new FakeDocument();
  const trigger = new FakeElement();
  const menu = new FakeElement();
  const changes = [];
  globalThis.document = fakeDocument;

  try {
    const controller = createDismissibleMenu({
      trigger,
      menu,
      onOpenChange: (isOpen) => changes.push(isOpen)
    });

    assert.equal(controller.isOpen(), false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(fakeDocument.listenerCount("click"), 0);
    assert.equal(fakeDocument.listenerCount("keydown"), 0);

    controller.toggle();
    assert.equal(controller.isOpen(), true);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(menu.classList.contains("popup-menu-open"), true);
    assert.equal(fakeDocument.listenerCount("click"), 1);
    assert.equal(fakeDocument.listenerCount("keydown"), 1);

    controller.close();
    assert.equal(controller.isOpen(), false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(menu.classList.contains("popup-menu-open"), false);
    assert.equal(fakeDocument.listenerCount("click"), 0);
    assert.equal(fakeDocument.listenerCount("keydown"), 0);
    assert.deepEqual(changes, [true, false]);
  } finally {
    globalThis.document = previousDocument;
  }
});

test("search exposes one dismissible listbox and preserves engine selection and submission", async () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window
  };
  const fakeDocument = new FakeDocument();
  const opened = [];
  let registration;
  globalThis.document = fakeDocument;
  globalThis.window = {
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    },
    open(...args) {
      opened.push(args);
      return null;
    }
  };

  try {
    await import(`../dashboard/widgets/search.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const instance = registration.implementation.mount(root, {
      id: "search_test",
      props: {
        placeholder: "Find it",
        engines: [
          { name: "First", buildUrl: (query) => `/first?q=${query}` },
          { name: "Second", buildUrl: (query) => `/second?q=${query}` }
        ]
      }
    });
    const [firstItem, secondItem] = instance.menu.children;

    assert.equal(registration.type, "search");
    assert.equal(instance.engineBtn.getAttribute("aria-haspopup"), "listbox");
    assert.equal(instance.engineBtn.getAttribute("aria-expanded"), "false");
    assert.equal(instance.menu.getAttribute("role"), "listbox");
    assert.equal(firstItem.getAttribute("aria-selected"), "true");
    assert.equal(secondItem.getAttribute("aria-selected"), "false");
    assert.equal(fakeDocument.listenerCount("click"), 0);

    instance.engineBtn.fire("click");
    assert.equal(instance.engineBtn.getAttribute("aria-expanded"), "true");
    assert.equal(fakeDocument.listenerCount("click"), 1);

    secondItem.fire("click");
    assert.equal(instance.engineBtn.textContent, "Second");
    assert.equal(firstItem.getAttribute("aria-selected"), "false");
    assert.equal(secondItem.getAttribute("aria-selected"), "true");
    assert.equal(instance.engineBtn.getAttribute("aria-expanded"), "false");
    assert.equal(instance.input.focusCalls, 1);
    assert.equal(fakeDocument.listenerCount("click"), 0);

    instance.input.value = "dashboard";
    const submitEvent = instance.input.fire("keydown", { key: "Enter" });
    assert.equal(submitEvent.defaultPrevented, true);
    assert.equal(opened[0][0], "/second?q=dashboard");
    assert.equal(instance.input.value, "");

    instance.menuController.open();
    fakeDocument.fire("click", { target: new FakeElement("aside") });
    assert.equal(instance.menuController.isOpen(), false);
    assert.equal(fakeDocument.listenerCount("click"), 0);

    instance.menuController.open();
    fakeDocument.fire("keydown", { key: "Escape" });
    assert.equal(instance.menuController.isOpen(), false);
    assert.equal(instance.engineBtn.focusCalls, 1);
  } finally {
    globalThis.document = previous.document;
    globalThis.window = previous.window;
  }
});

test("todos installs dismissal listeners only while its list picker is open", async () => {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    window: globalThis.window
  };
  const fakeDocument = new FakeDocument();
  let registration;
  globalThis.document = fakeDocument;
  globalThis.fetch = async () => ({
    ok: true,
    async json() {
      return {
        ok: true,
        data: {
          tasks: [
            { uid: "a", content: "First task", source_file: "alpha.org", status: "TODO" },
            { uid: "b", content: "Second task", source_file: "beta.org", status: "TODO" }
          ]
        },
        error: null
      };
    }
  });
  globalThis.window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    await import(`../dashboard/widgets/todos.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    const instance = registration.implementation.mount(root, {
      id: "todos_test",
      props: { defaultList: "alpha.org" }
    });

    assert.equal(registration.type, "todos");
    assert.equal(instance.listButton.tagName, "button");
    assert.equal(instance.listButton.getAttribute("aria-haspopup"), "listbox");
    assert.equal(instance.listButton.getAttribute("aria-expanded"), "false");
    assert.equal(fakeDocument.listenerCount("click"), 0);

    await registration.implementation.update(instance);
    assert.equal(instance.selectedList, "alpha.org");
    assert.equal(instance.menu.children.length, 2);

    instance.listButton.fire("click");
    assert.equal(instance.listButton.getAttribute("aria-expanded"), "true");
    assert.equal(fakeDocument.listenerCount("click"), 1);

    instance.menu.children[1].fire("click");
    assert.equal(instance.selectedList, "beta.org");
    assert.equal(instance.listButton.getAttribute("aria-expanded"), "false");
    assert.equal(fakeDocument.listenerCount("click"), 0);

    instance.menuController.open();
    fakeDocument.fire("click", { target: new FakeElement("aside") });
    assert.equal(instance.menuController.isOpen(), false);
    assert.equal(fakeDocument.listenerCount("click"), 0);
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
});

test("dismissible menus keep instance state independent and dismiss outside or on Escape", () => {
  const previousDocument = globalThis.document;
  const fakeDocument = new FakeDocument();
  const triggerA = new FakeElement();
  const menuA = new FakeElement();
  const triggerB = new FakeElement();
  const menuB = new FakeElement();
  globalThis.document = fakeDocument;

  try {
    const menuControllerA = createDismissibleMenu({ trigger: triggerA, menu: menuA });
    const menuControllerB = createDismissibleMenu({ trigger: triggerB, menu: menuB });

    menuControllerA.open();
    menuControllerB.open();
    assert.equal(fakeDocument.listenerCount("click"), 2);

    fakeDocument.fire("click", { target: triggerA });
    assert.equal(menuControllerA.isOpen(), true);
    assert.equal(menuControllerB.isOpen(), false);
    assert.equal(fakeDocument.listenerCount("click"), 1);

    fakeDocument.fire("keydown", { key: "Escape" });
    assert.equal(menuControllerA.isOpen(), false);
    assert.equal(triggerA.focusCalls, 1);
    assert.equal(fakeDocument.listenerCount("click"), 0);
    assert.equal(fakeDocument.listenerCount("keydown"), 0);
  } finally {
    globalThis.document = previousDocument;
  }
});
