import assert from "node:assert/strict";
import test from "node:test";

import {
  createSystemHealthCollector,
  createSystemHealthHandler
} from "../gateway/widget-routes/system-health.js";
import { createGatewayResponse } from "./helpers/test-utils.mjs";

const SNAPSHOT = {
  sampledAt: "2026-08-09T18:00:00.000Z",
  cpu: { usagePercent: 18, ioWaitPercent: 0.5 },
  memory: { usedPercent: 61, swapUsedPercent: 0 },
  disk: { usedPercent: 72 },
  temperature: { celsius: 54 },
  uptimeSeconds: 1_555_200,
  containers: {
    total: 11,
    running: 11,
    unhealthy: 0,
    restarting: 0
  }
};

test("system health returns one host snapshot in the standard Gateway envelope", async () => {
  const handler = createSystemHealthHandler({
    collectSnapshot: async () => SNAPSHOT
  });
  const response = createGatewayResponse();

  await handler({}, response);

  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, {
    ok: true,
    data: SNAPSHOT,
    error: null
  });
});

test("system health reports collection failures without leaking host details", async () => {
  const handler = createSystemHealthHandler({
    collectSnapshot: async () => {
      throw new Error("sensitive host path /private/example");
    }
  });
  const response = createGatewayResponse();

  await handler({}, response);

  assert.deepEqual(response.body, {
    ok: false,
    data: null,
    error: {
      code: "system_health_unavailable",
      message: "System health metrics are unavailable."
    }
  });
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.stringify(response.body).includes("/private/example"), false);
});

test("system health collects CPU, memory, disk, and uptime from Linux host data", async () => {
  const fileContents = new Map([
    [
      "/test/proc/meminfo",
      "MemTotal:       100000 kB\nMemAvailable:    39000 kB\nSwapTotal:       10000 kB\nSwapFree:        10000 kB\n"
    ],
    ["/test/proc/uptime", "1555200.42 123.00\n"]
  ]);
  const cpuSamples = [
    "cpu  100 0 100 800 0 0 0 0 0 0\n",
    "cpu  150 0 150 900 0 0 0 0 0 0\n"
  ];
  const collector = createSystemHealthCollector({
    procRoot: "/test/proc",
    sysRoot: "/test/sys",
    diskPath: "/test/disk",
    now: () => new Date("2026-08-09T18:00:00.000Z"),
    delay: async () => {},
    readFile: async (path) => {
      if (path === "/test/proc/stat") return cpuSamples.shift();
      if (fileContents.has(path)) return fileContents.get(path);
      const error = new Error(`Missing test file: ${path}`);
      error.code = "ENOENT";
      throw error;
    },
    readdir: async () => [],
    statfs: async () => ({ bsize: 4096, blocks: 1000, bfree: 280, bavail: 280 })
  });

  const snapshot = await collector.collectSnapshot();

  assert.deepEqual(snapshot, {
    sampledAt: "2026-08-09T18:00:00.000Z",
    cpu: { usagePercent: 50, ioWaitPercent: 0 },
    memory: { usedPercent: 61, swapUsedPercent: 0 },
    disk: { usedPercent: 72 },
    temperature: null,
    uptimeSeconds: 1_555_200,
    containers: null
  });
});

test("system health selects a CPU temperature without confusing it with storage sensors", async () => {
  const files = new Map([
    ["/test/proc/stat", [
      "cpu  100 0 100 800 0 0 0 0\n",
      "cpu  150 0 150 900 0 0 0 0\n"
    ]],
    ["/test/proc/meminfo", ["MemTotal: 100 kB\nMemAvailable: 50 kB\n"]],
    ["/test/proc/uptime", ["3600 0\n"]],
    ["/test/sys/class/hwmon/hwmon0/name", ["nvme\n"]],
    ["/test/sys/class/hwmon/hwmon0/temp1_input", ["41850\n"]],
    ["/test/sys/class/hwmon/hwmon1/name", ["k10temp\n"]],
    ["/test/sys/class/hwmon/hwmon1/temp1_input", ["52125\n"]],
    ["/test/sys/class/hwmon/hwmon1/temp2_input", ["39250\n"]]
  ]);
  const directories = new Map([
    ["/test/sys/class/hwmon", ["hwmon0", "hwmon1"]],
    ["/test/sys/class/hwmon/hwmon0", ["name", "temp1_input"]],
    ["/test/sys/class/hwmon/hwmon1", ["name", "temp1_input", "temp2_input"]]
  ]);
  const collector = createSystemHealthCollector({
    procRoot: "/test/proc",
    sysRoot: "/test/sys",
    delay: async () => {},
    now: () => new Date("2026-08-09T18:00:00.000Z"),
    readFile: async (path) => files.get(path)?.shift(),
    readdir: async (path) => directories.get(path) || [],
    statfs: async () => ({ bsize: 1, blocks: 100, bfree: 50, bavail: 50 })
  });

  const snapshot = await collector.collectSnapshot();

  assert.deepEqual(snapshot.temperature, { celsius: 52.1 });
});

test("system health summarizes container states through a configured read-only proxy", async () => {
  const files = new Map([
    ["/proc/stat", [
      "cpu  100 0 100 800 0 0 0 0\n",
      "cpu  150 0 150 900 0 0 0 0\n"
    ]],
    ["/proc/meminfo", ["MemTotal: 100 kB\nMemAvailable: 50 kB\n"]],
    ["/proc/uptime", ["3600 0\n"]]
  ]);
  const requests = [];
  const collector = createSystemHealthCollector({
    containerApiUrl: "http://docker-proxy.test:2375",
    delay: async () => {},
    readFile: async (path) => files.get(path)?.shift(),
    readdir: async () => [],
    statfs: async () => ({ bsize: 1, blocks: 100, bfree: 50, bavail: 50 }),
    fetchImpl: async (url, options) => {
      requests.push({ url: url.toString(), options });
      return {
        ok: true,
        async json() {
          return [
            { State: "running", Status: "Up 2 hours (healthy)" },
            { State: "running", Status: "Up 2 hours (unhealthy)" },
            { State: "restarting", Status: "Restarting (1) 5 seconds ago" },
            { State: "exited", Status: "Exited (1) 1 minute ago" },
            { State: "paused", Status: "Up 2 hours (Paused)" },
            { State: "created", Status: "Created" }
          ];
        }
      };
    }
  });

  const snapshot = await collector.collectSnapshot();

  assert.deepEqual(snapshot.containers, {
    total: 6,
    running: 2,
    unhealthy: 1,
    restarting: 1,
    exited: 1,
    paused: 1,
    other: 1
  });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "http://docker-proxy.test:2375/containers/json?all=1");
  assert.equal(requests[0].options.method, "GET");
});

test("system health preserves host readings when the container proxy is unavailable", async () => {
  const files = new Map([
    ["/proc/stat", [
      "cpu  100 0 100 800 0 0 0 0\n",
      "cpu  150 0 150 900 0 0 0 0\n"
    ]],
    ["/proc/meminfo", ["MemTotal: 100 kB\nMemAvailable: 50 kB\n"]],
    ["/proc/uptime", ["3600 0\n"]]
  ]);
  const collector = createSystemHealthCollector({
    containerApiUrl: "http://docker-proxy.test:2375",
    delay: async () => {},
    readFile: async (path) => files.get(path)?.shift(),
    readdir: async () => [],
    statfs: async () => ({ bsize: 1, blocks: 100, bfree: 50, bavail: 50 }),
    fetchImpl: async () => {
      throw new Error("Proxy offline");
    }
  });

  const snapshot = await collector.collectSnapshot();

  assert.equal(snapshot.cpu.usagePercent, 50);
  assert.equal(snapshot.containers, null);
});
