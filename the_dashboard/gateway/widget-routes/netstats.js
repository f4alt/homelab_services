import { execFile } from "node:child_process";
import { Router } from "express";
import { CONFIG, hostIsAllowed } from "../platform/config.js";
import { errorMessage, sendError, sendOk } from "../platform/responses.js";

const router = Router();
const BITS_PER_MEGABIT = 1_000_000;
const FPING_SAMPLE_COUNT = 3;
const MAX_PING_SAMPLE_MS = 200;
const PUBLIC_IP_API_URL = "https://api.ipify.org?format=json";
const SPEEDTEST_TIMEOUT_MS = 180_000;

function allowedPingTarget(raw) {
  const value = String(raw || "").trim();
  if (!value || /[\s/@]/.test(value)) {
    return false;
  }
  return hostIsAllowed(value, CONFIG.statusProbe.allowedHosts);
}

function pingOnce(target) {
  return new Promise((resolve, reject) => {
    execFile(
      "fping",
      ["-C", String(FPING_SAMPLE_COUNT), "-q", target],
      (error, stdout, stderr) => {
        const output = (stderr || stdout || "").trim();

        if (error && !output) {
          reject(error);
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
          .filter((value) => Number.isFinite(value) && value <= MAX_PING_SAMPLE_MS)
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
      }
    );
  });
}

function runSpeedtestCli() {
  return new Promise((resolve, reject) => {
    execFile(
      "speedtest-cli",
      ["--json"],
      { timeout: SPEEDTEST_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`speedtest-cli failed: ${errorMessage(error)}\n${stderr || ""}`));
          return;
        }

        try {
          resolve(JSON.parse(stdout));
        } catch (parseError) {
          reject(new Error(`Failed to parse speedtest-cli JSON: ${parseError}`));
        }
      }
    );
  });
}

let speedtestRunning = false;

router.get("/net/myip", async (_req, res) => {
  try {
    const response = await fetch(PUBLIC_IP_API_URL, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CONFIG.upstreamTimeoutMs)
    });
    const json = await response.json().catch(() => ({}));

    if (!response.ok) {
      return sendError(res, 502, "upstream_error", "Public IP lookup failed.", {
        status: response.status
      });
    }

    return sendOk(res, { ip: json.ip || null });
  } catch (error) {
    return sendError(res, 502, "upstream_unreachable", "Public IP lookup was unreachable.", {
      error: errorMessage(error)
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
    return sendOk(res, { target, ms });
  } catch (error) {
    return sendError(res, 500, "upstream_error", errorMessage(error));
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
      ping_ms: raw.ping,
      download_mbps: raw.download / BITS_PER_MEGABIT,
      upload_mbps: raw.upload / BITS_PER_MEGABIT,
      raw
    });
  } catch (error) {
    return sendError(res, 500, "upstream_error", errorMessage(error));
  } finally {
    speedtestRunning = false;
  }
});

export default router;
