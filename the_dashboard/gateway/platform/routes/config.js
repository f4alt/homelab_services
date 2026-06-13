import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { CONFIG } from "../config.js";
import { sendError, sendOk } from "../responses.js";

const router = express.Router();

const CONFIG_PATH = path.resolve(CONFIG.dashboardConfigPath);
const VALIDATOR_PATH = path.resolve(CONFIG.dashboardConfigValidatorPath);
const MAX_SOURCE_BYTES = 1024 * 1024;

router.use(express.text({
  type: ["text/plain", "application/javascript"],
  limit: `${MAX_SOURCE_BYTES}b`
}));

function normalizeSource(req) {
  if (typeof req.body?.source === "string") {
    return req.body.source;
  }

  if (typeof req.body === "string") {
    return req.body;
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
      timeout: 1000
    });
  } catch (err) {
    return {
      ok: false,
      errors: [`Config JavaScript failed to evaluate: ${String(err?.message || err)}`],
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

async function writeConfigSource(source) {
  const dir = path.dirname(CONFIG_PATH);
  const tempPath = path.join(dir, `.config.js.${Date.now()}.${process.pid}.tmp`);

  try {
    await fs.writeFile(tempPath, source, { encoding: "utf8", mode: 0o644 });
    await fs.rename(tempPath, CONFIG_PATH);
  } catch (err) {
    await fs.unlink(tempPath).catch(() => {});
    throw err;
  }
}

router.get("/config", async (_req, res) => {
  try {
    const source = await fs.readFile(CONFIG_PATH, "utf8");
    return res.type("application/javascript").send(source);
  } catch (err) {
    return sendError(res, 500, "config_read_failed", "Unable to read dashboard config.", {
      error: String(err?.message || err)
    });
  }
});

router.post("/config/validate", async (req, res) => {
  let result;
  try {
    result = await validateSource(normalizeSource(req));
  } catch (err) {
    return sendError(res, 500, "validation_failed", "Unable to validate dashboard config.", {
      error: String(err?.message || err)
    });
  }

  if (!result.ok) {
    return sendError(res, 400, "validation_error", "Dashboard config is invalid.", result);
  }

  return sendOk(res, result);
});

router.put("/config", async (req, res) => {
  const source = normalizeSource(req);
  let result;
  try {
    result = await validateSource(source);
  } catch (err) {
    return sendError(res, 500, "validation_failed", "Unable to validate dashboard config.", {
      error: String(err?.message || err)
    });
  }

  if (!result.ok) {
    return sendError(res, 400, "validation_error", "Dashboard config is invalid.", result);
  }

  try {
    await writeConfigSource(source);
    return sendOk(res, result);
  } catch (err) {
    return sendError(res, 500, "config_write_failed", "Unable to write dashboard config.", {
      error: String(err?.message || err)
    });
  }
});

export default router;
