import {
  createElement,
  createTile,
  createWidgetMessage,
  fetchJson,
  installWidgetStyles,
  setStateMessage
} from "../platform/global.js";
import {
  addLocalDays,
  buildMonthGrid,
  CALENDAR_GRID_DAYS,
  countdownState,
  eventsForDate,
  formatEventTimeRange,
  formatMonthHeading,
  formatSelectedDate,
  nextCalendarEvent,
  nextFederalHoliday,
  parseLocalDateKey,
  sortEventsForDate
} from "./calendar-domain.js";

const CALENDAR_STYLE_ID = "calendar-widget-styles";
const SEARCH_DAYS = 366;
const MAX_FEED_URL_LENGTH = 2048;
const WEEKDAY_LABELS = Object.freeze(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]);

const CALENDAR_STYLES = `
    .calendar-widget {
      --calendar-cell-gap: var(--space-xs);
      --calendar-cell-height: 34px;
      --tile-padding: var(--space-comfortable);
      display: flex;
      flex-direction: column;
      gap: var(--gap);
    }

    .calendar-heading {
      font-size: 16px;
      line-height: 1.2;
      margin: 0;
      text-align: center;
    }

    .calendar-weekdays,
    .calendar-days {
      display: grid;
      gap: var(--calendar-cell-gap);
      grid-template-columns: repeat(7, minmax(0, 1fr));
    }

    .calendar-weekday {
      color: var(--muted);
      font-size: 11px;
      font-weight: 600;
      line-height: 1;
      padding: var(--space-hairline) 0;
      text-align: center;
    }

    .calendar-day {
      align-items: center;
      appearance: none;
      background: transparent;
      border: 1px solid transparent;
      border-radius: var(--radius);
      color: var(--fg);
      cursor: pointer;
      display: flex;
      flex-direction: column;
      font: inherit;
      gap: var(--space-hairline);
      height: var(--calendar-cell-height);
      justify-content: center;
      min-width: 0;
      padding: var(--space-hairline);
    }

    .calendar-day:hover {
      background: rgba(var(--ok-rgb), .08);
      border-color: var(--card-border);
    }

    .calendar-day:focus-visible {
      outline: 2px solid var(--ok);
      outline-offset: 1px;
    }

    .calendar-day--spillover {
      color: var(--muted);
      opacity: .62;
    }

    .calendar-day--selected {
      background: rgba(var(--ok-rgb), .13);
      border-color: rgba(var(--ok-rgb), .55);
      opacity: 1;
    }

    .calendar-day-number {
      align-items: center;
      border: 1px solid transparent;
      border-radius: 50%;
      display: inline-flex;
      font-size: 12px;
      height: 22px;
      justify-content: center;
      line-height: 1;
      width: 22px;
    }

    .calendar-day--today .calendar-day-number {
      border-color: var(--ok);
      box-shadow: 0 0 8px rgba(var(--ok-rgb), .28);
    }

    .calendar-day-dot {
      background: var(--ok);
      border-radius: 50%;
      height: 4px;
      width: 4px;
    }

    .calendar-day-dot[hidden] {
      visibility: hidden;
    }

    .calendar-lower {
      display: flex;
      flex-direction: column;
      gap: var(--space-control);
      min-width: 0;
    }

    .calendar-countdown {
      display: flex;
      flex-direction: column;
      gap: 9px;
      min-width: 0;
      padding-top: 4px;
      position: relative;
    }

    .calendar-countdown-bottom {
      min-width: 0;
      position: relative;
    }

    .calendar-countdown .popup {
      bottom: 18px;
      --popup-transform: translateX(-50%);
    }

    .calendar-countdown--today .popup {
      border-color: rgba(var(--ok-rgb), .5);
      box-shadow: 0 10px 24px rgba(var(--ok-rgb), .25);
    }

    .calendar-countdown--overdue .popup {
      border-color: rgba(var(--err-rgb), .4);
      box-shadow: 0 10px 24px rgba(var(--err-rgb), .3);
    }

    .calendar-event-list {
      --list-max-height: 12rem;
      border-top: 1px solid var(--card-border);
      padding-top: 6px;
    }

    .calendar-event {
      display: flex;
      flex-direction: column;
      gap: var(--space-hairline);
      padding: 5px var(--space-hairline);
    }

    .calendar-event-title {
      overflow: visible;
      text-overflow: clip;
      white-space: normal;
    }

    .calendar-refresh-warning {
      font-size: 11px;
      line-height: 1.2;
      text-align: center;
    }

    @media (max-width: 420px) {
      .calendar-widget {
        --calendar-cell-gap: var(--space-hairline);
        --calendar-cell-height: 30px;
        --tile-padding: var(--space-control);
      }

      .calendar-day-number {
        font-size: 11px;
        height: 19px;
        width: 19px;
      }
    }
  `;

function normalizeFeedUrl(value) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source || source.length > MAX_FEED_URL_LENGTH) return null;

  try {
    const url = new URL(source.replace(/^webcal:\/\//i, "https://"));
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
      ? source
      : null;
  } catch {
    return null;
  }
}

function monthIdentity(date) {
  return `${date.getFullYear()}-${date.getMonth()}`;
}

function createDayButton() {
  const button = createElement("button", "calendar-day");
  button.type = "button";
  const number = createElement("span", "calendar-day-number");
  const dot = createElement("span", "calendar-day-dot");
  dot.hidden = true;
  button.append(number, dot);
  return { button, number, dot };
}

function createCountdownBar(label, targetDate = null) {
  const bar = createElement("div", "calendar-countdown popup-on-hover");
  bar.appendChild(createElement("div", "label", label));

  const bottom = createElement("div", "calendar-countdown-bottom");
  const track = createElement("div", "progress-track");
  const futureFill = createElement("div", "progress-fill progress-fill--future");
  const overdueFill = createElement("div", "progress-fill progress-fill--overdue");
  track.append(futureFill, overdueFill);

  if (targetDate) {
    const countdown = countdownState(targetDate);
    const chip = createElement("div", "popup");
    chip.style.left = `${countdown.chipPercent}%`;
    chip.appendChild(createElement("div", "label", countdown.chipText));
    bottom.appendChild(chip);
    futureFill.style.width = `${countdown.futurePercent}%`;
    overdueFill.style.width = `${countdown.overduePercent}%`;
    bar.classList.toggle("calendar-countdown--today", countdown.mode === "today");
    bar.classList.toggle("calendar-countdown--overdue", countdown.mode === "overdue");
  }

  bottom.appendChild(track);
  bar.appendChild(bottom);
  return bar;
}

function renderDefaultLower(state, now) {
  const holiday = nextFederalHoliday(now);
  const nextEvent = nextCalendarEvent(state.events, now);
  state.lower.appendChild(createCountdownBar(holiday.title, holiday.date));
  state.lower.appendChild(nextEvent
    ? createCountdownBar(nextEvent.event.title, nextEvent.targetDate)
    : createCountdownBar("No upcoming events"));
}

function renderSelectedLower(state) {
  const selectedDate = parseLocalDateKey(state.selectedDateKey);
  state.lower.appendChild(createCountdownBar(formatSelectedDate(selectedDate), selectedDate));

  const events = sortEventsForDate(state.events, state.selectedDateKey);
  if (events.length === 0) {
    state.lower.appendChild(createWidgetMessage("No events scheduled.", "muted"));
    return;
  }

  const list = createElement("div", "list-scroll calendar-event-list");
  for (const event of events) {
    const item = createElement("div", "calendar-event");
    item.append(
      createElement("div", "label calendar-event-title", event.title),
      createElement("div", "label-info", formatEventTimeRange(event, state.selectedDateKey))
    );
    list.appendChild(item);
  }
  state.lower.appendChild(list);
}

function renderLower(state, now = new Date()) {
  state.lower.classList.remove("is-loading", "is-empty", "is-error");
  state.lower.replaceChildren();
  if (state.selectedDateKey) renderSelectedLower(state);
  else renderDefaultLower(state, now);
}

function dayAccessibleName(day, hasEvents) {
  const dateName = formatSelectedDate(day.date);
  return hasEvents ? `${dateName}, has events` : dateName;
}

function renderGrid(state) {
  state.heading.textContent = formatMonthHeading(state.viewDate);

  state.days.forEach((day, index) => {
    const controls = state.dayButtons[index];
    const hasEvents = eventsForDate(state.events, day.dateKey).length > 0;
    const isSelected = state.selectedDateKey === day.dateKey;
    controls.number.textContent = String(day.dayNumber);
    controls.dot.hidden = !hasEvents;
    controls.button.className = "calendar-day";
    controls.button.classList.toggle("calendar-day--spillover", !day.isCurrentMonth);
    controls.button.classList.toggle("calendar-day--today", day.isToday);
    controls.button.classList.toggle("calendar-day--selected", isSelected);
    controls.button.setAttribute("aria-label", dayAccessibleName(day, hasEvents));
    controls.button.setAttribute("aria-pressed", String(isSelected));
  });
}

function syncCurrentMonth(state, now = new Date()) {
  const nextMonthIdentity = monthIdentity(now);
  if (state.monthIdentity !== nextMonthIdentity) {
    state.monthIdentity = nextMonthIdentity;
    state.selectedDateKey = null;
  }
  state.viewDate = now;
  state.days = buildMonthGrid(now, now);
  renderGrid(state);
  if (state.hasSuccessfulFetch) renderLower(state, now);
}

function calendarRequestUrl(state, now) {
  const rangeStart = state.days[0].date;
  const rangeEnd = addLocalDays(now, SEARCH_DAYS);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const query = new URLSearchParams({
    feedUrl: state.feedUrl,
    from: rangeStart.toISOString(),
    to: rangeEnd.toISOString(),
    timeZone
  });
  return `/calendar/events?${query.toString()}`;
}

window.DASH.registerWidget("calendar", {
  mount(root, { props = {} }) {
    installWidgetStyles(CALENDAR_STYLE_ID, CALENDAR_STYLES);

    const now = new Date();
    const tile = createTile("calendar-widget");
    const heading = createElement("h2", "calendar-heading label");
    const weekdays = createElement("div", "calendar-weekdays");
    WEEKDAY_LABELS.forEach((label) => (
      weekdays.appendChild(createElement("div", "calendar-weekday", label))
    ));
    const daysGrid = createElement("div", "calendar-days");
    const dayButtons = Array.from({ length: CALENDAR_GRID_DAYS }, createDayButton);
    dayButtons.forEach(({ button }) => daysGrid.appendChild(button));
    const lower = createElement("div", "calendar-lower");
    const warning = createElement(
      "div",
      "calendar-refresh-warning muted widget-status"
    );
    tile.append(heading, weekdays, daysGrid, lower, warning);
    root.replaceChildren(tile);

    const state = {
      heading,
      dayButtons,
      lower,
      warning,
      feedUrl: normalizeFeedUrl(props.feedUrl),
      monthIdentity: monthIdentity(now),
      viewDate: now,
      days: buildMonthGrid(now, now),
      events: [],
      selectedDateKey: null,
      hasSuccessfulFetch: false,
      aborter: null
    };

    dayButtons.forEach(({ button }, index) => {
      button.addEventListener("click", () => {
        const dateKey = state.days[index].dateKey;
        state.selectedDateKey = state.selectedDateKey === dateKey ? null : dateKey;
        renderGrid(state);
        if (state.hasSuccessfulFetch) renderLower(state);
      });
    });
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !state.selectedDateKey) return;
      state.selectedDateKey = null;
      renderGrid(state);
      if (state.hasSuccessfulFetch) renderLower(state);
    });

    renderGrid(state);
    if (state.feedUrl) setStateMessage(lower, "Loading calendar…", "loading");
    else setStateMessage(lower, "Calendar feed URL is invalid.", "error");
    return state;
  },

  async update(state) {
    const now = new Date();
    syncCurrentMonth(state, now);
    if (!state.feedUrl) return;

    state.aborter?.abort();
    const aborter = new AbortController();
    state.aborter = aborter;

    try {
      const data = await fetchJson(calendarRequestUrl(state, now), {
        fetchOptions: { signal: aborter.signal }
      });
      if (state.aborter !== aborter) return;

      state.events = Array.isArray(data?.events) ? data.events : [];
      state.hasSuccessfulFetch = true;
      state.warning.textContent = "";
      syncCurrentMonth(state, new Date());
    } catch {
      if (state.aborter !== aborter || aborter.signal.aborted) return;
      if (state.hasSuccessfulFetch) {
        state.warning.textContent = "Calendar refresh failed";
        syncCurrentMonth(state, new Date());
      } else {
        setStateMessage(state.lower, "Unable to load calendar.", "error");
      }
    } finally {
      if (state.aborter === aborter) state.aborter = null;
    }
  }
});
