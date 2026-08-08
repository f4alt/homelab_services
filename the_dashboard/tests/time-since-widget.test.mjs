import assert from "node:assert/strict";
import test from "node:test";

import { FakeDocument, FakeElement } from "./helpers/fake-dom.mjs";

const NOW_ISO = "2026-08-08T12:00:00Z";
const DAY_MS = 86_400_000;
let widgetImportNumber = 0;

function successResponse(data) {
  return {
    ok: true,
    async json() {
      return { ok: true, data, error: null };
    }
  };
}

function errorResponse(message) {
  return {
    ok: false,
    status: 502,
    async json() {
      return {
        ok: false,
        data: null,
        error: { message }
      };
    }
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function findByClass(element, className) {
  if (element.classList.contains(className)) return element;
  for (const child of element.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

function treeText(element) {
  return [element.textContent, ...element.children.map(treeText)].join(" ");
}

async function withTimeSinceWidget(fetchImplementation, run) {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    setInterval: globalThis.setInterval,
    window: globalThis.window
  };
  const fakeDocument = new FakeDocument();
  let intervalCallCount = 0;
  let registration;
  globalThis.document = fakeDocument;
  globalThis.fetch = fetchImplementation;
  globalThis.setInterval = () => {
    intervalCallCount += 1;
    return Symbol("interval");
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
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/time-since.js?test=${widgetImportNumber}`);
    await run({
      fakeDocument,
      getIntervalCallCount: () => intervalCallCount,
      registration
    });
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.setInterval = previous.setInterval;
    globalThis.window = previous.window;
  }
}

test("time-since registers and defaults to an ordered aggregate view", async () => {
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
    return successResponse({ items });
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, { props: {} });

    await registration.implementation.update(state);

    assert.equal(registration.type, "time-since");
    assert.equal(state.currentSource.textContent, "All");
    assert.equal(state.list.classList.contains("list-scroll"), true);
    assert.deepEqual(
      state.list.children.map((row) => findByClass(row, "time-since-name").textContent),
      ["Change the AC filter", "Test the backup restore"]
    );
    assert.equal(treeText(state.list).includes("home.org"), false);
    assert.equal(treeText(state.list).includes("homelab.org"), false);
    assert.deepEqual(requests, ["/api/todos/time-since"]);
  });
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
    return successResponse({ items });
  }, async ({ registration }) => {
    const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
    await registration.implementation.update(state);

    state.menu.children[2].fire("click");

    assert.equal(state.currentSource.textContent, "homelab.org");
    assert.deepEqual(
      state.list.children.map((row) => findByClass(row, "time-since-name").textContent),
      ["Homelab activity"]
    );
    assert.equal(requestCount, 1);
  });
});

test("time-since uses the shared empty state for an empty collection", async () => {
  await withTimeSinceWidget(
    async () => successResponse({ items: [] }),
    async ({ registration }) => {
      const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
      await registration.implementation.update(state);

      assert.equal(state.list.classList.contains("is-empty"), true);
      assert.equal(state.list.children[0].textContent, "No tracked activities found.");
    }
  );
});

test("time-since colors only the age token and renders unknown ages", async () => {
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
      uid: "unknown",
      name: "Unknown activity",
      source_file: "home.org",
      last_done: null,
      target_days: null
    }
  ];

  await withTimeSinceWidget(
    async () => successResponse({ items }),
    async ({ registration }) => {
      const state = registration.implementation.mount(new FakeElement("section"), {
        props: { approachingRatio: 0.8 }
      });
      await registration.implementation.update(state);

      const knownRow = state.list.children[0];
      const knownToken = findByClass(knownRow, "time-since-age-token");
      const knownAge = findByClass(knownRow, "time-since-age");
      const unknownRow = state.list.children[1];
      const unknownToken = findByClass(unknownRow, "time-since-age-token");

      assert.equal(knownToken.textContent, "8");
      assert.equal(knownToken.classList.contains("time-since-age-token--approaching"), true);
      assert.equal(knownAge.classList.contains("time-since-age-token--approaching"), false);
      assert.equal(knownRow.classList.contains("time-since-age-token--approaching"), false);
      assert.match(treeText(knownAge), /8\s+days since/);
      assert.equal(unknownToken.textContent, "?");
      assert.equal(unknownToken.classList.contains("time-since-age-token--unknown"), true);
      assert.match(treeText(unknownRow), /\?\s+days since/);
    }
  );
});

test("Done now posts the existing update contract, renders zero optimistically, and reloads", async () => {
  const postResponse = deferred();
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  const authoritativeTimestamp = new Date(Date.now() - DAY_MS).toISOString();
  const requests = [];
  let getCount = 0;

  await withTimeSinceWidget(async (url, options = {}) => {
    requests.push({ url, options });
    if (options.method === "POST") return postResponse.promise;

    getCount += 1;
    return successResponse({
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
    const originalButton = findByClass(state.list.children[0], "time-since-done-button");

    const action = originalButton.fireAsync("click");
    const optimisticButton = findByClass(state.list.children[0], "time-since-done-button");
    const optimisticToken = findByClass(state.list.children[0], "time-since-age-token");

    assert.equal(originalButton.disabled, true);
    assert.equal(optimisticButton.disabled, true);
    assert.equal(optimisticToken.textContent, "0");
    assert.equal(requests[1].url, "/api/todos/tasks/update");
    assert.equal(requests[1].options.method, "POST");
    assert.deepEqual(JSON.parse(requests[1].options.body), {
      uid: "filter",
      status: "DONE"
    });

    postResponse.resolve(successResponse({ task: { uid: "filter", status: "TODO" } }));
    await action;

    assert.equal(getCount, 2);
    assert.equal(state.items[0].last_done, authoritativeTimestamp);
    assert.equal(findByClass(state.list.children[0], "time-since-done-button").disabled, false);
  });
});

test("Done now restores the prior item and shows the shared error state on failure", async () => {
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  let getCount = 0;

  await withTimeSinceWidget(async (_url, options = {}) => {
    if (options.method === "POST") {
      return errorResponse("Unable to update todo.");
    }

    getCount += 1;
    return successResponse({
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

    await findByClass(state.list.children[0], "time-since-done-button").fireAsync("click");

    assert.equal(getCount, 1);
    assert.equal(state.items[0].last_done, originalTimestamp);
    assert.equal(state.pendingCompletions.size, 0);
    assert.equal(state.list.classList.contains("is-error"), true);
    assert.equal(state.list.children[0].textContent, "Unable to update todo.");
  });
});

test("Done now retains the optimistic completion when only the authoritative reload fails", async () => {
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  let getCount = 0;

  await withTimeSinceWidget(async (_url, options = {}) => {
    if (options.method === "POST") {
      return successResponse({ task: { uid: "filter", status: "TODO" } });
    }

    getCount += 1;
    if (getCount > 1) return errorResponse("Authoritative reload failed.");
    return successResponse({
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

    await findByClass(state.list.children[0], "time-since-done-button").fireAsync("click");

    assert.notEqual(state.items[0].last_done, originalTimestamp);
    assert.equal(state.pendingCompletions.size, 0);
    assert.equal(state.list.classList.contains("is-error"), true);
    assert.equal(state.list.children[0].textContent, "Authoritative reload failed.");
  });
});

test("overlapping Done now actions keep optimistic and authoritative state isolated by UID", async () => {
  const firstPost = deferred();
  const secondPost = deferred();
  const originalTimestamp = new Date(Date.now() - (5 * DAY_MS)).toISOString();
  const authoritativeTimestamp = new Date(Date.now() - DAY_MS).toISOString();
  let getCount = 0;

  await withTimeSinceWidget(async (_url, options = {}) => {
    if (options.method === "POST") {
      const { uid } = JSON.parse(options.body);
      return uid === "first" ? firstPost.promise : secondPost.promise;
    }

    getCount += 1;
    return successResponse({
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
      state.list.children[0],
      "time-since-done-button"
    ).fireAsync("click");
    const secondAction = findByClass(
      state.list.children[1],
      "time-since-done-button"
    ).fireAsync("click");

    firstPost.resolve(successResponse({ task: { uid: "first", status: "TODO" } }));
    await firstAction;

    assert.equal(
      findByClass(state.list.children[1], "time-since-age-token").textContent,
      "0"
    );

    secondPost.resolve(errorResponse("Second update failed."));
    await secondAction;

    assert.equal(state.items[0].last_done, authoritativeTimestamp);
    assert.equal(state.items[1].last_done, originalTimestamp);
    assert.equal(state.pendingCompletions.size, 0);
  });
});

test("unchanged refreshes reuse source choices, rows, and row handlers", async () => {
  const item = {
    uid: "filter",
    name: "Change the AC filter",
    source_file: "home.org",
    last_done: NOW_ISO,
    target_days: 30
  };

  await withTimeSinceWidget(
    async () => successResponse({ items: [item] }),
    async ({ registration }) => {
      const state = registration.implementation.mount(new FakeElement("section"), { props: {} });
      await registration.implementation.update(state);
      const allChoice = state.menu.children[0];
      const sourceChoice = state.menu.children[1];
      const row = state.list.children[0];
      const doneButton = findByClass(row, "time-since-done-button");

      await registration.implementation.update(state);

      assert.equal(state.menu.children[0], allChoice);
      assert.equal(state.menu.children[1], sourceChoice);
      assert.equal(state.list.children[0], row);
      assert.equal(findByClass(state.list.children[0], "time-since-done-button"), doneButton);
      assert.equal(doneButton.events.get("click").size, 1);
    }
  );
});

test("overlapping refresh requests are serialized and coalesced per instance", async () => {
  const firstResponse = deferred();
  let requestCount = 0;

  await withTimeSinceWidget(async () => {
    requestCount += 1;
    if (requestCount === 1) return firstResponse.promise;
    return successResponse({
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
    firstResponse.resolve(successResponse({ items: [] }));
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
    return successResponse({ items: requestCount === 1 ? firstItems : [firstItems[0]] });
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
    async () => successResponse({ items }),
    async ({ registration }) => {
      const firstState = registration.implementation.mount(new FakeElement("section"), { props: {} });
      const secondState = registration.implementation.mount(new FakeElement("section"), { props: {} });
      await registration.implementation.update(firstState);
      await registration.implementation.update(secondState);

      firstState.menu.children[2].fire("click");

      assert.equal(firstState.currentSource.textContent, "homelab.org");
      assert.equal(firstState.list.children.length, 1);
      assert.equal(secondState.currentSource.textContent, "All");
      assert.equal(secondState.list.children.length, 2);
      assert.notEqual(firstState.pendingCompletions, secondState.pendingCompletions);
    }
  );
});
