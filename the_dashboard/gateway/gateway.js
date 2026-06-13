import express from "express";
import { CONFIG } from "./platform/config.js";
import { sendError, sendOk } from "./platform/responses.js";

// Routers
import config from "./platform/routes/config.js";
import netstats from "./platform/routes/netstats.js";
import status from "./platform/routes/status.js";
import metar from "./widget-routes/metar.js";
import todos from "./widget-routes/todos.js";

const app = express();

// Preserve client IP forwarded by nginx
// app.set("trust proxy", true);

// Minimal body parsers (large raw bodies handled in net.js only)
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

app.get("/api/health", async (_req, res) => {
  const startedAt = new Date().toISOString();

  try {
    const upstream = await fetch(new URL("/health", CONFIG.netstatsBaseUrl), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(CONFIG.upstreamTimeoutMs)
    });
    const payload = await upstream.json().catch(() => ({}));

    if (!upstream.ok) {
      return sendError(res, 503, "dependency_unhealthy", "Netstats healthcheck failed.", {
        status: upstream.status
      });
    }

    return sendOk(res, {
      service: "gateway",
      dependencies: {
        netstats: {
          ok: Boolean(payload?.ok) && upstream.ok,
          status: upstream.status
        }
      },
      checked_at: startedAt
    });
  } catch (err) {
    return sendError(res, 503, "dependency_unreachable", "Netstats healthcheck was unreachable.", {
      error: String(err?.message || err),
      checked_at: startedAt
    });
  }
});

// Mount routers
app.use("/api", config);
app.use("/api", metar);
app.use("/api", netstats);
app.use("/api", status);
app.use("/api", todos);

app.listen(CONFIG.port, () => {
  console.log(`[gateway] running on ${CONFIG.port}`);
});
