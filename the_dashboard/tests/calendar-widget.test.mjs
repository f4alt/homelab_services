import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeDocument,
  FakeElement,
  findAll,
  findByClass,
  treeText
} from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createErrorResponse,
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

let widgetImportNumber = 0;

function sampleEvents() {
  return [
    {
      id: "all-day",
      title: "Family day",
      allDay: true,
      startDate: "2026-08-09",
      endDateExclusive: "2026-08-10",
      feedOrder: 0
    },
    {
      id: "appointment",
      title: "Dentist",
      allDay: false,
      start: new Date(2026, 7, 9, 9).toISOString(),
      end: new Date(2026, 7, 9, 10, 30).toISOString(),
      feedOrder: 1
    }
  ];
}

async function withCalendarWidget(fetchImplementation, run) {
  const NativeDate = globalThis.Date;
  let now = new NativeDate(2026, 7, 9, 12).getTime();
  let registration;

  class FixedDate extends NativeDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }

    static now() {
      return now;
    }
  }

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
    Date: FixedDate,
    document: new FakeDocument({ supportsPopover: true }),
    fetch: fetchImplementation,
    window
  }, async () => {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/calendar.js?test=${widgetImportNumber}`);
    await run({
      registration,
      setNow(date) {
        now = date.getTime();
      }
    });
  });
}

test("calendar renders a semantic fixed grid, boolean dots, and the two default countdowns", async () => {
  const requests = [];
  await withCalendarWidget(async (url) => {
    requests.push(url);
    return createSuccessResponse({ events: sampleEvents() });
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, {
      props: { feedUrl: "webcal://calendar.example.test/feed.ics" }
    });
    await registration.implementation.update(state);

    const buttons = findAll(root, (element) => element.tagName === "button");
    assert.equal(registration.type, "calendar");
    assert.equal(buttons.length, 42);
    assert.equal(buttons.every((button) => button.type === "button"), true);
    assert.equal(buttons.every((button) => (
      button.classList.contains("clickable")
      && button.classList.contains("clickable--compact")
    )), true);
    assert.match(treeText(root), /August 2026\s+Sun\s+Mon\s+Tue\s+Wed\s+Thu\s+Fri\s+Sat/);
    assert.match(treeText(root), /Labor Day/);
    assert.match(treeText(root), /Family day/);
    assert.equal(findAll(root, (element) => (
      element.classList.contains("calendar-day-dot") && element.hidden === false
    )).length, 1);
    const countdownPopups = findAll(
      root,
      (element) => element.classList.contains("popup")
    );
    assert.equal(countdownPopups.length, 2);
    assert.equal(countdownPopups.every((popup) => (
      popup.classList.contains("popup--floating") &&
      popup.getAttribute("popover") === "manual"
    )), true);
    assert.match(requests[0], /^\/api\/calendar\/events\?/);
    assert.match(requests[0], /feedUrl=webcal%3A%2F%2Fcalendar\.example\.test/);
  });
});

test("calendar selection toggles, switches directly, lists every event, and clears with Escape", async () => {
  await withCalendarWidget(
    async () => createSuccessResponse({ events: sampleEvents() }),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: { feedUrl: "https://calendar.example.test/feed.ics" }
      });
      await registration.implementation.update(state);

      const selectedIndex = state.days.findIndex((day) => day.dateKey === "2026-08-09");
      state.dayButtons[selectedIndex].button.fire("click");
      assert.equal(state.selectedDateKey, "2026-08-09");
      assert.match(
        treeText(state.lower),
        /Sunday, August 9\s+TODAY\s+Family day\s+All day\s+Dentist\s+9:00 AM–10:30 AM/
      );
      assert.equal(findByClass(state.lower, "list-scroll") !== null, true);

      const emptyIndex = state.days.findIndex((day) => day.dateKey === "2026-08-10");
      state.dayButtons[emptyIndex].button.fire("click");
      assert.equal(state.selectedDateKey, "2026-08-10");
      assert.match(
        treeText(state.lower),
        /Monday, August 10\s+in 1 day\s+No events scheduled\./
      );

      root.fire("keydown", { key: "Escape" });
      assert.equal(state.selectedDateKey, null);
      assert.match(treeText(state.lower), /Labor Day/);

      state.dayButtons[emptyIndex].button.fire("click");
      state.dayButtons[emptyIndex].button.fire("click");
      assert.equal(state.selectedDateKey, null);
    }
  );
});

test("calendar clears selection on month rollover without duplicating handlers", async () => {
  await withCalendarWidget(
    async () => createSuccessResponse({ events: sampleEvents() }),
    async ({ registration, setNow }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: { feedUrl: "https://calendar.example.test/feed.ics" }
      });
      await registration.implementation.update(state);
      const augustNine = state.days.findIndex((day) => day.dateKey === "2026-08-09");
      state.dayButtons[augustNine].button.fire("click");

      await registration.implementation.update(state);
      assert.equal(state.dayButtons[augustNine].button.events.get("click").size, 1);

      setNow(new Date(2026, 8, 1, 0, 1));
      await registration.implementation.update(state);
      assert.equal(state.selectedDateKey, null);
      assert.equal(state.heading.textContent, "September 2026");
    }
  );
});

test("calendar preserves known-good data and selection across a failed refresh, then recovers", async () => {
  const responses = [
    createSuccessResponse({ events: sampleEvents() }),
    createErrorResponse("secret upstream failure"),
    createSuccessResponse({ events: sampleEvents() })
  ];

  await withCalendarWidget(async () => responses.shift(), async ({ registration }) => {
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, {
      props: { feedUrl: "https://calendar.example.test/feed.ics" }
    });
    await registration.implementation.update(state);
    const selectedIndex = state.days.findIndex((day) => day.dateKey === "2026-08-09");
    state.dayButtons[selectedIndex].button.fire("click");

    await registration.implementation.update(state);
    assert.equal(state.selectedDateKey, "2026-08-09");
    assert.equal(state.warning.textContent, "Calendar refresh failed");
    assert.match(treeText(state.lower), /Dentist/);
    assert.equal(treeText(root).includes("secret"), false);

    await registration.implementation.update(state);
    assert.equal(state.warning.textContent, "");
  });
});

test("calendar discards stale overlapping responses and keeps instances independent", async () => {
  const firstResponse = createDeferred();
  let requestCount = 0;
  await withCalendarWidget(async () => {
    requestCount += 1;
    return requestCount === 1
      ? firstResponse.promise
      : createSuccessResponse({ events: sampleEvents() });
  }, async ({ registration }) => {
    const firstRoot = new FakeElement("section");
    const secondRoot = new FakeElement("section");
    const firstState = registration.implementation.mount(firstRoot, {
      props: { feedUrl: "https://calendar.example.test/feed.ics" }
    });
    const secondState = registration.implementation.mount(secondRoot, {
      props: { feedUrl: "https://calendar.example.test/feed.ics" }
    });

    const staleUpdate = registration.implementation.update(firstState);
    await registration.implementation.update(firstState);
    firstResponse.resolve(createSuccessResponse({ events: [] }));
    await staleUpdate;
    assert.equal(firstState.events.length, 2);

    await registration.implementation.update(secondState);
    const selectedIndex = firstState.days.findIndex((day) => day.dateKey === "2026-08-09");
    firstState.dayButtons[selectedIndex].button.fire("click");
    assert.equal(firstState.selectedDateKey, "2026-08-09");
    assert.equal(secondState.selectedDateKey, null);
  });
});

test("calendar uses the standard error state before any successful fetch", async () => {
  await withCalendarWidget(
    async () => createErrorResponse("sensitive failure"),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: { feedUrl: "https://calendar.example.test/feed.ics" }
      });
      await registration.implementation.update(state);

      assert.equal(state.lower.classList.contains("is-error"), true);
      assert.equal(treeText(root).includes("sensitive"), false);
    }
  );
});
