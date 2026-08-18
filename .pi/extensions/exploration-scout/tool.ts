/** Pi-facing tools for the independent exploration plugin. */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LlmClient } from "../_shared/llm.ts";
import type { WorkflowPriorProvider } from "../_shared/interop.ts";
import { validateTaskBrief } from "./core/brief.ts";
import type { ExplorationBudget, ExplorationSelection, ScoutRunRecord, ScoutRoundRecord, TaskBrief } from "./core/types.ts";
import { DEFAULT_EXPLORATION_BUDGET } from "./core/types.ts";
import { resolvePrior } from "./core/prior.ts";
import { makePacket } from "./core/packet.ts";
import { selectScoutRoles, type ScoutRole } from "./core/roles.ts";
import { runScouts, type ScoutRunOptions } from "./runner.ts";

export interface ExplorationToolDeps {
	llm: LlmClient;
	getBudget?: () => Partial<ExplorationBudget> | undefined;
	getCurrentUserInput?: () => string | null;
	priorProvider?: WorkflowPriorProvider;
	runScouts?: (options: Omit<ScoutRunOptions, "role"> & { roles: ScoutRole[] }) => Promise<ScoutRunRecord[]>;
	onRound?: (input: { brief: TaskBrief; round: number; focus?: string; packet: ReturnType<typeof makePacket>; budget: ExplorationBudget }) => void;
	onSelection?: (selection: ExplorationSelection, ctx: ExtensionContext) => string | void;
	getRounds?: () => ScoutRoundRecord[];
	getCurrentRound?: () => ScoutRoundRecord | null;
}

const briefSchema = Type.Object({
	rawUserInput: Type.String(), objective: Type.String(), deliverable: Type.String(),
	acceptanceCriteria: Type.Array(Type.String()), constraints: Type.Array(Type.String()),
	knownFacts: Type.Array(Type.Object({ fact: Type.String(), source: Type.String() })), unknowns: Type.Array(Type.String()),
	relevantPaths: Type.Array(Type.String()), forbiddenAssumptions: Type.Array(Type.String()),
});
const exploreSchema = Type.Object({ taskBrief: briefSchema, round: Type.Optional(Type.Integer({ minimum: 1, maximum: 2 })), focus: Type.Optional(Type.String()), includeCounterexample: Type.Optional(Type.Boolean()) });
const selectSchema = Type.Object({ selectedProposalIds: Type.Array(Type.String()), combinedPlanSummary: Type.Optional(Type.String()), reason: Type.Optional(Type.String()) });

function mergedBudget(deps: ExplorationToolDeps): ExplorationBudget { return { ...DEFAULT_EXPLORATION_BUDGET, ...(deps.getBudget?.() ?? {}) }; }
function modelShape(ctx: ExtensionContext): { provider?: string; id?: string } {
	const model = ctx.model as { provider?: unknown; id?: unknown } | undefined;
	return { provider: typeof model?.provider === "string" ? model.provider : undefined, id: typeof model?.id === "string" ? model.id : undefined };
}

export function createExploreSpaceTool(deps: ExplorationToolDeps) {
	return defineTool({
		name: "explore_space", label: "Explore solution space",
		description: "在不修改工作区的前提下，启动多个独立 Scout 发散探索候选方案。Scout 只返回未验证的事实、假设和思路；主 Agent 必须自行评估、组合或否定它们。",
		promptSnippet: "Explore candidate solution space with read-only independent scouts when the task is novel or ambiguous",
		parameters: exploreSchema, executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const validation = validateTaskBrief(params.taskBrief);
			if (!validation.valid || !validation.brief) return { content: [{ type: "text", text: `TaskBrief 无效：${validation.reasons.join("；")}` }], details: { status: "invalid_brief", reasons: validation.reasons } };
			const budget = mergedBudget(deps);
			const requestedRound = params.round ?? 1;
			const rounds = deps.getRounds?.() ?? [];
			if (requestedRound > budget.maxRoundsPerTask || rounds.some((record) => record.packet.round === requestedRound)) {
				return { content: [{ type: "text", text: `探索轮次 ${requestedRound} 已达到任务预算或已经执行过。` }], details: { status: "round_budget_exceeded", round: requestedRound } };
			}
			const brief = { ...validation.brief, rawUserInput: deps.getCurrentUserInput?.() ?? validation.brief.rawUserInput };
			const prior = await resolvePrior(brief.rawUserInput, deps.priorProvider);
			const roles = selectScoutRoles(budget.maxScouts, params.includeCounterexample === true);
				const focus = typeof params.focus === "string" && params.focus.trim() ? params.focus.trim() : undefined;
				const runs = await (deps.runScouts ?? runScouts)({ cwd: ctx.cwd, model: modelShape(ctx), brief, prior, budget, focus, signal, roles });
				const packet = makePacket(params.round ?? 1, prior, runs, budget, focus);
				deps.onRound?.({ brief, round: params.round ?? 1, focus, packet, budget });
			return { content: [{ type: "text", text: packet.content }], details: { packet } };
		},
	});
}

export function createSelectExplorationTool(deps: ExplorationToolDeps) {
	return defineTool({
		name: "select_exploration", label: "Select exploration direction",
		description: "只记录主 Agent 对 Scout 候选的收敛结果。可以组合、否定或自行设计；本插件不会执行任务或激活工作流。",
		promptSnippet: "Record the main agent's selected or combined exploration direction",
		parameters: selectSchema, executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const currentRound = deps.getCurrentRound?.();
			if (!currentRound) return { content: [{ type: "text", text: "当前没有可供选择的探索轮次。" }], details: { status: "no_current_round" } };
			const proposalIds = new Set(currentRound.packet.runs.flatMap((run) => run.report?.proposals.map((proposal) => proposal.id) ?? []));
				const selected = [...new Set(params.selectedProposalIds)];
				if (selected.length !== params.selectedProposalIds.length || selected.some((id) => !id.trim() || !proposalIds.has(id))) return { content: [{ type: "text", text: "选择中包含重复、空白或当前轮次不存在的 proposal ID。" }], details: { status: "invalid_selection" } };
			const selection: ExplorationSelection = { selectedProposalIds: selected, combinedPlanSummary: params.combinedPlanSummary ?? null, reason: params.reason ?? null };
			const selectionMessage = deps.onSelection?.(selection, ctx);
			return { content: [{ type: "text", text: selectionMessage ?? "已记录探索收敛结果。现在请由主 Agent 正式执行并用外部结果验证。" }], details: { selection } };
		},
	});
}

export function registerExplorationTools(pi: ExtensionAPI, deps: ExplorationToolDeps): void {
	pi.registerTool(createExploreSpaceTool(deps));
	pi.registerTool(createSelectExplorationTool(deps));
}
