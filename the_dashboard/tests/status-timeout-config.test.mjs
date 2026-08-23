import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";

const MILLISECONDS_PER_SECOND = 1_000;
const GATEWAY_CONFIG_PATH = new URL("../gateway/platform/config.js", import.meta.url);
const NGINX_CONFIG_PATH = new URL("../nginx/default.conf", import.meta.url);
const STATUS_WIDGET_PATH = new URL("../dashboard/widgets/status.js", import.meta.url);

function readNumericConstant(source, name) {
  const match = source.match(new RegExp(`const ${name} = ([^;]+);`));
  assert.ok(match, `${name} must be configured as a named constant.`);

  const factors = match[1]
    .split("*")
    .map((factor) => Number(factor.trim().replaceAll("_", "")));
  assert.ok(factors.every(Number.isFinite), `${name} must use a numeric expression.`);

  return factors.reduce((product, factor) => product * factor, 1);
}

test("status request deadlines increase across gateway, proxy, and browser", async () => {
  const [gatewayConfig, nginxConfig, statusWidget] = await Promise.all([
    fs.readFile(GATEWAY_CONFIG_PATH, "utf8"),
    fs.readFile(NGINX_CONFIG_PATH, "utf8"),
    fs.readFile(STATUS_WIDGET_PATH, "utf8")
  ]);

  const gatewayDeadlineMs = readNumericConstant(gatewayConfig, "STATUS_BATCH_DEADLINE_MS");
  const browserDeadlineMs = readNumericConstant(statusWidget, "STATUS_BATCH_TIMEOUT_MS");
  const proxyTimeoutMatch = nginxConfig.match(/proxy_read_timeout\s+(\d+)s;/);

  assert.ok(proxyTimeoutMatch, "Nginx must configure an API response timeout.");
  const proxyDeadlineMs = Number(proxyTimeoutMatch[1]) * MILLISECONDS_PER_SECOND;

  assert.ok(gatewayDeadlineMs < proxyDeadlineMs, "Nginx must outlast the gateway batch.");
  assert.ok(proxyDeadlineMs < browserDeadlineMs, "The browser must outlast Nginx.");
});
