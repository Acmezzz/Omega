/**
 * Memory log types: per-compaction synthesized layer.
 *
 * The memory log is LLM-generated from the (source-of-truth) fact journal plus
 * on-demand backup fragments. Two fidelity rules specific to this layer:
 *  - tool calls: complete and faithful, in real-time order, successes AND
 *    failures are both recorded;
 *  - tool results: only summarized — success → what was gained; failure → why
 *    it failed (failure analysis).
 * User input and LLM thinking/output are distilled. Long truncated fields keep
 * backup fragment ids so the full conversation can be recovered later. The
 * memory log is append-only; it is the SOLE input to workflow extraction.
 */
import type { BackupField } from "../journal/backup.ts";

export interface MemoryTool {
	/** Ordering within this memory span; matches the fact-tool sequence. */
	index: number;
	/** Underlying fact turn seq + tool refSequence for provenance. */
	turnSeq: number;
	refSequence: number;
	tool: string;
	status: "success" | "error" | "timeout" | "cancelled";
	/** Faithful (truncated) args. Truncated fields keep fragment ids. */
	args: string;
	argsFragmentIds?: string[];
	/** Distilled result summary. Success → what was gained; failure → null here. */
	resultSummary: string | null;
	resultFragmentIds?: string[];
	/** Distilled failure analysis (why it failed + whether anything learned). */
	failureAnalysis: string | null;
	/** Distilled per-call intent (from visible reasoning when available). */
	intent: string | null;
	significance: "essential" | "helpful" | "neutral" | "wasted" | null;
}

export interface MemoryRecord {
	seq: number;
	/** Fact turn range this memory span covers. */
	spanFromTurnSeq: number;
	spanToTurnSeq: number;
	generatedAt: string;
	/** Distilled from the user inputs across the span. */
	userIntent: string;
	/** Distilled from assistant thinking/output across the span. */
	thinking: string | null;
	/** Long-term-memory-style salient facts extracted from the span. */
	memories: string[];
	/** Faithful tool timeline, in real-time order, successes and failures. */
	tools: MemoryTool[];
	/** Fact turn seqs consumed to produce this record. */
	sourceTurns: number[];
	/** Backup fragments consumed during generation (provenance). */
	fragmentIds?: string[];
}

/** A memory record before its seq/span/generatedAt are assigned by the writer. */
export type MemoryRecordData = Omit<MemoryRecord, "seq" | "spanFromTurnSeq" | "spanToTurnSeq" | "generatedAt">;

/** What append() accepts: data plus an explicit span (generatedAt is stamped by the writer). */
export type MemoryRecordDataWithSpan = MemoryRecordData & { spanFromTurnSeq: number; spanToTurnSeq: number };

/** Read model merged across the append-only memory log. */
export interface MemoryLog {
	records: MemoryRecord[];
	skippedLines: number;
}

export const MEMORY_BLOCK_TURN_LIMIT = 200;
export const MEMORY_BLOCK_BYTE_LIMIT = 1024 * 1024;

export type { BackupField };