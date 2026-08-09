import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { sendError, sendOk } from "../platform/responses.js";

const DASHBOARD_SCRIPT_API_PATTERN =
  /^\/api\/services\/script\/dashboard_[a-z0-9_]+$/;

function isDashboardScriptApi(value) {
  return DASHBOARD_SCRIPT_API_PATTERN.test(value);
}

export function createHomeAssistantActionHandler({
  config = CONFIG,
  fetchImpl = fetch,
  signalForTimeout = (timeoutMs) => AbortSignal.timeout(timeoutMs)
} = {}) {
  return async function runHomeAssistantAction(req, res) {
    const api = typeof req.body?.api === "string" ? req.body.api.trim() : "";
    if (!isDashboardScriptApi(api)) {
      return sendError(
        res,
        400,
        "invalid_home_assistant_action",
        "Home Assistant action must be a reserved dashboard script path."
      );
    }

    const baseUrl = String(config.homeAssistant?.baseUrl || "").trim();
    const token = String(config.homeAssistant?.token || "").trim();
    if (!baseUrl || !token) {
      return sendError(
        res,
        503,
        "home_assistant_not_configured",
        "Home Assistant is not configured."
      );
    }

    const upstreamUrl = new URL(api, `${baseUrl}/`);

    let upstreamResponse;
    try {
      upstreamResponse = await fetchImpl(upstreamUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: "{}",
        signal: signalForTimeout(config.upstreamTimeoutMs)
      });
    } catch {
      return sendError(
        res,
        502,
        "home_assistant_unreachable",
        "Home Assistant is unreachable."
      );
    }
    if (!upstreamResponse.ok) {
      return sendError(
        res,
        502,
        "home_assistant_upstream_error",
        "Home Assistant rejected the action.",
        { status: upstreamResponse.status }
      );
    }

    return sendOk(res, { api });
  };
}

const router = Router();
router.post("/home-assistant/actions", createHomeAssistantActionHandler());

export default router;
