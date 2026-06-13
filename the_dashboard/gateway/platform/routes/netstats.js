import { Router } from "express";
import { CONFIG } from "../config.js";
import { sendError, sendOk } from "../responses.js";

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

function allowedPingTarget(raw) {
  const value = String(raw || "").trim();
  if (!value || /[\s/@]/.test(value)) {
    return false;
  }
  return CONFIG.statusProbe.allowedHosts.some((pattern) =>
    hostMatchesPattern(value, pattern)
  );
}

async function fetchJson(url, timeoutMs = CONFIG.upstreamTimeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

router.get("/net/myip", async (_req, res) => {
  try {
    const { response, json } = await fetchJson("https://api.ipify.org?format=json");

    if (!response.ok) {
      return sendError(res, 502, "upstream_error", "Public IP lookup failed.", {
        status: response.status
      });
    }

    return sendOk(res, { ip: json.ip || null });
  } catch (err) {
    return sendError(res, 502, "upstream_unreachable", "Public IP lookup was unreachable.", {
      error: String(err?.message || err)
    });
  }
});

router.get("/net/ping", async (req, res) => {
  const url = new URL("/net/ping", CONFIG.netstatsBaseUrl);
  if (req.query.target) {
    const target = String(req.query.target).trim();
    if (!allowedPingTarget(target)) {
      return sendError(res, 400, "target_not_allowed", `Ping target "${target}" is not allowed.`);
    }
    url.searchParams.set("target", target);
  }
  try {
    const { response, json } = await fetchJson(url);
    if (!response.ok || json?.ok === false) {
      return sendError(res, response.status || 502, "upstream_error", json?.error || "Netstats ping failed.");
    }
    return sendOk(res, json);
  } catch (err) {
    return sendError(res, 502, "upstream_unreachable", "Netstats ping was unreachable.", {
      error: String(err?.message || err)
    });
  }
});

router.get("/net/speedtest", async (_req, res) => {
  const url = new URL("/net/speedtest", CONFIG.netstatsBaseUrl);
  try {
    const { response, json } = await fetchJson(url, 185000);
    if (!response.ok || json?.ok === false) {
      return sendError(res, response.status || 502, "upstream_error", json?.error || "Netstats speedtest failed.");
    }
    return sendOk(res, json);
  } catch (err) {
    return sendError(res, 502, "upstream_unreachable", "Netstats speedtest was unreachable.", {
      error: String(err?.message || err)
    });
  }
});

export default router;
