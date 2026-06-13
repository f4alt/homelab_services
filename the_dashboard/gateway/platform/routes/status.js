import { Router } from "express";
import { CONFIG } from "../config.js";
import { errorPayload, sendError, sendOk } from "../responses.js";

const router = Router();

function normalizeHost(hostname) {
  return String(hostname || "").trim().toLowerCase();
}

function hostMatchesPattern(hostname, pattern) {
  const host = normalizeHost(hostname);
  const rule = normalizeHost(pattern);

  if (!rule) return false;
  if (rule === "*") return true;
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix) && host.length > suffix.length;
  }
  if (rule.endsWith("*")) {
    return host.startsWith(rule.slice(0, -1));
  }
  return host === rule;
}

function allowedHost(hostname) {
  return CONFIG.statusProbe.allowedHosts.some((pattern) =>
    hostMatchesPattern(hostname, pattern)
  );
}

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

  const disallowed = candidates.find((url) => !allowedHost(url.hostname));
  if (disallowed) {
    return {
      ok: false,
      error: errorPayload("target_not_allowed", `Target host "${disallowed.hostname}" is not allowed.`)
    };
  }

  return { ok: true, candidates };
}

async function tryFetch(url) {
  const t0 = performance.now();
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(CONFIG.statusProbe.timeoutMs)
  });
  const t1 = performance.now();
  return { response, ms: Math.round(t1 - t0) };
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

async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await fn(items[index], index);
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
      async (target) => probeOne(String(target?.url || "").trim())
    );

    return sendOk(res, {
      count: results.length,
      results
    });
  } catch (err) {
    return sendError(res, 500, "internal_error", "Status checks failed.", {
      error: String(err?.message || err)
    });
  }
});

export default router;
