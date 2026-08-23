import { CONFIG } from "../platform/config.js";
import {
  attentionResult,
  STATUS_INDICATOR,
  statusResult
} from "./result.js";

const ACCEPT_HEADER = "application/vnd.github+json";
const USER_AGENT = "homelab-dashboard";
const REPOSITORY_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const ACTIVE_RUN_DETAILS = new Map([
  ["queued", "Workflow queued."],
  ["requested", "Workflow requested."],
  ["waiting", "Workflow waiting."],
  ["pending", "Workflow pending."],
  ["in_progress", "Workflow in progress."]
]);
const ATTENTION_CONCLUSION_DETAILS = new Map([
  ["failure", "Workflow failed."],
  ["timed_out", "Workflow timed out."],
  ["action_required", "Workflow needs attention."]
]);
const OTHER_CONCLUSION_DETAILS = new Map([
  ["cancelled", "Workflow cancelled."],
  ["neutral", "Workflow completed neutrally."],
  ["skipped", "Workflow skipped."],
  ["stale", "Workflow became stale."]
]);

class GitHubStatusError extends Error {}

function nonEmptyOptionalString(value) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) return null;
  return value.trim();
}

function validateConfig(providerConfig) {
  const repository = typeof providerConfig?.repository === "string"
    ? providerConfig.repository.trim()
    : "";
  const workflow = typeof providerConfig?.workflow === "string"
    ? providerConfig.workflow.trim()
    : "";
  const branch = nonEmptyOptionalString(providerConfig?.branch);
  const event = nonEmptyOptionalString(providerConfig?.event);

  if (!REPOSITORY_PATTERN.test(repository)) {
    return { error: "Repository must use the owner/repo format." };
  }
  if (!workflow) return { error: "Workflow is required." };
  if (branch === null) return { error: "Branch must be a non-empty string." };
  if (event === null) return { error: "Event must be a non-empty string." };

  return { repository, workflow, branch, event, error: null };
}

function repositoryPath(repository) {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function resultForRun(run) {
  if (!run || typeof run !== "object" || Array.isArray(run)) {
    throw new GitHubStatusError("GitHub returned malformed workflow data.");
  }

  const href = typeof run.html_url === "string" ? run.html_url : null;
  const activeDetail = ACTIVE_RUN_DETAILS.get(run.status);
  if (activeDetail) {
    return statusResult(STATUS_INDICATOR.OTHER, activeDetail, href);
  }

  if (run.status !== "completed") {
    throw new GitHubStatusError("GitHub returned an unsupported workflow state.");
  }

  if (run.conclusion === "success") {
    return statusResult(STATUS_INDICATOR.PASSING, "Workflow passed.", href);
  }

  const attentionDetail = ATTENTION_CONCLUSION_DETAILS.get(run.conclusion);
  if (attentionDetail) {
    return attentionResult(attentionDetail, href);
  }

  const otherDetail = OTHER_CONCLUSION_DETAILS.get(run.conclusion);
  if (otherDetail) {
    return statusResult(STATUS_INDICATOR.OTHER, otherDetail, href);
  }

  throw new GitHubStatusError("GitHub returned an unsupported workflow state.");
}

export function createGitHubActionsStatusProvider({
  apiBaseUrl = CONFIG.githubActions.apiBaseUrl,
  defaultBranchCacheMs = CONFIG.githubActions.defaultBranchCacheMs,
  fetchImpl = fetch,
  now = Date.now,
  runCacheMs = CONFIG.githubActions.runCacheMs,
  signalForTimeout = (timeoutMs) => AbortSignal.timeout(timeoutMs),
  timeoutMs = CONFIG.githubActions.timeoutMs,
  token = CONFIG.githubActions.token
} = {}) {
  const defaultBranchCache = new Map();
  const runCache = new Map();
  const requestHeaders = {
    Accept: ACCEPT_HEADER,
    "User-Agent": USER_AGENT,
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  };

  async function requestJson(url) {
    const signal = signalForTimeout(timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        headers: requestHeaders,
        signal
      });
    } catch {
      throw new GitHubStatusError("GitHub request failed.");
    }

    if (!response.ok) {
      throw new GitHubStatusError(`GitHub request failed (HTTP ${response.status}).`);
    }

    try {
      return await response.json();
    } catch {
      throw new GitHubStatusError("GitHub returned malformed data.");
    }
  }

  function apiUrl(path) {
    return new URL(path, `${apiBaseUrl.replace(/\/+$/, "")}/`);
  }

  function cachedValue(cache, key) {
    const entry = cache.get(key);
    if (!entry || entry.expiresAt <= now()) {
      cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function cacheValue(cache, key, value, lifetimeMs) {
    cache.set(key, { value, expiresAt: now() + lifetimeMs });
    return value;
  }

  async function defaultBranch(repository) {
    const cached = cachedValue(defaultBranchCache, repository);
    if (cached !== undefined) return cached;

    const data = await requestJson(apiUrl(`repos/${repositoryPath(repository)}`));
    if (typeof data?.default_branch !== "string" || !data.default_branch.trim()) {
      throw new GitHubStatusError("GitHub returned malformed repository data.");
    }
    return cacheValue(
      defaultBranchCache,
      repository,
      data.default_branch.trim(),
      defaultBranchCacheMs
    );
  }

  async function check(providerConfig) {
    const config = validateConfig(providerConfig);
    if (config.error) return attentionResult(config.error);

    try {
      const branch = config.branch || await defaultBranch(config.repository);
      const runCacheKey = JSON.stringify([
        config.repository,
        config.workflow,
        branch,
        config.event || null
      ]);
      const cached = cachedValue(runCache, runCacheKey);
      if (cached !== undefined) return cached;

      const path = [
        "repos",
        repositoryPath(config.repository),
        "actions/workflows",
        encodeURIComponent(config.workflow),
        "runs"
      ].join("/");
      const url = apiUrl(path);
      url.searchParams.set("branch", branch);
      if (config.event) url.searchParams.set("event", config.event);
      url.searchParams.set("per_page", "1");
      url.searchParams.set("exclude_pull_requests", "true");

      const data = await requestJson(url);
      if (!Array.isArray(data?.workflow_runs)) {
        throw new GitHubStatusError("GitHub returned malformed workflow data.");
      }
      if (data.workflow_runs.length === 0) {
        return cacheValue(
          runCache,
          runCacheKey,
          statusResult(
            STATUS_INDICATOR.OTHER,
            "No matching workflow run.",
            `https://github.com/${config.repository}/actions`
          ),
          runCacheMs
        );
      }
      return cacheValue(
        runCache,
        runCacheKey,
        resultForRun(data.workflow_runs[0]),
        runCacheMs
      );
    } catch (error) {
      if (error instanceof GitHubStatusError) return attentionResult(error.message);
      throw error;
    }
  }

  return Object.freeze({ check });
}
