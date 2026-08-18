/**
 * Pi adapter: the ONLY module that touches Pi extension APIs.
 * Translates Pi events into SimEvents for the core JournalWriter and exposes
 * core outputs (patches, workflow guidance, escape messages) back to Pi.
 *
 * wire() is shared between the real extension entry (index.ts) and the test
 * fake-pi harness, so event replay tests exercise the identical wiring code.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { LlmClient } from "./core/llm.ts";
import { textFromContent } from "./core/llm.ts";
import { JournalWriter } from "./core/journal/writer.ts";
import { BackupWriter, type BackupAppendResult } from "./core/journal/backup.ts";
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
		getSessionFile?: () => string | undefined;
		getSessionDir?: () => string;
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

function safeEventText(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? String(value ?? "");
	} catch {
		return String(value ?? "");
	}
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
		getBackupDir(): string | null;

}

export function wire(pi: ExtensionAPI, deps: WireDeps): WiredRuntime {
		let writer: JournalWriter | null = null;
		let backup: BackupWriter | null = null;
		let currentCtx: HandlerCtx | undefined;

	let lastUserMessage: unknown = null;
		let lastAssistantMessage: unknown = null;
		let lastAssistantText: string | null = null;
		let lastAssistantFragmentIds: string[] | undefined;

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

		const trackerSnapshotPath = (): string | null => writer ? join(writer.dir, "tracker.json") : null;
		const clearTrackerSnapshot = (): void => {
			const path = trackerSnapshotPath();
			if (!path) return;
			try { if (existsSync(path)) unlinkSync(path); } catch { /* best effort */ }
		};
		const saveTrackerSnapshot = (): void => {
			if (!tracker || !tracker.active) { clearTrackerSnapshot(); return; }
			const path = trackerSnapshotPath();
			if (!path) return;
			const temp = `${path}.tmp-${process.pid}`;
			try {
				writeFileSync(temp, `${JSON.stringify(tracker.toSnapshot(), null, "\t")}\n`);
				renameSync(temp, path);
			} catch {
				try { if (existsSync(temp)) unlinkSync(temp); } catch { /* best effort */ }
			}
		};
		const restoreTracker = (workflowId: string, steps: Parameters<typeof EngineTracker.fromSnapshot>[1]): EngineTracker | null => {
			const path = trackerSnapshotPath();
			if (!path || !existsSync(path)) return null;
			try {
				const snapshot = JSON.parse(readFileSync(path, "utf8")) as unknown;
				const restored = EngineTracker.fromSnapshot(snapshot, steps, { getL1: (id) => getStore().getL1(id) });
				if (!restored || restored.workflowId !== workflowId || !restored.active) {
					clearTrackerSnapshot();
					return null;
				}
				return restored;
			} catch {
				clearTrackerSnapshot();
				return null;
			}
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

			const resetEngine = (): void => {
				tracker = null;
				activeEntry = null;
				clearTrackerSnapshot();
				writer?.setActiveWorkflow(null);
			};

		const executeEngineActions = (actions: EngineAction[]): void => {
			for (const action of actions) {
				if (action.message !== null) steer(action.message);
				if (action.type === "escape") {
					writer?.appendFailure(action.failure);
					if (activeEntry) getStore().bumpEscape(activeEntry.id);
					resetEngine();
				}
			}
		};


		const ensureWriter = (ctx: HandlerCtx): JournalWriter | null => {
			const header = ctx.sessionManager?.getHeader?.();
			if (!header?.id) return null;
			const key = projectKeyFromCwd(ctx.cwd);
				if (writer && writer.taskId === header.id && writer.projectKey === key) return writer;
				resetEngine();
				prevContext = null;
				lastUserMessage = null;
				lastAssistantMessage = null;
				lastAssistantText = null;
				lastAssistantFragmentIds = undefined;
				reasoningById.clear();
				(matchCache as Map<string, RegistryEntry | null>).clear();
				writer?.handleEvent({ kind: "session_shutdown" });
				backup = null;

				writer = new JournalWriter(deps.config.journalsRoot, key, header.id);

			if (deps.config.backupEnabled !== false) {
				backup = new BackupWriter(deps.config.backupsRoot ?? join(deps.config.journalsRoot, ".backups"), key, header.id, header.id, {
					fragmentSize: deps.config.fragmentSize,
					fragmentOverlap: deps.config.fragmentOverlap,
				});
			} else {
				backup = null;
			}
			return writer;
			};

		const appendBackup = (
			eventType: string,
			payload: unknown,
			options: Parameters<BackupWriter["appendEvent"]>[2] = {},
		): BackupAppendResult | undefined => {
			try {
				return backup?.appendEvent(eventType, payload, options);
			} catch {
				return undefined;
			}
		};

		pi.on("session_start", (event: { reason?: string; previousSessionFile?: string }, ctxRaw: unknown) => {

			currentCtx = ctxRaw as HandlerCtx;
			const w = ensureWriter(currentCtx);
			appendBackup("session_start", { reason: event.reason ?? "startup", previousSessionFile: event.previousSessionFile, sessionFile: currentCtx.sessionManager?.getSessionFile?.() });
			void w;

		deps.afterEvent?.("session_start");
	});

		pi.on("message_end", (event: { message?: { role?: string; content?: unknown } }, ctxRaw: unknown) => {
			currentCtx = ctxRaw as HandlerCtx;
			const w = ensureWriter(currentCtx);
			if (!w || !event.message) return;
			if (event.message.role === "user") {
				lastUserMessage = event.message;
				const text = userTextOf(event.message.content);
				const raw = appendBackup("user_message", event.message, { turnSeq: w.nextTurnSeq, texts: text ? [{ field: "userInput", text }] : [] });
				w.handleEvent({ kind: "message_end_user", text, fragmentIds: raw?.fragmentIds.userInput });
			} else if (event.message.role === "toolResult") {
			appendBackup("tool_result_message", event.message, { turnSeq: w.currentTurnSeq, toolCallId: typeof (event.message as { toolCallId?: unknown }).toolCallId === "string" ? (event.message as { toolCallId: string }).toolCallId : null });
		} else if (event.message.role === "assistant") {
				const content = event.message.content;
				const prose = userTextOf(content);
				const thinking = thinkingTextOf(content);
				const raw = appendBackup("assistant_message", event.message, { turnSeq: w.currentTurnSeq,
					texts: [
						...(prose ? [{ field: "assistantText" as const, text: prose }] : []),
						...(thinking ? [{ field: "assistantThinking" as const, text: thinking, sensitivity: "restricted" as const }] : []),
					],
				});
				lastAssistantMessage = event.message;
				lastAssistantFragmentIds = raw?.fragmentIds.assistantText;
				const segments = reasoningByToolCall(content);
				for (const [id, text] of segments) {
					if (text) reasoningById.set(id, text);
				}
				if (prose) lastAssistantText = prose;
			}
			deps.afterEvent?.("message_end");
		});


		pi.on("tool_execution_start", (event: { toolCallId: string; toolName: string; args: unknown }, ctxRaw: unknown) => {
			currentCtx = ctxRaw as HandlerCtx;
			const raw = appendBackup("tool_execution_start", event, {
				turnSeq: writer?.currentTurnSeq,
				toolCallId: event.toolCallId,
				texts: [{ field: "tool.args", text: safeEventText(event.args) }],
			});
			writer?.handleEvent({ kind: "tool_start", toolCallId: event.toolCallId, tool: event.toolName, args: event.args, argsFragmentIds: raw?.fragmentIds["tool.args"] });

		deps.afterEvent?.("tool_execution_start");
	});

		const activateWorkflow = (workflowId: string): string | null => {
			const entry = getStore().getEntry(workflowId);
			if (!entry || entry.status !== "active") return null;
			if (activeEntry?.id === entry.id && tracker?.active) return renderGuidance(entry, { getEntity: (id) => getStore().getEntity(id) });
				const l2 = getStore().getL2(entry.id);
				const restored = l2 ? restoreTracker(l2.id, l2.steps) : null;
				resetEngine();
				activeEntry = entry;
				getStore().bumpUsage(entry.id);
				const guidance = renderGuidance(entry, { getEntity: (id) => getStore().getEntity(id) });
				tracker = l2 ? (restored ?? new EngineTracker(l2.id, l2.steps, { getL1: (id) => getStore().getL1(id) })) : null;
				if (tracker?.active) saveTrackerSnapshot();
				writer?.setActiveWorkflow(entry.id);
			return guidance || null;
		};


		pi.on("before_agent_start", async (event: { prompt: string; systemPrompt: string }, ctxRaw: unknown) => {
			currentCtx = ctxRaw as HandlerCtx;
			if ((deps.config.workflowPolicy ?? "workflow-first") === "off") {
				resetEngine();
				return undefined;
			}

		try {
				const entry = await matchWorkflow(event.prompt, getStore().getRegistry(), llm, matchCache, getStore().getCatalogFeatures());
				if (!entry) {
					resetEngine();
					return undefined;
				}

			const guidance = activateWorkflow(entry.id);
			if (!guidance) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n<workflow_guidance>\n${guidance}\n</workflow_guidance>` };
		} catch {
			return undefined;
		}
	});

		pi.on("tool_execution_update", (event: { toolCallId: string; toolName: string; args: unknown; partialResult: unknown }, ctxRaw: unknown) => {
			currentCtx = ctxRaw as HandlerCtx;
			if (deps.config.captureToolUpdates) appendBackup("tool_execution_update", event, { turnSeq: writer?.currentTurnSeq, toolCallId: event.toolCallId });
			deps.afterEvent?.("tool_execution_update");
		});

		pi.on("tool_execution_end", (event: { toolCallId: string; toolName: string; result: unknown; isError: boolean }, ctxRaw: unknown) => {
			currentCtx = ctxRaw as HandlerCtx;
			const w = writer;
			if (!w) return;
			const resultContent = (event.result as { content?: unknown } | undefined)?.content;
			const resultText = textFromContent(resultContent) ?? safeEventText(event.result);
			const reasoning = reasoningById.get(event.toolCallId);
			const raw = appendBackup("tool_execution_end", event, {
				turnSeq: writer?.currentTurnSeq,
				toolCallId: event.toolCallId,
				texts: [
					{ field: "tool.result", text: resultText },
					...(reasoning ? [{ field: "tool.reasoning" as const, text: reasoning, sensitivity: "restricted" as const }] : []),
				],
			});
			w.handleEvent({

			kind: "tool_end",
			toolCallId: event.toolCallId,
				resultContent: resultText,
				isError: event.isError,
				reasoning,
				resultFragmentIds: raw?.fragmentIds["tool.result"],
				reasoningFragmentIds: raw?.fragmentIds["tool.reasoning"],

		});
		// Engine checkpoint validation for the current step, fire-and-forget.
				const t = tracker;
				const step = t?.currentStep;
				const completion = t?.recordToolCompletion(event.toolCallId, event.toolName);
				if (t && completion?.matched && completion.needsCheckpoint && step?.expect) {
					const expect = step.expect;

					const tracked: Promise<void> = checkExpect(expect, resultText, llm)
							.then((outcome) => {
								executeEngineActions(t.handleCheckpoint(outcome, resultText));
								saveTrackerSnapshot();
							})
							.catch(() => {
								executeEngineActions(t.handleCheckpoint(null, resultText));
								saveTrackerSnapshot();
							})
						.finally(() => {
							pendingChecks.delete(tracked);
						});
					pendingChecks.add(tracked);
					} else if (t && completion?.matched) {
						executeEngineActions(completion.actions);
						saveTrackerSnapshot();
					}

		deps.afterEvent?.("tool_execution_end");
	});

		pi.on("turn_end", (event: { message?: { role?: string; stopReason?: string }; toolResults?: unknown[] }, ctxRaw: unknown) => {

		currentCtx = ctxRaw as HandlerCtx;
		const w = writer;
		if (!w) return;
			appendBackup("turn_end", event, { turnSeq: w.currentTurnSeq });
			w.handleEvent({
				kind: "turn_end",
				stopReason: event.message?.stopReason ?? "stop",
				assistantText: lastAssistantText ?? undefined,
				assistantFragmentIds: lastAssistantFragmentIds,
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
			lastAssistantFragmentIds = undefined;
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
			// Evidence is earned only after every tracked step is complete.
				if (tracker && activeEntry && tracker.completed && w.flushedTurn?.outcome === "completed") {
					const completedTurn = w.flushedTurn;
					getStore().recordEvidence(activeEntry.id, `runtime:${w.projectKey}:${w.taskId}:${completedTurn?.seq ?? "unknown"}:${activeEntry.id}`, { source: { kind: "workflow-completion", projectKey: w.projectKey, taskId: w.taskId, turnSeq: completedTurn?.seq ?? null, workflowId: activeEntry.id }, provenance: { source: "journal-workflow" } });
					resetEngine();
				}

		// Fire-and-forget distillation of the just-flushed fact turn.
		const flushed = w.flushedTurn;
		if (flushed) {
				const prev = prevContext;
				const backupReader = backup?.reader({ allowSensitive: deps.config.allowSensitiveFragments });
					const availableFragments = backupReader?.listFragments()
						.filter((fragment) => fragment.turnSeq === flushed.seq)
						.filter((fragment) => deps.config.allowSensitiveFragments || fragment.sensitivity !== "restricted")
						.map(({ fragmentId, field, side, originalChars, sensitivity }) => ({ fragmentId, field, side, originalChars, sensitivity }));

				const tracked: Promise<void> = distillTurn(flushed, prev, llm, {
					availableFragments,
					readFragments: (request) => backupReader?.getFragments(request) ?? [],
					allowSensitiveFragments: deps.config.allowSensitiveFragments,
					maxFragmentChars: deps.config.maxFragmentCharsPerRequest,
					maxFragments: deps.config.maxFragmentsPerRequest,
				})

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

		pi.on("session_shutdown", (event: { reason?: string; targetSessionFile?: string }, ctxRaw: unknown) => {
			currentCtx = ctxRaw as HandlerCtx;
			appendBackup("session_shutdown", { reason: event.reason ?? "quit", targetSessionFile: event.targetSessionFile });
			writer?.handleEvent({ kind: "session_shutdown" });
			backup = null;

		deps.afterEvent?.("session_shutdown");
	});

		// Slash commands (/wf-extract, /wf-list, /wf-catalog, /wf-stats).
	registerWorkflowCommands(
		pi as unknown as CommandPi,
		{
				config: deps.config,
				llm,
				resolveProjectKey: projectKeyFromCwd,
				isTaskActive: (projectKey, taskId) => writer?.projectKey === projectKey && writer?.taskId === taskId,
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
		getBackupDir: () => backup?.dir ?? null,
	};
}
