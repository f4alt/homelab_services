import assert from "node:assert/strict";
import test from "node:test";

import {
  createGitHubActionsStatusProvider
} from "../gateway/status-providers/github-actions.js";

const API_BASE_URL = "https://api.github.test";
const REPOSITORY = "BRL-CAD/brlcad";
const RUN_URL = "https://github.com/BRL-CAD/brlcad/actions/runs/42";

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    async json() {
      return body;
    }
  };
}

test("GitHub Actions checks discover the default branch and map success to passing", async () => {
  const requests = [];
  const responses = [
    jsonResponse({ default_branch: "main" }),
    jsonResponse({
      workflow_runs: [{
        status: "completed",
        conclusion: "success",
        html_url: RUN_URL
      }]
    })
  ];
  const provider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return responses.shift();
    },
    signalForTimeout: () => "timeout-signal",
    timeoutMs: 5_000,
    token: ""
  });

  const result = await provider.check({
    repository: REPOSITORY,
    workflow: "push.yml"
  });

  assert.deepEqual(result, {
    indicator: "passing",
    detail: "Workflow passed.",
    href: RUN_URL
  });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].url, `${API_BASE_URL}/repos/BRL-CAD/brlcad`);

  const runsUrl = new URL(requests[1].url);
  assert.equal(runsUrl.pathname, "/repos/BRL-CAD/brlcad/actions/workflows/push.yml/runs");
  assert.equal(runsUrl.searchParams.get("branch"), "main");
  assert.equal(runsUrl.searchParams.get("per_page"), "1");
  assert.equal(runsUrl.searchParams.get("exclude_pull_requests"), "true");
  assert.equal(runsUrl.searchParams.has("event"), false);
  assert.equal(requests[1].options.headers.Authorization, undefined);
  assert.equal(requests[1].options.signal, "timeout-signal");
});

test("GitHub Actions checks distinguish active, failed, and other completed runs", async () => {
  const scenarios = [
    ["queued", null, "other", "Workflow queued."],
    ["requested", null, "other", "Workflow requested."],
    ["waiting", null, "other", "Workflow waiting."],
    ["pending", null, "other", "Workflow pending."],
    ["in_progress", null, "other", "Workflow in progress."],
    ["completed", "failure", "attention", "Workflow failed."],
    ["completed", "timed_out", "attention", "Workflow timed out."],
    ["completed", "action_required", "attention", "Workflow needs attention."],
    ["completed", "cancelled", "other", "Workflow cancelled."],
    ["completed", "neutral", "other", "Workflow completed neutrally."],
    ["completed", "skipped", "other", "Workflow skipped."],
    ["completed", "stale", "other", "Workflow became stale."]
  ];

  for (const [status, conclusion, indicator, detail] of scenarios) {
    const provider = createGitHubActionsStatusProvider({
      apiBaseUrl: API_BASE_URL,
      fetchImpl: async () => jsonResponse({
        workflow_runs: [{ status, conclusion, html_url: RUN_URL }]
      })
    });

    assert.deepEqual(await provider.check({
      repository: REPOSITORY,
      workflow: "push.yml",
      branch: "main"
    }), { indicator, detail, href: RUN_URL });
  }
});

test("GitHub Actions checks treat no matching run as a legitimate other state", async () => {
  const provider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async () => jsonResponse({ workflow_runs: [] })
  });

  assert.deepEqual(await provider.check({
    repository: REPOSITORY,
    workflow: "push.yml",
    branch: "main"
  }), {
    indicator: "other",
    detail: "No matching workflow run.",
    href: "https://github.com/BRL-CAD/brlcad/actions"
  });
});

test("GitHub Actions checks preserve a valid status when a run has no destination", async () => {
  const provider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async () => jsonResponse({
      workflow_runs: [{ status: "completed", conclusion: "success" }]
    })
  });

  assert.deepEqual(await provider.check({
    repository: REPOSITORY,
    workflow: "push.yml",
    branch: "main"
  }), {
    indicator: "passing",
    detail: "Workflow passed.",
    href: null
  });
});

test("GitHub Actions checks apply optional event filters and authorization", async () => {
  const requests = [];
  const token = "test-token";
  const provider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return jsonResponse({ workflow_runs: [] });
    },
    token
  });

  const result = await provider.check({
    repository: REPOSITORY,
    workflow: "push.yml",
    branch: "main",
    event: "push"
  });

  assert.equal(requests.length, 1);
  assert.equal(new URL(requests[0].url).searchParams.get("event"), "push");
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${token}`);
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("GitHub Actions checks cache runs and retain default-branch metadata longer", async () => {
  let currentTime = 0;
  let requestCount = 0;
  const provider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    defaultBranchCacheMs: 10_000,
    fetchImpl: async (url) => {
      requestCount += 1;
      return url.pathname.endsWith("/brlcad")
        ? jsonResponse({ default_branch: "main" })
        : jsonResponse({
          workflow_runs: [{
            status: "completed",
            conclusion: "success",
            html_url: RUN_URL
          }]
        });
    },
    now: () => currentTime,
    runCacheMs: 1_000
  });
  const config = { repository: REPOSITORY, workflow: "push.yml" };

  await provider.check(config);
  assert.equal(requestCount, 2);

  currentTime = 999;
  await provider.check(config);
  assert.equal(requestCount, 2);

  currentTime = 1_001;
  await provider.check(config);
  assert.equal(requestCount, 3);

  currentTime = 10_001;
  await provider.check(config);
  assert.equal(requestCount, 5);
});

test("GitHub Actions checks map configuration and upstream errors to attention", async () => {
  const scenarios = [
    {
      config: { repository: "invalid", workflow: "push.yml", branch: "main" },
      fetchImpl: async () => { throw new Error("must not fetch"); },
      detail: "Repository must use the owner/repo format."
    },
    {
      config: { repository: REPOSITORY, workflow: "push.yml", branch: "main" },
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 401 }),
      detail: "GitHub request failed (HTTP 401)."
    },
    {
      config: { repository: REPOSITORY, workflow: "push.yml", branch: "main" },
      fetchImpl: async () => jsonResponse({}, { ok: false, status: 403 }),
      detail: "GitHub request failed (HTTP 403)."
    },
    {
      config: { repository: REPOSITORY, workflow: "push.yml", branch: "main" },
      fetchImpl: async () => { throw new Error("network detail"); },
      detail: "GitHub request failed."
    },
    {
      config: { repository: REPOSITORY, workflow: "push.yml", branch: "main" },
      fetchImpl: async () => jsonResponse({ unexpected: true }),
      detail: "GitHub returned malformed workflow data."
    }
  ];

  for (const { config, fetchImpl, detail } of scenarios) {
    const provider = createGitHubActionsStatusProvider({
      apiBaseUrl: API_BASE_URL,
      fetchImpl
    });
    assert.deepEqual(await provider.check(config), {
      indicator: "attention",
      detail,
      href: null
    });
  }
});

test("GitHub Actions checks do not misreport local processing errors as upstream failures", async () => {
  const provider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async () => jsonResponse({
      workflow_runs: [{
        status: "completed",
        conclusion: "success",
        html_url: RUN_URL
      }]
    }),
    now() {
      throw new Error("clock failed");
    }
  });

  await assert.rejects(provider.check({
    repository: REPOSITORY,
    workflow: "push.yml",
    branch: "main"
  }), /clock failed/);

  const signalProvider = createGitHubActionsStatusProvider({
    apiBaseUrl: API_BASE_URL,
    fetchImpl: async () => { throw new Error("must not fetch"); },
    signalForTimeout() {
      throw new Error("signal failed");
    }
  });
  await assert.rejects(signalProvider.check({
    repository: REPOSITORY,
    workflow: "push.yml",
    branch: "main"
  }), /signal failed/);
});
