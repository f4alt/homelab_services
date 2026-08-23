import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const CONFIG_EVALUATION_TIMEOUT_MS = 1_000;
const TRACKED_CONFIG_PATH = new URL("../dashboard/config.js", import.meta.url);

async function loadTrackedConfig() {
  const source = await fs.readFile(TRACKED_CONFIG_PATH, "utf8");
  const context = { window: {} };
  vm.runInNewContext(source, context, {
    filename: TRACKED_CONFIG_PATH.pathname,
    timeout: CONFIG_EVALUATION_TIMEOUT_MS
  });
  return context.window.DASH_CONFIG;
}

function collectUnderscoredKeys(value, path = "DASH_CONFIG") {
  if (!value || typeof value !== "object") return [];

  return Object.entries(value).flatMap(([key, child]) => {
    const childPath = `${path}.${key}`;
    const keyMatches = key.includes("_") ? [childPath] : [];
    return [...keyMatches, ...collectUnderscoredKeys(child, childPath)];
  });
}

test("tracked dashboard config uses camelCase property keys", async () => {
  const config = await loadTrackedConfig();

  assert.deepEqual(collectUnderscoredKeys(config), []);
});

test("tracked dashboard config preserves the wide layout rhythm", async () => {
  const config = await loadTrackedConfig();

  assert.deepEqual(
    Array.from(config.widgets, ({ id, width }) => [id, width]),
    [
      ["searchbar", "all"],
      ["clocks", 7],
      ["calendar", 5],
      ["todos", 5],
      ["time_since", 7],
      ["system_health", "all"],
      ["status", 5],
      ["netstats", 7],
      ["metar", "all"],
      ["home_assistant", "all"]
    ]
  );
  assert.deepEqual({ ...config.options.grid }, {
    columns: 12,
    minColWidth: 280,
    gap: 34,
    width: "1420px"
  });
});

test("tracked dashboard config uses conservative refresh cadences", async () => {
  const config = await loadTrackedConfig();
  const refreshById = Object.fromEntries(
    Array.from(config.widgets, ({ id, refreshMs }) => [id, refreshMs])
  );

  const contentRefreshMs = 5 * 60 * 1000;
  const statusCheckRefreshMs = 2 * 60 * 1000;
  assert.equal(refreshById.calendar, contentRefreshMs);
  assert.equal(refreshById.todos, contentRefreshMs);
  assert.equal(refreshById.time_since, contentRefreshMs);
  assert.equal(refreshById.metar, contentRefreshMs);
  assert.equal(refreshById.status, statusCheckRefreshMs);
});

test("tracked dashboard config includes the public BRL-CAD Actions check", async () => {
  const config = await loadTrackedConfig();
  const statusWidget = config.widgets.find(({ type }) => type === "status");

  assert.deepEqual(Array.from(statusWidget.props.checks, (check) => ({
    ...check,
    provider: { ...check.provider }
  })), [{
    name: "BRL-CAD CI",
    provider: {
      type: "github-actions",
      repository: "BRL-CAD/brlcad",
      workflow: "push.yml"
    }
  }]);
  assert.equal("services" in statusWidget.props, false);
});
