import assert from "node:assert/strict";
import test from "node:test";

import {
  buildMonthGrid,
  calendarDayDifference,
  countdownState,
  eventsForDate,
  formatEventTimeRange,
  localDateKey,
  nextCalendarEvent,
  nextFederalHoliday,
  sortEventsForDate
} from "../dashboard/widgets/calendar-domain.js";

test("calendar builds a Sunday-first fixed six-week grid across month and year boundaries", () => {
  const january = buildMonthGrid(
    new Date(2027, 0, 15),
    new Date(2027, 0, 1)
  );

  assert.equal(january.length, 42);
  assert.equal(january[0].dateKey, "2026-12-27");
  assert.equal(january.at(-1).dateKey, "2027-02-06");
  assert.equal(january[0].isCurrentMonth, false);
  assert.equal(january[5].isCurrentMonth, true);
  assert.equal(january[5].isToday, true);
});

test("calendar grids cover leap days and months that require a sixth visible week", () => {
  const leapFebruary = buildMonthGrid(new Date(2024, 1, 1));
  const sixWeekAugust = buildMonthGrid(new Date(2026, 7, 1));

  assert.equal(leapFebruary.some((day) => day.dateKey === "2024-02-29"), true);
  assert.equal(sixWeekAugust[0].dateKey, "2026-07-26");
  assert.equal(sixWeekAugust.at(-1).dateKey, "2026-09-05");
});

test("calendar-day differences do not assume every local day is 24 hours", () => {
  const beforeSpringDst = new Date(2026, 2, 7, 12);
  const afterSpringDst = new Date(2026, 2, 9, 12);
  const beforeFallDst = new Date(2026, 9, 31, 12);
  const afterFallDst = new Date(2026, 10, 2, 12);

  assert.equal(calendarDayDifference(afterSpringDst, beforeSpringDst), 2);
  assert.equal(calendarDayDifference(beforeSpringDst, afterSpringDst), -2);
  assert.equal(calendarDayDifference(afterFallDst, beforeFallDst), 2);
});

test("countdown bars use one capped 365-day scale in both directions", () => {
  const now = new Date(2026, 7, 9, 12);

  assert.deepEqual(countdownState(new Date(2026, 7, 9), now), {
    chipText: "TODAY",
    mode: "today",
    futurePercent: 100,
    overduePercent: 0,
    chipPercent: 95
  });
  assert.equal(countdownState(new Date(2026, 7, 10), now).chipText, "in 1 day");
  assert.equal(countdownState(new Date(2026, 7, 8), now).chipText, "1 day ago");
  assert.equal(countdownState(new Date(2027, 7, 10), now).futurePercent, 0);
  assert.equal(countdownState(new Date(2025, 7, 8), now).overduePercent, 100);
});

test("next federal holiday includes observed dates across calendar years", () => {
  assert.deepEqual(nextFederalHoliday(new Date(2021, 11, 30, 12)), {
    title: "New Year’s Day",
    date: new Date(2021, 11, 31)
  });
  assert.deepEqual(nextFederalHoliday(new Date(2026, 8, 1, 12)), {
    title: "Labor Day",
    date: new Date(2026, 8, 7)
  });
});

test("calendar occupancy honors all-day exclusivity and timed midnight boundaries", () => {
  const events = [
    {
      id: "all-day",
      title: "Conference",
      allDay: true,
      startDate: "2026-08-09",
      endDateExclusive: "2026-08-12",
      feedOrder: 0
    },
    {
      id: "overnight",
      title: "Overnight",
      allDay: false,
      start: "2026-08-10T04:00:00.000Z",
      end: "2026-08-10T07:00:00.000Z",
      feedOrder: 1
    },
    {
      id: "ends-midnight",
      title: "Ends at midnight",
      allDay: false,
      start: "2026-08-11T22:00:00.000Z",
      end: "2026-08-12T05:00:00.000Z",
      feedOrder: 2
    }
  ];

  assert.deepEqual(
    eventsForDate(events, "2026-08-09").map((event) => event.id),
    ["all-day", "overnight"]
  );
  assert.deepEqual(
    eventsForDate(events, "2026-08-10").map((event) => event.id),
    ["all-day", "overnight"]
  );
  assert.deepEqual(
    eventsForDate(events, "2026-08-11").map((event) => event.id),
    ["all-day", "ends-midnight"]
  );
  assert.deepEqual(eventsForDate(events, "2026-08-12"), []);
});

test("next event is the earliest occurrence that has not ended, with stable ties and a one-year cutoff", () => {
  const now = new Date(2026, 7, 9, 12);
  const timed = (id, start, end, feedOrder) => ({
    id,
    title: id,
    allDay: false,
    start: start.toISOString(),
    end: end.toISOString(),
    feedOrder
  });
  const ended = timed(
    "ended",
    new Date(2026, 7, 9, 8),
    new Date(2026, 7, 9, 9),
    0
  );
  const ongoing = timed(
    "ongoing",
    new Date(2026, 7, 8, 11),
    new Date(2026, 7, 10, 13),
    1
  );
  const tiedLater = timed(
    "tied-later",
    new Date(2026, 7, 9, 14),
    new Date(2026, 7, 9, 15),
    5
  );
  const tiedEarlier = timed(
    "tied-earlier",
    new Date(2026, 7, 9, 14),
    new Date(2026, 7, 9, 16),
    2
  );
  const allDayToday = {
    id: "all-day",
    title: "all-day",
    allDay: true,
    startDate: "2026-08-09",
    endDateExclusive: "2026-08-10",
    feedOrder: 4
  };

  const nextOngoing = nextCalendarEvent(
    [ended, tiedLater, tiedEarlier, ongoing],
    now
  );
  assert.equal(nextOngoing.event.id, "ongoing");
  assert.equal(localDateKey(nextOngoing.targetDate), "2026-08-09");

  assert.equal(
    nextCalendarEvent([ended, tiedLater, allDayToday], now).event.id,
    "all-day"
  );
  assert.equal(
    nextCalendarEvent([ended, tiedLater, tiedEarlier], now).event.id,
    "tied-earlier"
  );

  const beyondHorizon = timed(
    "too-far",
    new Date(2027, 7, 10, 9),
    new Date(2027, 7, 10, 10),
    0
  );
  assert.equal(nextCalendarEvent([ended, beyondHorizon], now), null);
});

test("day details put all-day events first and format multi-day timed ranges relative to the selected day", () => {
  const at = (year, month, day, hour, minute = 0) => (
    new Date(year, month, day, hour, minute).toISOString()
  );
  const allDay = {
    id: "all-day",
    allDay: true,
    startDate: "2026-08-09",
    endDateExclusive: "2026-08-10",
    feedOrder: 3
  };
  const morningLaterInFeed = {
    id: "morning-later",
    allDay: false,
    start: at(2026, 7, 9, 9),
    end: at(2026, 7, 9, 10, 30),
    feedOrder: 5
  };
  const morningEarlierInFeed = {
    ...morningLaterInFeed,
    id: "morning-earlier",
    feedOrder: 2
  };
  const crossing = {
    id: "crossing",
    allDay: false,
    start: at(2026, 7, 9, 23),
    end: at(2026, 7, 11, 1),
    feedOrder: 4
  };
  const carriedEarlierInFeed = {
    id: "carried-earlier",
    allDay: false,
    start: at(2026, 7, 8, 20),
    end: at(2026, 7, 10, 2),
    feedOrder: 1
  };
  const carriedLaterInFeed = {
    id: "carried-later",
    allDay: false,
    start: at(2026, 7, 7, 20),
    end: at(2026, 7, 10, 3),
    feedOrder: 6
  };

  assert.deepEqual(
    sortEventsForDate(
      [crossing, morningLaterInFeed, allDay, morningEarlierInFeed],
      "2026-08-09"
    ).map((event) => event.id),
    ["all-day", "morning-earlier", "morning-later", "crossing"]
  );
  assert.equal(formatEventTimeRange(allDay, "2026-08-09"), "All day");
  assert.equal(
    formatEventTimeRange(morningLaterInFeed, "2026-08-09"),
    "9:00 AM–10:30 AM"
  );
  assert.equal(
    formatEventTimeRange(crossing, "2026-08-09"),
    "11:00 PM–midnight"
  );
  assert.equal(
    formatEventTimeRange(crossing, "2026-08-10"),
    "All day (continues)"
  );
  assert.equal(
    formatEventTimeRange(crossing, "2026-08-11"),
    "midnight–1:00 AM"
  );
  assert.deepEqual(
    sortEventsForDate(
      [carriedLaterInFeed, carriedEarlierInFeed],
      "2026-08-09"
    ).map((event) => event.id),
    ["carried-earlier", "carried-later"]
  );
});
