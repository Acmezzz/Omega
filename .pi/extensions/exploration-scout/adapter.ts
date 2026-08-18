import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LlmClient } from "../_shared/llm.ts";
import { textFromContent } from "../_shared/llm.ts";
import { projectKeyFromCwd } from "../_shared/task-identity.ts";
import { registerExplorationTools, type ExplorationToolDeps } from "./tool.ts";
import { buildMainExplorationProtocol } from "./core/prompts.ts";
import { ExplorationJournal } from "./core/journal.ts";
import type { ExplorationRoundView, ExplorationSelection, ScoutRoundRecord } from "./core/types.ts";
import { registerExplorationCommand, type ExplorationCommandPi } from "./commands.ts";
import type { ExplorationScoutConfig } from "./config.ts";

interface HandlerCtx {
	cwd: string;
	model?: unknown;
	sessionManager?: { getHeader?: () => { id: string }; getEntries?: () => unknown[] };
	modelRegistry?: { complete?: (model: unknown, context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown; timestamp: number }> }, options?: { maxTokens?: number }) => Promise<{ content: unknown }> };
}

function makeCtxLlm(getCtx: () => HandlerCtx | undefined): LlmClient {
	return { async complete(input) {
		const ctx = getCtx();
		if (!ctx?.modelRegistry?.complete || !ctx.model) throw new Error("exploration-scout: no model available");
		const result = await ctx.modelRegistry.complete(ctx.model, { systemPrompt: input.systemPrompt, messages: [{ role: "user", content: input.userPayload, timestamp: Date.now() }] }, { maxTokens: input.maxTokens });
		return textFromContent(result.content) ?? "";
	} };
}

export interface ScoutWireDeps { config: ExplorationScoutConfig; llm?: LlmClient; exploration?: Partial<ExplorationToolDeps> };

interface ScoutModeEntry { enabled: boolean }

export function wire(pi: ExtensionAPI, deps: ScoutWireDeps): void {
	let ctx: HandlerCtx | undefined;
	let currentUserInput: string | null = null;
	let journal: ExplorationJournal | null = null;
	let currentRound: ExplorationRoundView | null = null;
	let manualModeEnabled = deps.config.policy === "explore-first";
	const llm = deps.llm ?? makeCtxLlm(() => ctx);
	const explorationEnabled = (): boolean => deps.config.policy === "explore-first" || (deps.config.policy === "manual" && manualModeEnabled);

		const clearTaskState = (): void => {
			journal = null;
			currentRound = null;
			currentUserInput = null;
		};

		const ensureJournal = (next: HandlerCtx): ExplorationJournal | null => {
			const taskId = next.sessionManager?.getHeader?.()?.id;
			if (typeof taskId !== "string" || !taskId.trim()) {
				clearTaskState();
				return null;
			}
			const projectKey = projectKeyFromCwd(next.cwd);
			if (journal && journal.taskId === taskId && journal.projectKey === projectKey) return journal;
			journal = new ExplorationJournal(deps.config.explorationsRoot, projectKey, taskId);
			currentRound = journal.readState().currentRound;
			currentUserInput = null;
			return journal;
		};


		pi.on("session_start", (_event, raw) => {
			ctx = raw as HandlerCtx;
			const nextJournal = ensureJournal(ctx);
			const entries = ctx.sessionManager?.getEntries?.() ?? [];
			const saved = [...entries].reverse().find((entry: unknown) => {
				const item = entry as { type?: string; customType?: string; data?: ScoutModeEntry };
				return item.type === "custom" && item.customType === "exploration-scout-mode" && typeof item.data?.enabled === "boolean";
			}) as { data?: ScoutModeEntry } | undefined;
			if (deps.config.policy === "manual") manualModeEnabled = saved?.data?.enabled === true;
			void nextJournal;
		});
	pi.on("message_end", (event: { message?: { role?: string; content?: unknown } }, raw) => {
		ctx = raw as HandlerCtx;
		ensureJournal(ctx);
		if (event.message?.role === "user") currentUserInput = typeof event.message.content === "string" ? event.message.content : textFromContent(event.message.content);
	});
	pi.on("turn_end", (_event, raw) => { ctx = raw as HandlerCtx; currentUserInput = null; });
		pi.on("before_agent_start", (event: { systemPrompt: string }, raw) => {
			ctx = raw as HandlerCtx;
			if (!explorationEnabled()) return undefined;
			return { systemPrompt: `${event.systemPrompt}\n\n<exploration_protocol>\n${buildMainExplorationProtocol()}\n</exploration_protocol>` };
		});

			registerExplorationTools(pi, {
				...deps.exploration,
				llm,
				getBudget: () => deps.config.budget,
				getCurrentUserInput: () => currentUserInput,
				getRounds: () => journal?.readRounds() ?? [],
				getCurrentRound: () => currentRound,
				isExplorationEnabled: explorationEnabled,
			onRound: ({ brief, round, focus, packet, budget }) => {
				const taskId = ctx?.sessionManager?.getHeader?.()?.id;
				if (!journal || !taskId) return;
				const record: ScoutRoundRecord = {
					roundId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
					taskId,
					projectKey: projectKeyFromCwd(ctx!.cwd),
					trigger: round > 1 ? "replan" : "initial",
					taskBrief: brief,
					model: ctx?.model && typeof ctx.model === "object" ? `${String((ctx.model as { provider?: unknown }).provider ?? "unknown")}/${String((ctx.model as { id?: unknown }).id ?? "unknown")}` : "unknown",
					budget, prior: packet.prior, runs: packet.runs, packet,
					...(focus ? { focus } : {}),
					adoptedProposalIds: [], verifiedOutcome: "not-yet-executed",
				};
				journal.appendRound(record);
				currentRound = { ...record, selection: null };
			},
				onSelection: (selection: ExplorationSelection) => {
					if (currentRound && journal) {
						selection.selectionId = journal.appendSelection(currentRound.roundId, selection);
						currentRound = { ...currentRound, selection, adoptedProposalIds: selection.selectedProposalIds, ...(selection.combinedPlanSummary ? { combinedPlanSummary: selection.combinedPlanSummary } : {}) };
					}
				return "已记录探索收敛结果。现在请由主 Agent 正式执行并用外部结果验证；探索插件不会执行任务或激活工作流。";
				},
		});

		registerExplorationCommand(pi as unknown as ExplorationCommandPi, {
			config: deps.config,
			getJournal: (commandCtx: ExtensionCommandContext) => ensureJournal(commandCtx as unknown as HandlerCtx),
			getCurrentRound: () => currentRound,
			isEnabled: explorationEnabled,
			setEnabled: (enabled, commandCtx) => {
				manualModeEnabled = enabled;
				pi.appendEntry("exploration-scout-mode", { enabled });
				ctx = commandCtx as unknown as HandlerCtx;
			},
		});
		}
