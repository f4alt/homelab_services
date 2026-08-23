import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const DOCKERFILE_PATH = new URL("../gateway/Dockerfile", import.meta.url);

test("the Gateway image includes status provider adapters", async () => {
  const dockerfile = await fs.readFile(DOCKERFILE_PATH, "utf8");

  assert.match(dockerfile, /^COPY status-providers\/ \.\/status-providers\/$/m);
});
