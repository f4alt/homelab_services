import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

test("dashboard enables the time-since widget with the ratified live config", async () => {
  const source = await readFile(new URL("../dashboard/config.js", import.meta.url), "utf8");
  const context = vm.createContext({ window: {} });
  vm.runInContext(source, context);

  const widget = context.window.DASH_CONFIG.widgets.find(({ id }) => id === "time_since");
  assert.deepEqual(
    JSON.parse(JSON.stringify(widget)),
    {
      type: "time-since",
      id: "time_since",
      width: "all",
      refreshMs: 60000,
      props: { approachingRatio: 0.8 }
    }
  );
});
