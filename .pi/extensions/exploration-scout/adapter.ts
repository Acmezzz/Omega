import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LlmClient } from "../_shared/llm.ts";
import { textFromContent } from "../_shared/llm.ts";
import { projectKeyFromCwd } from "../_shared/task-identity.ts";
import { registerExplorationTools, type ExplorationToolDeps } from "./tool.ts";
import { buildMainExplorationProtocol } from "./core/prompts.ts";
import { ExplorationJournal } from "./core/journal.ts";
import type { ExplorationSelection, ScoutRoundRecord } from "./core/types.ts";
import type { ExplorationScoutConfig } from "./config.ts";

interface HandlerCtx {
	cwd: string;
	model?: unknown;
	sessionManager?: { getHeader?: () => { id: string } };
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

export interface ScoutWireDeps { config: ExplorationScoutConfig; llm?: LlmClient; exploration?: Partial<ExplorationToolDeps> }

export function wire(pi: ExtensionAPI, deps: ScoutWireDeps): void {
	let ctx: HandlerCtx | undefined;
	let currentUserInput: string | null = null;
	let journal: ExplorationJournal | null = null;
	let currentRound: ScoutRoundRecord | null = null;
	const llm = deps.llm ?? makeCtxLlm(() => ctx);

	const ensureJournal = (next: HandlerCtx): ExplorationJournal | null => {
		if (journal) return journal;
		const taskId = next.sessionManager?.getHeader?.()?.id;
		if (!taskId) return null;
		journal = new ExplorationJournal(deps.config.explorationsRoot, projectKeyFromCwd(next.cwd), taskId);
		return journal;
	};

	pi.on("session_start", (_event, raw) => { ctx = raw as HandlerCtx; ensureJournal(ctx); });
	pi.on("message_end", (event: { message?: { role?: string; content?: unknown } }, raw) => {
		ctx = raw as HandlerCtx;
		ensureJournal(ctx);
		if (event.message?.role === "user") currentUserInput = typeof event.message.content === "string" ? event.message.content : textFromContent(event.message.content);
	});
	pi.on("turn_end", (_event, raw) => { ctx = raw as HandlerCtx; currentUserInput = null; });
	pi.on("before_agent_start", (event: { systemPrompt: string }, raw) => {
		ctx = raw as HandlerCtx;
		if (deps.config.policy !== "explore-first") return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n<exploration_protocol>\n${buildMainExplorationProtocol()}\n</exploration_protocol>` };
	});

	registerExplorationTools(pi, {
		llm,
		getBudget: () => deps.config.budget,
		getCurrentUserInput: () => currentUserInput,
		...deps.exploration,
		onRound: ({ brief, round, packet, budget }) => {
			const taskId = ctx?.sessionManager?.getHeader?.()?.id ?? "unknown";
			const record: ScoutRoundRecord = {
				roundId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				taskId,
				projectKey: ctx ? projectKeyFromCwd(ctx.cwd) : "unknown",
				trigger: round > 1 ? "replan" : "initial",
				taskBrief: brief,
				model: ctx?.model && typeof ctx.model === "object" ? `${String((ctx.model as { provider?: unknown }).provider ?? "unknown")}/${String((ctx.model as { id?: unknown }).id ?? "unknown")}` : "unknown",
				budget, prior: packet.prior, runs: packet.runs, packet,
				adoptedProposalIds: [], verifiedOutcome: "not-yet-executed",
			};
			currentRound = record;
			journal?.appendRound(record);
		},
		onSelection: (selection: ExplorationSelection) => {
			if (currentRound) journal?.appendSelection(currentRound.roundId, selection);
			return "已记录探索收敛结果。现在请由主 Agent 正式执行并用外部结果验证；探索插件不会执行任务或激活工作流。";
		},
	});
}
