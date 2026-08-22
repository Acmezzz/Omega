import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { sanitizeTranscript, toRendererEvent } from "../electron/agent-bridge.js";

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
  assert.match(source, /createAgentSessionRuntime/);
});

test("thinking deltas become thinking_status without any reasoning text", () => {
  const events = toRendererEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "secret chain of thought" },
  });
  assert.deepEqual(events, [{ type: "thinking_status", active: true }]);
  assert.equal(JSON.stringify(events).includes("secret"), false);
});

test("thinking_end marks thinking_status inactive", () => {
  const events = toRendererEvent({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_end" },
  });
  assert.deepEqual(events, [{ type: "thinking_status", active: false }]);
});

test("compaction events expose status only", () => {
  const start = toRendererEvent({ type: "compaction_start", reason: "manual" });
  assert.deepEqual(start, [{ type: "compaction_start", status: "start" }]);
  const end = toRendererEvent({
    type: "compaction_end",
    reason: "manual",
    result: { summary: "private compaction text", tokensBefore: 12000 },
    aborted: false,
  });
  assert.deepEqual(end, [{ type: "compaction_end", status: "done" }]);
  assert.equal(JSON.stringify(end).includes("private compaction"), false);
});

test("queue_update forwards a count, not queued text", () => {
  const events = toRendererEvent({
    type: "queue_update",
    steering: ["do not leak this"],
    followUp: ["or this"],
  });
  assert.deepEqual(events, [{ type: "queue_update", pendingCount: 2 }]);
});

test("sanitizeTranscript drops thinking and tool payloads", () => {
  const { messages, toolCards } = sanitizeTranscript([
    { id: "u1", role: "user", content: "hello", timestamp: "2026-01-01T00:00:00.000Z" },
    {
      id: "a1",
      role: "assistant",
      content: [
        { type: "thinking", text: "hidden reasoning" },
        { type: "text", text: "visible" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "/abs/secret/README.md" } },
      ],
      timestamp: "2026-01-01T00:00:01.000Z",
    },
  ]);
  assert.equal(messages[1].text, "visible");
  assert.equal(JSON.stringify(messages).includes("hidden reasoning"), false);
  assert.equal(toolCards[0].target, "README.md");
  assert.equal(toolCards[0].afterMessageId, "a1");
  assert.equal(toolCards[0].args, undefined);
});

test("command palette discovers commands instead of hardcoding the V1 list", async () => {
  const source = await read("../src/renderer/components/layout/CommandPalette.tsx");
  assert.match(source, /listCommands/);
  assert.doesNotMatch(source, /const COMMANDS/);
});

test("prompt channel supports steering interrupts while streaming", async () => {
  const main = await read("../electron/main.js");
  assert.match(main, /PROMPT_BEHAVIORS/);
  assert.match(main, /"steer"/);
});

test("agent tools include the pi search tools (grep/find/ls)", async () => {
  const source = await read("../electron/agent-bridge.js");
  assert.match(source, /\["read", "bash", "edit", "write", "grep", "find", "ls"\]/);
});

test("native menu bar is replaced by the in-app title bar", async () => {
  const main = await read("../electron/main.js");
  assert.match(main, /Menu\.setApplicationMenu\(null\)/);
  const titleBar = await read("../src/renderer/components/layout/TitleBar.tsx");
  assert.match(titleBar, /WebkitAppRegion/);
  assert.match(titleBar, /ipc\.minimize/);
  assert.match(titleBar, /ipc\.toggleMaximize/);
  assert.match(titleBar, /ipc\.closeWindow/);
});

test("session list supports search, rename, and delete affordances", async () => {
  const source = await read("../src/renderer/components/sessions/SessionList.tsx");
  assert.match(source, /搜索会话/);
  assert.match(source, /setSessionName/);
  assert.match(source, /deleteSession/);
});

test("workbench registers Ctrl+K palette and Ctrl+Shift+N new-session shortcuts", async () => {
  const source = await read("../src/renderer/App.tsx");
  assert.match(source, /keydown/);
  assert.match(source, /"k"/);
  assert.match(source, /Shift.*new|shiftKey/);
});

test("composer supports image paste, attach, and removable chips", async () => {
  const source = await read("../src/renderer/components/chat/Composer.tsx");
  assert.match(source, /onPaste/);
  assert.match(source, /readImageFile/);
  assert.match(source, /AttachFile/);
  assert.match(source, /onDelete/);
});

test("settings dialog drives queue modes and auto toggles via IPC", async () => {
  const source = await read("../src/renderer/components/layout/SettingsDialog.tsx");
  assert.match(source, /updateSettings/);
  assert.match(source, /steeringMode/);
  assert.match(source, /followUpMode/);
  assert.match(source, /autoCompaction/);
  assert.match(source, /autoRetry/);
});
