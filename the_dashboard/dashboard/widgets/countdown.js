import { createStack, createTile, setStateMessage } from "../platform/global.js";

(function () {
  function ensureCountdownStyles() {
    if (document.getElementById("countdown-widget-styles")) return;
    const s = document.createElement("style");
    s.id = "countdown-widget-styles";
    s.textContent = `
    .countdown-tile {
      position: relative;
      box-shadow: 0 8px 24px rgba(var(--tile-shadow),.5);
      padding: 16px 14px 20px;
      display: flex;
      flex-direction: column;
      justify-content: flex-start;
    }

    .countdown-tile.cd-now {
      box-shadow:
        0 0 20px rgba(var(--ok-rgb), 0.5);
    }
    .countdown-tile.cd-overdue {
      box-shadow:
        0 0 20px rgba(var(--err-rgb), 0.5);
    }

    .cd-center-label {
      margin-bottom: 2px;
    }

    .cd-mode-hint {
      display: none;
      font-size: 11px;
      line-height: 1.2;
      font-weight: 500;
      text-transform: uppercase;
    }

    .cd-bottom {
      position: relative;
      min-width: 0;
    }

    .countdown-tile.cd-now .popup {
      border-color: rgba(var(--ok-rgb), 0.5);
      box-shadow:
        0 0 8px rgba(var(--ok-rgb), 0.1),
        0 10px 30px rgba(var(--ok-rgb), 0.3);
    }
    .countdown-tile.cd-overdue .popup {
      border-color: rgba(var(--err-rgb), 0.3);
      box-shadow:
        0 0 8px rgba(var(--err-rgb), 0.1),
        0 10px 30px rgba(var(--err-rgb), 0.5);
    }

    .countdown-tile .popup {
      bottom: 22px;
    }

    .cd-popup-target {
      --popup-transform: translateX(-50%);
    }
    `;
    document.head.appendChild(s);
  }

  const DAY_MS = 24 * 60 * 60 * 1000;
  const YEAR_DAYS = 365;

  function startOfDay(d) {
    return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0,0,0,0);
  }

  // recurring helper for MM/DD-style events:
  function nextOccurrenceOfMonthDay(mm, dd) {
    const now = new Date();
    const y = now.getFullYear();
    const cand = new Date(y, mm - 1, dd, 0,0,0,0);
    if (cand.getTime() >= startOfDay(now).getTime()) return cand;
    return new Date(y + 1, mm - 1, dd, 0,0,0,0);
  }

  function toDateObjFlexible(input) {
    if (input instanceof Date) {
      return isNaN(input) ? null : input;
    }

    if (typeof input === "string") {
      const trimmed = input.trim();

      // recurring MM/DD or MM-DD
      if (/^\d{2}[-/]\d{2}$/.test(trimmed)) {
        const [mm, dd] = trimmed.split(/[-/]/).map(n => parseInt(n,10));
        return nextOccurrenceOfMonthDay(mm, dd);
      }

      // ISO-ish or YYYY-MM-DD
      // If Date(...) can parse it, we accept it literally (even if it's in the past)
      {
        const d = new Date(trimmed);
        if (!isNaN(d)) {
          return d;
        }
      }

      // if still nothing, fail
      return null;
    }

    // object {month, day} => recurring
    if (typeof input === "object" && input && "month" in input && "day" in input) {
      const mm = parseInt(input.month, 10);
      const dd = parseInt(input.day, 10);
      return nextOccurrenceOfMonthDay(mm, dd);
    }

    return null;
  }

  // signed day difference target - now:
  //  >0 future, 0 today, <0 overdue
  function diffDaysSigned(target, now) {
    const ms = startOfDay(target) - startOfDay(now);
    if (ms === 0) return 0;
    return Math.round(ms / DAY_MS);
  }

  function etaStrings(daysDelta) {
    if (daysDelta === 0) {
      return { chipText: "TODAY", mode: "today" };
    }
    if (daysDelta > 0) {
      return {
        chipText: (daysDelta === 1 ? "in 1 day" : `in ${daysDelta} days`),
        mode: "future"
      };
    }
    const overdue = Math.abs(daysDelta);
    return {
      chipText: (overdue === 1 ? "1 day ago" : `${overdue} days ago`),
      mode: "overdue"
    };
  }

  function nthWeekdayOfMonth(year, monthIdx, weekday, n) {
    const d = new Date(year, monthIdx, 1);
    while (d.getDay() !== weekday) d.setDate(d.getDate() + 1);
    d.setDate(d.getDate() + (n - 1) * 7);
    return d;
  }

  function lastWeekdayOfMonth(year, monthIdx, weekday) {
    const d = new Date(year, monthIdx + 1, 0);
    while (d.getDay() !== weekday) d.setDate(d.getDate() - 1);
    return d;
  }

  function observedDate(dateObj) {
    const d = new Date(dateObj.getTime());
    const dow = d.getDay();
    if (dow === 6) { // Sat -> Fri
      const fri = new Date(d.getTime());
      fri.setDate(fri.getDate() - 1);
      return fri;
    }
    if (dow === 0) { // Sun -> Mon
      const mon = new Date(d.getTime());
      mon.setDate(mon.getDate() + 1);
      return mon;
    }
    return d;
  }

  function getFederalHolidaysForYear(year) {
    const list = [];
    { // New Year's Day
      const d = new Date(year, 0, 1);
      list.push({ label: "New Year’s Day", date: observedDate(d) });
    }
    list.push({
      label: "Martin Luther King Jr. Day",
      date: nthWeekdayOfMonth(year, 0, 1, 3)
    });
    list.push({
      label: "Washington’s Birthday",
      date: nthWeekdayOfMonth(year, 1, 1, 3)
    });
    list.push({
      label: "Memorial Day",
      date: lastWeekdayOfMonth(year, 4, 1)
    });
    {
      const d = new Date(year, 5, 19);
      list.push({ label: "Juneteenth", date: observedDate(d) });
    }
    {
      const d = new Date(year, 6, 4);
      list.push({ label: "Independence Day", date: observedDate(d) });
    }
    list.push({
      label: "Labor Day",
      date: nthWeekdayOfMonth(year, 8, 1, 1)
    });
    list.push({
      label: "Columbus Day",
      date: nthWeekdayOfMonth(year, 9, 1, 2)
    });
    {
      const d = new Date(year, 10, 11);
      list.push({ label: "Veterans Day", date: observedDate(d) });
    }
    list.push({
      label: "Thanksgiving Day",
      date: nthWeekdayOfMonth(year, 10, 4, 4)
    });
    {
      const d = new Date(year, 11, 25);
      list.push({ label: "Christmas Day", date: observedDate(d) });
    }
    return list;
  }

  // Return the next N *future-or-today* fed holidays as events {label,date}
  function upcomingFederalHolidays(opts) {
    const now = new Date();
    const y = now.getFullYear();
    const holidays = [
      ...getFederalHolidaysForYear(y),
      ...getFederalHolidaysForYear(y + 1)
    ];
    const fut = holidays
      .filter(h => startOfDay(h.date).getTime() >= startOfDay(now).getTime())
      .sort((a, b) => a.date - b.date);
    const n = Math.max(1, opts.federalCount || 1);
    return fut.slice(0, n);
  }

  // We want "most relevant right now" first.
  // rank:
  //   0 -> today
  //   1 -> future
  //   2 -> overdue
  //
  // absDays sorts within each rank:
  //   for future: sooner first
  //   for overdue: most recently missed first
  function distanceRank(dateObj, now) {
    const delta = diffDaysSigned(dateObj, now);
    if (delta === 0) {
      return { rank: 0, absDays: 0, delta };
    }
    if (delta > 0) {
      return { rank: 2, absDays: delta, delta };
    }
    return { rank: 1, absDays: Math.abs(delta), delta };
  }

  function createCountdownTile() {
    const card = createTile("countdown-tile popup-on-hover cd-popup-target");

    const centerLabel = document.createElement("div");
    centerLabel.className = "center-stack cd-center-label";

    const mainText = document.createElement("div");
    mainText.className = "label";
    mainText.textContent = "Event name";

    const modeHint = document.createElement("div");
    modeHint.className = "cd-mode-hint muted";
    modeHint.textContent = "IN 00 DAYS";

    centerLabel.appendChild(mainText);
    centerLabel.appendChild(modeHint);

    const bottom = document.createElement("div");
    bottom.className = "cd-bottom";

    const chipFloat = document.createElement("div");
    chipFloat.className = "popup";
    chipFloat.style.left = "50%";

    const chipText = document.createElement("div");
    chipText.className = "label";
    chipText.textContent = "in 00 days";
    chipFloat.appendChild(chipText);

    const barTrack = document.createElement("div");
    barTrack.className = "progress-track";

    const barFillFuture = document.createElement("div");
    barFillFuture.className = "progress-fill progress-fill--future";
    barFillFuture.style.width = "0%";

    const barFillOverdue = document.createElement("div");
    barFillOverdue.className = "progress-fill progress-fill--overdue";
    barFillOverdue.style.width = "0%";

    barTrack.appendChild(barFillFuture);
    barTrack.appendChild(barFillOverdue);

    bottom.appendChild(chipFloat);
    bottom.appendChild(barTrack);

    card.appendChild(centerLabel);
    card.appendChild(bottom);

    return {
      card,
      centerLabel,
      mainText,
      modeHint,
      bottom,
      chipFloat,
      chipText,
      barTrack,
      barFillFuture,
      barFillOverdue
    };
  }

  function updateCountdownTile(tile, eventDate, label, now) {
    const daysDelta = diffDaysSigned(eventDate, now); // >0 future, 0 today, <0 overdue
    const { chipText, mode } = etaStrings(daysDelta);

    const absDays = Math.abs(daysDelta);
    const cappedDays = Math.min(absDays, YEAR_DAYS);

    let pctFutureFill = 0;
    let pctOverdueFill = 0;
    let chipPct = 50;

    if (mode === "future") {
      // closer event => bigger fill from LEFT
      pctFutureFill = ((YEAR_DAYS - cappedDays) / YEAR_DAYS) * 100;
      pctFutureFill = Math.max(0, Math.min(100, pctFutureFill));
      chipPct = pctFutureFill;
    } else if (mode === "today") {
      pctFutureFill = 100;
      pctOverdueFill = 0;
      chipPct = 100;
    } else { // overdue
      // overdue => fill grows from RIGHT the longer it's late
      pctOverdueFill = (cappedDays / YEAR_DAYS) * 100;
      pctOverdueFill = Math.max(0, Math.min(100, pctOverdueFill));
      chipPct = 100 - pctOverdueFill;
    }

    const chipPctClamped = Math.min(95, Math.max(5, chipPct));
    tile.chipFloat.style.left = chipPctClamped + "%";

    tile.mainText.textContent = label;
    tile.chipText.textContent = chipText;
    tile.modeHint.textContent = chipText.toUpperCase();

    if (mode === "overdue") {
      tile.barFillFuture.style.width = "0%";
      tile.barFillOverdue.style.width = pctOverdueFill + "%";
    } else {
      tile.barFillFuture.style.width = pctFutureFill + "%";
      tile.barFillOverdue.style.width = "0%";
    }

    tile.card.classList.toggle("cd-now", mode === "today");
    tile.card.classList.toggle("cd-overdue", mode === "overdue");
  }

  function buildEventsFromProps(props) {
    const now = new Date();

    // all custom events stay, regardless of past/future
    const custom = Array.isArray(props?.events) ? props.events : [];
    const parsedCustom = custom.map(ev => {
      const d = toDateObjFlexible(ev.date);
      if (!d) return null;
      return { label: ev.label || "Event", date: d };
    }).filter(Boolean);

    // optional next N federal holidays
    const includeFederal = props?.includeFederal !== false;
    const fedCount = props?.federalCount ?? 1;
    const fedEvents = includeFederal
      ? upcomingFederalHolidays({ federalCount: fedCount }).map(h => ({
          label: h.label,
          date: h.date
        }))
      : [];

    // merge & dedupe by label|time
    const mergedMap = new Map();
    for (const ev of [...parsedCustom, ...fedEvents]) {
      const key = ev.label + "|" + ev.date.getTime();
      if (!mergedMap.has(key)) {
        mergedMap.set(key, ev);
      }
    }

    const merged = [...mergedMap.values()];

    // sort by relevance to now:
    //    today (rank0), then future soon, then overdue recent.
    merged.sort((a, b) => {
      const A = distanceRank(a.date, now);
      const B = distanceRank(b.date, now);
      if (A.rank !== B.rank) return A.rank - B.rank;
      if (A.absDays !== B.absDays) return A.absDays - B.absDays;
      return a.date - b.date;
    });

    return merged;
  }

  window.DASH.registerWidget("countdown", {
    mount(root, { props = {} }) {
      ensureCountdownStyles();

      const events = buildEventsFromProps(props);

      const wrap = createStack();
      root.replaceChildren(wrap);
      if (!events.length) {
        setStateMessage(wrap, "No countdowns configured.", "empty");
        return { wrap, tiles: [], lastTickMin: -1 };
      }

      const tiles = [];
      for (const ev of events) {
        const dom = createCountdownTile();
        wrap.appendChild(dom.card);
        tiles.push({
          ...dom,
          evDate: ev.date,
          evLabel: ev.label
        });
      }

      return {
        wrap,
        tiles,
        lastTickMin: -1
      };
    },

    update(state) {
      const now = new Date();

      // throttle to once per minute
      const uniqueMinuteKey =
        now.getUTCFullYear()   * 525600 +
        now.getUTCMonth()      * 43200  +
        now.getUTCDate()       * 1440   +
        now.getUTCHours()      * 60     +
        now.getUTCMinutes();

      if (state.lastTickMin === uniqueMinuteKey)
        return;
      state.lastTickMin = uniqueMinuteKey;

      for (const t of state.tiles) {
        updateCountdownTile(t, t.evDate, t.evLabel, now);
      }
    }
  });
})();
