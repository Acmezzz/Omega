import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = new URL("../", import.meta.url);

test("renderer uses text-only DOM updates and aggregates deltas", async () => {
  const source = await readFile(new URL("../renderer.js", import.meta.url), "utf8");
  assert.match(source, /textContent/);
  assert.doesNotMatch(source, /innerHTML/);
  assert.match(source, /pendingDeltas/);
  assert.match(source, /requestAnimationFrame/);
  assert.match(source, /pendingUsers/);
  assert.match(source, /reconcileUserMessage/);
});

test("index contains accessibility and CSP boundaries", async () => {
  const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /role="log"/);
  assert.match(html, /<form id="composer"/);
});
