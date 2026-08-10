#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ALLOWED_STATUS = 200;
const COMPOSE_EXEC_TIMEOUT_MS = 30_000;
const DENIED_STATUS = 403;
const DASHBOARD_DIRECTORY = fileURLToPath(new URL("..", import.meta.url));
const PROXY_REQUEST_TIMEOUT_MS = 5_000;
const PROBE_SOURCE = `
  const baseUrl = "http://docker_socket_proxy:2375";
  const request = (path, options = {}) => fetch(baseUrl + path, {
    ...options,
    signal: AbortSignal.timeout(${PROXY_REQUEST_TIMEOUT_MS})
  });
  const probes = await Promise.all([
    request("/containers/json?all=1"),
    request("/containers/create", { method: "POST" }),
    request("/images/json")
  ]);
  console.log(JSON.stringify(probes.map((response) => response.status)));
`;
const COMPOSE_EXEC_ARGUMENTS = Object.freeze([
  "compose",
  "exec",
  "-T",
  "gateway",
  "node",
  "--input-type=module",
  "-e",
  PROBE_SOURCE
]);

function runProxyProbe() {
  return new Promise((resolve, reject) => {
    execFile(
      "docker",
      COMPOSE_EXEC_ARGUMENTS,
      { cwd: DASHBOARD_DIRECTORY, timeout: COMPOSE_EXEC_TIMEOUT_MS },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`Container proxy verification failed: ${stderr || error.message}`));
          return;
        }
        resolve(JSON.parse(stdout.trim()));
      }
    );
  });
}

const [containerListStatus, createContainerStatus, imageListStatus] = await runProxyProbe();

assert.equal(containerListStatus, ALLOWED_STATUS, "container listing should be allowed");
assert.equal(createContainerStatus, DENIED_STATUS, "container creation should be denied");
assert.equal(imageListStatus, DENIED_STATUS, "non-container Docker APIs should be denied");

console.log("[PASS] Docker proxy permits container reads and rejects broader access.");
