/**
 * Agent bridge — keeps the agent session in the Electron main process and
 * exposes only renderer-safe event DTOs.
 *
 * `toRendererEvent` now ALSO derives a `tool_execution_summary` event for tool
 * calls. The `target` field is ONLY the file basename (extracted from the raw
 * tool args and immediately discarded) — the renderer never receives the full
 * path, raw parameters, results, or any thinking. See system_design.md §3.2.
 */
import { createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const DEV_EXTENSIONS_ROOT = resolve(fileURLToPath(new URL("../../../.pi/extensions", import.meta.url)));

function extensionsRootOf(value) {
  const root = value ?? process.env.OMEGA_EXTENSIONS_ROOT ?? DEV_EXTENSIONS_ROOT;
  if (!existsSync(root)) throw new Error(`Omega extensions directory not found: ${root}`);
  return root;
}

/** Create a fresh agent session in the main process. */
export async function createSession({ cwd, extensionsRoot }) {
  const omegaExtensions = extensionsRootOf(extensionsRoot);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: AGENT_DIR,
    additionalExtensionPaths: [
      join(omegaExtensions, "journal-workflow", "index.ts"),
      join(omegaExtensions, "exploration-scout", "index.ts"),
    ],
    settingsManager: SettingsManager.create(cwd, AGENT_DIR),
  });
  await resourceLoader.reload();
  return createAgentSession({ cwd, agentDir: AGENT_DIR, resourceLoader, tools: ["read", "bash", "edit", "write"] });
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value.map((item) => {
    if (typeof item === "string") return item;
    if (item && typeof item === "object" && typeof item.text === "string") return item.text;
    return "";
  }).filter(Boolean);
  return parts.length > 0 ? parts.join("") : undefined;
}

function basenameOf(value) {
  const parts = String(value).split(/[\\/]/);
  return parts[parts.length - 1] || undefined;
}

/** Extract ONLY the file basename from raw tool args (everything else is dropped). */
function extractTargetBasename(args) {
  if (!args || typeof args !== "object") return undefined;
  const candidates = [args.path, args.file, args.filePath, args.file_path];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return basenameOf(candidate);
  }
  return undefined;
}

function classifyKind(toolName) {
  if (toolName === "read") return "read";
  if (toolName === "write") return "write";
  if (toolName === "edit") return "edit";
  if (toolName === "bash") return "bash";
  return "other";
}

/** Build a safe `tool_execution_summary` from a raw tool event (basename only). */
function toToolSummary(event, status) {
  const toolName = textValue(event.toolName) ?? "tool";
  return {
    type: "tool_execution_summary",
    toolCallId: textValue(event.toolCallId) ?? `tool-${Date.now()}`,
    toolName,
    kind: classifyKind(toolName),
    target: extractTargetBasename(event.args),
    op: toolName,
    status,
    ...(status === "running" ? { startedAt: new Date().toISOString() } : { endedAt: new Date().toISOString() }),
  };
}

/**
 * Convert an SDK event into one or more minimal renderer DTOs.
 * Returns an array (some inputs expand into a safe event + a summary event).
 */
export function toRendererEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return [];
  const type = event.type;
  if (type === "message_start") {
    const role = event.message?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return [];
    const id = textValue(event.message?.id);
    const text = textValue(event.message?.content);
    return [{ type, message: { role, ...(id ? { id } : {}), ...(text ? { text } : {}) } }];
  }
  if (type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update || typeof update !== "object" || typeof update.type !== "string") return [];
    if (update.type === "text_delta") return [{ type, assistantMessageEvent: { type: update.type, delta: textValue(update.delta) ?? "" } }];
    if (update.type === "toolcall_start" || update.type === "toolcall_end" || update.type === "tool_call") {
      return [{ type, assistantMessageEvent: { type: update.type, toolName: textValue(update.toolName) ?? textValue(update.tool) } }];
    }
    return [];
  }
  if (type === "tool_execution_start") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
    return [safe, toToolSummary(event, "running")];
  }
  if (type === "tool_execution_update") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
    return [safe];
  }
  if (type === "tool_execution_end") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool", isError: event.isError === true };
    return [safe, toToolSummary(event, event.isError === true ? "error" : "done")];
  }
  if (["agent_start", "agent_end", "turn_start", "turn_end", "agent_settled", "session_start", "session_shutdown"].includes(type)) return [{ type }];
  if (type === "error" || type.endsWith("_error")) return [{ type, message: textValue(event.message) ?? "Agent error" }];
  return [];
}

export function streamToRenderer(session, webContents) {
  const unsubscribe = session.subscribe((event) => {
    if (webContents.isDestroyed()) return;
    const safeEvents = toRendererEvent(event);
    for (const safeEvent of safeEvents) {
      if (safeEvent) webContents.send("agent:event", safeEvent);
    }
  });
  return unsubscribe;
}
