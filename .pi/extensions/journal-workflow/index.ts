/**
 * journal-workflow extension entry.
 * Loads config and wires the adapter; the adapter defaults to a ctx-bound
 * session-model LLM client for auxiliary distill, match and checkpoint calls;
 * wire() connects journal events, workflow guidance, engine state and commands.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { wire } from "./adapter.ts";

export default function journalWorkflowExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) return;
	wire(pi, { config });
}
