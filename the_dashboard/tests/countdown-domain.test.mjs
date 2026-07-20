import assert from "node:assert/strict";
import test from "node:test";

import {
  minuteIdentity,
  sortEventsByRelevance
} from "../dashboard/widgets/countdown-domain.js";

test("countdown orders today, upcoming nearest-first, then overdue most-recent-first", () => {
  const now = new Date(2026, 6, 19, 12, 30);
  const events = [
    { label: "Overdue week", date: new Date(2026, 6, 12) },
    { label: "Future week", date: new Date(2026, 6, 26) },
    { label: "Future day", date: new Date(2026, 6, 20) },
    { label: "Today", date: new Date(2026, 6, 19) },
    { label: "Overdue day", date: new Date(2026, 6, 18) }
  ];

  const sorted = sortEventsByRelevance(events, now);

  assert.deepEqual(
    sorted.map((event) => event.label),
    ["Today", "Future day", "Future week", "Overdue day", "Overdue week"]
  );
});

test("countdown minute identity advances exactly across month and year boundaries", () => {
  const januaryEnd = new Date(Date.UTC(2026, 0, 31, 23, 59));
  const februaryStart = new Date(januaryEnd.getTime() + 60_000);
  const yearEnd = new Date(Date.UTC(2026, 11, 31, 23, 59));
  const yearStart = new Date(yearEnd.getTime() + 60_000);

  assert.equal(minuteIdentity(februaryStart) - minuteIdentity(januaryEnd), 1);
  assert.equal(minuteIdentity(yearStart) - minuteIdentity(yearEnd), 1);
});
