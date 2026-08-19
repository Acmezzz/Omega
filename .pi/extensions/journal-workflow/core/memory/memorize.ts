/**
 * Memorization: LLM synthesis of a MemoryRecord from fact turns (+ on-demand
 * backup fragments), triggered at context compaction.
 *
 * Fidelity rules (mirror your design):
 *  - tool calls: complete and faithful, in real-time order; every call is kept
 *    regardless of success/failure;
 *  - tool results: summarized only — success → what was gained; failure → why
 *    it failed (failure analysis), never "it just failed";
 *  - user input / LLM thinking / output: distilled.
 * Truncated fields keep backup fragment ids so the full text can be recovered.
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { FragmentResult } from "../journal/backup.ts";
import type { TurnRecord } from "../journal/types.ts";
import type { MemoryRecordData } from "./types.ts";

export const MEMORIZE_SYSTEM_PROMPT = `You synthesize a long-term memory record from one agent-turn fact log.
The memory log is the source for future workflow extraction, so fidelity and usefulness both matter.
Rules:
- Tool calls: keep EVERY tool call in real-time order (index ascending). Faithful args.
- Tool results: summarize only.
    success → resultSummary: state exactly what the tool gained (concrete output/value);
    failure → failureAnalysis: state why it failed and whether anything was learned; resultSummary: null.
- intent: why that call was made (use "reasoning" when present, else reconstruct conservatively).
- significance: "essential" (directly produced what the task needed) | "helpful" | "neutral" | "wasted".
- userIntent: distill the span's user inputs into one intent statement.
- thinking: distill assistant thinking/output; null if none.
- memories: extract salient, reusable facts a future task would want (decisions, root causes, workarounds, structure). Empty array if nothing stands out.
- If a truncated field is needed, request only fragment IDs listed in availableFragments.
Output ONLY JSON: {"patch": {...}} or {"patch": {...}, "needs": [{"fragmentIds":["..."],"reason":"..."}]}`;

interface MemoryPatch {
	userIntent: string;
	thinking: string | null;
	memories: string[];
	tools: Array<{
		index: number;
		turnSeq: number;
		refSequence: number;
		tool: string;
		status: string;
		args: string;
		argsFragmentIds?: string[];
		resultSummary: string | null;
		resultFragmentIds?: string[];
		failureAnalysis: string | null;
		intent: string | null;
		significance: string | null;
	}>;
	fragmentIds?: string[];
}

export interface MemorizeOptions {
	availableFragments?: Array<{ fragmentId: string; field: string; turnSeq: number | null; originalChars: number; sensitivity: string }>;
	fragments?: FragmentResult[];
	readFragments?: (request: { fragmentIds: string[]; maxFragments?: number; maxChars?: number; allowSensitive?: boolean }) => FragmentResult[] | Promise<FragmentResult[]>;
	maxFragments?: number;
	maxFragmentChars?: number;
	allowSensitive?: boolean;
}

/** Build the LLM input from fact turns, keeping the faithful tool timeline. */
export function buildMemoryPayload(turns: TurnRecord[], options: MemorizeOptions = {}): string {
	return JSON.stringify(
		{
			turns: turns.map((turn) => ({
				seq: turn.seq,
				userInput: turn.userInput,
				assistantText: turn.assistantTextRaw ?? null,
				toolCalls: turn.toolCalls.map((tc) => ({
					refSequence: tc.refSequence,
					tool: tc.tool,
					args: tc.argsRaw,
					reasoning: tc.reasoningRaw ?? null,
					status: tc.status,
					result: tc.resultRaw,
					truncated: {
						args: !!tc.argsTruncation,
						result: !!tc.resultTruncation,
						reasoning: !!tc.reasoningTruncation,
					},
				})),
			})),
			availableFragments: options.availableFragments ?? [],
			backupFragments: (options.fragments ?? []).map((fragment) => ({
				fragmentId: fragment.fragmentId,
				field: fragment.field,
				side: fragment.side,
				text: fragment.text,
			})),
		},
		null,
		1,
	);
}

const SIGNIFICANCE = new Set(["essential", "helpful", "neutral", "wasted"]);
const STATUS = new Set(["success", "error", "timeout", "cancelled"]);

export function parseMemoryPatch(text: string, turns: TurnRecord[]): { patch: MemoryPatch; needs: string[] } | null {
	const parsed = parseJsonLoose(text);
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	// Two-level output: {"patch": {...}} (with optional "needs") or flat patch.
	const patchValue = obj.patch && typeof obj.patch === "object" ? obj.patch as Record<string, unknown> : obj;
	const needsRaw = obj.needs;
	const needs = Array.isArray(needsRaw)
		? (needsRaw as Array<Record<string, unknown>>).flatMap((n) =>
				Array.isArray(n?.fragmentIds) ? (n.fragmentIds as unknown[]).filter((id): id is string => typeof id === "string") : [],
			)
		: [];

	const validRefs = new Map<string, { tool: string; status: string }>();
	for (const turn of turns) {
		for (const tc of turn.toolCalls) validRefs.set(`${turn.seq}:${tc.refSequence}`, { tool: tc.tool, status: tc.status });
	}

	const rawTools = Array.isArray(patchValue.tools) ? (patchValue.tools as Array<Record<string, unknown>>) : [];
	const tools: MemoryPatch["tools"] = [];
	for (const t of rawTools) {
		if (!t || typeof t !== "object") continue;
		const turnSeq = typeof t.turnSeq === "number" ? t.turnSeq : -1;
		const refSequence = typeof t.refSequence === "number" ? t.refSequence : -1;
		const key = `${turnSeq}:${refSequence}`;
		const known = validRefs.get(key);
		if (!known) continue;
		const statusRaw = typeof t.status === "string" ? t.status : known.status;
		const status = STATUS.has(statusRaw) ? statusRaw : known.status;
		const sig = typeof t.significance === "string" && SIGNIFICANCE.has(t.significance) ? t.significance : null;
		tools.push({
			index: typeof t.index === "number" ? t.index : tools.length,
			turnSeq,
			refSequence,
			tool: typeof t.tool === "string" ? t.tool : known.tool,
			status,
			args: typeof t.args === "string" ? t.args : "",
			argsFragmentIds: Array.isArray(t.argsFragmentIds) ? t.argsFragmentIds.filter((x): x is string => typeof x === "string") : undefined,
			resultSummary: typeof t.resultSummary === "string" && t.resultSummary.length > 0 ? t.resultSummary : null,
			resultFragmentIds: Array.isArray(t.resultFragmentIds) ? t.resultFragmentIds.filter((x): x is string => typeof x === "string") : undefined,
			failureAnalysis: typeof t.failureAnalysis === "string" && t.failureAnalysis.length > 0 ? t.failureAnalysis : null,
			intent: typeof t.intent === "string" && t.intent.length > 0 ? t.intent : null,
			significance: sig,
		});
	}
	tools.sort((a, b) => a.index - b.index);

	const patch: MemoryPatch = {
		userIntent: typeof patchValue.userIntent === "string" ? patchValue.userIntent : "",
		thinking: typeof patchValue.thinking === "string" && patchValue.thinking.length > 0 ? patchValue.thinking : null,
		memories: Array.isArray(patchValue.memories) ? (patchValue.memories as unknown[]).filter((m): m is string => typeof m === "string") : [],
		tools,
		fragmentIds: Array.isArray(patchValue.fragmentIds) ? (patchValue.fragmentIds as unknown[]).filter((x): x is string => typeof x === "string") : undefined,
	};

	// Strict: every expected tool must be covered (fidelity guard).
	const expected = turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
	if (tools.length !== expected) return null;
	return { patch, needs };
}

export function memorizeMaxTokens(toolCount: number): number {
	return Math.min(4000, 800 + toolCount * 120);
}

/**
 * Memorize a span of fact turns. Returns a ready-to-append record (without
 * seq) or null on failure. Two-level strategy: strict full coverage first,
 * then a lenient retry (uncovered tools are dropped, no fabrication).
 */
export async function memorizeTurn(
	turns: TurnRecord[],
	spanFrom: number,
	spanTo: number,
	llm: LlmClient,
	options: MemorizeOptions = {},
): Promise<Omit<MemoryRecordData, "seq" | "spanFromTurnSeq" | "spanToTurnSeq"> | null> {
	let fragments: FragmentResult[] = options.fragments ?? [];
	for (const lenient of [false, true]) {
		try {
			const payload = buildMemoryPayload(turns, { ...options, fragments });
			const text = await llm.complete({ systemPrompt: MEMORIZE_SYSTEM_PROMPT, userPayload: payload, maxTokens: memorizeMaxTokens(turnCountOf(turns)) });
			const parsed = parseMemoryPatch(text, turns);
			if (!parsed) continue;
			if (parsed.needs.length > 0 && options.readFragments && fragments.length === 0) {
				const allowed = new Set((options.availableFragments ?? []).map((f) => f.fragmentId));
				const requested = [...new Set(parsed.needs)].filter((id) => allowed.has(id));
				if (requested.length === 0) continue;
				fragments = await options.readFragments({
					fragmentIds: requested,
					maxFragments: options.maxFragments,
					maxChars: options.maxFragmentChars,
					allowSensitive: options.allowSensitive,
				});
				continue;
			}
			// Strict full-coverage is the fidelity guard; lenient only drops
			// uncovered tools (never invents content).
			return {
				userIntent: parsed.patch.userIntent,
				thinking: parsed.patch.thinking,
				memories: parsed.patch.memories,
				tools: parsed.patch.tools.map(normalizeTool),
				fragmentIds: parsed.patch.fragmentIds ?? fragments.map((f) => f.fragmentId),
				sourceTurns: turns.map((t) => t.seq),
			};
		} catch {
			// fall through to the next strategy level
		}
	}
	return null;
}

function normalizeTool(t: MemoryPatch["tools"][number]): MemoryRecordData["tools"][number] {
	return {
		index: t.index,
		turnSeq: t.turnSeq,
		refSequence: t.refSequence,
		tool: t.tool,
		status: t.status as MemoryRecordData["tools"][number]["status"],
		args: t.args,
		argsFragmentIds: t.argsFragmentIds,
		resultSummary: t.resultSummary,
		resultFragmentIds: t.resultFragmentIds,
		failureAnalysis: t.failureAnalysis,
		intent: t.intent,
		significance: t.significance as MemoryRecordData["tools"][number]["significance"],
	};
}

function turnCountOf(turns: TurnRecord[]): number {
	return turns.reduce((sum, turn) => sum + turn.toolCalls.length, 0);
}