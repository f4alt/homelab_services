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
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  const url = new URL(withProtocol);

  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    url.hostname = "host.docker.internal";
  }

  return url.toString().replace(/\/+$/, "");
}

function normalizeHost(hostname) {
  return String(hostname || "").trim().toLowerCase();
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
    upstreamTimeoutMs: parsePositiveInt(env, "GATEWAY_UPSTREAM_TIMEOUT_MS", 5000),
    statusProbe: {
      timeoutMs: parsePositiveInt(env, "STATUS_PROBE_TIMEOUT_MS", 5000),
      maxTargets: parsePositiveInt(env, "STATUS_PROBE_MAX_TARGETS", 100),
      concurrency: parsePositiveInt(env, "STATUS_PROBE_CONCURRENCY", 10),
      allowedHosts: parseCsv(
        env,
        "STATUS_PROBE_ALLOWED_HOSTS",
        "localhost"
      )
    }
  };
}

export const CONFIG = readGatewayConfig();
