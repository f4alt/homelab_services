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

export function readGatewayConfig(env = process.env) {
  return {
    port: 3000,
    netstatsBaseUrl: "http://netstats:4000",
    todoBaseUrl: parseUrlBase(env, "TODO_API_BASE_URL", "http://host.docker.internal:5000"),
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
