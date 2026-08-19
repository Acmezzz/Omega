/**
 * Memory log facade: generates and appends MemoryRecords from fact turns at
 * context compaction, and reads them back for workflow extraction.
 */
import type { LlmClient } from "../llm.ts";
import { join } from "node:path";
import { readTask } from "../journal/writer.ts";
import { BackupReader } from "../journal/backup.ts";
import { MemoryWriter, readMemoryLog, memoryTaskDir } from "./writer.ts";
import { memorizeTurn } from "./memorize.ts";
import type { MemoryLog, MemoryRecord } from "./types.ts";

export interface MemorizeSpanOptions {
	journalsRoot: string;
	projectKey: string;
	taskId: string;
	llm: LlmClient;
	/** Backup reader for on-demand fragments; optional. */
	backupReader?: BackupReader | null;
	allowSensitive?: boolean;
	maxFragmentsPerRequest?: number;
	maxFragmentCharsPerRequest?: number;
}

/** Read the current task's memory log (records + skipped-line count). */
export function readTaskMemory(journalsRoot: string, projectKey: string, taskId: string): MemoryLog {
	return readMemoryLog(memoryTaskDir(journalsRoot, projectKey, taskId));
}

/**
 * Build + append a MemoryRecord for the fact turns [fromSeq, toSeq].
 * Returns the appended record, or null on failure / no new turns.
 */
export async function memorizeSpan(opts: MemorizeSpanOptions, fromSeq: number, toSeq: number): Promise<MemoryRecord | null> {
	if (toSeq < fromSeq || (toSeq - fromSeq) > 400) return null;
	const { meta, turns } = readTask(join(opts.journalsRoot, opts.projectKey, opts.taskId));
	if (!meta) return null;
	const spanTurns = turns.filter((t) => t.seq >= fromSeq && t.seq <= toSeq);
	if (spanTurns.length === 0) return null;

	const availableFragments = opts.backupReader
		?.listFragments()
		.filter((f) => opts.allowSensitive || f.sensitivity !== "restricted")
		.map((f) => ({ fragmentId: f.fragmentId, field: f.field, turnSeq: f.turnSeq, originalChars: f.originalChars, sensitivity: f.sensitivity })) ?? [];
	const data = await memorizeTurn(spanTurns, fromSeq, toSeq, opts.llm, {
		availableFragments,
		readFragments: opts.backupReader ? (request) => opts.backupReader!.getFragments(request) : undefined,
		maxFragments: opts.maxFragmentsPerRequest,
		maxFragmentChars: opts.maxFragmentCharsPerRequest,
		allowSensitive: opts.allowSensitive,
	});
	if (!data) return null;
	const writer = new MemoryWriter(opts.journalsRoot, opts.projectKey, opts.taskId);
	return writer.append({ ...data, spanFromTurnSeq: fromSeq, spanToTurnSeq: toSeq });
}

export type { MemoryLog, MemoryRecord };