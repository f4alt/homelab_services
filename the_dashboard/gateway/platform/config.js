export const DOCKER_HOST_ALIAS = "host.docker.internal";
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const MINUTE_MS = 60_000;
const GITHUB_RUN_CACHE_MS = 5 * MINUTE_MS;
const GITHUB_DEFAULT_BRANCH_CACHE_MS = 60 * MINUTE_MS;
const STATUS_BATCH_DEADLINE_MS = 90_000;

function parsePositiveInt(env, name, fallback) {
  const raw = env[name] ?? String(fallback);
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function parseCsv(env, name, fallback) {
  return String(env[name] ?? fallback)
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
}

function parseUrlBase(env, name, fallback) {
  const raw = String(env[name] || fallback).trim();
  if (!raw) return "";

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);

  if (hostIsLocal(url.hostname)) {
    url.hostname = DOCKER_HOST_ALIAS;
  }

  return url.toString().replace(/\/+$/, "");
}

function normalizeHost(hostname) {
  return String(hostname || "")
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
}

export function hostIsLocal(hostname) {
  return LOCAL_HOSTS.has(normalizeHost(hostname));
}

export function hostIsAllowed(hostname, patterns) {
  const host = normalizeHost(hostname);

  return patterns.some((pattern) => {
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
  });
}

function readGatewayConfig(env = process.env) {
  const upstreamTimeoutMs = parsePositiveInt(env, "GATEWAY_UPSTREAM_TIMEOUT_MS", 5000);
  const statusCheckConcurrency = parsePositiveInt(env, "STATUS_PROBE_CONCURRENCY", 10);
  const statusCheckMaximum = parsePositiveInt(env, "STATUS_PROBE_MAX_TARGETS", 100);

  return {
    port: 3000,
    pingTarget: env.PING_TARGET || "8.8.8.8",
    todoBaseUrl: parseUrlBase(env, "TODO_API_BASE_URL", "http://host.docker.internal:5000"),
    homeAssistant: {
      baseUrl: parseUrlBase(
        env,
        "HOME_ASSISTANT_BASE_URL",
        "http://host.docker.internal:8123"
      ),
      token: String(env.HOME_ASSISTANT_TOKEN || "").trim()
    },
    dashboardConfigPath: "/dashboard/config.js",
    dashboardConfigValidatorPath: "/dashboard/platform/config-validator.mjs",
    upstreamTimeoutMs,
    statusChecks: {
      batchDeadlineMs: STATUS_BATCH_DEADLINE_MS,
      concurrency: statusCheckConcurrency,
      maxChecks: statusCheckMaximum
    },
    githubActions: {
      apiBaseUrl: "https://api.github.com",
      token: String(env.GITHUB_TOKEN || "").trim(),
      timeoutMs: upstreamTimeoutMs,
      runCacheMs: GITHUB_RUN_CACHE_MS,
      defaultBranchCacheMs: GITHUB_DEFAULT_BRANCH_CACHE_MS
    },
    statusProbe: {
      timeoutMs: parsePositiveInt(env, "STATUS_PROBE_TIMEOUT_MS", 5000),
      allowedHosts: parseCsv(
        env,
        "STATUS_PROBE_ALLOWED_HOSTS",
        ""
      )
    }
  };
}

export const CONFIG = readGatewayConfig();
