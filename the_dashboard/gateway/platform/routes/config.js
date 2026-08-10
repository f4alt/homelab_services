import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { CONFIG } from "../config.js";
import { writeConfigFile } from "../config-file.js";
import { errorMessage, sendError, sendOk } from "../responses.js";

const router = express.Router();

const CONFIG_PATH = path.resolve(CONFIG.dashboardConfigPath);
const VALIDATOR_PATH = path.resolve(CONFIG.dashboardConfigValidatorPath);
const CONFIG_EVALUATION_TIMEOUT_MS = 1000;
const MAX_SOURCE_BYTES = 1024 * 1024;

router.use(express.text({
  type: ["text/plain", "application/javascript"],
  limit: `${MAX_SOURCE_BYTES}b`
}));

function normalizeSource(body) {
  if (typeof body?.source === "string") {
    return body.source;
  }

  if (typeof body === "string") {
    return body;
  }

  return null;
}

async function validateSource(source) {
  if (typeof source !== "string") {
    return {
      ok: false,
      errors: ["Request body must include a string source field."],
      warnings: []
    };
  }

  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return {
      ok: false,
      errors: ["Config source is larger than 1 MiB."],
      warnings: []
    };
  }

  const sandbox = { window: {} };

  try {
    vm.runInNewContext(source, sandbox, {
      filename: "dashboard/config.js",
      timeout: CONFIG_EVALUATION_TIMEOUT_MS
    });
  } catch (error) {
    return {
      ok: false,
      errors: [`Config JavaScript failed to evaluate: ${errorMessage(error)}`],
      warnings: []
    };
  }

  const { validateDashboardConfig } = await import(pathToFileURL(VALIDATOR_PATH).href);
  const validation = validateDashboardConfig(sandbox.window.DASH_CONFIG);

  return {
    ok: validation.ok,
    errors: validation.errors,
    warnings: validation.warnings
  };
}

router.get("/config", async (_req, res) => {
  try {
    const source = await fs.readFile(CONFIG_PATH, "utf8");
    return res.type("application/javascript").send(source);
  } catch (error) {
    return sendError(res, 500, "config_read_failed", "Unable to read dashboard config.", {
      error: errorMessage(error)
    });
  }
});

router.put("/config", async (req, res) => {
  const source = normalizeSource(req.body);
  let result;
  try {
    result = await validateSource(source);
  } catch (error) {
    return sendError(res, 500, "validation_failed", "Unable to validate dashboard config.", {
      error: errorMessage(error)
    });
  }

  if (!result.ok) {
    return sendError(res, 400, "validation_error", "Dashboard config is invalid.", result);
  }

  try {
    await writeConfigFile(CONFIG_PATH, source);
    return sendOk(res, result);
  } catch (error) {
    return sendError(res, 500, "config_write_failed", "Unable to write dashboard config.", {
      error: errorMessage(error)
    });
  }
});

export default router;
