import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeDocument,
  FakeElement,
  findAll,
  treeText
} from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createErrorResponse,
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

let widgetImportNumber = 0;

const findAllByTag = (element, tagName) => (
  findAll(element, (candidate) => candidate.tagName === tagName)
);

function findByAttribute(element, name, value) {
  if (element.getAttribute(name) === value) return element;
  for (const child of element.children) {
    const match = findByAttribute(child, name, value);
    if (match) return match;
  }
  return null;
}

async function withHomeAssistantWidget(fetchImplementation, run) {
  let registration;
  const window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  await withPatchedGlobals({
    document: new FakeDocument(),
    fetch: fetchImplementation,
    window
  }, async () => {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/home-assistant.js?test=${widgetImportNumber}`);
    await run({ registration });
  });
}

test("home-assistant registers as a static action-only widget", async () => {
  await withHomeAssistantWidget(async () => {
    throw new Error("Mounting the widget must not fetch.");
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      props: {
        dashboardUrl: "https://home-assistant.example.test/dashboard",
        buttons: [{
          name: "Office Focus",
          api: "/api/services/script/dashboard_office_focus"
        }]
      }
    });

    const links = findAllByTag(root, "a");
    assert.equal(registration.type, "home-assistant");
    assert.equal(typeof registration.implementation.update, "undefined");
    assert.equal(links.length, 0);
    assert.deepEqual(
      findAllByTag(root, "button").map((button) => button.textContent),
      ["Office Focus"]
    );
    assert.equal(treeText(root).includes("Open Home Assistant"), false);
  });
});

test("home-assistant renders only valid named actions in declared order", async () => {
  await withHomeAssistantWidget(async () => ({ ok: true }), async ({ registration }) => {
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      props: {
        buttons: [
          { name: " Office Focus ", api: " /api/services/script/dashboard_office_focus " },
          null,
          ["not", "an", "object"],
          { name: "", api: "/api/services/script/dashboard_missing_name" },
          { name: "Missing API", api: "" },
          { name: 42, api: "/api/services/script/dashboard_wrong_name_type" },
          { name: "All Lights Off", api: "/api/services/script/dashboard_all_lights_off" }
        ]
      }
    });

    assert.deepEqual(
      findAllByTag(root, "button").map((button) => button.textContent),
      ["Office Focus", "All Lights Off"]
    );
  });
});

test("a Home Assistant action posts only its path and prevents duplicate pending clicks", async () => {
  const upstream = createDeferred();
  const requests = [];
  await withHomeAssistantWidget(async (url, options) => {
    requests.push({ url, options });
    return upstream.promise;
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      props: {
        buttons: [{
          name: "Office Focus",
          api: "/api/services/script/dashboard_office_focus"
        }]
      }
    });
    const button = findAllByTag(root, "button")[0];
    const status = findByAttribute(root, "aria-live", "polite");
    status.textContent = "Stale result";

    const action = button.fireAsync("click");
    button.fire("click");

    assert.equal(button.disabled, true);
    assert.equal(status.textContent, "");
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, "/api/home-assistant/actions");
    assert.equal(requests[0].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      api: "/api/services/script/dashboard_office_focus"
    });

    upstream.resolve(createSuccessResponse({
      api: "/api/services/script/dashboard_office_focus"
    }));
    await action;

    assert.equal(button.disabled, false);
    assert.equal(status.textContent, "Ran Office Focus.");
  });
});

test("an action failure re-enables only its button and keeps the other controls usable", async () => {
  const upstream = createDeferred();
  await withHomeAssistantWidget(async () => upstream.promise, async ({ registration }) => {
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      props: {
        buttons: [
          { name: "Office Focus", api: "/api/services/script/dashboard_office_focus" },
          { name: "All Lights Off", api: "/api/services/script/dashboard_all_lights_off" }
        ]
      }
    });
    const [officeButton, lightsButton] = findAllByTag(root, "button");
    const status = findByAttribute(root, "aria-live", "polite");

    const action = officeButton.fireAsync("click");

    assert.equal(officeButton.disabled, true);
    assert.notEqual(lightsButton.disabled, true);
    assert.equal(findAllByTag(root, "a").length, 0);

    upstream.resolve(createErrorResponse("Home Assistant is unreachable."));
    await action;

    assert.equal(officeButton.disabled, false);
    assert.notEqual(lightsButton.disabled, true);
    assert.equal(status.textContent, "Home Assistant is unreachable.");
    assert.equal(findAllByTag(root, "button").length, 2);
    assert.equal(findAllByTag(root, "a").length, 0);
  });
});

test("an empty action list explains the action-only empty state", async () => {
  await withHomeAssistantWidget(async () => createSuccessResponse({}), async ({ registration }) => {
    const root = new FakeElement("section");
    registration.implementation.mount(root, {
      props: {
        buttons: "not-an-array"
      }
    });

    assert.equal(findAllByTag(root, "a").length, 0);
    assert.equal(findAllByTag(root, "button").length, 0);
    assert.match(treeText(root), /No Home Assistant actions configured\./);
    assert.equal(
      treeText(root).includes("Home Assistant dashboard URL is not configured."),
      false
    );
  });
});
