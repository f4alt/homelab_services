const CALENDAR_GRID_DAYS = 42;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const PROGRESS_DAYS = 365;
const PROGRESS_MAX_PERCENT = 100;
const CHIP_MIN_PERCENT = 5;
const CHIP_MAX_PERCENT = 95;
const SUNDAY = 0;
const MONDAY = 1;
const THURSDAY = 4;
const FRIDAY = 5;
const SATURDAY = 6;

function padDatePart(value) {
  return String(value).padStart(2, "0");
}

export function localDateKey(date) {
  return [
    date.getFullYear(),
    padDatePart(date.getMonth() + 1),
    padDatePart(date.getDate())
  ].join("-");
}

export function parseLocalDateKey(dateKey) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey));
  if (!match) return null;

  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return localDateKey(date) === dateKey ? date : null;
}

export function startOfLocalDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addLocalDays(date, days) {
  const result = startOfLocalDay(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function calendarDayDifference(target, reference) {
  const targetDay = Date.UTC(
    target.getFullYear(),
    target.getMonth(),
    target.getDate()
  );
  const referenceDay = Date.UTC(
    reference.getFullYear(),
    reference.getMonth(),
    reference.getDate()
  );
  return Math.round((targetDay - referenceDay) / MILLISECONDS_PER_DAY);
}

export function countdownState(target, now = new Date()) {
  const days = calendarDayDifference(target, now);
  const cappedDays = Math.min(Math.abs(days), PROGRESS_DAYS);
  let chipText;
  let mode;
  let futurePercent = 0;
  let overduePercent = 0;
  let rawChipPercent;

  if (days === 0) {
    chipText = "TODAY";
    mode = "today";
    futurePercent = PROGRESS_MAX_PERCENT;
    rawChipPercent = PROGRESS_MAX_PERCENT;
  } else if (days > 0) {
    chipText = days === 1 ? "in 1 day" : `in ${days} days`;
    mode = "future";
    futurePercent = ((PROGRESS_DAYS - cappedDays) / PROGRESS_DAYS)
      * PROGRESS_MAX_PERCENT;
    rawChipPercent = futurePercent;
  } else {
    const overdueDays = Math.abs(days);
    chipText = overdueDays === 1 ? "1 day ago" : `${overdueDays} days ago`;
    mode = "overdue";
    overduePercent = (cappedDays / PROGRESS_DAYS) * PROGRESS_MAX_PERCENT;
    rawChipPercent = PROGRESS_MAX_PERCENT - overduePercent;
  }

  return {
    chipText,
    mode,
    futurePercent,
    overduePercent,
    chipPercent: Math.min(CHIP_MAX_PERCENT, Math.max(CHIP_MIN_PERCENT, rawChipPercent))
  };
}

function nthWeekdayOfMonth(year, month, weekday, occurrence) {
  const date = new Date(year, month, 1);
  const offset = (weekday - date.getDay() + 7) % 7;
  date.setDate(1 + offset + ((occurrence - 1) * 7));
  return date;
}

function lastWeekdayOfMonth(year, month, weekday) {
  const date = new Date(year, month + 1, 0);
  const offset = (date.getDay() - weekday + 7) % 7;
  date.setDate(date.getDate() - offset);
  return date;
}

function observedDate(year, month, day) {
  const date = new Date(year, month, day);
  if (date.getDay() === SATURDAY) return addLocalDays(date, -1);
  if (date.getDay() === SUNDAY) return addLocalDays(date, 1);
  return date;
}

function federalHolidaysForYear(year) {
  return [
    { title: "New Year’s Day", date: observedDate(year, 0, 1) },
    {
      title: "Martin Luther King Jr. Day",
      date: nthWeekdayOfMonth(year, 0, MONDAY, 3)
    },
    {
      title: "Washington’s Birthday",
      date: nthWeekdayOfMonth(year, 1, MONDAY, 3)
    },
    { title: "Memorial Day", date: lastWeekdayOfMonth(year, 4, MONDAY) },
    { title: "Juneteenth", date: observedDate(year, 5, 19) },
    { title: "Independence Day", date: observedDate(year, 6, 4) },
    { title: "Labor Day", date: nthWeekdayOfMonth(year, 8, MONDAY, 1) },
    { title: "Columbus Day", date: nthWeekdayOfMonth(year, 9, MONDAY, 2) },
    { title: "Veterans Day", date: observedDate(year, 10, 11) },
    {
      title: "Thanksgiving Day",
      date: nthWeekdayOfMonth(year, 10, THURSDAY, 4)
    },
    { title: "Christmas Day", date: observedDate(year, 11, 25) }
  ];
}

export function nextFederalHoliday(now = new Date()) {
  const today = startOfLocalDay(now);
  return [
    ...federalHolidaysForYear(today.getFullYear()),
    ...federalHolidaysForYear(today.getFullYear() + 1)
  ]
    .filter((holiday) => holiday.date >= today)
    .sort((left, right) => left.date - right.date)[0];
}

export function eventOccupiesDate(event, dateKey) {
  const dayStart = parseLocalDateKey(dateKey);
  if (!dayStart) return false;

  if (event?.allDay === true) {
    return typeof event.startDate === "string"
      && typeof event.endDateExclusive === "string"
      && event.startDate <= dateKey
      && dateKey < event.endDateExclusive;
  }

  const eventStart = new Date(event?.start);
  const eventEnd = new Date(event?.end);
  if (
    !Number.isFinite(eventStart.getTime())
    || !Number.isFinite(eventEnd.getTime())
    || eventEnd <= eventStart
  ) {
    return false;
  }

  const dayEnd = addLocalDays(dayStart, 1);
  return eventStart < dayEnd && eventEnd > dayStart;
}

export function eventsForDate(events, dateKey) {
  return Array.isArray(events)
    ? events.filter((event) => eventOccupiesDate(event, dateKey))
    : [];
}

function upcomingEventCandidate(event, now, originalIndex) {
  const today = startOfLocalDay(now);
  const todayKey = localDateKey(today);
  let sortStart;
  let targetDate;

  if (event?.allDay === true) {
    const startDate = parseLocalDateKey(event.startDate);
    const endDate = parseLocalDateKey(event.endDateExclusive);
    if (
      !startDate
      || !endDate
      || event.endDateExclusive <= event.startDate
      || event.endDateExclusive <= todayKey
    ) {
      return null;
    }

    sortStart = startDate;
    targetDate = event.startDate <= todayKey ? today : startDate;
  } else {
    const start = new Date(event?.start);
    const end = new Date(event?.end);
    if (
      !Number.isFinite(start.getTime())
      || !Number.isFinite(end.getTime())
      || end <= now
      || end <= start
    ) {
      return null;
    }

    sortStart = start;
    targetDate = start <= now ? today : startOfLocalDay(start);
  }

  if (calendarDayDifference(targetDate, today) > PROGRESS_DAYS) return null;

  return {
    event,
    originalIndex,
    sortStart,
    targetDate,
    feedOrder: Number.isFinite(event.feedOrder)
      ? event.feedOrder
      : Number.MAX_SAFE_INTEGER
  };
}

export function nextCalendarEvent(events, now = new Date()) {
  if (!Array.isArray(events)) return null;

  const candidate = events
    .map((event, originalIndex) => upcomingEventCandidate(event, now, originalIndex))
    .filter(Boolean)
    .sort((left, right) => (
      left.sortStart - right.sortStart
      || left.feedOrder - right.feedOrder
      || left.originalIndex - right.originalIndex
    ))[0];

  return candidate
    ? { event: candidate.event, targetDate: candidate.targetDate }
    : null;
}

function eventFeedOrder(event) {
  return Number.isFinite(event?.feedOrder)
    ? event.feedOrder
    : Number.MAX_SAFE_INTEGER;
}

export function sortEventsForDate(events, dateKey) {
  const dayStart = parseLocalDateKey(dateKey);
  if (!dayStart) return [];

  return eventsForDate(events, dateKey)
    .map((event, originalIndex) => ({ event, originalIndex }))
    .sort((left, right) => {
      if (left.event.allDay !== right.event.allDay) {
        return left.event.allDay ? -1 : 1;
      }
      if (!left.event.allDay) {
        const leftStart = Math.max(new Date(left.event.start).getTime(), dayStart.getTime());
        const rightStart = Math.max(new Date(right.event.start).getTime(), dayStart.getTime());
        const startDifference = leftStart - rightStart;
        if (startDifference !== 0) return startDifference;
      }
      return eventFeedOrder(left.event) - eventFeedOrder(right.event)
        || left.originalIndex - right.originalIndex;
    })
    .map(({ event }) => event);
}

function formatLocalTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(date);
}

export function formatEventTimeRange(event, dateKey) {
  if (event?.allDay === true) return "All day";

  const dayStart = parseLocalDateKey(dateKey);
  const eventStart = new Date(event?.start);
  const eventEnd = new Date(event?.end);
  if (
    !dayStart
    || !Number.isFinite(eventStart.getTime())
    || !Number.isFinite(eventEnd.getTime())
  ) {
    return "";
  }

  const dayEnd = addLocalDays(dayStart, 1);
  const startsBeforeDay = eventStart < dayStart;
  const endsAfterDay = eventEnd > dayEnd;

  if (startsBeforeDay && endsAfterDay) return "All day (continues)";

  const startText = startsBeforeDay ? "midnight" : formatLocalTime(eventStart);
  const endText = eventEnd >= dayEnd ? "midnight" : formatLocalTime(eventEnd);
  return `${startText}–${endText}`;
}

export function formatSelectedDate(date) {
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric"
  }).format(date);
}

export function formatMonthHeading(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric"
  }).format(date);
}

export function buildMonthGrid(viewDate, today = new Date()) {
  const firstOfMonth = new Date(viewDate.getFullYear(), viewDate.getMonth(), 1);
  const gridStart = addLocalDays(firstOfMonth, -firstOfMonth.getDay());
  const todayKey = localDateKey(today);

  return Array.from({ length: CALENDAR_GRID_DAYS }, (_, index) => {
    const date = addLocalDays(gridStart, index);
    const dateKey = localDateKey(date);
    return {
      date,
      dateKey,
      dayNumber: date.getDate(),
      isCurrentMonth: date.getMonth() === viewDate.getMonth()
        && date.getFullYear() === viewDate.getFullYear(),
      isToday: dateKey === todayKey
    };
  });
}
