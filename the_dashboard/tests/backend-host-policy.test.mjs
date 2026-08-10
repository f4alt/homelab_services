import assert from "node:assert/strict";
import test from "node:test";

import { hostIsAllowed, hostIsLocal } from "../gateway/platform/config.js";

test("host allowlist matching ignores surrounding whitespace and case", () => {
  assert.equal(hostIsAllowed(" Example.COM ", ["example.com"]), true);
  assert.equal(hostIsAllowed("example.net", ["example.com"]), false);
});

test("host allowlist matching preserves wildcard semantics", () => {
  assert.equal(hostIsAllowed("anything.example", ["*"]), true);
  assert.equal(hostIsAllowed("node.example.com", ["*.example.com"]), true);
  assert.equal(hostIsAllowed("example.com", ["*.example.com"]), false);
  assert.equal(hostIsAllowed("home-router", ["home-*"]), true);
  assert.equal(hostIsAllowed("router-home", ["home-*"]), false);
  assert.equal(hostIsAllowed("localhost", [""]), false);
});

test("local host matching covers browser loopback spellings", () => {
  assert.equal(hostIsLocal("localhost"), true);
  assert.equal(hostIsLocal("127.0.0.1"), true);
  assert.equal(hostIsLocal("[::1]"), true);
  assert.equal(hostIsLocal("localhost.example"), false);
});
