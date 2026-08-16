/**
 * journal-workflow extension entry.
 * Loads config and wires the adapter; the adapter defaults to a ctx-bound
 * session-model LLM client for all auxiliary calls (distill/match/validate).
 * Engine (M3), commands (M4) and evolution (M5) attach inside wire() as they land.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { wire } from "./adapter.ts";

export default function journalWorkflowExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) return;
	wire(pi, { config });
}
