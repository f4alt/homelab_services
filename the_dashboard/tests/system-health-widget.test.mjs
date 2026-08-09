import assert from "node:assert/strict";
import test from "node:test";

import { FakeDocument, FakeElement, treeText } from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createErrorResponse,
  createSuccessResponse
} from "./helpers/test-utils.mjs";

let widgetImportNumber = 0;

function findByClass(element, className) {
  if (element.classList.contains(className)) return element;
  for (const child of element.children) {
    const match = findByClass(child, className);
    if (match) return match;
  }
  return null;
}

async function withSystemHealthWidget(fetchImplementation, run) {
  const previous = {
    document: globalThis.document,
    fetch: globalThis.fetch,
    window: globalThis.window
  };
  let registration;
  globalThis.document = new FakeDocument();
  globalThis.fetch = fetchImplementation;
  globalThis.window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  try {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/system-health.js?test=${widgetImportNumber}`);
    await run({ registration });
  } finally {
    globalThis.document = previous.document;
    globalThis.fetch = previous.fetch;
    globalThis.window = previous.window;
  }
}

test("system-health renders the minimal six-reading tile", async () => {
  const requests = [];
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 18, ioWaitPercent: 0.5 },
    memory: { usedPercent: 61, swapUsedPercent: 0 },
    disk: { usedPercent: 72 },
    temperature: { celsius: 54 },
    uptimeSeconds: 1_555_200,
    containers: { total: 11, running: 11, unhealthy: 0, restarting: 0 }
  };

  await withSystemHealthWidget(async (url) => {
    requests.push(url);
    return createSuccessResponse(snapshot);
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, { props: {} });

    await registration.implementation.update(state);

    assert.equal(registration.type, "system-health");
    assert.deepEqual(requests, ["/api/system-health"]);
    assert.match(
      treeText(root),
      /System\s+Healthy\s+CPU\s+18%\s+RAM\s+61%\s+Disk\s+72%\s+Temp\s+54°C\s+Uptime\s+18d\s+Containers\s+11\/11/
    );
    assert.equal(findByClass(root, "ui-tile") !== null, true);
    assert.equal(findByClass(root, "severity-ok") !== null, true);
  });
});

test("system-health reports unavailable core readings without rendering malformed units", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 18, ioWaitPercent: 0 },
    memory: { usedPercent: 61, swapUsedPercent: 0 },
    disk: { usedPercent: 72 },
    temperature: { celsius: null },
    uptimeSeconds: 3600,
    containers: null
  };

  await withSystemHealthWidget(
    async () => createSuccessResponse(snapshot),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: {} });

      await registration.implementation.update(state);

      assert.equal(findByClass(root, "system-health-state").textContent, "Attention");
      assert.equal(
        findByClass(root, "system-health-warning").textContent,
        "Temperature unavailable · Container health unavailable"
      );
      assert.match(treeText(root), /Temp\s+—\s+Uptime\s+1h\s+Containers\s+—/);
      assert.equal(treeText(root).includes("—°C"), false);
    }
  );
});

test("system-health applies configured labels and warning thresholds", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 40, ioWaitPercent: 0 },
    memory: { usedPercent: 50, swapUsedPercent: 0 },
    disk: { usedPercent: 50 },
    temperature: { celsius: 50 },
    uptimeSeconds: 3600,
    containers: {
      total: 3,
      running: 3,
      unhealthy: 0,
      restarting: 0,
      exited: 0,
      paused: 0
    }
  };

  await withSystemHealthWidget(
    async () => createSuccessResponse(snapshot),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: { label: "Server", cpuWarnPercent: 30 }
      });

      await registration.implementation.update(state);

      assert.match(treeText(root), /Server\s+Attention/);
      assert.equal(findByClass(root, "system-health-warning").textContent, "CPU high");
    }
  );
});

test("system-health keeps problems in one warning line and escalates unhealthy containers", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 91, ioWaitPercent: 22 },
    memory: { usedPercent: 88, swapUsedPercent: 25 },
    disk: { usedPercent: 92 },
    temperature: { celsius: 85 },
    uptimeSeconds: 3600,
    containers: {
      total: 5,
      running: 2,
      unhealthy: 1,
      restarting: 1,
      exited: 1,
      paused: 0,
      other: 1
    }
  };

  await withSystemHealthWidget(
    async () => createSuccessResponse(snapshot),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: {} });

      await registration.implementation.update(state);

      assert.equal(findByClass(root, "system-health-state").textContent, "Unhealthy");
      assert.equal(findByClass(root, "severity-error") !== null, true);
      assert.equal(
        findByClass(root, "system-health-warning").textContent,
        "CPU high · Memory high · Disk nearly full · Temperature high · I/O wait high · Swap in use · 1 container unhealthy · 1 container restarting · 1 container exited · 1 container not running"
      );
    }
  );
});

test("system-health preserves the last snapshot when a refresh fails", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 18, ioWaitPercent: 0 },
    memory: { usedPercent: 61, swapUsedPercent: 0 },
    disk: { usedPercent: 72 },
    temperature: null,
    uptimeSeconds: 3600,
    containers: null
  };
  const responses = [
    createSuccessResponse(snapshot),
    createErrorResponse("Gateway unavailable.")
  ];

  await withSystemHealthWidget(
    async () => responses.shift(),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: {} });
      await registration.implementation.update(state);

      await registration.implementation.update(state);

      assert.match(treeText(root), /CPU\s+18%/);
      assert.equal(findByClass(root, "system-health-state").textContent, "Attention");
      assert.equal(
        findByClass(root, "system-health-warning").textContent,
        "Temperature unavailable · Container health unavailable · Gateway unavailable. Showing the previous snapshot."
      );
    }
  );
});

test("system-health ignores an older response after a newer refresh starts", async () => {
  const firstResponse = createDeferred();
  const snapshots = [
    {
      sampledAt: new Date().toISOString(),
      cpu: { usagePercent: 99, ioWaitPercent: 0 },
      memory: { usedPercent: 50, swapUsedPercent: 0 },
      disk: { usedPercent: 50 },
      temperature: null,
      uptimeSeconds: 3600,
      containers: null
    },
    {
      sampledAt: new Date().toISOString(),
      cpu: { usagePercent: 22, ioWaitPercent: 0 },
      memory: { usedPercent: 50, swapUsedPercent: 0 },
      disk: { usedPercent: 50 },
      temperature: null,
      uptimeSeconds: 3600,
      containers: null
    }
  ];
  let requestCount = 0;

  await withSystemHealthWidget(async () => {
    requestCount += 1;
    return requestCount === 1
      ? firstResponse.promise
      : createSuccessResponse(snapshots[1]);
  }, async ({ registration }) => {
    const root = new FakeElement("section");
    const state = registration.implementation.mount(root, { props: {} });

    const firstUpdate = registration.implementation.update(state);
    await registration.implementation.update(state);
    firstResponse.resolve(createSuccessResponse(snapshots[0]));
    await firstUpdate;

    assert.match(treeText(root), /CPU\s+22%/);
    assert.equal(treeText(root).includes("99%"), false);
  });
});
