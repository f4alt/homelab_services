import assert from "node:assert/strict";
import test from "node:test";

import {
  FakeDocument,
  FakeElement,
  findByClass,
  treeText
} from "./helpers/fake-dom.mjs";
import {
  createDeferred,
  createErrorResponse,
  createSuccessResponse,
  withPatchedGlobals
} from "./helpers/test-utils.mjs";

let widgetImportNumber = 0;

async function withSystemHealthWidget(fetchImplementation, run) {
  let registration;
  const window = {
    DASH_CONFIG: { apiBase: "/api" },
    DASH: {
      registerWidget(type, implementation) {
        registration = { type, implementation };
      }
    }
  };

  await withPatchedGlobals({
    document: new FakeDocument(),
    fetch: fetchImplementation,
    window
  }, async () => {
    widgetImportNumber += 1;
    await import(`../dashboard/widgets/system-health.js?test=${widgetImportNumber}`);
    await run({ registration });
  });
}

function healthySnapshot() {
  return {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 18, ioWaitPercent: 0.5 },
    memory: { usedPercent: 61, swapUsedPercent: 0 },
    disk: { usedPercent: 72 },
    temperature: { celsius: 54 },
    uptimeSeconds: 1_555_200
  };
}

test("system-health renders one compact neutral strip of host readings", async () => {
  const requests = [];
  const snapshot = healthySnapshot();

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
      /CPU\s+18%\s+RAM\s+61%\s+Disk\s+72%\s+Temp\s+54°C\s+Uptime\s+18d/
    );
    assert.equal(treeText(root).includes("System"), false);
    assert.equal(treeText(root).includes("Healthy"), false);
    assert.equal(treeText(root).includes("Containers"), false);
    assert.equal(findByClass(root, "dot"), null);
    assert.equal(findByClass(root, "system-health-state"), null);
    assert.equal(findByClass(root, "ui-tile--compact") !== null, true);
    assert.equal(state.grid.classList.contains("list-fullWidth"), true);
    assert.equal(findByClass(root, "severity-ok"), null);
    assert.equal(findByClass(root, "severity-warn"), null);
    assert.equal(findByClass(root, "severity-error"), null);
  });
});

test("system-health warns about unavailable host readings without malformed units", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 18, ioWaitPercent: 0 },
    memory: { usedPercent: 61, swapUsedPercent: 0 },
    disk: { usedPercent: 72 },
    temperature: { celsius: null },
    uptimeSeconds: 3600
  };

  await withSystemHealthWidget(
    async () => createSuccessResponse(snapshot),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: {} });

      await registration.implementation.update(state);

      assert.equal(
        findByClass(root, "system-health-warning").textContent,
        "Temperature unavailable"
      );
      assert.match(treeText(root), /Temp\s+—\s+Uptime\s+1h/);
      assert.equal(treeText(root).includes("—°C"), false);
      assert.equal(findByClass(root, "severity-warn") !== null, true);
    }
  );
});

test("system-health applies configured warning thresholds without a title", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 40, ioWaitPercent: 0 },
    memory: { usedPercent: 50, swapUsedPercent: 0 },
    disk: { usedPercent: 50 },
    temperature: { celsius: 50 },
    uptimeSeconds: 3600
  };

  await withSystemHealthWidget(
    async () => createSuccessResponse(snapshot),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, {
        props: { label: "Server", cpuWarnPercent: 30 }
      });

      await registration.implementation.update(state);

      assert.equal(treeText(root).includes("Server"), false);
      assert.equal(findByClass(root, "system-health-warning").textContent, "CPU high");
      assert.equal(findByClass(root, "severity-warn") !== null, true);
    }
  );
});

test("system-health keeps host problems in one warning line", async () => {
  const snapshot = {
    sampledAt: new Date().toISOString(),
    cpu: { usagePercent: 91, ioWaitPercent: 22 },
    memory: { usedPercent: 88, swapUsedPercent: 25 },
    disk: { usedPercent: 92 },
    temperature: { celsius: 85 },
    uptimeSeconds: 3600
  };

  await withSystemHealthWidget(
    async () => createSuccessResponse(snapshot),
    async ({ registration }) => {
      const root = new FakeElement("section");
      const state = registration.implementation.mount(root, { props: {} });

      await registration.implementation.update(state);

      assert.equal(findByClass(root, "severity-warn") !== null, true);
      assert.equal(findByClass(root, "severity-error"), null);
      assert.equal(
        findByClass(root, "system-health-warning").textContent,
        "CPU high · Memory high · Disk nearly full · Temperature high · I/O wait high · Swap in use"
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
    uptimeSeconds: 3600
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
      assert.equal(
        findByClass(root, "system-health-warning").textContent,
        "Temperature unavailable · Gateway unavailable. Showing the previous snapshot."
      );
      assert.equal(findByClass(root, "severity-error") !== null, true);
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
      uptimeSeconds: 3600
    },
    {
      sampledAt: new Date().toISOString(),
      cpu: { usagePercent: 22, ioWaitPercent: 0 },
      memory: { usedPercent: 50, swapUsedPercent: 0 },
      disk: { usedPercent: 50 },
      temperature: null,
      uptimeSeconds: 3600
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

test("system-health treats a malformed first response as an unavailable refresh", async () => {
  await withSystemHealthWidget(
    async () => createSuccessResponse({}),
    async ({ registration }) => {
      const state = registration.implementation.mount(
        new FakeElement("section"),
        { props: {} }
      );

      await assert.doesNotReject(() => registration.implementation.update(state));

      assert.equal(state.grid.classList.contains("is-error"), true);
      assert.equal(
        state.grid.children[0].textContent,
        "System health response was incomplete."
      );
    }
  );
});

test("system-health preserves a valid snapshot when a later payload is malformed", async () => {
  const responses = [
    createSuccessResponse(healthySnapshot()),
    createSuccessResponse({})
  ];

  await withSystemHealthWidget(
    async () => responses.shift(),
    async ({ registration }) => {
      const state = registration.implementation.mount(
        new FakeElement("section"),
        { props: {} }
      );
      await registration.implementation.update(state);

      await assert.doesNotReject(() => registration.implementation.update(state));

      assert.equal(state.values.cpu.textContent, "18%");
      assert.equal(
        state.warning.textContent,
        "System health response was incomplete. Showing the previous snapshot."
      );
    }
  );
});
