import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GLOBAL_CSS_PATH = new URL("../dashboard/platform/global.css", import.meta.url);

test("flippable tiles keep the front in flow and overlay a content-sized back", async () => {
  const css = await readFile(GLOBAL_CSS_PATH, "utf8");

  assert.match(
    css,
    /\.flippable-tile\s*{[^}]*position:\s*relative;/s
  );
  assert.match(
    css,
    /\.flippable-tile-face--back\s*{[^}]*position:\s*absolute;[^}]*width:\s*max-content;/s
  );
  assert.match(
    css,
    /\.flippable-tile--flipped\s*{[^}]*z-index:\s*var\(--flippable-tile-open-z-index\);/s
  );
});
