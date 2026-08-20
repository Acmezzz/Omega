/**
 * Agent bridge — keeps the agent session in the Electron main process and
 * exposes only renderer-safe event DTOs.
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

/** Convert an SDK event into a minimal renderer DTO. */
export function toRendererEvent(event) {
	if (!event || typeof event !== "object" || typeof event.type !== "string") return null;
	const type = event.type;
  if (type === "message_start") {
    const role = event.message?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return null;
    const id = textValue(event.message?.id);
    const text = textValue(event.message?.content);
    return { type, message: { role, ...(id ? { id } : {}), ...(text ? { text } : {}) } };
  }
	if (type === "message_update") {
		const update = event.assistantMessageEvent;
		if (!update || typeof update !== "object" || typeof update.type !== "string") return null;
		if (update.type === "text_delta") return { type, assistantMessageEvent: { type: update.type, delta: textValue(update.delta) ?? "" } };
		if (update.type === "toolcall_start" || update.type === "toolcall_end" || update.type === "tool_call") {
			return { type, assistantMessageEvent: { type: update.type, toolName: textValue(update.toolName) ?? textValue(update.tool) } };
		}
		return null;
	}
	if (type === "tool_execution_start") return { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
	if (type === "tool_execution_update") return { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
	if (type === "tool_execution_end") return { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool", isError: event.isError === true };
	if (["agent_start", "agent_end", "turn_start", "turn_end", "agent_settled", "session_start", "session_shutdown"].includes(type)) return { type };
	if (type === "error" || type.endsWith("_error")) return { type, message: textValue(event.message) ?? "Agent error" };
	return null;
}

export function streamToRenderer(session, webContents) {
	const unsubscribe = session.subscribe((event) => {
		if (webContents.isDestroyed()) return;
		const safeEvent = toRendererEvent(event);
		if (safeEvent) webContents.send("agent:event", safeEvent);
	});
	return unsubscribe;
}
