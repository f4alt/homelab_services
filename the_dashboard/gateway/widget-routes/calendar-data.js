import ICAL from "ical.js";

const CALENDAR_START_PATTERN = /BEGIN:VCALENDAR/i;
const CALENDAR_END_PATTERN = /END:VCALENDAR/i;
const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * MILLISECONDS_PER_SECOND;
const TIME_ZONE_OFFSET_MAX_ATTEMPTS = 4;
// Sparse historical series may require scanning before the requested range,
// while this multiplier still rejects pathological high-frequency rules.
const RECURRENCE_SCAN_MULTIPLIER = 20;
const FREQUENCY_MILLISECONDS = Object.freeze({
  SECONDLY: MILLISECONDS_PER_SECOND,
  MINUTELY: 60 * MILLISECONDS_PER_SECOND,
  HOURLY: 60 * 60 * MILLISECONDS_PER_SECOND,
  DAILY: MILLISECONDS_PER_DAY,
  WEEKLY: 7 * MILLISECONDS_PER_DAY,
  MONTHLY: 28 * MILLISECONDS_PER_DAY,
  YEARLY: 365 * MILLISECONDS_PER_DAY
});
const RECURRENCE_EXPANSION_PARTS = Object.freeze([
  "BYSECOND",
  "BYMINUTE",
  "BYHOUR",
  "BYDAY",
  "BYMONTH",
  "BYMONTHDAY",
  "BYYEARDAY",
  "BYWEEKNO",
  "BYSETPOS"
]);

export class CalendarDataError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CalendarDataError";
    this.code = code;
  }
}

function occurrenceLimitExceeded() {
  throw new CalendarDataError(
    "occurrence_limit_exceeded",
    "Calendar occurrence limit exceeded."
  );
}

function countDelimitedValues(value) {
  let count = value ? 1 : 0;
  for (const character of value) {
    if (character === ",") count += 1;
  }
  return count;
}

function assertRawRdateCapacity(source, maxOccurrences) {
  const unfolded = source.replace(/\r?\n[ \t]/g, "");
  let rdateCount = 0;

  for (const line of unfolded.split(/\r?\n/)) {
    if (!/^RDATE(?:;|:)/i.test(line)) continue;
    const valueSeparator = line.indexOf(":");
    if (valueSeparator < 0) continue;
    rdateCount += countDelimitedValues(line.slice(valueSeparator + 1));
    if (rdateCount > maxOccurrences) occurrenceLimitExceeded();
  }
}

function formatterParts(formatter, date) {
  return Object.fromEntries(
    formatter.formatToParts(date).map((part) => [part.type, part.value])
  );
}

class IntlTimeZone extends ICAL.Timezone {
  constructor(tzid) {
    super({ tzid });
    this.formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: tzid,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    });
  }

  utcOffset(time) {
    const localFieldsAsUtc = Date.UTC(
      time.year,
      time.month - 1,
      time.day,
      time.hour,
      time.minute,
      time.second
    );
    let candidate = localFieldsAsUtc;
    let offsetSeconds = 0;

    // Re-evaluate at the candidate instant because the first offset can fall
    // on the other side of a daylight-saving transition.
    for (
      let attempt = 0;
      attempt < TIME_ZONE_OFFSET_MAX_ATTEMPTS;
      attempt += 1
    ) {
      const parts = formatterParts(this.formatter, new Date(candidate));
      offsetSeconds = (
        Date.UTC(
          Number(parts.year),
          Number(parts.month) - 1,
          Number(parts.day),
          Number(parts.hour),
          Number(parts.minute),
          Number(parts.second)
        ) - candidate
      ) / MILLISECONDS_PER_SECOND;
      const nextCandidate = localFieldsAsUtc - (offsetSeconds * MILLISECONDS_PER_SECOND);
      if (nextCandidate === candidate) break;
      candidate = nextCandidate;
    }

    return offsetSeconds;
  }
}

function registerIanaTimeZone(timeZoneId) {
  if (ICAL.TimezoneService.has(timeZoneId)) return;
  try {
    ICAL.TimezoneService.register(new IntlTimeZone(timeZoneId));
  } catch {
    throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
  }
}

function registerReferencedIanaTimeZones(calendar, eventComponents, browserTimeZone) {
  registerIanaTimeZone(browserTimeZone);
  const timeZoneIds = new Set();
  for (const component of eventComponents) {
    for (const property of component.getAllProperties()) {
      const timeZoneId = property.getParameter("tzid");
      if (timeZoneId) timeZoneIds.add(timeZoneId);
    }
  }

  for (const timeZoneId of timeZoneIds) {
    if (calendar.getTimeZoneByID(timeZoneId) || ICAL.TimezoneService.has(timeZoneId)) {
      continue;
    }
    registerIanaTimeZone(timeZoneId);
  }
}

function bindFloatingTime(time, browserZone) {
  if (
    time instanceof ICAL.Time
    && !time.isDate
    && time.zone === ICAL.Timezone.localTimezone
  ) {
    time.zone = browserZone;
  }
}

function bindFloatingEventTimes(eventComponents, browserZone) {
  for (const component of eventComponents) {
    for (const property of component.getAllProperties()) {
      for (const value of property.getValues()) {
        if (value instanceof ICAL.Period) {
          bindFloatingTime(value.start, browserZone);
          bindFloatingTime(value.end, browserZone);
        } else if (value instanceof ICAL.Recur) {
          bindFloatingTime(value.until, browserZone);
        } else {
          bindFloatingTime(value, browserZone);
        }
      }
    }
  }
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

function textValue(value) {
  return String(value ?? "").trim();
}

function isCancelled(event) {
  return textValue(event?.component?.getFirstPropertyValue("status")).toUpperCase()
    === "CANCELLED";
}

function eventTitle(event, baseEvent) {
  return textValue(event?.summary) || textValue(baseEvent?.summary) || "Untitled event";
}

function timeMilliseconds(time) {
  return time.toUnixTime() * MILLISECONDS_PER_SECOND;
}

function occurrenceIdentity(time) {
  return time.isDate
    ? time.toString()
    : time.convertToZone(ICAL.Timezone.utcTimezone).toString();
}

function normalizedOccurrence({
  event,
  baseEvent,
  start,
  end,
  recurrenceId,
  uid,
  feedOrder
}) {
  if (isCancelled(event)) return null;

  const id = `${uid}:${occurrenceIdentity(recurrenceId)}`;
  const title = eventTitle(event, baseEvent);
  if (start.isDate) {
    if (!end?.isDate || end.compare(start) <= 0) return null;
    return {
      id,
      title,
      allDay: true,
      startDate: start.toString(),
      endDateExclusive: end.toString(),
      feedOrder
    };
  }

  const startMilliseconds = timeMilliseconds(start);
  const endMilliseconds = timeMilliseconds(end);
  if (
    !Number.isFinite(startMilliseconds)
    || !Number.isFinite(endMilliseconds)
    || endMilliseconds <= startMilliseconds
  ) {
    return null;
  }
  return {
    id,
    title,
    allDay: false,
    start: new Date(startMilliseconds).toISOString(),
    end: new Date(endMilliseconds).toISOString(),
    feedOrder
  };
}

function occurrenceOverlapsRange(occurrence, range) {
  if (occurrence.allDay) {
    return occurrence.startDate < range.endDateExclusive
      && occurrence.endDateExclusive > range.startDate;
  }
  return occurrence.start < range.endIso && occurrence.end > range.startIso;
}

function occurrenceSortValue(occurrence) {
  return occurrence.allDay
    ? `${occurrence.startDate}T00:00:00.000Z`
    : occurrence.start;
}

function addOccurrence(occurrences, seenIds, occurrence, range, maxOccurrences) {
  if (
    !occurrence
    || seenIds.has(occurrence.id)
    || !occurrenceOverlapsRange(occurrence, range)
  ) {
    return;
  }
  seenIds.add(occurrence.id);
  occurrences.push(occurrence);
  if (occurrences.length > maxOccurrences) occurrenceLimitExceeded();
}

function exceptionComponentsByUid(eventComponents) {
  const exceptions = new Map();
  for (const component of eventComponents) {
    if (!component.hasProperty("recurrence-id")) continue;
    const uid = textValue(component.getFirstPropertyValue("uid"));
    if (!uid) continue;
    const related = exceptions.get(uid) || [];
    related.push(component);
    exceptions.set(uid, related);
  }
  return exceptions;
}

function minimumRecurrenceShift(exceptionComponents) {
  let minimum = 0;
  for (const component of exceptionComponents) {
    const exception = new ICAL.Event(component);
    const shift = timeMilliseconds(exception.startDate)
      - timeMilliseconds(exception.recurrenceId);
    if (!Number.isFinite(shift)) continue;
    minimum = Math.min(minimum, shift);
  }
  return minimum;
}

function assertRecurrenceScanIsBounded(event, searchEndMilliseconds, scanLimit) {
  let estimate = 1;
  for (const property of event.component.getAllProperties("rrule")) {
    const rule = property.getFirstValue();
    const frequencyMilliseconds = FREQUENCY_MILLISECONDS[rule.freq];
    if (!frequencyMilliseconds) occurrenceLimitExceeded();

    const interval = Number.isInteger(rule.interval) && rule.interval > 0
      ? rule.interval
      : 1;
    const ruleEndMilliseconds = rule.until
      ? Math.min(searchEndMilliseconds, timeMilliseconds(rule.until))
      : searchEndMilliseconds;
    const span = Math.max(
      0,
      ruleEndMilliseconds - timeMilliseconds(event.startDate)
    );
    let ruleEstimate = Math.ceil(span / (frequencyMilliseconds * interval)) + 1;
    for (const partName of RECURRENCE_EXPANSION_PARTS) {
      const values = rule.getComponent(partName);
      if (values.length > 1) ruleEstimate *= values.length;
      if (ruleEstimate > scanLimit) break;
    }
    if (Number.isInteger(rule.count)) ruleEstimate = Math.min(ruleEstimate, rule.count);
    estimate += ruleEstimate;
    if (estimate > scanLimit) occurrenceLimitExceeded();
  }
}

function isExcludedDate(eventComponent, candidate) {
  for (const property of eventComponent.getAllProperties("exdate")) {
    for (const excluded of property.getValues()) {
      if (excluded.isDate && !candidate.isDate) {
        if (
          excluded.year === candidate.year
          && excluded.month === candidate.month
          && excluded.day === candidate.day
        ) {
          return true;
        }
      } else if (excluded.compare(candidate) === 0) {
        return true;
      }
    }
  }
  return false;
}

function periodRdates(eventComponent) {
  const properties = eventComponent.getAllProperties("rdate");
  const periodProperties = [];
  const periods = [];
  for (const property of properties) {
    const values = property.getValues();
    if (!values.some((value) => value instanceof ICAL.Period)) continue;
    periodProperties.push(property);
    periods.push(...values);
  }
  return { periodProperties, periods };
}

function restoreProperties(component, properties) {
  for (const property of properties) component.addProperty(property);
}

function addExplicitExceptions({
  baseEvent,
  exceptionComponents,
  feedOrder,
  uid,
  occurrences,
  seenIds,
  range,
  maxOccurrences
}) {
  for (const component of exceptionComponents) {
    const exception = new ICAL.Event(component);
    const occurrence = normalizedOccurrence({
      event: exception,
      baseEvent,
      start: exception.startDate,
      end: exception.endDate,
      recurrenceId: exception.recurrenceId,
      uid,
      feedOrder
    });
    addOccurrence(occurrences, seenIds, occurrence, range, maxOccurrences);
  }
}

function addPeriodRdates({
  event,
  periods,
  feedOrder,
  uid,
  occurrences,
  seenIds,
  range,
  maxOccurrences
}) {
  for (const period of periods) {
    if (isExcludedDate(event.component, period.start)) continue;
    const details = event.getOccurrenceDetails(period.start);
    const hasOverride = details.item !== event;
    const occurrence = normalizedOccurrence({
      event: details.item,
      baseEvent: event,
      start: hasOverride ? details.startDate : period.start,
      end: hasOverride ? details.endDate : period.getEnd(),
      recurrenceId: period.start,
      uid,
      feedOrder
    });
    addOccurrence(occurrences, seenIds, occurrence, range, maxOccurrences);
  }
}

function expandEvent({
  component,
  exceptionComponents,
  feedOrder,
  uid,
  range,
  maxOccurrences,
  scanBudget,
  occurrences,
  seenIds
}) {
  const { periodProperties, periods } = periodRdates(component);
  // ICAL's recurrence iterator treats RDATE values as instants. Expand PERIOD
  // values separately so each occurrence retains its explicit duration.
  periodProperties.forEach((property) => component.removeProperty(property));

  try {
    const event = new ICAL.Event(component, {
      exceptions: exceptionComponents,
      strictExceptions: true
    });
    if (isCancelled(event)) return;

    addExplicitExceptions({
      baseEvent: event,
      exceptionComponents,
      feedOrder,
      uid,
      occurrences,
      seenIds,
      range,
      maxOccurrences
    });
    addPeriodRdates({
      event,
      periods,
      feedOrder,
      uid,
      occurrences,
      seenIds,
      range,
      maxOccurrences
    });

    const minimumShift = minimumRecurrenceShift(exceptionComponents);
    const searchEnd = range.endMilliseconds + Math.max(0, -minimumShift);
    assertRecurrenceScanIsBounded(event, searchEnd, scanBudget.remaining);

    const iterator = event.iterator();
    for (let recurrenceId = iterator.next(); recurrenceId; recurrenceId = iterator.next()) {
      scanBudget.remaining -= 1;
      if (scanBudget.remaining < 0) occurrenceLimitExceeded();
      if (timeMilliseconds(recurrenceId) > searchEnd) break;

      const details = event.getOccurrenceDetails(recurrenceId);
      const occurrence = normalizedOccurrence({
        event: details.item,
        baseEvent: event,
        start: details.startDate,
        end: details.endDate,
        recurrenceId,
        uid,
        feedOrder
      });
      addOccurrence(occurrences, seenIds, occurrence, range, maxOccurrences);
    }
  } finally {
    restoreProperties(component, periodProperties);
  }
}

export async function parseCalendarOccurrences(source, {
  rangeStart,
  rangeEnd,
  timeZone = "UTC",
  maxOccurrences
}) {
  const sourceText = String(source);
  if (!CALENDAR_START_PATTERN.test(sourceText) || !CALENDAR_END_PATTERN.test(sourceText)) {
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

  assertRawRdateCapacity(sourceText, maxOccurrences);

  let calendar;
  let eventComponents;
  try {
    calendar = new ICAL.Component(ICAL.parse(sourceText));
    eventComponents = calendar.getAllSubcomponents("vevent");
    registerReferencedIanaTimeZones(calendar, eventComponents, timeZone);
    bindFloatingEventTimes(eventComponents, ICAL.TimezoneService.get(timeZone));
  } catch (error) {
    if (error instanceof CalendarDataError) throw error;
    throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
  }

  const range = {
    endMilliseconds: rangeEnd.getTime(),
    startIso: rangeStart.toISOString(),
    endIso: rangeEnd.toISOString(),
    startDate: dateKeyInTimeZone(rangeStart, timeZone),
    endDateExclusive: dateKeyInTimeZone(rangeEnd, timeZone)
  };
  const occurrences = [];
  const seenIds = new Set();
  const exceptions = exceptionComponentsByUid(eventComponents);
  const scanBudget = { remaining: maxOccurrences * RECURRENCE_SCAN_MULTIPLIER };

  try {
    eventComponents.forEach((component, feedOrder) => {
      if (component.hasProperty("recurrence-id")) return;
      const uid = textValue(component.getFirstPropertyValue("uid")) || `event-${feedOrder}`;
      expandEvent({
        component,
        exceptionComponents: exceptions.get(uid) || [],
        feedOrder,
        uid,
        range,
        maxOccurrences,
        scanBudget,
        occurrences,
        seenIds
      });
    });
  } catch (error) {
    if (error instanceof CalendarDataError) throw error;
    throw new CalendarDataError("malformed_calendar", "Calendar data is malformed.");
  }

  return occurrences.sort((left, right) => (
    occurrenceSortValue(left).localeCompare(occurrenceSortValue(right))
    || left.feedOrder - right.feedOrder
  ));
}
