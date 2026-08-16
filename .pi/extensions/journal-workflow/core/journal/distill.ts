/**
 * Turn distillation: one background LLM call per settled turn.
 * Facts in, compact semantic patch out. The prompt enforces the three rules
 * that separate this from a memory system: cover every event, fill null when
 * unsure, never invent.
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { ToolCallRecord, TurnPatch, TurnRecord, TurnRelation } from "./types.ts";

export const DISTILL_SYSTEM_PROMPT = `You distill one agent-turn log (harness-recorded facts) into a compact semantic patch — an outline that loses no core content.
Rules:
- Cover EVERY tool call in order via toolPatches (use each refSequence exactly once). Never omit events.
- Fill null when the information is absent. Do NOT invent facts, do NOT add knowledge not present in the input.
- Each tool call may carry a "reasoning" field: the model's own words for WHY it made that call (visible-CoT models). When present, PREFER it as the source for that call's intent and failure analysis. When absent, reconstruct from behavior — and stay conservative.
- Per tool call: intent = why it was called (purpose); significance = actual contribution to the task:
    "essential" (directly produced what the task needed) | "helpful" (supported progress: exploration, confirmation) | "neutral" (no real effect on the outcome) | "wasted" (failed without yielding information, or redundant detour). Success does NOT imply essential; failure does NOT imply wasted.
- taskEssence = what this task fundamentally IS, abstracted ("检索 arXiv 论文并结构化总结" → "外部信息检索+筛选+结构化综合").
- deliverable = what the task ultimately exists to produce ("一份含设计细节的论文筛选总结文档").
- relation classifies this turn against the PREVIOUS turn: "new" | "retry" | "fix_success" | "fix_failed" | "clarify". With no previous turn context, use "new".
- unfinished lists concrete remaining work items; empty array when the turn completed its goal.
- errorSummary explains failures and what the agent did about them; null when nothing failed.
Output ONLY a JSON object, no prose:
{"intent": string|null, "taskEssence": string|null, "deliverable": string|null, "relation": "new"|"retry"|"fix_success"|"fix_failed"|"clarify", "plan": string|null, "toolPatches": [{"refSequence": number, "intent": string|null, "argsSummary": string|null, "resultSummary": string|null, "significance": "essential"|"helpful"|"neutral"|"wasted"|null, "followUp": string|null}], "unfinished": string[], "errorSummary": string|null}`;

const ALLOWED_RELATIONS: readonly TurnRelation[] = ["new", "retry", "fix_success", "fix_failed", "clarify"];

export interface PrevTurnContext {
	intent: string | null;
	relation: TurnRelation | null;
	unfinished: string[];
}

export function buildUserPayload(turn: TurnRecord, prev: PrevTurnContext | null): string {
	const facts = {
		previousTurn: prev
			? { intent: prev.intent, relation: prev.relation, unfinished: prev.unfinished }
			: null,
		userInput: turn.userInput,
		// Assistant's prose reply (truncated) — first-hand narrative of results.
		// Per-tool reasoning (why THIS call) travels with each toolCall below;
		// hidden-CoT models leave it null and intents are reconstructed from behavior.
		assistantText: turn.assistantTextRaw ?? null,
		outcome: turn.outcome,
		toolCalls: turn.toolCalls.map((tc) => ({
			refSequence: tc.refSequence,
			tool: tc.tool,
			args: tc.argsRaw,
			reasoning: tc.reasoningRaw ?? null,
			status: tc.status,
			result: tc.resultRaw,
		})),
	};
	return JSON.stringify(facts, null, 1);
}

/** Validate and normalize an LLM reply into a TurnPatch; null when unusable. */
export function parseDistillPatch(text: string, turn: TurnRecord, lenient = false): TurnPatch | null {
	const parsed = parseJsonLoose(text);
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	const relationRaw = typeof obj.relation === "string" ? obj.relation : "new";
	const relation = (ALLOWED_RELATIONS as readonly string[]).includes(relationRaw)
		? (relationRaw as TurnRelation)
		: null;
	if (relation === null) return null;
	const validSeqs = new Set(turn.toolCalls.map((tc) => tc.refSequence));
	const SIGNIFICANCE = new Set(["essential", "helpful", "neutral", "wasted"]);
	const toolPatches: TurnPatch["toolPatches"] = [];
	if (Array.isArray(obj.toolPatches)) {
		for (const tp of obj.toolPatches) {
			if (!tp || typeof tp !== "object") continue;
			const seq = (tp as Record<string, unknown>).refSequence;
			if (typeof seq !== "number" || !validSeqs.has(seq)) continue;
			const significanceRaw = (tp as Record<string, unknown>).significance;
			toolPatches.push({
				refSequence: seq,
				intent: stringOrNull((tp as Record<string, unknown>).intent),
				argsSummary: stringOrNull((tp as Record<string, unknown>).argsSummary),
				resultSummary: stringOrNull((tp as Record<string, unknown>).resultSummary),
				significance:
					typeof significanceRaw === "string" && SIGNIFICANCE.has(significanceRaw)
						? (significanceRaw as ToolCallRecord["significance"])
						: null,
				followUp: stringOrNull((tp as Record<string, unknown>).followUp),
			});
		}
	}
	// Strict mode requires full coverage (fidelity guard). Lenient mode accepts
	// partial coverage — uncovered calls simply keep null summaries; facts stay
	// in the fact layer, so nothing is invented or lost.
	if (!lenient && turn.toolCalls.length > 0 && toolPatches.length !== turn.toolCalls.length) return null;
	if (toolPatches.length === 0 && turn.toolCalls.length > 0) return null;
	const unfinished = Array.isArray(obj.unfinished)
		? obj.unfinished.filter((u): u is string => typeof u === "string")
		: [];
	return {
		intent: stringOrNull(obj.intent),
		taskEssence: stringOrNull(obj.taskEssence),
		deliverable: stringOrNull(obj.deliverable),
		relation,
		plan: stringOrNull(obj.plan),
		toolPatches,
		unfinished,
		errorSummary: stringOrNull(obj.errorSummary),
	};
}

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

/** Token budget scales with tool-call count: big turns need room for full patches. */
export function distillMaxTokens(turn: TurnRecord): number {
	return Math.min(4000, 800 + turn.toolCalls.length * 150);
}

/**
 * Distill one turn. Two-level strategy: strict (full coverage) first, then a
 * lenient retry (partial coverage accepted, missing items stay null). Distill
 * failures return null and stay pending for offline re-distill via /wf-extract.
 */
export async function distillTurn(
	turn: TurnRecord,
	prev: PrevTurnContext | null,
	llm: LlmClient,
): Promise<TurnPatch | null> {
	const payload = buildUserPayload(turn, prev);
	const maxTokens = distillMaxTokens(turn);
	for (const lenient of [false, true]) {
		try {
			const text = await llm.complete({ systemPrompt: DISTILL_SYSTEM_PROMPT, userPayload: payload, maxTokens });
			const patch = parseDistillPatch(text, turn, lenient);
			if (patch) return patch;
		} catch {
			// fall through to the next strategy level
		}
	}
	return null;
}
