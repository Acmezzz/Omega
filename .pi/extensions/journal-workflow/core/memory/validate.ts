/**
 * Skeleton programmatic validation: diff a distilled memory record's skeleton
 * (the structured tool sequence) against the ground-truth fact journal.
 *
 * This is the "zero-cost quality gate": distillation freedom is confined to the
 * narrative/explanation fields (resultSummary, failureAnalysis, intent),
 * while the skeleton (tool / seq / status / order) can be audited by program.
 * Hallucinated calls, dropped failures, and reordering are all detectable here.
 */
import type { MemoryRecord } from "./types.ts";
import type { TurnRecord } from "../journal/types.ts";

export interface SkeletonIssue {
	kind: "hallucinated" | "missing" | "status-mismatch" | "out-of-order";
	turnSeq: number;
	refSequence: number;
	tool: string;
	memoryStatus?: string;
	factStatus?: string;
}

export interface SkeletonAudit {
	consistent: boolean;
	expectedCalls: number;
	coveredCalls: number;
	/** Calls the memory claims but the facts do not contain. */
	hallucinated: SkeletonIssue[];
	/** Fact calls the memory omitted. */
	missing: SkeletonIssue[];
	/** Calls whose status (success/error) disagrees with the facts. */
	statusMismatches: SkeletonIssue[];
}

/** Build an index of the fact journal's tool calls for diffing. */
export function factToolIndex(turns: TurnRecord[]): Map<string, { tool: string; status: string }> {
	const index = new Map<string, { tool: string; status: string }>();
	for (const turn of turns) {
		for (const tc of turn.toolCalls) {
			index.set(`${turn.seq}:${tc.refSequence}`, { tool: tc.tool, status: tc.status });
		}
	}
	return index;
}

/** Audit one memory record against the fact turns it claims to span. */
export function auditSkeleton(record: MemoryRecord, turns: TurnRecord[]): SkeletonAudit {
	const facts = factToolIndex(turns);
	const audit: SkeletonAudit = { consistent: true, expectedCalls: facts.size, coveredCalls: record.tools.length, hallucinated: [], missing: [], statusMismatches: [] };

	const seenFactKeys = new Set<string>();
	let lastOrder = -1;
	let orderBroken = false;
	for (const tool of record.tools) {
		const key = `${tool.turnSeq}:${tool.refSequence}`;
		const fact = facts.get(key);
		if (!fact) {
			audit.hallucinated.push({ kind: "hallucinated", turnSeq: tool.turnSeq, refSequence: tool.refSequence, tool: tool.tool, memoryStatus: tool.status });
			continue;
		}
		seenFactKeys.add(key);
		if (fact.tool !== tool.tool) {
			audit.hallucinated.push({ kind: "hallucinated", turnSeq: tool.turnSeq, refSequence: tool.refSequence, tool: tool.tool, memoryStatus: tool.status, factStatus: fact.tool });
		}
		if (fact.status !== tool.status) {
			audit.statusMismatches.push({ kind: "status-mismatch", turnSeq: tool.turnSeq, refSequence: tool.refSequence, tool: tool.tool, memoryStatus: tool.status, factStatus: fact.status });
		}
		if (tool.index < lastOrder) orderBroken = true;
		lastOrder = tool.index;
	}
	if (orderBroken) {
		audit.hallucinated.push({ kind: "out-of-order", turnSeq: 0, refSequence: 0, tool: "sequence" });
	}
	for (const [key, fact] of facts) {
		if (seenFactKeys.has(key)) continue;
		const [turnSeq, refSequence] = key.split(":").map(Number);
		audit.missing.push({ kind: "missing", turnSeq, refSequence, tool: fact.tool, factStatus: fact.status });
	}
	audit.consistent = audit.hallucinated.length === 0 && audit.missing.length === 0 && audit.statusMismatches.length === 0;
	return audit;
}