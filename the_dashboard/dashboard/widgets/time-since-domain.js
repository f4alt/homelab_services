const DAY_MS = 86_400_000;
const DEFAULT_APPROACHING_RATIO = 0.8;
const EXPLICIT_OFFSET_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;
const CLASSIFICATION_LABELS = Object.freeze({
  approaching: "Approaching",
  normal: "Normal",
  overdue: "Overdue",
  unknown: "Unknown"
});

function parseLastDone(value) {
  if (typeof value !== "string") return null;

  const match = EXPLICIT_OFFSET_TIMESTAMP.exec(value);
  if (!match) return null;

  const calendarDate = match[1];
  const calendarDateMs = Date.parse(`${calendarDate}T00:00:00Z`);
  if (
    !Number.isFinite(calendarDateMs) ||
    new Date(calendarDateMs).toISOString().slice(0, calendarDate.length) !== calendarDate
  ) {
    return null;
  }

  const timestampMs = Date.parse(value);
  return Number.isFinite(timestampMs) ? timestampMs : null;
}

function normalizeTargetDays(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeRequiredText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function classifyAge(elapsedMs, targetDays, approachingRatio) {
  if (targetDays === null) return "normal";

  const targetMs = targetDays * DAY_MS;
  if (elapsedMs >= targetMs) return "overdue";
  if (elapsedMs / targetMs >= approachingRatio) return "approaching";
  return "normal";
}

function buildTooltip(lastDone, targetDays, classification) {
  const target = targetDays === null
    ? "No target"
    : `Target: ${targetDays} ${targetDays === 1 ? "day" : "days"}`;
  return [
    `Last done: ${lastDone || "unknown"}`,
    target,
    CLASSIFICATION_LABELS[classification]
  ].join(" · ");
}

export function normalizeApproachingRatio(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 1
    ? value
    : DEFAULT_APPROACHING_RATIO;
}

export function normalizeTimeSinceItems(items) {
  if (!Array.isArray(items)) return [];

  const normalizedItems = [];
  for (const item of items) {
    const uid = normalizeRequiredText(item?.uid);
    const name = normalizeRequiredText(item?.name);
    const sourceFile = normalizeRequiredText(item?.source_file);
    if (!uid || !name || !sourceFile) continue;

    normalizedItems.push({
      uid,
      name,
      source_file: sourceFile,
      last_done: parseLastDone(item.last_done) === null ? null : item.last_done,
      target_days: normalizeTargetDays(item.target_days)
    });
  }

  return normalizedItems;
}

export function getTimeSincePresentation(item, nowMs, approachingRatio) {
  const lastDoneMs = parseLastDone(item?.last_done);
  const targetDays = normalizeTargetDays(item?.target_days);
  if (lastDoneMs === null) {
    return {
      days: null,
      ageToken: "?",
      agePhrase: "? days since",
      classification: "unknown",
      elapsedMs: null,
      lastDone: null,
      targetDays,
      tooltip: buildTooltip(null, targetDays, "unknown")
    };
  }

  const elapsedMs = Math.max(0, nowMs - lastDoneMs);
  const days = Math.floor(elapsedMs / DAY_MS);
  const classification = classifyAge(
    elapsedMs,
    targetDays,
    normalizeApproachingRatio(approachingRatio)
  );

  return {
    days,
    elapsedMs,
    ageToken: String(days),
    agePhrase: `${days} ${days === 1 ? "day" : "days"} since`,
    classification,
    lastDone: item.last_done,
    targetDays,
    tooltip: buildTooltip(item.last_done, targetDays, classification)
  };
}
