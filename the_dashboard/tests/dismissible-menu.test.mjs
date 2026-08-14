import assert from "node:assert/strict";
import test from "node:test";

import {
  bindHoverPopup,
  createDismissibleMenu
} from "../dashboard/platform/global.js";
import {
  FakeDocument,
  FakeElement,
  findByClass
} from "./helpers/fake-dom.mjs";
import { withPatchedGlobals } from "./helpers/test-utils.mjs";

test("hover popups keep their in-flow fallback without CSS anchor support", async () => {
  const trigger = new FakeElement("div", { supportsPopover: true });
  const popup = new FakeElement("div", { supportsPopover: true });

  await withPatchedGlobals({ CSS: { supports: () => false } }, async () => {
    bindHoverPopup(trigger, popup);

    trigger.fire("mouseenter");
    assert.equal(popup.classList.contains("popup--floating"), false);
    assert.equal(popup.getAttribute("popover"), null);
    assert.equal(popup.showPopoverCalls, 0);
  });
});

test("hover popups require every anchor feature used by shared styles", async () => {
  const trigger = new FakeElement("div", { supportsPopover: true });
  const popup = new FakeElement("div", { supportsPopover: true });

  await withPatchedGlobals({
    CSS: {
      supports: (query) => query !== "width: anchor-size(width)"
    }
  }, async () => {
    bindHoverPopup(trigger, popup);

    assert.equal(popup.classList.contains("popup--floating"), false);
    assert.equal(popup.getAttribute("popover"), null);
  });
});

test("dismissible menu toggles ARIA state and keeps listeners only while open", async () => {
  const fakeDocument = new FakeDocument();
  const trigger = new FakeElement("button", { supportsPopover: true });
  const menu = new FakeElement("div", { supportsPopover: true });
  const changes = [];

  await withPatchedGlobals({
    CSS: { supports: () => true },
    document: fakeDocument
  }, async () => {
    const controller = createDismissibleMenu({
      trigger,
      menu,
      onOpenChange: (isOpen) => changes.push(isOpen)
    });

    assert.equal(controller.isOpen(), false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(menu.classList.contains("popup--floating"), true);
    assert.equal(menu.getAttribute("popover"), "manual");
    assert.equal(fakeDocument.listenerCount("click"), 0);
    assert.equal(fakeDocument.listenerCount("keydown"), 0);

    controller.toggle();
    assert.equal(controller.isOpen(), true);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(menu.classList.contains("popup-menu-open"), true);
    assert.equal(menu.showPopoverCalls, 1);
    assert.equal(fakeDocument.listenerCount("click"), 1);
    assert.equal(fakeDocument.listenerCount("keydown"), 1);

    controller.close();
    assert.equal(controller.isOpen(), false);
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(menu.classList.contains("popup-menu-open"), false);
    assert.equal(menu.hidePopoverCalls, 1);
    assert.equal(fakeDocument.listenerCount("click"), 0);
    assert.equal(fakeDocument.listenerCount("keydown"), 0);
    assert.deepEqual(changes, [true, false]);
  });
});

test("search exposes one dismissible listbox and preserves engine selection and submission", async () => {
  const fakeDocument = new FakeDocument();
  const opened = [];
  let registration;

  await withPatchedGlobals({
    document: fakeDocument,
    window: {
      DASH: {
        registerWidget(type, implementation) {
          registration = { type, implementation };
        }
      },
      open(...args) {
        opened.push(args);
        return null;
      }
    }
  }, async () => {
    await import(`../dashboard/widgets/search.js?test=${Date.now()}`);
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      id: "search_test",
      props: {
        placeholder: "Find it",
        engines: [
          { name: "First", buildUrl: (query) => `/first?q=${query}` },
          { name: "Second", buildUrl: (query) => `/second?q=${query}` }
        ]
      }
    });
    const engineButton = findByClass(root, "search-engine-btn");
    const input = findByClass(root, "search-input");
    const menu = findByClass(root, "search-engine-menu");
    const [firstItem, secondItem] = menu.children;

    assert.equal(registration.type, "search");
    assert.equal(engineButton.getAttribute("aria-haspopup"), "listbox");
    assert.equal(engineButton.getAttribute("aria-expanded"), "false");
    assert.equal(menu.getAttribute("role"), "listbox");
    assert.equal(firstItem.className, "popup-menu-item clickable label");
    assert.equal(firstItem.children.length, 0);
    assert.equal(firstItem.textContent, "First");
    assert.equal(firstItem.getAttribute("aria-selected"), "true");
    assert.equal(secondItem.getAttribute("aria-selected"), "false");
    assert.equal(fakeDocument.listenerCount("click"), 0);

    engineButton.fire("click");
    assert.equal(engineButton.getAttribute("aria-expanded"), "true");
    assert.equal(fakeDocument.listenerCount("click"), 1);

    secondItem.fire("click");
    assert.equal(engineButton.textContent, "Second");
    assert.equal(firstItem.getAttribute("aria-selected"), "false");
    assert.equal(secondItem.getAttribute("aria-selected"), "true");
    assert.equal(engineButton.getAttribute("aria-expanded"), "false");
    assert.equal(input.focusCalls, 1);
    assert.equal(fakeDocument.listenerCount("click"), 0);

    input.value = "dashboard";
    const submitEvent = input.fire("keydown", { key: "Enter" });
    assert.equal(submitEvent.defaultPrevented, true);
    assert.deepEqual(opened[0], [
      "/second?q=dashboard",
      "_blank",
      "noopener,noreferrer"
    ]);
    assert.equal(input.value, "");

    engineButton.fire("click");
    fakeDocument.fire("click", { target: new FakeElement("aside") });
    assert.equal(engineButton.getAttribute("aria-expanded"), "false");
    assert.equal(fakeDocument.listenerCount("click"), 0);

    engineButton.fire("click");
    fakeDocument.fire("keydown", { key: "Escape" });
    assert.equal(engineButton.getAttribute("aria-expanded"), "false");
    assert.equal(engineButton.focusCalls, 1);
  });
});

test("todos installs dismissal listeners only while its list picker is open", async () => {
  const fakeDocument = new FakeDocument();
  let registration;

  await withPatchedGlobals({
    document: fakeDocument,
    fetch: async () => ({
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
    }),
    window: {
      DASH_CONFIG: { apiBase: "/api" },
      DASH: {
        registerWidget(type, implementation) {
          registration = { type, implementation };
        }
      }
    }
  }, async () => {
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
    assert.equal(
      instance.menu.children.every((item) => (
        item.className === "popup-menu-item clickable label"
      )),
      true
    );

    instance.listButton.fire("click");
    assert.equal(instance.listButton.getAttribute("aria-expanded"), "true");
    assert.equal(fakeDocument.listenerCount("click"), 1);

    instance.menu.children[1].fire("click");
    assert.equal(instance.selectedList, "beta.org");
    assert.equal(instance.listButton.getAttribute("aria-expanded"), "false");
    assert.equal(instance.listButton.focusCalls, 1);
    assert.equal(fakeDocument.listenerCount("click"), 0);

    instance.menuController.open();
    fakeDocument.fire("click", { target: new FakeElement("aside") });
    assert.equal(instance.menuController.isOpen(), false);
    assert.equal(fakeDocument.listenerCount("click"), 0);
  });
});

test("dismissible menus keep instance state independent and dismiss outside or on Escape", async () => {
  const fakeDocument = new FakeDocument();
  const triggerA = new FakeElement();
  const menuA = new FakeElement();
  const triggerB = new FakeElement();
  const menuB = new FakeElement();

  await withPatchedGlobals({ document: fakeDocument }, async () => {
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
  });
});
