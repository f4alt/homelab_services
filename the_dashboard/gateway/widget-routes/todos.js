import { Router } from "express";
import { CONFIG } from "../platform/config.js";
import { errorMessage, sendError, sendOk } from "../platform/responses.js";

const router = Router();
const VALID_STATUSES = new Set(["TODO", "DONE"]);

export function normalizeTimeSincePayload(payload) {
  return { items: Array.isArray(payload?.items) ? payload.items : [] };
}

async function fetchTodo(upstreamPath, requestOptions = {}) {
  const response = await fetch(new URL(upstreamPath, CONFIG.todoBaseUrl), {
    ...requestOptions,
    headers: {
      Accept: "application/json",
      ...(requestOptions.body ? { "Content-Type": "application/json" } : {}),
      ...(requestOptions.headers || {})
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

function sendUpstreamError(res, error, message) {
  return sendError(res, 502, "todo_upstream_error", message, {
    status: error?.status,
    error: errorMessage(error),
    upstream: error?.payload || null
  });
}

function createTodoProxyHandler({
  upstreamPath,
  failureMessage,
  requestOptions,
  normalizePayload = (payload) => payload
}) {
  return async function todoProxyHandler(_req, res) {
    try {
      const payload = await fetchTodo(upstreamPath, requestOptions);
      return sendOk(res, normalizePayload(payload));
    } catch (error) {
      return sendUpstreamError(res, error, failureMessage);
    }
  };
}

router.get("/todos/health", createTodoProxyHandler({
  upstreamPath: "/health",
  failureMessage: "Todo server healthcheck failed."
}));

router.get("/todos/tasks", createTodoProxyHandler({
  upstreamPath: "/tasks",
  failureMessage: "Unable to load todos.",
  normalizePayload: (payload) => ({
    tasks: Array.isArray(payload?.tasks) ? payload.tasks : []
  })
}));

export const getTimeSince = createTodoProxyHandler({
  upstreamPath: "/time-since",
  failureMessage: "Unable to load time-since activities.",
  normalizePayload: normalizeTimeSincePayload
});

router.get("/todos/time-since", getTimeSince);

router.post("/todos/sync", createTodoProxyHandler({
  upstreamPath: "/sync",
  failureMessage: "Unable to sync todos.",
  requestOptions: { method: "POST" }
}));

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
  } catch (error) {
    return sendUpstreamError(res, error, "Unable to update todo.");
  }
});

export default router;
