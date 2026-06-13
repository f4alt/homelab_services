#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { validateDashboardConfig } from "../dashboard/platform/config-validator.mjs";

const configPath = process.argv[2] || "dashboard/config.js";
const absolutePath = path.resolve(configPath);
const source = fs.readFileSync(absolutePath, "utf8");

function loadConfig() {
  const sandbox = { window: {} };
  vm.runInNewContext(source, sandbox, {
    filename: absolutePath,
    timeout: 1000
  });
  return sandbox.window.DASH_CONFIG;
}

const result = validateDashboardConfig(loadConfig());

if (!result.ok) {
  console.error(`[FAIL] ${configPath}`);
  for (const error of result.errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(`[PASS] ${configPath}`);
for (const warning of result.warnings) {
  console.log(`[WARN] ${warning}`);
}
