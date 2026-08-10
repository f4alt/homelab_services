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
