import ical from "node-ical";

const CALENDAR_START_PATTERN = /BEGIN:VCALENDAR/i;
const CALENDAR_END_PATTERN = /END:VCALENDAR/i;
const ICAL_DATE_PATTERN = /^\d{8}$/;
const ICAL_DATE_TIME_PATTERN = /^\d{8}T\d{6}Z?$/;
const FREQUENCY_MILLISECONDS = Object.freeze({
  SECONDLY: 1000,
  MINUTELY: 60 * 1000,
  HOURLY: 60 * 60 * 1000,
  DAILY: 24 * 60 * 60 * 1000,
  WEEKLY: 7 * 24 * 60 * 60 * 1000,
  MONTHLY: 28 * 24 * 60 * 60 * 1000,
  YEARLY: 365 * 24 * 60 * 60 * 1000
});
const RECURRENCE_EXPANSION_FIELDS = Object.freeze([
  "byHour",
  "byMinute",
  "bySecond",
  "byDay",
  "byMonth",
  "byMonthDay",
  "byYearDay",
  "byWeekNo",
  "bySetPos"
]);

export class CalendarDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CalendarDataError";
    this.code = code;
  }
}

function textValue(value) {
  const raw = value && typeof value === "object" && "val" in value
    ? value.val
    : value;
  return String(raw ?? "").trim();
}

function isCancelled(event) {
  return textValue(event?.status).toUpperCase() === "CANCELLED";
}

function dateOnlyKey(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0")
  ].join("-");
}

function dateKeyInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function normalizedTitle(instanceEvent, baseEvent) {
  return textValue(instanceEvent?.summary || baseEvent?.summary) || "Untitled event";
}

function normalizedOccurrence(instance, baseEvent, feedOrder) {
  const instanceEvent = instance.event || baseEvent;
  if (isCancelled(instanceEvent)) return null;

  const title = normalizedTitle(instanceEvent, baseEvent);
  const uid = textValue(baseEvent.uid) || `event-${feedOrder}`;

  if (instance.isFullDay) {
    const startDate = dateOnlyKey(instance.start);
    return {
      id: `${uid}:${startDate}`,
      title,
      allDay: true,
      startDate,
      endDateExclusive: dateOnlyKey(instance.end),
      feedOrder
    };
  }

  const start = new Date(instance.start);
  const end = new Date(instance.end);
  if (
    !Number.isFinite(start.getTime())
    || !Number.isFinite(end.getTime())
    || end <= start
  ) {
    return null;
  }

  return {
    id: `${uid}:${start.toISOString()}`,
    title,
    allDay: false,
    start: start.toISOString(),
    end: end.toISOString(),
    feedOrder
  };
}

function rdateProperties(event) {
  const values = Array.isArray(event?.rdate) ? event.rdate : [event?.rdate];
  return values
    .filter((value) => value !== undefined && value !== null)
    .flatMap((property) => {
      const value = property && typeof property === "object" && "val" in property
        ? property.val
        : property;
      const params = property && typeof property === "object" && "params" in property
        ? property.params
        : {};
      return String(value).split(",").map((entry) => ({
        value: entry.trim(),
        params
      }));
    });
}

function safeRdateParams(params, baseEvent) {
  const normalized = { ...params };
  if (Object.keys(normalized).length === 0) {
    if (baseEvent.datetype === "date") normalized.VALUE = "DATE";
    else if (baseEvent.start?.tz) normalized.TZID = baseEvent.start.tz;
  }

  return Object.entries(normalized)
    .filter(([, value]) => !/[\r\n]/.test(String(value)))
    .map(([name, value]) => `${name}=${value}`)
    .join(";");
}

function parseRdateStart(property, baseEvent) {
  const isDate = ICAL_DATE_PATTERN.test(property.value);
  if (!isDate && !ICAL_DATE_TIME_PATTERN.test(property.value)) return null;

  const params = safeRdateParams(property.params, baseEvent);
  const propertyName = params ? `DTSTART;${params}` : "DTSTART";
  const source = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "BEGIN:VEVENT",
    "UID:rdate-instance",
    `${propertyName}:${property.value}`,
    "END:VEVENT",
    "END:VCALENDAR"
  ].join("\r\n");
  const parsed = ical.sync.parseICS(source)["rdate-instance"];
  return parsed?.start instanceof Date
    ? { start: parsed.start, isFullDay: parsed.datetype === "date" }
    : null;
}

function matchingDateEntry(entries, start, isFullDay) {
  if (!entries) return null;
  if (isFullDay) return entries[dateOnlyKey(start)] || null;
  return entries[start.toISOString()] || null;
}

function eventDurationMilliseconds(event) {
  const start = new Date(event.start);
  const end = new Date(event.end);
  return Number.isFinite(start.getTime()) && Number.isFinite(end.getTime())
    ? Math.max(0, end - start)
    : 0;
}

function allDayDuration(event) {
  if (!event.start?.dateOnly || !event.end?.dateOnly) return 1;
  const [startYear, startMonth, startDay] = dateOnlyKey(event.start).split("-").map(Number);
  const [endYear, endMonth, endDay] = dateOnlyKey(event.end).split("-").map(Number);
  const duration = (
    Date.UTC(endYear, endMonth - 1, endDay)
    - Date.UTC(startYear, startMonth - 1, startDay)
  ) / FREQUENCY_MILLISECONDS.DAILY;
  return Math.max(1, duration);
}

function rdateInstances(event) {
  const baseDuration = eventDurationMilliseconds(event);
  return rdateProperties(event).flatMap((property) => {
    const parsed = parseRdateStart(property, event);
    if (!parsed || matchingDateEntry(event.exdate, parsed.start, parsed.isFullDay)) {
      return [];
    }

    const override = matchingDateEntry(event.recurrences, parsed.start, parsed.isFullDay);
    const instanceEvent = override || event;
    const start = override?.start instanceof Date ? override.start : parsed.start;
    let end;
    if (override?.end instanceof Date) {
      end = override.end;
    } else if (parsed.isFullDay) {
      end = new Date(start.getTime());
      end.setDate(end.getDate() + allDayDuration(event));
    } else {
      end = new Date(start.getTime() + baseDuration);
    }
    if (parsed.isFullDay) {
      start.dateOnly = true;
      end.dateOnly = true;
    }

    return [{
      start,
      end,
      isFullDay: parsed.isFullDay,
      event: instanceEvent
    }];
  });
}

function occurrenceOverlapsRange(occurrence, range) {
  if (occurrence.allDay) {
    return occurrence.startDate < range.endDateExclusive
      && occurrence.endDateExclusive > range.startDate;
  }
  return occurrence.start < range.end.toISOString()
    && occurrence.end > range.start.toISOString();
}

function occurrenceSortValue(occurrence) {
  return occurrence.allDay
    ? `${occurrence.startDate}T00:00:00.000Z`
    : occurrence.start;
}

function assertOccurrenceCapacity(occurrences, maxOccurrences) {
  if (occurrences.length > maxOccurrences) {
    throw new CalendarDataError(
      "occurrence_limit_exceeded",
      "Calendar occurrence limit exceeded."
    );
  }
}

function assertRecurrenceIsBounded(event, rangeStart, rangeEnd, maxOccurrences) {
  const options = event.rrule?.options;
  if (!options) return;

  const frequencyMilliseconds = FREQUENCY_MILLISECONDS[options.freq];
  if (!frequencyMilliseconds) {
    throw new CalendarDataError(
      "occurrence_limit_exceeded",
      "Calendar occurrence limit exceeded."
    );
  }

  const interval = Number.isInteger(options.interval) && options.interval > 0
    ? options.interval
    : 1;
  const duration = eventDurationMilliseconds(event);
  const searchMilliseconds = (rangeEnd - rangeStart) + duration;
  let estimate = Math.ceil(searchMilliseconds / (frequencyMilliseconds * interval)) + 1;

  for (const field of RECURRENCE_EXPANSION_FIELDS) {
    const values = options[field];
    if (Array.isArray(values) && values.length > 1) estimate *= values.length;
    if (estimate > maxOccurrences) break;
  }
  if (Number.isInteger(options.count)) estimate = Math.min(estimate, options.count);

  if (estimate > maxOccurrences) {
    throw new CalendarDataError(
      "occurrence_limit_exceeded",
      "Calendar occurrence limit exceeded."
    );
  }
}

export async function parseCalendarOccurrences(source, {
  rangeStart,
  rangeEnd,
  timeZone = "UTC",
  maxOccurrences
}) {
  if (!CALENDAR_START_PATTERN.test(source) || !CALENDAR_END_PATTERN.test(source)) {
    throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
  }
  if (
    !(rangeStart instanceof Date)
    || !(rangeEnd instanceof Date)
    || !Number.isFinite(rangeStart.getTime())
    || !Number.isFinite(rangeEnd.getTime())
    || rangeEnd <= rangeStart
    || !Number.isInteger(maxOccurrences)
    || maxOccurrences < 1
  ) {
    throw new TypeError("A valid bounded calendar range is required.");
  }

  let calendar;
  try {
    calendar = await ical.async.parseICS(String(source));
  } catch {
    throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
  }

  const range = {
    start: rangeStart,
    end: rangeEnd,
    startDate: dateKeyInTimeZone(rangeStart, timeZone),
    endDateExclusive: dateKeyInTimeZone(rangeEnd, timeZone)
  };
  const occurrences = [];
  const seenIds = new Set();
  const events = Object.values(calendar).filter((entry) => entry?.type === "VEVENT");

  try {
    for (const [feedOrder, event] of events.entries()) {
      if (!(event.start instanceof Date)) continue;
      assertRecurrenceIsBounded(event, rangeStart, rangeEnd, maxOccurrences);

      const instances = [
        ...ical.expandRecurringEvent(event, {
          from: rangeStart,
          to: new Date(rangeEnd.getTime() - 1),
          includeOverrides: true,
          excludeExdates: true,
          expandOngoing: true
        }),
        ...rdateInstances(event)
      ];

      for (const instance of instances) {
        const occurrence = normalizedOccurrence(instance, event, feedOrder);
        if (
          !occurrence
          || seenIds.has(occurrence.id)
          || !occurrenceOverlapsRange(occurrence, range)
        ) {
          continue;
        }
        seenIds.add(occurrence.id);
        occurrences.push(occurrence);
        assertOccurrenceCapacity(occurrences, maxOccurrences);
      }
    }
  } catch (error) {
    if (error instanceof CalendarDataError) throw error;
    throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
  }

  return occurrences.sort((left, right) => (
    occurrenceSortValue(left).localeCompare(occurrenceSortValue(right))
    || left.feedOrder - right.feedOrder
  ));
}
