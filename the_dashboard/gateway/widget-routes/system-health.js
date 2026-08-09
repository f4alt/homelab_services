import { readFile, readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { sendError, sendOk } from "../platform/responses.js";

const CPU_SAMPLE_INTERVAL_MS = 100;
const CPU_STAT_IDLE_INDEX = 3;
const CPU_STAT_IO_WAIT_INDEX = 4;
const CPU_STAT_REQUIRED_TIME_FIELDS = 5;
const CPU_STAT_TIME_FIELDS = 8;
const CPU_SENSOR_NAMES = new Set([
  "acpitz",
  "coretemp",
  "cpu-thermal",
  "cpu_thermal",
  "k10temp",
  "zenpower"
]);
const MAX_CPU_TEMPERATURE_CELSIUS = 200;
const MILLIDEGREES_PER_DEGREE = 1000;
const MIN_CPU_TEMPERATURE_CELSIUS = -50;
const KIBIBYTE_BYTES = 1024;
const RECOGNIZED_CONTAINER_STATES = new Set([
  "exited",
  "paused",
  "restarting",
  "running"
]);
const PERCENT_SCALE = 100;
const SYSTEM_HEALTH_UPSTREAM_TIMEOUT_MS = 5000;

function roundToTenths(value) {
  return Math.round(value * 10) / 10;
}

function asPercentage(used, total) {
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) {
    throw new Error("Metric totals must be positive finite numbers.");
  }
  return roundToTenths((used / total) * PERCENT_SCALE);
}

function parseCpuStat(source) {
  const [label, ...rawTimes] = String(source).trim().split(/\s+/);
  if (label !== "cpu" || rawTimes.length < CPU_STAT_REQUIRED_TIME_FIELDS) {
    throw new Error("Host CPU data is malformed.");
  }

  const times = rawTimes.slice(0, CPU_STAT_TIME_FIELDS).map(Number);
  if (times.some((value) => !Number.isFinite(value))) {
    throw new Error("Host CPU data is malformed.");
  }

  const idle = times[CPU_STAT_IDLE_INDEX];
  const ioWait = times[CPU_STAT_IO_WAIT_INDEX];
  return {
    // Linux reports I/O wait separately but includes it in overall idle time.
    idle: idle + ioWait,
    ioWait,
    total: times.reduce((sum, value) => sum + value, 0)
  };
}

function cpuUsage(before, after) {
  const total = after.total - before.total;
  const idle = after.idle - before.idle;
  const ioWait = after.ioWait - before.ioWait;

  return {
    usagePercent: asPercentage(total - idle, total),
    ioWaitPercent: asPercentage(ioWait, total)
  };
}

function parseMemory(source) {
  const values = new Map();
  for (const line of String(source).split("\n")) {
    const match = line.match(/^([A-Za-z_]+):\s+(\d+)\s+kB$/);
    if (match) values.set(match[1], Number(match[2]) * KIBIBYTE_BYTES);
  }

  const total = values.get("MemTotal");
  const available = values.get("MemAvailable");
  const swapTotal = values.get("SwapTotal") || 0;
  const swapFree = values.get("SwapFree") || 0;

  return {
    usedPercent: asPercentage(total - available, total),
    swapUsedPercent: swapTotal > 0
      ? asPercentage(swapTotal - swapFree, swapTotal)
      : 0
  };
}

function parseUptime(source) {
  const value = Number.parseFloat(String(source));
  if (!Number.isFinite(value) || value < 0) {
    throw new Error("Host uptime data is malformed.");
  }
  return Math.floor(value);
}

function diskUsage(stats) {
  const blocks = Number(stats.blocks);
  const freeBlocks = Number(stats.bfree);
  const availableBlocks = Number(stats.bavail);
  const usedBlocks = blocks - freeBlocks;
  // Match df: root-reserved blocks are excluded from the capacity denominator.
  return asPercentage(usedBlocks, usedBlocks + availableBlocks);
}

function defaultDelay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function readCpuTemperature({ hwmonRoot, readText, readdirImpl }) {
  try {
    const sensorDirectories = await readdirImpl(hwmonRoot);
    const readings = [];

    for (const directory of sensorDirectories) {
      const sensorRoot = join(hwmonRoot, directory);
      let sensorName;
      try {
        sensorName = String(await readText(join(sensorRoot, "name"))).trim().toLowerCase();
      } catch {
        continue;
      }
      if (!CPU_SENSOR_NAMES.has(sensorName)) continue;

      const sensorFiles = await readdirImpl(sensorRoot);
      const inputFiles = sensorFiles.filter((name) => /^temp\d+_input$/.test(name));
      for (const inputFile of inputFiles) {
        try {
          const millidegrees = Number.parseFloat(await readText(join(sensorRoot, inputFile)));
          // Linux hwmon temp*_input files are defined in millidegrees Celsius.
          const celsius = millidegrees / MILLIDEGREES_PER_DEGREE;
          if (
            Number.isFinite(celsius)
            && celsius >= MIN_CPU_TEMPERATURE_CELSIUS
            && celsius <= MAX_CPU_TEMPERATURE_CELSIUS
          ) {
            readings.push(celsius);
          }
        } catch {
          continue;
        }
      }
    }

    return readings.length > 0
      ? { celsius: roundToTenths(Math.max(...readings)) }
      : null;
  } catch {
    return null;
  }
}

async function readContainerHealth({
  containerApiUrl,
  fetchImpl,
  signalForTimeout,
  timeoutMs
}) {
  if (!containerApiUrl) return null;

  try {
    const baseUrl = `${String(containerApiUrl).replace(/\/+$/, "")}/`;
    const url = new URL("containers/json?all=1", baseUrl);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: signalForTimeout(timeoutMs)
    });
    if (!response.ok) return null;

    const containers = await response.json();
    if (!Array.isArray(containers)) return null;

    return containers.reduce(
      (summary, container) => {
        const state = String(container?.State || "").toLowerCase();
        const status = String(container?.Status || "").toLowerCase();
        summary.total += 1;
        if (state === "running") summary.running += 1;
        if (state === "restarting") summary.restarting += 1;
        if (state === "exited") summary.exited += 1;
        if (state === "paused") summary.paused += 1;
        if (!RECOGNIZED_CONTAINER_STATES.has(state)) summary.other += 1;
        if (status.includes("(unhealthy)")) summary.unhealthy += 1;
        return summary;
      },
      {
        total: 0,
        running: 0,
        unhealthy: 0,
        restarting: 0,
        exited: 0,
        paused: 0,
        other: 0
      }
    );
  } catch {
    return null;
  }
}

export function createSystemHealthCollector({
  procRoot = "/proc",
  sysRoot = "/sys",
  diskPath = "/",
  readFile: readFileImpl = readFile,
  readdir: readdirImpl = readdir,
  statfs: statfsImpl = statfs,
  containerApiUrl = "",
  containerTimeoutMs = SYSTEM_HEALTH_UPSTREAM_TIMEOUT_MS,
  fetchImpl = fetch,
  signalForTimeout = AbortSignal.timeout,
  delay = defaultDelay,
  now = () => new Date()
} = {}) {
  async function readText(path) {
    return readFileImpl(path, "utf8");
  }

  async function collectSnapshot() {
    const cpuBefore = parseCpuStat(await readText(join(procRoot, "stat")));
    await delay(CPU_SAMPLE_INTERVAL_MS);

    const [
      cpuAfterSource,
      memorySource,
      uptimeSource,
      diskStats,
      temperature,
      containers
    ] = await Promise.all([
      readText(join(procRoot, "stat")),
      readText(join(procRoot, "meminfo")),
      readText(join(procRoot, "uptime")),
      statfsImpl(diskPath),
      readCpuTemperature({
        hwmonRoot: join(sysRoot, "class", "hwmon"),
        readText,
        readdirImpl
      }),
      readContainerHealth({
        containerApiUrl,
        fetchImpl,
        signalForTimeout,
        timeoutMs: containerTimeoutMs
      })
    ]);
    const cpu = cpuUsage(cpuBefore, parseCpuStat(cpuAfterSource));

    return {
      sampledAt: now().toISOString(),
      cpu: {
        usagePercent: cpu.usagePercent,
        ioWaitPercent: cpu.ioWaitPercent
      },
      memory: parseMemory(memorySource),
      disk: { usedPercent: diskUsage(diskStats) },
      temperature,
      uptimeSeconds: parseUptime(uptimeSource),
      containers
    };
  }

  return Object.freeze({ collectSnapshot });
}

export function createSystemHealthHandler({ collectSnapshot }) {
  return async function systemHealthHandler(_req, res) {
    try {
      return sendOk(res, await collectSnapshot());
    } catch {
      return sendError(
        res,
        500,
        "system_health_unavailable",
        "System health metrics are unavailable."
      );
    }
  };
}

const router = Router();
const collector = createSystemHealthCollector({
  containerApiUrl: CONFIG.systemHealth.containerApiUrl,
  containerTimeoutMs: CONFIG.upstreamTimeoutMs
});

router.get(
  "/system-health",
  createSystemHealthHandler({ collectSnapshot: collector.collectSnapshot })
);

export default router;
