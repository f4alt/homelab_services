import express from "express";
import { CONFIG } from "./platform/config.js";

import config from "./platform/routes/config.js";
import homeAssistant from "./widget-routes/home-assistant.js";
import metar from "./widget-routes/metar.js";
import netstats from "./widget-routes/netstats.js";
import status from "./widget-routes/status.js";
import todos from "./widget-routes/todos.js";

const app = express();

app.use(express.json({ limit: "1mb" }));

app.use("/api", config);
app.use("/api", homeAssistant);
app.use("/api", metar);
app.use("/api", netstats);
app.use("/api", status);
app.use("/api", todos);

app.listen(CONFIG.port, () => {
  console.log(`[gateway] running on ${CONFIG.port}`);
});
