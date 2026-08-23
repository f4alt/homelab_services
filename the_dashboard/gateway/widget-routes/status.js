import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { sendError, sendOk } from "../platform/responses.js";
import { createGitHubActionsStatusProvider } from "../status-providers/github-actions.js";
import { createHttpStatusProvider } from "../status-providers/http.js";
import {
  attentionResult,
  isStatusIndicator
} from "../status-providers/result.js";

const PROVIDER_FAILURE_DETAIL = "Status provider failed.";
const INVALID_RESULT_DETAIL = "Status provider returned an invalid result.";
const BATCH_TIMEOUT_DETAIL = "Status check timed out.";

function normalizedHref(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !value.trim()) return undefined;

  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeProviderResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return attentionResult(INVALID_RESULT_DETAIL);
  }

  const detail = typeof result.detail === "string" ? result.detail.trim() : "";
  const href = normalizedHref(result.href);
  if (!isStatusIndicator(result.indicator) || !detail || href === undefined) {
    return attentionResult(INVALID_RESULT_DETAIL);
  }

  return { indicator: result.indicator, detail, href };
}

async function evaluateProvider(providerConfig, providers) {
  if (!providerConfig || typeof providerConfig !== "object" || Array.isArray(providerConfig)) {
    return attentionResult("Provider configuration must be an object.");
  }

  const type = typeof providerConfig.type === "string"
    ? providerConfig.type.trim()
    : "";
  if (!type) return attentionResult("Provider type is required.");
  if (!Object.hasOwn(providers, type)) {
    return attentionResult(`Unknown status provider "${type}".`);
  }

  try {
    return normalizeProviderResult(await providers[type].check(providerConfig));
  } catch {
    return attentionResult(PROVIDER_FAILURE_DETAIL);
  }
}

async function mapWithConcurrency(items, concurrency, mapper, deadlineMs) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let deadlineReached = false;

  async function worker() {
    while (!deadlineReached && nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  const workerCount = Math.min(concurrency, items.length);
  const workers = Promise.all(Array.from({ length: workerCount }, () => worker()));
  let deadlineTimer;
  const deadline = new Promise((resolve) => {
    deadlineTimer = setTimeout(() => {
      deadlineReached = true;
      resolve(false);
    }, deadlineMs);
  });
  const completed = await Promise.race([workers.then(() => true), deadline]);
  if (completed) clearTimeout(deadlineTimer);

  return Array.from(
    { length: items.length },
    (_, index) => results[index] || attentionResult(BATCH_TIMEOUT_DETAIL)
  );
}

export function createStatusProviderRegistry() {
  return Object.freeze({
    http: createHttpStatusProvider(),
    "github-actions": createGitHubActionsStatusProvider()
  });
}

export function createStatusChecksHandler({
  batchDeadlineMs = CONFIG.statusChecks.batchDeadlineMs,
  concurrency = CONFIG.statusChecks.concurrency,
  maxChecks = CONFIG.statusChecks.maxChecks,
  providers = createStatusProviderRegistry()
} = {}) {
  return async function statusChecksHandler(req, res) {
    const providerConfigs = Array.isArray(req.body?.providers) ? req.body.providers : [];
    if (!providerConfigs.length) {
      return sendError(res, 400, "validation_error", "No status providers provided.");
    }

    if (providerConfigs.length > maxChecks) {
      return sendError(
        res,
        400,
        "validation_error",
        `Too many status providers. Maximum is ${maxChecks}.`
      );
    }

    try {
      const results = await mapWithConcurrency(
        providerConfigs,
        concurrency,
        (providerConfig) => evaluateProvider(providerConfig, providers),
        batchDeadlineMs
      );

      return sendOk(res, { count: results.length, results });
    } catch {
      return sendError(
        res,
        500,
        "internal_error",
        "Status checks could not be completed."
      );
    }
  };
}

const router = Router();
router.post("/statuschecks", createStatusChecksHandler());

export default router;
