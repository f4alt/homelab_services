import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeDocument,
  FakeElement,
  findByClass,
  treeText
} from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createErrorResponse,
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

const NOW_ISO = "2026-08-08T12:00:00Z";
const DAY_MS = 86_400_000;
let widgetImportNumber = 0;

async function withTimeSinceWidget(fetchImplementation, run) {
  const fakeDocument = new FakeDocument({ supportsPopover: true });
  let intervalCallCount = 0;
  let registration;
  const setInterval = () => {
    intervalCallCount += 1;
    return Symbol("interval");
  };
  const window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  await withPatchedGlobals({
    CSS: { supports: () => true },
    document: fakeDocument,
    fetch: fetchImplementation,
    setInterval,
    window
  }, async () => {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/time-since.js?test=${widgetImportNumber}`);
    await run({
      fakeDocument,
      getIntervalCallCount: () => intervalCallCount,
      registration
    });
  });
}

test("time-since renders ordered tiles inside a height-capped responsive grid", async () => {
  const requests = [];
  const items = [
    {
      uid: "filter",
      name: "Change the AC filter",
      source_file: "home.org",
      last_done: NOW_ISO,
      target_days: 30
    },
    {
      uid: "backup",
      name: "Test the backup restore",
      source_file: "homelab.org",
      last_done: null,
      target_days: null
    }
  ];

  await withTimeSinceWidget(async (url) => {
    requests.push(url);
    return createSuccessResponse({ items });
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, { props: {} });

    await registration.implementation.update(state);

    const scroll = findByClass(root, "list-scroll");
    assert.equal(registration.type, "time-since");
    assert.equal(state.currentSource.textContent, "All");
    assert.equal(scroll !== null, true);
    assert.equal(scroll.children[0], state.grid);
    assert.equal(state.grid.classList.contains("list-tiled"), true);
    assert.deepEqual(
      state.grid.children.map((tile) => findByClass(tile, "time-since-name").textContent),
      ["Change the AC filter", "Test the backup restore"]
    );
    assert.equal(state.grid.children.every((tile) => tile.classList.contains("ui-tile")), true);
    assert.equal(
      state.menu.children.every((item) => (
        item.className === "popup-menu-item clickable label"
      )),
      true
    );
    assert.equal(treeText(state.grid).includes("home.org"), false);
    assert.equal(treeText(state.grid).includes("homelab.org"), false);
    assert.deepEqual(requests, ["/api/todos/time-since"]);
  });
});

test("time-since sorts by urgency by default and restores declaration order when disabled", async () => {
  const timestampDaysAgo = (days) => new Date(Date.now() - (days * DAY_MS)).toISOString();
  const items = [
    {
      uid: "normal-first",
      name: "Normal first",
      source_file: "home.org",
      last_done: timestampDaysAgo(1),
      target_days: 10
    },
    {
      uid: "overdue-first",
      name: "Overdue first",
      source_file: "home.org",
      last_done: timestampDaysAgo(11),
      target_days: 10
    },
    {
      uid: "approaching",
      name: "Approaching",
      source_file: "home.org",
      last_done: timestampDaysAgo(8),
      target_days: 10
    },
    {
      uid: "overdue-second",
      name: "Overdue second",
      source_file: "home.org",
      last_done: timestampDaysAgo(12),
      target_days: 10
    },
    {
      uid: "normal-second",
      name: "Normal second",
      source_file: "home.org",
      last_done: timestampDaysAgo(2),
      target_days: 10
    }
  ];

  await withTimeSinceWidget(
    async () => createSuccessResponse({ items }),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: {} });
      await registration.implementation.update(state);

      const tileNames = () => state.grid.children.map(
        (tile) => findByClass(tile, "time-since-name").textContent
      );
      const priorityToggle = findByClass(root, "inline-toggle");
      const priorityInput = priorityToggle.children[0];

      assert.equal(priorityInput.type, "checkbox");
      assert.equal(priorityInput.checked, true);
      assert.deepEqual(tileNames(), [
        "Overdue first",
        "Overdue second",
        "Approaching",
        "Normal first",
        "Normal second"
      ]);

      priorityInput.checked = false;
      priorityInput.fire("change");

      assert.deepEqual(tileNames(), items.map((item) => item.name));
    }
  );
});

test("time-since source filtering is local", async () => {
  let requestCount = 0;
  const items = [
    {
      uid: "home",
      name: "Home activity",
      source_file: "home.org",
      last_done: NOW_ISO,
      target_days: null
    },
    {
      uid: "homelab",
      name: "Homelab activity",
      source_file: "homelab.org",
      last_done: NOW_ISO,
      target_days: null
    }
  ];

  await withTimeSinceWidget(async () => {
    requestCount += 1;
    return createSuccessResponse({ items });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);

    state.menu.children[2].fire("click");

    assert.equal(state.currentSource.textContent, "homelab.org");
    assert.deepEqual(
      state.grid.children.map((tile) => findByClass(tile, "time-since-name").textContent),
      ["Homelab activity"]
    );
    assert.equal(requestCount, 1);
  });
});

test("time-since uses the shared empty state for an empty collection", async () => {
  await withTimeSinceWidget(
    async () => createSuccessResponse({ items: [] }),
    async ({ registration }) => {
      const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
      await registration.implementation.update(state);

      assert.equal(state.grid.classList.contains("is-empty"), true);
      assert.equal(state.grid.children[0].textContent, "No tracked activities found.");
    }
  );
});

test("time-since name flips to date-only conditional details and dismisses them", async () => {
  const approachingTimestamp = new Date(Date.now() - (8 * DAY_MS)).toISOString();
  const items = [
    {
      uid: "known",
      name: "Known activity",
      source_file: "home.org",
      last_done: approachingTimestamp,
      target_days: 10
    },
    {
      uid: "normal",
      name: "Normal activity",
      source_file: "home.org",
      last_done: NOW_ISO,
      target_days: null
    }
  ];

  await withTimeSinceWidget(
    async () => createSuccessResponse({ items }),
    async ({ fakeDocument, registration }) => {
      const state = registration.implementation.mount(new FakeElement("section"), {
        props: { approachingRatio: 0.8 }
      });
      await registration.implementation.update(state);

      const knownTile = state.grid.children[0];
      const knownButton = findByClass(knownTile, "time-since-reset-button");
      const knownNameButton = findByClass(knownTile, "time-since-name-button");
      const knownBack = findByClass(knownTile, "time-since-face--back");
      const normalTile = state.grid.children[1];
      const normalButton = findByClass(
        state.grid.children[1],
        "time-since-reset-button"
      );
      const normalBack = findByClass(normalTile, "time-since-face--back");

      assert.equal(knownButton.tagName, "button");
      assert.equal(knownButton.textContent, "8");
      assert.equal(knownButton.classList.contains("clickable"), true);
      assert.equal(knownButton.classList.contains("clickable--compact"), true);
      assert.equal(
        knownButton.classList.contains("time-since-age-token--approaching"),
        true
      );
      assert.equal(knownNameButton.tagName, "button");
      assert.equal(knownNameButton.textContent, "Known activity");
      assert.equal(knownNameButton.classList.contains("clickable"), false);
      assert.equal(knownNameButton.classList.contains("clickable--compact"), false);
      assert.match(
        fakeDocument.head.children[0].textContent,
        /\.time-since-name-button\s*{[^}]*cursor:\s*pointer;/
      );
      assert.equal(knownNameButton.getAttribute("aria-expanded"), "false");
      assert.equal(knownTile.classList.contains("time-since-tile--flipped"), false);
      assert.equal(findByClass(knownTile, "time-since-tooltip"), null);
      assert.match(
        treeText(knownBack),
        /Last done\s+\d{4}-\d{2}-\d{2}\s+Target\s+10 days\s+Status\s+Approaching/
      );
      assert.doesNotMatch(treeText(knownBack), /Last done\s+\d{4}-\d{2}-\d{2}T/);
      assert.equal(treeText(normalBack).includes("Target"), false);
      assert.equal(treeText(normalBack).includes("No target"), false);
      assert.equal(treeText(normalBack).includes("Status"), false);
      assert.equal(treeText(normalBack).includes("Normal"), false);
      assert.equal(normalButton.classList.contains("time-since-age-token--normal"), true);
      assert.equal(treeText(state.grid).includes("Done now"), false);
      assert.equal(treeText(state.grid).includes("days since"), false);

      knownNameButton.fire("click");
      assert.equal(knownNameButton.getAttribute("aria-expanded"), "true");
      assert.equal(knownTile.classList.contains("time-since-tile--flipped"), true);
      assert.equal(knownBack.focusCalls, 1);
      assert.equal(fakeDocument.listenerCount("click"), 1);
      assert.equal(fakeDocument.listenerCount("keydown"), 1);

      knownBack.fire("click");
      assert.equal(knownNameButton.getAttribute("aria-expanded"), "false");
      assert.equal(knownTile.classList.contains("time-since-tile--flipped"), false);
      assert.equal(knownNameButton.focusCalls, 1);
      assert.equal(fakeDocument.listenerCount("click"), 0);
      assert.equal(fakeDocument.listenerCount("keydown"), 0);

      knownTile.fire("click");
      assert.equal(knownTile.classList.contains("time-since-tile--flipped"), false);

      knownNameButton.fire("click");
      fakeDocument.fire("click", { target: new FakeElement("aside") });
      assert.equal(knownNameButton.getAttribute("aria-expanded"), "false");
      assert.equal(knownTile.classList.contains("time-since-tile--flipped"), false);

      knownNameButton.fire("click");
      fakeDocument.fire("keydown", { key: "Escape" });
      assert.equal(knownNameButton.getAttribute("aria-expanded"), "false");
      assert.equal(knownNameButton.focusCalls, 2);
      assert.equal(fakeDocument.listenerCount("keydown"), 0);
    }
  );
});

test("resetting the day number posts the existing update contract and reloads", async () => {
  const postResponse = createDeferred();
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  const authoritativeTimestamp = new Date(Date.now() - DAY_MS).toISOString();
  const requests = [];
  let getCount = 0;

  await withTimeSinceWidget(async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return postResponse.promise;

    getCount += 1;
    return createSuccessResponse({
      items: [{
        uid: "filter",
        name: "Change the AC filter",
        source_file: "home.org",
        last_done: getCount === 1 ? originalTimestamp : authoritativeTimestamp,
        target_days: 30
      }]
    });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);
    const originalButton = findByClass(state.grid.children[0], "time-since-reset-button");

    const action = originalButton.fireAsync("click");
    const optimisticButton = findByClass(state.grid.children[0], "time-since-reset-button");

    assert.equal(state.grid.children[0].classList.contains("time-since-tile--flipped"), false);
    assert.equal(originalButton.disabled, true);
    assert.equal(optimisticButton.disabled, true);
    assert.equal(optimisticButton.textContent, "0");
    assert.equal(requests[1].url, "/api/todos/tasks/update");
    assert.equal(requests[1].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      uid: "filter",
      status: "DONE"
    });

    postResponse.resolve(createSuccessResponse({ task: { uid: "filter", status: "TODO" } }));
    await action;

    assert.equal(getCount, 2);
    assert.equal(state.items[0].last_done, authoritativeTimestamp);
    assert.equal(
      findByClass(state.grid.children[0], "time-since-reset-button").disabled,
      false
    );
  });
});

test("a failed day reset restores the prior item and shows the shared error state", async () => {
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  let getCount = 0;

  await withTimeSinceWidget(async (_url, options = {}) => {
    if (options.method === "POST") {
      return createErrorResponse("Unable to update todo.");
    }

    getCount += 1;
    return createSuccessResponse({
      items: [{
        uid: "filter",
        name: "Change the AC filter",
        source_file: "home.org",
        last_done: originalTimestamp,
        target_days: 30
      }]
    });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);

    await findByClass(state.grid.children[0], "time-since-reset-button").fireAsync("click");

    assert.equal(getCount, 1);
    assert.equal(state.items[0].last_done, originalTimestamp);
    assert.equal(state.pendingCompletions.size, 0);
    assert.equal(state.grid.classList.contains("is-error"), true);
    assert.equal(state.grid.children[0].textContent, "Unable to update todo.");
  });
});

test("a day reset retains its optimistic completion when only the reload fails", async () => {
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  let getCount = 0;

  await withTimeSinceWidget(async (_url, options = {}) => {
    if (options.method === "POST") {
      return createSuccessResponse({ task: { uid: "filter", status: "TODO" } });
    }

    getCount += 1;
    if (getCount > 1) return createErrorResponse("Authoritative reload failed.");
    return createSuccessResponse({
      items: [{
        uid: "filter",
        name: "Change the AC filter",
        source_file: "home.org",
        last_done: originalTimestamp,
        target_days: 30
      }]
    });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);

    await findByClass(state.grid.children[0], "time-since-reset-button").fireAsync("click");

    assert.notEqual(state.items[0].last_done, originalTimestamp);
    assert.equal(state.pendingCompletions.size, 0);
    assert.equal(state.grid.classList.contains("is-error"), true);
    assert.equal(state.grid.children[0].textContent, "Authoritative reload failed.");
  });
});

test("overlapping day resets keep optimistic and authoritative state isolated by UID", async () => {
  const firstPost = createDeferred();
  const secondPost = createDeferred();
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  const authoritativeTimestamp = new Date(Date.now() - DAY_MS).toISOString();
  let getCount = 0;

  await withTimeSinceWidget(async (_url, options = {}) => {
    if (options.method === "POST") {
      const { uid } = JSON.parse(options.body);
      return uid === "first" ? firstPost.promise : secondPost.promise;
    }

    getCount += 1;
    return createSuccessResponse({
      items: [
        {
          uid: "first",
          name: "First activity",
          source_file: "home.org",
          last_done: getCount === 1 ? originalTimestamp : authoritativeTimestamp,
          target_days: null
        },
        {
          uid: "second",
          name: "Second activity",
          source_file: "home.org",
          last_done: originalTimestamp,
          target_days: null
        }
      ]
    });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);

    const firstAction = findByClass(
      state.grid.children[0],
      "time-since-reset-button"
    ).fireAsync("click");
    const secondAction = findByClass(
      state.grid.children[1],
      "time-since-reset-button"
    ).fireAsync("click");

    firstPost.resolve(createSuccessResponse({ task: { uid: "first", status: "TODO" } }));
    await firstAction;

    assert.equal(
      findByClass(state.grid.children[1], "time-since-reset-button").textContent,
      "0"
    );

    secondPost.resolve(createErrorResponse("Second update failed."));
    await secondAction;

    assert.equal(state.items[0].last_done, authoritativeTimestamp);
    assert.equal(state.items[1].last_done, originalTimestamp);
    assert.equal(state.pendingCompletions.size, 0);
  });
});

test("unchanged refreshes reuse source choices, tiles, and reset handlers", async () => {
  const item = {
    uid: "filter",
    name: "Change the AC filter",
    source_file: "home.org",
    last_done: NOW_ISO,
    target_days: 30
  };

  await withTimeSinceWidget(
    async () => createSuccessResponse({ items: [item] }),
    async ({ registration }) => {
      const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
      await registration.implementation.update(state);
      const allChoice = state.menu.children[0];
      const sourceChoice = state.menu.children[1];
      const tile = state.grid.children[0];
      const resetButton = findByClass(tile, "time-since-reset-button");

      await registration.implementation.update(state);

      assert.equal(state.menu.children[0], allChoice);
      assert.equal(state.menu.children[1], sourceChoice);
      assert.equal(state.grid.children[0], tile);
      assert.equal(
        findByClass(state.grid.children[0], "time-since-reset-button"),
        resetButton
      );
      assert.equal(resetButton.events.get("click").size, 1);
    }
  );
});

test("overlapping refresh requests are serialized and coalesced per instance", async () => {
  const firstResponse = createDeferred();
  let requestCount = 0;

  await withTimeSinceWidget(async () => {
    requestCount += 1;
    if (requestCount === 1) return firstResponse.promise;
    return createSuccessResponse({
      items: [{
        uid: "latest",
        name: "Latest activity",
        source_file: "home.org",
        last_done: NOW_ISO,
        target_days: null
      }]
    });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    const firstUpdate = registration.implementation.update(state);
    const secondUpdate = registration.implementation.update(state);

    assert.equal(requestCount, 1);
    firstResponse.resolve(createSuccessResponse({ items: [] }));
    await Promise.all([firstUpdate, secondUpdate]);

    assert.equal(requestCount, 2);
    assert.equal(state.items[0].uid, "latest");
  });
});

test("repeated updates keep one handler, add no timer, and reset a missing source to All", async () => {
  let requestCount = 0;
  const firstItems = [
    {
      uid: "home",
      name: "Home activity",
      source_file: "home.org",
      last_done: NOW_ISO,
      target_days: null
    },
    {
      uid: "homelab",
      name: "Homelab activity",
      source_file: "homelab.org",
      last_done: NOW_ISO,
      target_days: null
    }
  ];

  await withTimeSinceWidget(async () => {
    requestCount += 1;
    return createSuccessResponse({ items: requestCount === 1 ? firstItems : [firstItems[0]] });
  }, async ({ fakeDocument, getIntervalCallCount, registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);
    state.menu.children[2].fire("click");

    await registration.implementation.update(state);

    assert.equal(state.currentSource.textContent, "All");
    assert.equal(state.sourceButton.events.get("click").size, 1);
    assert.equal(fakeDocument.listenerCount("click"), 0);
    assert.equal(fakeDocument.listenerCount("keydown"), 0);
    assert.equal(getIntervalCallCount(), 0);
  });
});

test("two time-since instances keep their source filters independent", async () => {
  const items = [
    {
      uid: "home",
      name: "Home activity",
      source_file: "home.org",
      last_done: NOW_ISO,
      target_days: null
    },
    {
      uid: "homelab",
      name: "Homelab activity",
      source_file: "homelab.org",
      last_done: NOW_ISO,
      target_days: null
    }
  ];

  await withTimeSinceWidget(
    async () => createSuccessResponse({ items }),
    async ({ registration }) => {
      const firstState = registration.implementation.mount(new FakeElement("section"), { props: {} });
      const secondState = registration.implementation.mount(new FakeElement("section"), { props: {} });
      await registration.implementation.update(firstState);
      await registration.implementation.update(secondState);

      firstState.menu.children[2].fire("click");

      assert.equal(firstState.currentSource.textContent, "homelab.org");
      assert.equal(firstState.grid.children.length, 1);
      assert.equal(secondState.currentSource.textContent, "All");
      assert.equal(secondState.grid.children.length, 2);
      assert.notEqual(firstState.pendingCompletions, secondState.pendingCompletions);
    }
  );
});
