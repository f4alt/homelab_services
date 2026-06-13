import express from "express";
import { execFile } from "node:child_process";

const app = express();

const PORT = 4000;
// Default ping target – can override via env
const PING_TARGET = process.env.PING_TARGET || "8.8.8.8";

// ---------- helpers ----------

function pingOnce(target = PING_TARGET) {
  return new Promise((resolve, reject) => {
    // -C 3 = 3 pings, -q = quiet summary
    execFile("fping", ["-C", "3", "-q", target], (err, stdout, stderr) => {
      const out = (stderr || stdout || "").trim();

      if (err && !out) {
        // True execution error (binary missing, no permissions, etc.)
        return reject(err);
      }

      // Example fping output:
      //   "8.8.8.8 : 23.5 25.2 -"
      const parts = out.split(":");
      if (parts.length < 2) {
        return resolve(null); // treat weird output as no sample
      }

      const samples = parts[1]
        .trim()
        .split(/\s+/)
        .filter(v => v !== "-" && v !== "")       // remove loss markers
        .map(v => parseFloat(v))
        .filter(ms => Number.isFinite(ms))
        .filter(ms => ms <= 200);                 // drop spikes > 200ms

      if (samples.length === 0) {
        return resolve(null); // all invalid, no sample
      }

      // Median smoothing
      samples.sort((a, b) => a - b);
      const mid = Math.floor(samples.length / 2);
      const median =
        samples.length % 2 === 0
          ? (samples[mid - 1] + samples[mid]) / 2
          : samples[mid];

      resolve(median);
    });
  });
}

let speedtestRunning = false;

function runSpeedtestCli() {
  return new Promise((resolve, reject) => {
    execFile(
      "speedtest-cli",
      ["--json"],
      { timeout: 180_000 }, // 3 min safety timeout
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new Error(
              `speedtest-cli failed: ${err.message || err}\n${stderr || ""}`
            )
          );
        }
        try {
          const data = JSON.parse(stdout);
          resolve(data);
        } catch (e) {
          reject(new Error(`Failed to parse speedtest-cli JSON: ${e}`));
        }
      }
    );
  });
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "netstats",
    speedtest_running: speedtestRunning
  });
});


// Lightweight ping
app.get("/net/ping", async (req, res) => {
  try {
    const target = typeof req.query.target === "string" && req.query.target.trim()
      ? req.query.target.trim()
      : PING_TARGET;

    const ms = await pingOnce(target);
    res.json({ ok: true, target, ms });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
});

// Heavy speed test (on-demand)
app.get("/net/speedtest", async (_req, res) => {
  if (speedtestRunning) {
    return res
      .status(429)
      .json({ ok: false, error: "speedtest already in progress" });
  }

  speedtestRunning = true;
  try {
    const raw = await runSpeedtestCli();

    // speedtest-cli JSON usually has:
    //   download: bits per second
    //   upload: bits per second
    //   ping: ms
    const downloadBps = raw.download;
    const uploadBps = raw.upload;
    const pingMs = raw.ping;

    const downloadMbps = downloadBps / 1e6;
    const uploadMbps = uploadBps / 1e6;

    res.json({
      ok: true,
      ping_ms: pingMs,
      download_mbps: downloadMbps,
      upload_mbps: uploadMbps,
      raw
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err.message || err) });
  } finally {
    speedtestRunning = false;
  }
});

app.listen(PORT, () => {
  console.log(`[netstats] running on ${PORT}`);
});
