import {
  CONFIG,
  DOCKER_HOST_ALIAS,
  hostIsAllowed,
  hostIsLocal
} from "../platform/config.js";
import {
  attentionResult,
  STATUS_INDICATOR,
  statusResult
} from "./result.js";

const HTTP_SCHEME = "http";
const HTTP_SCHEMES = Object.freeze([HTTP_SCHEME, "https"]);
const EXPLICIT_HTTP_URL_PATTERN = /^https?:\/\//i;
const PASSING_STATUS_MINIMUM = 200;
const PASSING_STATUS_MAXIMUM = 399;

function asUrl(raw, scheme) {
  const value = String(raw || "").trim();
  if (!value || /[\s@]/.test(value)) return null;

  try {
    return new URL(EXPLICIT_HTTP_URL_PATTERN.test(value) ? value : `${scheme}://${value}`);
  } catch {
    return null;
  }
}

function normalizeCandidates(raw) {
  const value = String(raw || "").trim();

  if (EXPLICIT_HTTP_URL_PATTERN.test(value)) {
    const url = asUrl(value, HTTP_SCHEME);
    return url ? [url] : [];
  }

  return HTTP_SCHEMES.map((scheme) => asUrl(value, scheme)).filter(Boolean);
}

function validateUrl(raw, allowedHosts) {
  const candidates = normalizeCandidates(raw);
  if (!candidates.length) {
    return {
      detail: "URL must be a hostname, IP, or HTTP(S) URL.",
      candidates: []
    };
  }

  const disallowed = candidates.find((url) => (
    !hostIsLocal(url.hostname)
    && !hostIsAllowed(url.hostname, allowedHosts)
  ));
  if (disallowed) {
    return {
      detail: `Target host "${disallowed.hostname}" is not allowed.`,
      candidates: []
    };
  }

  return { detail: null, candidates };
}

function transportUrlFor(browserUrl) {
  const transportUrl = new URL(browserUrl);
  if (hostIsLocal(transportUrl.hostname)) {
    transportUrl.hostname = DOCKER_HOST_ALIAS;
  }
  return transportUrl;
}

function resultForResponse(response, latencyMs, browserUrl) {
  const passing = response.status >= PASSING_STATUS_MINIMUM
    && response.status <= PASSING_STATUS_MAXIMUM;

  return statusResult(
    passing ? STATUS_INDICATOR.PASSING : STATUS_INDICATOR.ATTENTION,
    `HTTP ${response.status} • ${latencyMs}ms`,
    browserUrl.toString()
  );
}

export function createHttpStatusProvider({
  allowedHosts = CONFIG.statusProbe.allowedHosts,
  fetchImpl = fetch,
  monotonicNow = () => performance.now(),
  signalForTimeout = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  timeoutMs = CONFIG.statusProbe.timeoutMs
} = {}) {
  async function check(providerConfig) {
    const validation = validateUrl(providerConfig?.url, allowedHosts);
    if (validation.detail) {
      return attentionResult(validation.detail);
    }

    for (const browserUrl of validation.candidates) {
      const transportUrl = transportUrlFor(browserUrl);
      const startedAt = monotonicNow();
      const signal = signalForTimeout(timeoutMs);
      let response;
      try {
        response = await fetchImpl(transportUrl, {
          method: "GET",
          redirect: "manual",
          signal
        });
      } catch {
        continue;
      }

      const latencyMs = Math.round(monotonicNow() - startedAt);
      return resultForResponse(response, latencyMs, browserUrl);
    }

    return attentionResult(
      "No response from target.",
      validation.candidates[0]?.toString() || null
    );
  }

  return Object.freeze({ check });
}
