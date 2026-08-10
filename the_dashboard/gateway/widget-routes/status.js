import { Router } from "express";
import {
  CONFIG,
  DOCKER_HOST_ALIAS,
  hostIsAllowed,
  hostIsLocal
} from "../platform/config.js";
import {
  errorMessage,
  errorPayload,
  sendError,
  sendOk
} from "../platform/responses.js";

const router = Router();
const HTTP_SCHEME = "http";
const HTTP_SCHEMES = Object.freeze([HTTP_SCHEME, "https"]);
const EXPLICIT_HTTP_URL_PATTERN = /^https?:\/\//i;

function asUrl(raw, scheme) {
  const value = String(raw || "").trim();
  if (!value || /[\s@]/.test(value)) {
    return null;
  }

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

function validateTarget(raw, allowedHosts) {
  const candidates = normalizeCandidates(raw);

  if (!candidates.length) {
    return {
      ok: false,
      error: errorPayload("invalid_target", "Target must be a hostname, IP, or http(s) URL.")
    };
  }

  const disallowed = candidates.find((url) => (
    !hostIsLocal(url.hostname)
    && !hostIsAllowed(url.hostname, allowedHosts)
  ));
  if (disallowed) {
    return {
      ok: false,
      error: errorPayload("target_not_allowed", `Target host "${disallowed.hostname}" is not allowed.`)
    };
  }

  return { ok: true, candidates };
}

function probeTransportUrl(browserUrl) {
  const transportUrl = new URL(browserUrl);
  if (hostIsLocal(transportUrl.hostname)) {
    transportUrl.hostname = DOCKER_HOST_ALIAS;
  }
  return transportUrl;
}

async function tryFetch(url, {
  fetchImpl,
  monotonicNow,
  signalForTimeout,
  timeoutMs
}) {
  const startedAt = monotonicNow();
  const response = await fetchImpl(url, {
    method: "GET",
    redirect: "manual",
    signal: signalForTimeout(timeoutMs)
  });
  const finishedAt = monotonicNow();
  return { response, ms: Math.round(finishedAt - startedAt) };
}

export function createStatusProbe({
  allowedHosts = CONFIG.statusProbe.allowedHosts,
  fetchImpl = fetch,
  monotonicNow = () => performance.now(),
  now = () => new Date(),
  signalForTimeout = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  timeoutMs = CONFIG.statusProbe.timeoutMs
} = {}) {
  return async function probe(raw) {
    const timestamp = now().toISOString();
    const validation = validateTarget(raw, allowedHosts);

    if (!validation.ok) {
      return {
        ok: false,
        target: raw,
        error: validation.error,
        timestamp
      };
    }

    for (const browserUrl of validation.candidates) {
      try {
        const transportUrl = probeTransportUrl(browserUrl);
        const { response, ms } = await tryFetch(transportUrl, {
          fetchImpl,
          monotonicNow,
          signalForTimeout,
          timeoutMs
        });
        return {
          ok: true,
          target: raw,
          final_url: browserUrl.toString(),
          status: response.status,
          latency_ms: ms,
          timestamp
        };
      } catch {
        continue;
      }
    }

    return {
      ok: false,
      target: raw,
      error: errorPayload("no_response", "No response from target."),
      timestamp
    };
  };
}

const probeStatus = createStatusProbe();

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker()
  );
  await Promise.all(workers);

  return results;
}

router.post("/statuschecks", async (req, res) => {
  try {
    const targets = Array.isArray(req.body?.targets) ? req.body.targets : [];
    if (!targets.length) {
      return sendError(res, 400, "validation_error", "No targets provided.");
    }

    if (targets.length > CONFIG.statusProbe.maxTargets) {
      return sendError(
        res,
        400,
        "validation_error",
        `Too many targets. Maximum is ${CONFIG.statusProbe.maxTargets}.`
      );
    }

    const results = await mapWithConcurrency(
      targets,
      CONFIG.statusProbe.concurrency,
      (target) => probeStatus(String(target?.url || "").trim())
    );

    return sendOk(res, {
      count: results.length,
      results
    });
  } catch (error) {
    return sendError(res, 500, "internal_error", "Status checks failed.", {
      error: errorMessage(error)
    });
  }
});

export default router;
