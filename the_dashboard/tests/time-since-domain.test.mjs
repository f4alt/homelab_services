import assert from "node:assert/strict";
import test from "node:test";

import {
  getTimeSincePresentation,
  normalizeApproachingRatio,
  normalizeTimeSinceItems
} from "../dashboard/widgets/time-since-domain.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;
const NOW_MS = Date.parse("2026-08-08T12:00:00Z");

function trackedItem(overrides = {}) {
  return {
    uid: "stable-uid",
    name: "Change the AC filter",
    source_file: "homelab.org",
    last_done: new Date(NOW_MS).toISOString(),
    target_days: null,
    ...overrides
  };
}

test("time-since counts only completed 24-hour periods", () => {
  const elapsedTimes = [
    { elapsedMs: 0, expectedDays: 0 },
    { elapsedMs: DAY_MS - MINUTE_MS, expectedDays: 0 },
    { elapsedMs: DAY_MS, expectedDays: 1 },
    { elapsedMs: (4 * DAY_MS) + 1, expectedDays: 4 }
  ];

  for (const { elapsedMs, expectedDays } of elapsedTimes) {
    const presentation = getTimeSincePresentation(
      trackedItem({ last_done: new Date(NOW_MS - elapsedMs).toISOString() }),
      NOW_MS
    );

    assert.equal(presentation.days, expectedDays);
  }
});

test("time-since presents a compact day token without an age phrase", () => {
  const presentation = getTimeSincePresentation(
    trackedItem({ last_done: new Date(NOW_MS - DAY_MS).toISOString() }),
    NOW_MS
  );

  assert.equal(presentation.ageToken, "1");
  assert.equal(Object.hasOwn(presentation, "agePhrase"), false);
});

test("time-since treats missing and malformed completion timestamps as unknown", () => {
  for (const lastDone of [
    null,
    "not-a-timestamp",
    "2026-08-08",
    "2026-02-30T12:00:00Z"
  ]) {
    const presentation = getTimeSincePresentation(trackedItem({ last_done: lastDone }), NOW_MS);

    assert.equal(presentation.days, null);
    assert.equal(presentation.ageToken, "?");
    assert.equal(presentation.classification, "unknown");
  }
});

test("time-since clamps future completion timestamps to zero elapsed", () => {
  const presentation = getTimeSincePresentation(
    trackedItem({ last_done: new Date(NOW_MS + DAY_MS).toISOString() }),
    NOW_MS
  );

  assert.equal(presentation.elapsedMs, 0);
  assert.equal(presentation.days, 0);
  assert.equal(presentation.ageToken, "0");
});

test("time-since accepts thresholds in (0, 1] and defaults every other value", () => {
  for (const value of [0.25, 0.8, 1]) {
    assert.equal(normalizeApproachingRatio(value), value);
  }

  for (const value of [undefined, null, "0.8", Number.NaN, 0, -0.1, 1.1]) {
    assert.equal(normalizeApproachingRatio(value), 0.8);
  }
});

test("time-since becomes approaching at the exact default threshold", () => {
  const presentation = getTimeSincePresentation(
    trackedItem({
      last_done: new Date(NOW_MS - (8 * DAY_MS)).toISOString(),
      target_days: 10
    }),
    NOW_MS
  );

  assert.equal(presentation.classification, "approaching");
});

test("time-since becomes overdue at the exact target boundary", () => {
  const presentation = getTimeSincePresentation(
    trackedItem({
      last_done: new Date(NOW_MS - (10 * DAY_MS)).toISOString(),
      target_days: 10
    }),
    NOW_MS
  );

  assert.equal(presentation.classification, "overdue");
});

test("time-since urgency uses precise elapsed time rather than displayed days", () => {
  const elapsedMs = DAY_MS - HOUR_MS;
  const presentation = getTimeSincePresentation(
    trackedItem({
      last_done: new Date(NOW_MS - elapsedMs).toISOString(),
      target_days: 1
    }),
    NOW_MS
  );

  assert.equal(presentation.days, 0);
  assert.equal(presentation.classification, "approaching");
});

test("time-since applies a valid custom threshold and defaults an invalid one", () => {
  const item = trackedItem({
    last_done: new Date(NOW_MS - (6 * DAY_MS)).toISOString(),
    target_days: 10
  });

  assert.equal(getTimeSincePresentation(item, NOW_MS, 0.5).classification, "approaching");
  assert.equal(getTimeSincePresentation(item, NOW_MS, 0).classification, "normal");
});

test("time-since treats invalid targets as absent", () => {
  for (const targetDays of [undefined, null, "10", 0, -1, 1.5]) {
    const presentation = getTimeSincePresentation(
      trackedItem({
        last_done: new Date(NOW_MS - (100 * DAY_MS)).toISOString(),
        target_days: targetDays
      }),
      NOW_MS
    );

    assert.equal(presentation.targetDays, null);
    assert.equal(presentation.classification, "normal");
  }
});

test("time-since normalizes valid items without changing their order", () => {
  const items = normalizeTimeSinceItems([
    trackedItem({ uid: "older", name: "  Older activity  ", last_done: "malformed" }),
    null,
    trackedItem({ uid: "", name: "Missing UID" }),
    trackedItem({ uid: "newer", name: "Newer activity", target_days: 2.5 })
  ]);

  assert.deepEqual(
    items.map(({ uid, name, last_done, target_days: targetDays }) => ({
      uid,
      name,
      last_done,
      targetDays
    })),
    [
      { uid: "older", name: "Older activity", last_done: null, targetDays: null },
      {
        uid: "newer",
        name: "Newer activity",
        last_done: "2026-08-08T12:00:00.000Z",
        targetDays: null
      }
    ]
  );
  assert.deepEqual(normalizeTimeSinceItems(null), []);
});

test("time-since tooltips expose exact timestamp, target, and classification", () => {
  const known = getTimeSincePresentation(
    trackedItem({
      last_done: "2026-07-31T12:00:00Z",
      target_days: 10
    }),
    NOW_MS
  );
  const unknown = getTimeSincePresentation(
    trackedItem({ last_done: null, target_days: 1 }),
    NOW_MS
  );

  assert.equal(
    known.tooltip,
    "Last done: 2026-07-31T12:00:00Z · Target: 10 days · Approaching"
  );
  assert.equal(
    unknown.tooltip,
    "Last done: unknown · Target: 1 day · Unknown"
  );
});
