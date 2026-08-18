/** Strict Scout report parsing and bounded packet rendering. */
import { parseJsonLoose } from "../../_shared/llm.ts";
import type {
	ExplorationAngle,
	ExplorationPacket,
	KnownFact,
	PriorResolution,
	Proposal,
	ProbeRecord,
	ScoutObservation,
	ScoutMechanism,
	ScoutReport,
	ScoutRunRecord,
} from "./types.ts";
import type { ExplorationBudget } from "./types.ts";

const ANGLES = new Set<ExplorationAngle>(["independent", "prior-first", "evidence-first", "alternative-first", "counterexample-first"]);
const PROBE_STATUSES = new Set(["observed", "not-observed", "error", "unknown"]);
const RANKING_KEYS = new Set(["best", "ranking", "rank", "confidence", "recommendation", "recommended", "最佳", "排名", "置信度", "推荐"]);

function stringArray(value: unknown, max: number): string[] {
	return Array.isArray(value)
		? value.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, max)
		: [];
}

function factArray(value: unknown, max: number): KnownFact[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
		.map((x) => ({ fact: typeof x.fact === "string" ? x.fact : "", source: typeof x.source === "string" ? x.source : "" }))
		.filter((x) => x.fact.trim() && x.source.trim())
		.slice(0, max);
}

function probeArray(value: unknown): ProbeRecord[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
		.map((x) => ({
			question: typeof x.question === "string" ? x.question : "",
			action: typeof x.action === "string" ? x.action : "",
			observation: typeof x.observation === "string" ? x.observation : "",
			status: PROBE_STATUSES.has(String(x.status)) ? (x.status as ProbeRecord["status"]) : "unknown",
			source: typeof x.source === "string" ? x.source : undefined,
		}))
		.filter((x) => x.question && x.action && x.observation);
}

function hasRankingField(value: unknown): boolean {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	return Object.keys(value).some((key) => RANKING_KEYS.has(key));
}

function proposalArray(value: unknown, max: number): Proposal[] {
	if (!Array.isArray(value)) return [];
	return value
		.filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
		.map((x) => ({
			id: typeof x.id === "string" ? x.id : "",
			idea: typeof x.idea === "string" ? x.idea : "",
			steps: stringArray(x.steps, 8),
			assumptions: stringArray(x.assumptions, 8),
			expectedEvidence: stringArray(x.expectedEvidence, 8),
			disqualifiers: stringArray(x.disqualifiers, 8),
			probes: probeArray(x.probes).slice(0, 6),
			...(typeof x.objective === "string" ? { objective: x.objective } : {}),
			...(typeof x.principle === "string" ? { principle: x.principle } : {}),
			...(Array.isArray(x.preconditions) ? { preconditions: stringArray(x.preconditions, 8) } : {}),
			...(Array.isArray(x.fallback) ? { fallback: stringArray(x.fallback, 8) } : {}),
			...(x.closureStatus === "closed" || x.closureStatus === "partial" ? { closureStatus: x.closureStatus } : {}),
			...(Array.isArray(x.basedOnObservationIds) ? { basedOnObservationIds: stringArray(x.basedOnObservationIds, 12) } : {}),
		}))
		.filter((x) => x.id && x.idea && x.steps.length > 0)
		.slice(0, max);
}

export function parseScoutReport(raw: string, scoutId: string, angle: ExplorationAngle, priorStatus: ScoutReport["priorStatus"], maxProposals = 2): ScoutReport | null {
	const parsed = parseJsonLoose(raw);
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	if (hasRankingField(obj)) return null;
	if (obj.noWorkPerformed !== true) return null;
	if (typeof obj.priorStatus === "string" && obj.priorStatus !== priorStatus) return null;
	return {
		scoutId,
		angle: ANGLES.has(angle) ? angle : "evidence-first",
		priorStatus,
		proposals: proposalArray(obj.proposals, maxProposals),
		...(Array.isArray(obj.observations) ? { observations: (obj.observations as unknown[]).filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item, index): ScoutObservation => ({ id: typeof item.id === "string" ? item.id : `observation-${index + 1}`, statement: typeof item.statement === "string" ? item.statement : "", sourceRefs: stringArray(item.sourceRefs, 8), status: item.status === "observed" || item.status === "not-observed" || item.status === "unknown" ? item.status : "unknown" })).filter((item) => item.statement).slice(0, 16) } : {}),
		...(Array.isArray(obj.mechanisms) ? { mechanisms: (obj.mechanisms as unknown[]).filter((item): item is Record<string, unknown> => !!item && typeof item === "object").map((item, index): ScoutMechanism => ({ id: typeof item.id === "string" ? item.id : `mechanism-${index + 1}`, statement: typeof item.statement === "string" ? item.statement : "", basedOnObservationIds: stringArray(item.basedOnObservationIds, 12), causalChain: stringArray(item.causalChain, 8), unknownConditions: stringArray(item.unknownConditions, 8) })).filter((item) => item.statement).slice(0, 12) } : {}),
		...(Array.isArray(obj.lightweightChecks) ? { lightweightChecks: probeArray(obj.lightweightChecks).slice(0, 12) } : {}),
		...(Array.isArray(obj.deadEnds) ? { deadEnds: factArray(obj.deadEnds, 12) } : {}),
		sourcesChecked: stringArray(obj.sourcesChecked, 12),
		searchesPerformed: stringArray(obj.searchesPerformed, 12),
		verifiedFacts: factArray(obj.verifiedFacts, 8),
		negativeEvidence: factArray(obj.negativeEvidence, 8),
		openQuestions: stringArray(obj.openQuestions, 8),
		limitations: stringArray(obj.limitations, 8),
		noWorkPerformed: true,
	};
}

function priorLabel(prior: PriorResolution): string {
	return prior.kind === "matched" ? `matched: ${prior.summary.id}` : `${prior.kind}: ${prior.reason}`;
}

function renderReport(run: ScoutRunRecord): string {
	if (!run.report) return `[${run.angle}] 状态=${run.status}，未得到结构化报告：${run.error ?? "unknown"}`;
	const report = run.report;
	const proposals = report.proposals
		.map(
			(p) =>
					`候选 ${p.id}: ${p.idea}${p.closureStatus ? ` [闭环=${p.closureStatus}]` : ""}\n  目标: ${p.objective ?? "无"}\n  原理: ${p.principle ?? "无"}\n  步骤: ${p.steps.join(" → ")}\n  假设: ${p.assumptions.join("；") || "无"}\n  预期证据: ${p.expectedEvidence.join("；") || "无"}\n  回退: ${p.fallback?.join("；") || "无"}\n  探查: ${p.probes.map((probe) => `${probe.question} => ${probe.observation} [${probe.status}]`).join("；") || "无"}\n  淘汰条件: ${p.disqualifiers.join("；") || "无"}`,
		)
		.join("\n");
		const observations = report.observations?.map((item) => `${item.id}: ${item.statement} [${item.status}]`).join("；") || "无";
		const mechanisms = report.mechanisms?.map((item) => `${item.id}: ${item.statement}`).join("；") || "无";
		const footprint = run.footprint ? `足迹: 工具=${run.footprint.toolCalls.length}，路径=${run.footprint.paths.length}，查询=${run.footprint.queries.length}` : "足迹: 无";
		return `[${report.angle} / prior=${report.priorStatus}]\n${footprint}\n观察: ${observations}\n原理: ${mechanisms}\n${proposals}\n事实: ${report.verifiedFacts.map((f) => `${f.fact} (${f.source})`).join("；") || "无"}\n反证: ${report.negativeEvidence.map((f) => `${f.fact} (${f.source})`).join("；") || "无"}\n未知: ${report.openQuestions.join("；") || "无"}\n限制: ${report.limitations.join("；") || "无"}`;
}

export function renderPacketContent(round: number, prior: PriorResolution, runs: ScoutRunRecord[], maxChars: number): string {
	const header = `<exploration_packet round="${round}">\n以下是独立 Scout 的未验证候选，不是排名，也不是完成结论。\n先验状态：${priorLabel(prior)}\n\n`;
	const footer = `\n\n请自行去重、组合、否定或重新设计；正式执行前验证关键假设。以上报告不是工作流约束。\n</exploration_packet>`;
	let content = header;
	for (const run of runs) {
		const block = `${renderReport(run)}\n\n`;
		if ((content + block + footer).length > maxChars) break;
		content += block;
	}
	return `${content}${footer}`.slice(0, maxChars);
}

export function makePacket(round: number, prior: PriorResolution, runs: ScoutRunRecord[], budget: ExplorationBudget, focus?: string): ExplorationPacket {
	const content = renderPacketContent(round, prior, runs, budget.maxPacketChars);
	return focus?.trim() ? { round, prior, runs, content, focus: focus.trim() } : { round, prior, runs, content };
}
