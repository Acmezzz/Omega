import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { toRendererEvent } from "../electron/agent-bridge.js";

test("main configures Electron isolation and navigation boundaries", async () => {
  const source = await readFile(new URL("../electron/main.js", import.meta.url), "utf8");
  assert.match(source, /contextIsolation:\s*true/);
  assert.match(source, /nodeIntegration:\s*false/);
  assert.match(source, /sandbox:\s*true/);
  assert.match(source, /setWindowOpenHandler/);
  assert.match(source, /will-navigate/);
  assert.match(source, /senderAllowed/);
  assert.match(source, /session\?\.dispose/);
});

test("bridge filters raw agent events and does not forward sensitive payloads", async () => {
  const source = await readFile(new URL("../electron/agent-bridge.js", import.meta.url), "utf8");
  assert.match(source, /toRendererEvent/);
  assert.match(source, /webContents\.isDestroyed/);
  assert.match(source, /event\.message\?\.id/);
  assert.doesNotMatch(source, /webContents\.send\("agent:event", event\)/);
});

test("DTO conversion keeps IDs and strips raw sensitive event fields", () => {
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
  assert.deepEqual(result, {
    type: "message_start",
    message: { role: "assistant", id: "assistant-1", text: "hello" },
  });
});

test("preload exposes a narrow validated bridge", async () => {
  const source = await readFile(new URL("../electron/preload.js", import.meta.url), "utf8");
  assert.match(source, /contextBridge\.exposeInMainWorld/);
  assert.match(source, /MAX_PROMPT_CHARS/);
  assert.match(source, /typeof callback !== "function"/);
  assert.doesNotMatch(source, /exposeInMainWorld\([^,]+,\s*ipcRenderer/);
});
