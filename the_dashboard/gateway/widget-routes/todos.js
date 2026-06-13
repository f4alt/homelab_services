import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { sendError, sendOk } from "../platform/responses.js";

const router = Router();
const VALID_STATUSES = new Set(["TODO", "DONE"]);

async function fetchTodo(path, options = {}) {
  const response = await fetch(new URL(path, CONFIG.todoBaseUrl), {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(CONFIG.upstreamTimeoutMs)
  });
  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const message = payload?.error || payload?.message || `Todo server returned HTTP ${response.status}.`;
    const error = new Error(message);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

function sendUpstreamError(res, err, message) {
  return sendError(res, 502, "todo_upstream_error", message, {
    status: err?.status,
    error: String(err?.message || err),
    upstream: err?.payload || null
  });
}

router.get("/todos/health", async (_req, res) => {
  try {
    const payload = await fetchTodo("/health");
    return sendOk(res, payload);
  } catch (err) {
    return sendUpstreamError(res, err, "Todo server healthcheck failed.");
  }
});

router.get("/todos/tasks", async (_req, res) => {
  try {
    const payload = await fetchTodo("/tasks");
    return sendOk(res, { tasks: Array.isArray(payload?.tasks) ? payload.tasks : [] });
  } catch (err) {
    return sendUpstreamError(res, err, "Unable to load todos.");
  }
});

router.post("/todos/sync", async (_req, res) => {
  try {
    const payload = await fetchTodo("/sync", { method: "POST" });
    return sendOk(res, payload);
  } catch (err) {
    return sendUpstreamError(res, err, "Unable to sync todos.");
  }
});

router.get("/todos/sync", async (_req, res) => {
  try {
    const payload = await fetchTodo("/sync");
    return sendOk(res, payload);
  } catch (err) {
    return sendUpstreamError(res, err, "Unable to sync todos.");
  }
});

router.post("/todos/tasks/update", async (req, res) => {
  const { uid, content, source_file, status } = req.body || {};

  if (!uid && !content) {
    return sendError(res, 400, "validation_error", "Todo update requires uid or content.");
  }
  if (!VALID_STATUSES.has(status)) {
    return sendError(res, 400, "validation_error", "Todo status must be TODO or DONE.");
  }

  try {
    const payload = await fetchTodo("/tasks/update", {
      method: "POST",
      body: JSON.stringify({ uid, content, source_file, status })
    });
    return sendOk(res, payload);
  } catch (err) {
    return sendUpstreamError(res, err, "Unable to update todo.");
  }
});

export default router;
