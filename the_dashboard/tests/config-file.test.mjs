import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { writeConfigFile } from "../gateway/platform/config-file.js";

const INITIAL_SOURCE = "window.DASH_CONFIG = { widgets: [] };\n";
const UPDATED_SOURCE = "window.DASH_CONFIG = { apiBase: '/api', widgets: [] };\n";

test("config writes fall back to in-place replacement for a bind-mounted file", async (context) => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "dashboard-config-test-"));
  const configPath = path.join(tempDirectory, "config.js");
  await fs.writeFile(configPath, INITIAL_SOURCE, "utf8");
  context.after(() => fs.rm(tempDirectory, { force: true, recursive: true }));

  const fileSystem = {
    copyFile: fs.copyFile,
    rename: async () => {
      const error = new Error("resource busy or locked");
      error.code = "EBUSY";
      throw error;
    },
    unlink: fs.unlink,
    writeFile: fs.writeFile
  };

  await writeConfigFile(configPath, UPDATED_SOURCE, fileSystem);

  assert.equal(await fs.readFile(configPath, "utf8"), UPDATED_SOURCE);
  assert.deepEqual(await fs.readdir(tempDirectory), ["config.js"]);
});
