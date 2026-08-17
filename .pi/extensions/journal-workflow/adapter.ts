/**
 * Pi adapter: the ONLY module that touches Pi extension APIs.
 * Translates Pi events into SimEvents for the core JournalWriter and exposes
 * core outputs (patches, workflow guidance, escape messages) back to Pi.
 *
 * wire() is shared between the real extension entry (index.ts) and the test
 * fake-pi harness, so event replay tests exercise the identical wiring code.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LlmClient } from "./core/llm.ts";
import { textFromContent } from "./core/llm.ts";
import { JournalWriter } from "./core/journal/writer.ts";
import { projectKeyFromCwd } from "./core/journal/types.ts";
import { resolveEntryIds, type EntryLike } from "./core/journal/refs.ts";
import { distillTurn, type PrevTurnContext } from "./core/journal/distill.ts";
import { WorkflowStore } from "./core/library/store.ts";
import type { RegistryEntry } from "./core/library/types.ts";
import { matchWorkflow, type MatchCache } from "./core/engine/matcher.ts";
import { renderGuidance } from "./core/engine/injector.ts";
import { checkExpect } from "./core/engine/validator.ts";
import { EngineTracker, type EngineAction } from "./core/engine/tracker.ts";
import { registerWorkflowCommands, type CommandPi } from "./commands.ts";
import type { JournalWorkflowConfig } from "./config.ts";

export interface WireDeps {
	config: JournalWorkflowConfig;
	/** Injected LLM client; defaults to a ctx-bound session-model client. */
	llm?: LlmClient;
	/** Test hook: notified after each wired handler runs. */
	afterEvent?: (kind: string) => void;
}

/** Minimal shape of the handler ctx we consume (keeps fake-pi simple). */
export interface HandlerCtx {
	cwd: string;
	sessionManager?: {
		getHeader?: () => { id: string };
		getEntries?: () => Array<{ id: string; message?: unknown; type: string }>;
	};
	model?: unknown;
	modelRegistry?: {
		complete?: (
			model: unknown,
			context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown; timestamp: number }> },
			options?: { maxTokens?: number },
		) => Promise<{ content: unknown }>;
	};
}

export function userTextOf(content: unknown): string {
	if (typeof content === "string") return content;
	const text = textFromContent(content);
	return text ?? "";
}

/** Extract visible thinking (CoT) text from an assistant message content array. */
export function thinkingTextOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "thinking") {
			const thinking = (part as { thinking?: unknown }).thinking;
			if (typeof thinking === "string" && thinking.length > 0) parts.push(thinking);
		}
	}
	return parts.join("\n");
}

/**
 * Split interleaved assistant content into per-tool-call reasoning segments.
 * Structure: [thinking A, toolCall 1, thinking B, toolCall 2, text] — the
 * thinking accumulated right before each toolCall is WHY that call was made.
 * Trailing thinking (after the last call) maps to null (it narrates the reply).
 */
export function reasoningByToolCall(content: unknown): Map<string, string> {
	const map = new Map<string, string>();
	if (!Array.isArray(content)) return map;
	let buffer: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const type = (part as { type?: string }).type;
		if (type === "thinking") {
			const thinking = (part as { thinking?: unknown }).thinking;
			if (typeof thinking === "string" && thinking.length > 0) buffer.push(thinking);
		} else if (type === "toolCall") {
			const id = (part as { id?: unknown }).id;
			if (typeof id === "string") {
				map.set(id, buffer.join("\n"));
				buffer = [];
			}
		}
	}
	return map;
}

/** Build a real LlmClient bound to the handler ctx (session model, auth automatic). */
export function makeCtxLlm(getCtx: () => HandlerCtx | undefined): LlmClient {
	return {
		async complete(input) {
			const ctx = getCtx();
			if (!ctx?.modelRegistry?.complete || !ctx.model) {
				throw new Error("journal-workflow: no model available for aux LLM call");
			}
			const result = await ctx.modelRegistry.complete(
				ctx.model,
				{
					systemPrompt: input.systemPrompt,
					messages: [{ role: "user", content: input.userPayload, timestamp: Date.now() }],
				},
				{ maxTokens: input.maxTokens },
			);
			return textFromContent(result.content) ?? "";
		},
	};
}

export interface WiredRuntime {
	/** Current writer (null before session_start resolves a task id). */
	getWriter(): JournalWriter | null;
	/** Latest handler ctx (persisted after the first event). */
	getCtx(): HandlerCtx | undefined;
	/** The LLM client in use (injected fake or ctx-bound real one). */
	getLlm(): LlmClient;
	/** In-flight fire-and-forget distill promises (tests await these). */
	getPendingDistills(): Array<Promise<void>>;
	/** In-flight fire-and-forget engine validations (tests await these). */
	getPendingChecks(): Array<Promise<void>>;
	/** Active workflow entry id, when the engine is guiding this turn. */
	getActiveWorkflowId(): string | null;
}

export function wire(pi: ExtensionAPI, deps: WireDeps): WiredRuntime {
	let writer: JournalWriter | null = null;
	let currentCtx: HandlerCtx | undefined;
	let lastUserMessage: unknown = null;
	let lastAssistantMessage: unknown = null;
	let lastAssistantText: string | null = null;
	/** Per-tool-call reasoning segments extracted from assistant messages. */
	const reasoningById = new Map<string, string>();
	let prevContext: PrevTurnContext | null = null;
	const pendingDistills = new Set<Promise<void>>();
	const pendingChecks = new Set<Promise<void>>();
	const llm: LlmClient = deps.llm ?? makeCtxLlm(() => currentCtx);

	// ---- Engine state (per session) ----
	let store: WorkflowStore | null = null;
	let tracker: EngineTracker | null = null;
	let activeEntry: RegistryEntry | null = null;
	const matchCache: MatchCache = new Map<string, RegistryEntry | null>() as MatchCache;

	const getStore = (): WorkflowStore => {
		if (!store) store = WorkflowStore.load(deps.config.workflowsRoot);
		return store;
	};

	const steer = (text: string): void => {
		// CustomMessage.display is a boolean (show in UI), not display text.
		const message = { customType: "journal-workflow", content: text, display: true };
		try {
			pi.sendMessage(message, { deliverAs: "steer" });
		} catch {
			// steer only works mid-stream; degradation to followUp is acceptable
			try {
				pi.sendMessage(message, { deliverAs: "followUp" });
			} catch {
				// messaging unavailable — journal still records the outcome
			}
		}
	};

	const executeEngineActions = (actions: EngineAction[]): void => {
		for (const action of actions) {
			if (action.message !== null) steer(action.message);
			if (action.type === "escape") {
				writer?.appendFailure(action.failure);
				if (activeEntry) getStore().bumpEscape(activeEntry.id);
				tracker = null;
			}
		}
	};

	const ensureWriter = (ctx: HandlerCtx): JournalWriter | null => {
		if (writer) return writer;
		const header = ctx.sessionManager?.getHeader?.();
		if (!header?.id) return null;
		const key = projectKeyFromCwd(ctx.cwd);
		writer = new JournalWriter(deps.config.journalsRoot, key, header.id);
		return writer;
	};

	pi.on("session_start", (_event: unknown, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		ensureWriter(currentCtx);
		deps.afterEvent?.("session_start");
	});

	pi.on("message_end", (event: { message?: { role?: string; content?: unknown } }, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		const w = ensureWriter(currentCtx);
		if (!w || !event.message) return;
		if (event.message.role === "user") {
			lastUserMessage = event.message;
				w.handleEvent({ kind: "message_end_user", text: userTextOf(event.message.content) });
		} else if (event.message.role === "assistant") {
			lastAssistantMessage = event.message;
			const content = (event.message as { content?: unknown }).content;
			// Split interleaved CoT into per-tool-call reasoning; capture prose reply.
			const segments = reasoningByToolCall(content);
			for (const [id, text] of segments) {
				if (text) reasoningById.set(id, text);
			}
			const prose = userTextOf(content);
			if (prose) lastAssistantText = prose;
		}
		deps.afterEvent?.("message_end");
	});

	pi.on("tool_execution_start", (event: { toolCallId: string; toolName: string; args: unknown }, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		writer?.handleEvent({ kind: "tool_start", toolCallId: event.toolCallId, tool: event.toolName, args: event.args });
		deps.afterEvent?.("tool_execution_start");
	});

	const activateWorkflow = (workflowId: string): string | null => {
		const entry = getStore().getEntry(workflowId);
		if (!entry || entry.status !== "active") return null;
		activeEntry = entry;
		getStore().bumpUsage(entry.id);
		const guidance = renderGuidance(entry, { getEntity: (id) => getStore().getEntity(id) });
		const l2 = getStore().getL2(entry.id);
		tracker = l2 ? new EngineTracker(l2.id, l2.steps, { getL1: (id) => getStore().getL1(id) }) : null;
		writer?.setActiveWorkflow(entry.id);
		return guidance || null;
	};

	pi.on("before_agent_start", async (event: { prompt: string; systemPrompt: string }, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		tracker = null;
		activeEntry = null;
		if ((deps.config.workflowPolicy ?? "workflow-first") === "off") return undefined;
		try {
			const entry = await matchWorkflow(event.prompt, getStore().getRegistry(), llm, matchCache, getStore().getCatalogFeatures());
			if (!entry) return undefined;
			const guidance = activateWorkflow(entry.id);
			if (!guidance) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n<workflow_guidance>\n${guidance}\n</workflow_guidance>` };
		} catch {
			return undefined;
		}
	});

	pi.on("tool_execution_end", (event: { toolCallId: string; toolName: string; result: { content?: unknown } | undefined; isError: boolean }, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		const w = writer;
		if (!w) return;
		const resultText = textFromContent(event.result?.content) ?? "";
		w.handleEvent({
			kind: "tool_end",
			toolCallId: event.toolCallId,
			resultContent: textFromContent(event.result?.content) ?? "",
			isError: event.isError,
			reasoning: reasoningById.get(event.toolCallId),
		});
		// Engine checkpoint validation for the current step, fire-and-forget.
		const t = tracker;
		const step = t?.currentStep;
		if (t && step?.expect && t.currentStepTools().includes(event.toolName)) {
			const expect = step.expect;
			const tracked: Promise<void> = checkExpect(expect, resultText, llm)
				.then((outcome) => {
					executeEngineActions(t.handleCheckpoint(outcome, resultText));
				})
				.catch(() => undefined)
				.finally(() => {
					pendingChecks.delete(tracked);
				});
			pendingChecks.add(tracked);
		}
		deps.afterEvent?.("tool_execution_end");
	});

	pi.on("turn_end", (event: { message?: { role?: string; stopReason?: string } }, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		const w = writer;
		if (!w) return;
		w.handleEvent({
			kind: "turn_end",
			stopReason: event.message?.stopReason ?? "stop",
			assistantText: lastAssistantText ?? undefined,
		});
		// refId resolution by object identity against the entry tail.
		try {
			const entries = (currentCtx.sessionManager?.getEntries?.() ?? []).slice(-40) as EntryLike[];
			const resolved = resolveEntryIds(lastUserMessage, lastAssistantMessage, entries);
			w.setEntryIds(resolved.userEntryId, resolved.assistantEntryId);
		} catch {
			// entries unavailable — entry ids stay null, logs remain usable
		}
		lastUserMessage = null;
		lastAssistantMessage = null;
		lastAssistantText = null;
		reasoningById.clear();
		deps.afterEvent?.("turn_end");
	});

	pi.on("agent_settled", (_event: unknown, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		const w = writer;
		if (!w) {
			deps.afterEvent?.("agent_settled");
			return;
		}
		w.handleEvent({ kind: "agent_settled" });
		// Evolution: a completed turn under workflow guidance strengthens the entry.
		if (tracker && activeEntry && !tracker.escapedFlag && w.flushedTurn?.outcome === "completed") {
			getStore().bumpEvidence(activeEntry.id);
		}
		tracker = null;
		activeEntry = null;
		// Fire-and-forget distillation of the just-flushed fact turn.
		const flushed = w.flushedTurn;
		if (flushed) {
			const prev = prevContext;
			const tracked: Promise<void> = distillTurn(flushed, prev, llm)
				.then((patch) => {
					if (patch && writer === w) {
						w.appendPatch(flushed.seq, patch);
						prevContext = { intent: patch.intent, relation: patch.relation, unfinished: patch.unfinished };
					}
				})
				.catch(() => undefined)
				.finally(() => {
					pendingDistills.delete(tracked);
				});
			pendingDistills.add(tracked);
		}
		deps.afterEvent?.("agent_settled");
	});

	pi.on("session_shutdown", (_event: unknown, ctxRaw: unknown) => {
		currentCtx = ctxRaw as HandlerCtx;
		writer?.handleEvent({ kind: "session_shutdown" });
		deps.afterEvent?.("session_shutdown");
	});

	// Slash commands (/wf-extract, /wf-list, /wf-stats).
	registerWorkflowCommands(
		pi as unknown as CommandPi,
		{
			config: deps.config,
			llm,
			resolveProjectKey: projectKeyFromCwd,
		},
		(text) => {
			const notify = (currentCtx as { ui?: { notify?: (t: string) => void } } | undefined)?.ui?.notify;
			if (notify) notify(text);
			else console.log(text);
		},
	);

	return {
		getWriter: () => writer,
		getCtx: () => currentCtx,
		getLlm: () => llm,
		getPendingDistills: () => [...pendingDistills],
		getPendingChecks: () => [...pendingChecks],
		getActiveWorkflowId: () => activeEntry?.id ?? null,
	};
}
