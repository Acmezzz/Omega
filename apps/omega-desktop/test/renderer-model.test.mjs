import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toRendererEvent } from "../electron/agent-bridge.js";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("agent:event message_start contract is preserved (role/id/text)", () => {
  const events = toRendererEvent({
    type: "message_start",
    message: { id: "assistant-1", role: "assistant", content: [{ type: "text", text: "hello" }] },
  });
  const messageStart = events.find((e) => e.type === "message_start");
  assert.ok(messageStart, "message_start is emitted");
  assert.deepEqual(messageStart.message, { role: "assistant", id: "assistant-1", text: "hello" });
});

test("agent:event text_delta is preserved and additive only", () => {
  const events = toRendererEvent({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "world" },
  });
  const delta = events.find((e) => e.type === "message_update" && e.assistantMessageEvent.type === "text_delta");
  assert.ok(delta, "text_delta is emitted");
  assert.equal(delta.assistantMessageEvent.delta, "world");
});

test("tool_execution_summary is additive and does not alter existing event fields", () => {
  // The original tool_execution_start shape must remain identical.
  const base = toRendererEvent({
    type: "tool_execution_start",
    toolCallId: "call-9",
    toolName: "read",
  });
  const safe = base.find((e) => e.type === "tool_execution_start");
  assert.deepEqual(safe, { type: "tool_execution_start", toolCallId: "call-9", toolName: "read" });

  // And a summary event is produced alongside it.
  const summary = base.find((e) => e.type === "tool_execution_summary");
  assert.ok(summary, "summary event is added");
  assert.equal(summary.toolCallId, "call-9");
  assert.equal(summary.status, "running");
});

test("tool_execution_end marks the summary as done/error", () => {
  const end = toRendererEvent({
    type: "tool_execution_end",
    toolCallId: "call-9",
    toolName: "read",
    isError: true,
  });
  const summary = end.find((e) => e.type === "tool_execution_summary");
  assert.ok(summary);
  assert.equal(summary.status, "error");
  assert.ok(summary.endedAt, "endedAt timestamp is set");
});

test("index.html keeps a CSP boundary and references the built bundle", async () => {
  const html = await read("../index.html");
  assert.match(html, /lang="zh-CN"/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /\.\/dist\/assets\/index\.js/);
  assert.match(html, /\.\/dist\/assets\/index\.css/);
});

test("bridge source still wires the agent event channel", async () => {
  const source = await read("../electron/agent-bridge.js");
  assert.match(source, /webContents\.send\("agent:event"/);
  assert.match(source, /tool_execution_summary/);
});
