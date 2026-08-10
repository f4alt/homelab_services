import { Router } from "express";
import { CONFIG, hostIsAllowed } from "../platform/config.js";
import {
  errorMessage,
  errorPayload,
  sendError,
  sendOk
} from "../platform/responses.js";

const router = Router();

function asUrl(raw, scheme) {
  const value = String(raw || "").trim();
  if (!value || /[\s@]/.test(value)) {
    return null;
  }

  try {
    return new URL(/^https?:\/\//i.test(value) ? value : `${scheme}://${value}`);
  } catch {
    return null;
  }
}

function normalizeCandidates(raw) {
  const value = String(raw || "").trim();

  if (/^https?:\/\//i.test(value)) {
    const url = asUrl(value, "http");
    return url ? [url] : [];
  }

  return [asUrl(value, "http"), asUrl(value, "https")].filter(Boolean);
}

function validateTarget(raw) {
  const candidates = normalizeCandidates(raw);

  if (!candidates.length) {
    return {
      ok: false,
      error: errorPayload("invalid_target", "Target must be a hostname, IP, or http(s) URL.")
    };
  }

  const disallowed = candidates.find((url) => (
    !hostIsAllowed(url.hostname, CONFIG.statusProbe.allowedHosts)
  ));
  if (disallowed) {
    return {
      ok: false,
      error: errorPayload("target_not_allowed", `Target host "${disallowed.hostname}" is not allowed.`)
    };
  }

  return { ok: true, candidates };
}

async function tryFetch(url) {
  const startedAt = performance.now();
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(CONFIG.statusProbe.timeoutMs)
  });
  const finishedAt = performance.now();
  return { response, ms: Math.round(finishedAt - startedAt) };
}

async function probeOne(raw) {
  const timestamp = new Date().toISOString();
  const validation = validateTarget(raw);

  if (!validation.ok) {
    return {
      ok: false,
      target: raw,
      error: validation.error,
      timestamp
    };
  }

  for (const url of validation.candidates) {
    try {
      const { response, ms } = await tryFetch(url);
      return {
        ok: true,
        target: raw,
        final_url: url.toString(),
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
}

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
      (target) => probeOne(String(target?.url || "").trim())
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
