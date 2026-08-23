import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GLOBAL_CSS_PATH = new URL("../dashboard/platform/global.css", import.meta.url);
const STATUS_WIDGET_PATH = new URL("../dashboard/widgets/status.js", import.meta.url);
const globalCss = readFile(GLOBAL_CSS_PATH, "utf8");
const statusWidget = readFile(STATUS_WIDGET_PATH, "utf8");

test("clickable surfaces accept widget-specific background and border tokens", async () => {
  const css = await globalCss;

  assert.match(
    css,
    /\.clickable\s*{[^}]*background:\s*var\(--clickable-background,\s*var\(--bg\)\);/s
  );
  assert.match(
    css,
    /\.clickable\s*{[^}]*border:\s*1px solid var\(--clickable-border,\s*var\(--bg\)\);/s
  );
});

test("status entries use open instrument lines instead of ui tiles", async () => {
  const source = await statusWidget;

  assert.match(
    source,
    /\.status-tile-shell\s*{[^}]*--clickable-background:\s*transparent;[^}]*--clickable-border:\s*transparent;/s
  );
  assert.match(
    source,
    /\.status-tile::after\s*{[^}]*background:\s*var\(--status-line-color\);[^}]*grid-area:\s*line;/s
  );
  assert.match(source, /createResponsiveGrid\(props,\s*"status-list"\)/);
  assert.match(source, /link\.className\s*=\s*"status-tile-shell";/);
  assert.doesNotMatch(source, /link\.className\s*=\s*"[^"\n]*ui-tile/);
});
