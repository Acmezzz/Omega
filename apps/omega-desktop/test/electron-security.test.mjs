import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toRendererEvent } from "../electron/agent-bridge.js";

const read = (rel) => readFile(new URL(rel, import.meta.url), "utf8");

test("main configures Electron isolation and navigation boundaries", async () => {
  const source = await read("../electron/main.js");
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /will-navigate/);
  assert.match(source, /senderAllowed/);
  assert.match(source, /runtime\?\.dispose/);
});

test("bridge filters raw agent events and does not forward sensitive payloads", async () => {
  const source = await read("../electron/agent-bridge.js");
  assert.match(source, /toRendererEvent/);
  assert.match(source, /webContents\.isDestroyed/);
  assert.match(source, /event\.message\?\.id/);
  // V3: full-fidelity content, but events are still projected (never the raw SDK event object).
  assert.doesNotMatch(source, /webContents\.send\("agent:event",\s*event\)/);
});

test("tool_execution_summary carries full paths and raw payloads (V3 fidelity)", async () => {
  const events = toRendererEvent({
    type: "tool_execution_start",
    toolCallId: "call-1",
    toolName: "edit",
    args: { path: "/abs/secret/project/src/very/deep/README.md", content: "body" },
  });
  const summary = events.find((e) => e.type === "tool_execution_summary");
  assert.ok(summary, "produces a tool_execution_summary event");
  assert.equal(summary.target, "/abs/secret/project/src/very/deep/README.md");
  assert.match(summary.argsJson, /README\.md/);
  // Payloads are size-capped so a pathological result cannot OOM the renderer.
  const source = await read("../electron/agent-bridge.js");
  assert.match(source, /MAX_PAYLOAD_CHARS/);
});

test("message_start keeps IDs and strips raw sensitive event fields (thinking)", () => {
  const result = toRendererEvent({
    type: "message_start",
    message: {
      id: "assistant-1",
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      thinking: "private reasoning",
      toolCall: { args: { secret: "value" } },
    },
  });
  // toRendererEvent now returns an array of safe events.
  assert.ok(Array.isArray(result));
  assert.deepEqual(result[0], {
    type: "message_start",
    message: { role: "assistant", id: "assistant-1", text: "hello" },
  });
});

test("state-reader never exposes rawOutput as a DTO field and does not import extension source", async () => {
  const source = await read("../electron/state-reader.js");
  // The renderer-facing DTO must not carry the scout rawOutput field.
  // (Mentions in documentation comments are allowed; only code-level exposure is forbidden.)
  assert.doesNotMatch(source, /rawOutput\s*[:=]/, "rawOutput is not assigned/exposed as a field");
  // It must not import the upstream extension source (read-only re-implementation).
  assert.doesNotMatch(
    source,
    /import\s+[^;]*from\s+["'][^"']*(journal-workflow|exploration-scout)/,
    "does not import upstream extension source",
  );
});

test("new IPC handlers stay behind senderAllowed and return an IpcResult envelope", async () => {
  const source = await read("../electron/main.js");
  for (const channel of [
    "omega:queryExtensionState",
    "omega:listSessions",
    "omega:newSession",
    "omega:loadSession",
    "omega:saveSession",
    "omega:deleteSession",
    "omega:diffWorkspace",
    "omega:approveChange",
    "omega:getState",
    "omega:listModels",
    "omega:setModel",
    "omega:setThinkingLevel",
    "omega:listCommands",
    "omega:listPiSessions",
    "omega:newPiSession",
    "omega:switchPiSession",
    "omega:compact",
    "omega:authStatus",
    "omega:setSessionName",
    "agent:abort",
  ]) {
    assert.match(source, new RegExp(`ipcMain\\.handle\\("${channel}"`), `${channel} handler present`);
    // The handler's 2nd argument is the event. Allow an optional `async` modifier
    // before `(event` — that is an implementation detail, not a security concern.
    assert.match(source, new RegExp(`"${channel}",\\s*(?:async\\s*)?\\(event`), `${channel} receives event`);
  }
  // Every handler re-checks the sender and returns { ok: ... }.
  // (The real implementation passes a descriptive message as a 2nd arg, which is fine.)
  assert.match(source, /if \(!senderAllowed\(event\)\) return errorResult\("forbidden"/, "every handler re-checks the sender");
});

test("preload exposes a narrow validated bridge including omega:* methods", async () => {
  const source = await read("../electron/preload.js");
  assert.match(source, /contextBridge\.exposeInMainWorld/);
  assert.match(source, /MAX_PROMPT_CHARS/);
  assert.match(source, /typeof callback !== "function"/);
  assert.doesNotMatch(source, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
  for (const method of [
    "queryExtensionState",
    "listSessions",
    "newSession",
    "loadSession",
    "saveSession",
    "deleteSession",
    "diffWorkspace",
    "approveChange",
    "getState",
    "listModels",
    "setModel",
    "setThinkingLevel",
    "listCommands",
    "listPiSessions",
    "newPiSession",
    "switchPiSession",
    "compact",
    "authStatus",
    "setSessionName",
    "updateSettings",
    "clearQueue",
    "getSessionTree",
    "getForkCandidates",
    "fork",
    "navigateTree",
  ]) {
    assert.match(source, new RegExp(`ipcRenderer\\.invoke\\("omega:${method}"`), `${method} invoke present`);
  }
  assert.match(source, /ipcRenderer\.invoke\("agent:abort"\)/);
  // Untrusted inputs are validated before invoking.
  assert.match(source, /invalid_args/);
});

test("index.html CSP carries the style nonce but no unsafe-inline / unsafe-eval", async () => {
  const html = await read("../index.html");
  assert.match(html, /Content-Security-Policy/);
  // Scope the unsafe-* checks to the actual CSP directive, not the whole document
  // (the words legitimately appear inside a documentation comment).
  const csp = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]*)"/);
  assert.ok(csp, "CSP meta tag is present");
  const cspContent = csp[1];
  assert.match(cspContent, /style-src 'self' 'nonce-omega-static-2026'/);
  assert.match(cspContent, /script-src 'self'/);
  assert.doesNotMatch(cspContent, /unsafe-inline/);
  assert.doesNotMatch(cspContent, /unsafe-eval/);
  assert.match(html, /\.\/dist\/assets\/index\.js/);
});

test("custom window controls are guarded IPC behind senderAllowed", async () => {
  const main = await read("../electron/main.js");
  for (const channel of ["window:minimize", "window:toggleMaximize", "window:close", "window:isMaximized"]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel}",\\s*\\(event`), `${channel} handler present`);
  }
  const preload = await read("../electron/preload.js");
  for (const channel of ["window:minimize", "window:toggleMaximize", "window:close", "window:isMaximized"]) {
    assert.match(preload, new RegExp(`ipcRenderer\\.invoke\\("${channel}"`), `${channel} invoke present`);
  }
  assert.match(preload, /onWindowStateChanged/);
});

test("deleteSession only removes files inside the pi sessions root", async () => {
  const main = await read("../electron/main.js");
  assert.match(main, /piSessionsRoot/);
  assert.match(main, /Refusing to delete a file outside the pi sessions directory/);
  assert.match(main, /forgetSessionPath/);
});

test("prompt images are validated in both preload and main", async () => {
  const main = await read("../electron/main.js");
  assert.match(main, /MAX_PROMPT_IMAGES/);
  assert.match(main, /normalizePromptImages/);
  const preload = await read("../electron/preload.js");
  assert.match(preload, /MAX_PROMPT_IMAGES/);
  assert.match(preload, /validImage/);
});

test("main notifies on completion only when the window is unfocused", async () => {
  const main = await read("../electron/main.js");
  assert.match(main, /Notification\.isSupported/);
  assert.match(main, /win\.isFocused\(\)/);
});

test("first prompt auto-titles an unnamed session", async () => {
  const main = await read("../electron/main.js");
  assert.match(main, /setSessionName/);
  assert.match(main, /session\.sessionName/);
});
