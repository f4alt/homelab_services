import { execFile } from "node:child_process";
import { Router } from "express";
import { CONFIG, hostIsAllowed } from "../config.js";
import { sendError, sendOk } from "../responses.js";

const router = Router();

function allowedPingTarget(raw) {
  const value = String(raw || "").trim();
  if (!value || /[\s/@]/.test(value)) {
    return false;
  }
  return hostIsAllowed(value, CONFIG.statusProbe.allowedHosts);
}

function pingOnce(target) {
  return new Promise((resolve, reject) => {
    execFile("fping", ["-C", "3", "-q", target], (err, stdout, stderr) => {
      const output = (stderr || stdout || "").trim();

      if (err && !output) {
        reject(err);
        return;
      }

      const parts = output.split(":");
      if (parts.length < 2) {
        resolve(null);
        return;
      }

      const samples = parts[1]
        .trim()
        .split(/\s+/)
        .filter((value) => value !== "-" && value !== "")
        .map((value) => Number.parseFloat(value))
        .filter((value) => Number.isFinite(value) && value <= 200)
        .sort((a, b) => a - b);

      if (!samples.length) {
        resolve(null);
        return;
      }

      const midpoint = Math.floor(samples.length / 2);
      const median = samples.length % 2 === 0
        ? (samples[midpoint - 1] + samples[midpoint]) / 2
        : samples[midpoint];

      resolve(median);
    });
  });
}

function runSpeedtestCli() {
  return new Promise((resolve, reject) => {
    execFile("speedtest-cli", ["--json"], { timeout: 180_000 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`speedtest-cli failed: ${err.message || err}\n${stderr || ""}`));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`Failed to parse speedtest-cli JSON: ${parseError}`));
      }
    });
  });
}

async function fetchJson(url, timeoutMs = CONFIG.upstreamTimeoutMs) {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const json = await response.json().catch(() => ({}));
  return { response, json };
}

let speedtestRunning = false;

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
  let target = CONFIG.pingTarget;
  if (req.query.target) {
    target = String(req.query.target).trim();
    if (!allowedPingTarget(target)) {
      return sendError(res, 400, "target_not_allowed", `Ping target "${target}" is not allowed.`);
    }
  }

  try {
    const ms = await pingOnce(target);
    return sendOk(res, { ok: true, target, ms });
  } catch (err) {
    return sendError(res, 500, "upstream_error", String(err?.message || err));
  }
});

router.get("/net/speedtest", async (_req, res) => {
  if (speedtestRunning) {
    return sendError(res, 429, "upstream_error", "speedtest already in progress");
  }

  speedtestRunning = true;
  try {
    const raw = await runSpeedtestCli();
    return sendOk(res, {
      ok: true,
      ping_ms: raw.ping,
      download_mbps: raw.download / 1e6,
      upload_mbps: raw.upload / 1e6,
      raw
    });
  } catch (err) {
    return sendError(res, 500, "upstream_error", String(err?.message || err));
  } finally {
    speedtestRunning = false;
  }
});

export default router;
