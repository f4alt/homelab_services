import assert from "node:assert/strict";
import test from "node:test";

import { parseCalendarOccurrences } from "../gateway/widget-routes/calendar-data.js";

const CALENDAR_SOURCE = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//Dashboard Tests//EN\r
BEGIN:VEVENT\r
UID:all-day@example.test\r
DTSTART;VALUE=DATE:20260809\r
DTEND;VALUE=DATE:20260812\r
SUMMARY:Conference\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:recurring@example.test\r
DTSTART;TZID=America/Chicago:20260809T090000\r
DTEND;TZID=America/Chicago:20260809T100000\r
RRULE:FREQ=DAILY;COUNT=4\r
RDATE;TZID=America/Chicago:20260814T090000\r
EXDATE;TZID=America/Chicago:20260810T090000\r
SUMMARY:Standup\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:recurring@example.test\r
RECURRENCE-ID;TZID=America/Chicago:20260811T090000\r
DTSTART;TZID=America/Chicago:20260811T120000\r
DTEND;TZID=America/Chicago:20260811T130000\r
SUMMARY:Moved standup\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:recurring@example.test\r
RECURRENCE-ID;TZID=America/Chicago:20260812T090000\r
DTSTART;TZID=America/Chicago:20260812T090000\r
DTEND;TZID=America/Chicago:20260812T100000\r
STATUS:CANCELLED\r
SUMMARY:Cancelled standup\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:cancelled@example.test\r
DTSTART:20260813T140000Z\r
DTEND:20260813T150000Z\r
STATUS:CANCELLED\r
SUMMARY:Cancelled event\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:untitled@example.test\r
DTSTART:20260815T140000Z\r
DTEND:20260815T150000Z\r
END:VEVENT\r
END:VCALENDAR\r
`;

test("calendar parsing returns bounded normalized occurrences with RFC recurrence semantics", async () => {
  const occurrences = await parseCalendarOccurrences(CALENDAR_SOURCE, {
    rangeStart: new Date("2026-08-08T00:00:00.000Z"),
    rangeEnd: new Date("2026-08-16T00:00:00.000Z"),
    maxOccurrences: 20
  });

  assert.deepEqual(
    occurrences.map((event) => event.title),
    ["Conference", "Standup", "Moved standup", "Standup", "Untitled event"]
  );
  assert.deepEqual(occurrences[0], {
    id: "all-day@example.test:2026-08-09",
    title: "Conference",
    allDay: true,
    startDate: "2026-08-09",
    endDateExclusive: "2026-08-12",
    feedOrder: 0
  });
  assert.equal(occurrences[1].start, "2026-08-09T14:00:00.000Z");
  assert.equal(occurrences[2].start, "2026-08-11T17:00:00.000Z");
  assert.equal(occurrences[3].start, "2026-08-14T14:00:00.000Z");
  assert.equal(occurrences[1].feedOrder, 1);
  assert.equal(occurrences[2].feedOrder, 1);
  assert.equal(new Set(occurrences.map((event) => event.id)).size, occurrences.length);
  assert.equal(occurrences.some((event) => event.title.includes("Cancelled")), false);
});

test("calendar parsing rejects malformed input and occurrence explosions", async () => {
  await assert.rejects(
    parseCalendarOccurrences("not a calendar", {
      rangeStart: new Date("2026-08-08T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-16T00:00:00.000Z"),
      maxOccurrences: 20
    }),
    { code: "malformed_calendar" }
  );

  await assert.rejects(
    parseCalendarOccurrences(CALENDAR_SOURCE, {
      rangeStart: new Date("2026-08-08T00:00:00.000Z"),
      rangeEnd: new Date("2026-08-16T00:00:00.000Z"),
      maxOccurrences: 2
    }),
    { code: "occurrence_limit_exceeded" }
  );
});

test("calendar parsing honors a hosted VTIMEZONE definition", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VTIMEZONE\r
TZID:Custom Central\r
BEGIN:STANDARD\r
DTSTART:19701101T020000\r
RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\r
TZOFFSETFROM:-0500\r
TZOFFSETTO:-0600\r
END:STANDARD\r
BEGIN:DAYLIGHT\r
DTSTART:19700308T020000\r
RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\r
TZOFFSETFROM:-0600\r
TZOFFSETTO:-0500\r
END:DAYLIGHT\r
END:VTIMEZONE\r
BEGIN:VEVENT\r
UID:custom-zone@example.test\r
DTSTART;TZID=Custom Central:20261031T090000\r
DTEND;TZID=Custom Central:20261031T100000\r
RRULE:FREQ=DAILY;COUNT=3\r
SUMMARY:Custom zone\r
END:VEVENT\r
END:VCALENDAR\r
`;

  const events = await parseCalendarOccurrences(source, {
    rangeStart: new Date("2026-10-30T00:00:00.000Z"),
    rangeEnd: new Date("2026-11-03T00:00:00.000Z"),
    maxOccurrences: 10
  });

  assert.deepEqual(events.map((event) => event.start), [
    "2026-10-31T14:00:00.000Z",
    "2026-11-01T15:00:00.000Z",
    "2026-11-02T15:00:00.000Z"
  ]);
  assert.equal(events[0].end, "2026-10-31T15:00:00.000Z");
});

test("calendar parsing binds floating events to the browser timezone across DST", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:floating@example.test\r
DTSTART:20261031T090000\r
DTEND:20261031T100000\r
RRULE:FREQ=DAILY;COUNT=3\r
SUMMARY:Floating local time\r
END:VEVENT\r
END:VCALENDAR\r
`;

  const events = await parseCalendarOccurrences(source, {
    rangeStart: new Date("2026-10-30T00:00:00.000Z"),
    rangeEnd: new Date("2026-11-03T00:00:00.000Z"),
    timeZone: "America/Chicago",
    maxOccurrences: 10
  });

  assert.deepEqual(events.map((event) => event.start), [
    "2026-10-31T14:00:00.000Z",
    "2026-11-01T15:00:00.000Z",
    "2026-11-02T15:00:00.000Z"
  ]);
});

test("calendar RDATE keeps literal all-day duration across DST changes", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:rdate-all-day@example.test\r
DTSTART;VALUE=DATE:20260307\r
DTEND;VALUE=DATE:20260310\r
RDATE;VALUE=DATE:20261031\r
SUMMARY:Three days\r
END:VEVENT\r
END:VCALENDAR\r
`;

  const events = await parseCalendarOccurrences(source, {
    rangeStart: new Date("2026-10-30T00:00:00.000Z"),
    rangeEnd: new Date("2026-11-05T00:00:00.000Z"),
    timeZone: "America/Chicago",
    maxOccurrences: 10
  });

  assert.deepEqual(events.map(({ startDate, endDateExclusive }) => ({
    startDate,
    endDateExclusive
  })), [{
    startDate: "2026-10-31",
    endDateExclusive: "2026-11-03"
  }]);
});

test("calendar parsing includes overrides moved into range and excludes overrides moved out", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:moved@example.test\r
DTSTART:20260731T140000Z\r
DTEND:20260731T150000Z\r
RRULE:FREQ=DAILY;COUNT=2\r
SUMMARY:Original\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:moved@example.test\r
RECURRENCE-ID:20260731T140000Z\r
DTSTART:20260810T160000Z\r
DTEND:20260810T170000Z\r
SUMMARY:Moved into range\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:moved@example.test\r
RECURRENCE-ID:20260801T140000Z\r
DTSTART:20260901T160000Z\r
DTEND:20260901T170000Z\r
SUMMARY:Moved out of range\r
END:VEVENT\r
END:VCALENDAR\r
`;

  const events = await parseCalendarOccurrences(source, {
    rangeStart: new Date("2026-08-09T00:00:00.000Z"),
    rangeEnd: new Date("2026-08-12T00:00:00.000Z"),
    maxOccurrences: 10
  });

  assert.deepEqual(events.map(({ title, start }) => ({ title, start })), [{
    title: "Moved into range",
    start: "2026-08-10T16:00:00.000Z"
  }]);
});

test("calendar parsing honors explicit-end and duration RDATE periods", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:periods@example.test\r
DTSTART:20260701T160000Z\r
DTEND:20260701T170000Z\r
RDATE;VALUE=PERIOD:20260810T160000Z/20260810T180000Z,20260811T160000Z/PT90M\r
SUMMARY:Variable duration\r
END:VEVENT\r
END:VCALENDAR\r
`;

  const events = await parseCalendarOccurrences(source, {
    rangeStart: new Date("2026-08-09T00:00:00.000Z"),
    rangeEnd: new Date("2026-08-12T23:59:59.000Z"),
    maxOccurrences: 10
  });

  assert.deepEqual(events.map(({ start, end }) => ({ start, end })), [
    {
      start: "2026-08-10T16:00:00.000Z",
      end: "2026-08-10T18:00:00.000Z"
    },
    {
      start: "2026-08-11T16:00:00.000Z",
      end: "2026-08-11T17:30:00.000Z"
    }
  ]);
});

test("calendar parsing preserves source order for numeric UIDs and bounds RDATE input", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:10\r
DTSTART:20260810T160000Z\r
DTEND:20260810T170000Z\r
SUMMARY:First in source\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:2\r
DTSTART:20260810T160000Z\r
DTEND:20260810T170000Z\r
SUMMARY:Second in source\r
END:VEVENT\r
END:VCALENDAR\r
`;
  const options = {
    rangeStart: new Date("2026-08-09T00:00:00.000Z"),
    rangeEnd: new Date("2026-08-12T00:00:00.000Z"),
    maxOccurrences: 10
  };

  const events = await parseCalendarOccurrences(source, options);
  assert.deepEqual(events.map(({ title, feedOrder }) => ({ title, feedOrder })), [
    { title: "First in source", feedOrder: 0 },
    { title: "Second in source", feedOrder: 1 }
  ]);

  const excessiveRdates = source.replace(
    "SUMMARY:First in source",
    "RDATE:20260811T160000Z,20260812T160000Z,20260813T160000Z\r\nSUMMARY:First in source"
  );
  await assert.rejects(
    parseCalendarOccurrences(excessiveRdates, { ...options, maxOccurrences: 2 }),
    { code: "occurrence_limit_exceeded" }
  );
});

test("calendar recurrence scan estimates honor an early UNTIL", async () => {
  const source = `BEGIN:VCALENDAR\r
VERSION:2.0\r
BEGIN:VEVENT\r
UID:historical@example.test\r
DTSTART:20200101T000000Z\r
DTEND:20200101T000100Z\r
RRULE:FREQ=MINUTELY;UNTIL=20200101T010000Z\r
SUMMARY:Short historical series\r
END:VEVENT\r
END:VCALENDAR\r
`;

  const events = await parseCalendarOccurrences(source, {
    rangeStart: new Date("2026-08-09T00:00:00.000Z"),
    rangeEnd: new Date("2026-08-12T00:00:00.000Z"),
    maxOccurrences: 10
  });

  assert.deepEqual(events, []);
});
