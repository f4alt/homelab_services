export const STATUS_INDICATOR = Object.freeze({
  PASSING: "passing",
  ATTENTION: "attention",
  OTHER: "other"
});

const VALID_INDICATORS = new Set(Object.values(STATUS_INDICATOR));

export function isStatusIndicator(value) {
  return VALID_INDICATORS.has(value);
}

export function statusResult(indicator, detail, href = null) {
  return { indicator, detail, href };
}

export function attentionResult(detail, href = null) {
  return statusResult(STATUS_INDICATOR.ATTENTION, detail, href);
}
