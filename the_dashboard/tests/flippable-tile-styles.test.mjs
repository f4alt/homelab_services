import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const GLOBAL_CSS_PATH = new URL("../dashboard/platform/global.css", import.meta.url);
const globalCss = readFile(GLOBAL_CSS_PATH, "utf8");

test("flippable tiles keep the front in flow and overlay a content-sized back", async () => {
  const css = await globalCss;

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

test("flippable tile backs never shrink below either front-face dimension", async () => {
  const css = await globalCss;

  assert.match(
    css,
    /\.flippable-tile-face--back\s*{[^}]*min-height:\s*100%;[^}]*min-width:\s*100%;/s
  );
});

test("flippable tile backs stay centered on the front face while growing", async () => {
  const css = await globalCss;

  assert.match(
    css,
    /\.flippable-tile-face--back\s*{[^}]*inset-inline-start:\s*50%;[^}]*translate:\s*-50%\s+0;/s
  );
});

test("scroll lists disable x overflow and anchored tile backs use fixed positioning", async () => {
  const css = await globalCss;

  assert.match(
    css,
    /\.list-scroll\s*{[^}]*overflow-x:\s*clip;[^}]*overflow-y:\s*auto;/s
  );
  assert.match(
    css,
    /\.flippable-tile-face--floating\s*{[^}]*position:\s*fixed;/s
  );
});
