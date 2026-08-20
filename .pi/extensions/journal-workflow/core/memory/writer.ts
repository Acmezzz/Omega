/**
 * MemoryWriter: append-only, segment-based memory-log writer with a coverage
 * watermark.
 *
 * The memory log is a segment stream rather than a one-shot artifact of
 * context compaction. Triggers (compact / shutdown / manual / resume) all boil
 * down to "distill facts up to seq N", unified by a coverage watermark:
 *   coverage.json  { distilledUpTo, stale, segments: [...] }
 *   seg-<NNN>.json  one distilled segment (JSONL, append-only per segment)
 *
 * Invariant: distilledUpTo >= journal maxSeq AND !stale means the task's facts
 * are fully covered. A short task (never compacted) is covered in one
 * shutdown-triggered distill; a long task is covered incrementally by multiple
 * compact-triggered segments plus a tail on shutdown. Reopening a task marks
 * coverage stale; the next trigger re-covers incrementally without rewriting
 * old segments.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { MemoryLog, MemoryRecord, MemoryRecordDataWithSpan } from "./types.ts";

export type MemoryTrigger = "compact" | "shutdown" | "manual" | "resume";

export interface CoverageSegment {
	file: string;
	fromTurnSeq: number;
	toTurnSeq: number;
	trigger: MemoryTrigger;
	model: string;
	recordedAt: string;
}

export interface MemoryCoverage {
	taskId: string;
	projectKey: string;
	createdAt: string;
	updatedAt: string;
	/** Highest fact turn seq already distilled. */
	distilledUpTo: number;
	/** True when a task was reopened and old segments must not be trusted as complete. */
	stale: boolean;
	segments: CoverageSegment[];
}

export function memoryTaskDir(journalsRoot: string, projectKey: string, taskId: string): string {
	return join(journalsRoot, projectKey, taskId, "memory");
}

function parseCoverage(path: string): MemoryCoverage | null {
	if (!existsSync(path)) return null;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as MemoryCoverage;
	} catch {
		return null;
	}
}

/** Read the coverage watermark for a task (null when no memory log exists yet). */
export function readCoverage(taskMemoryDir: string): MemoryCoverage | null {
	return parseCoverage(join(taskMemoryDir, "coverage.json"));
}

/** True only when facts are fully covered and the task wasn't reopened. */
export function isFullyCovered(coverage: MemoryCoverage, journalMaxSeq: number): boolean {
	return !coverage.stale && coverage.distilledUpTo >= journalMaxSeq;
}

/** Read all memory records, in segment then record order. */
export function readMemoryLog(taskMemoryDir: string): MemoryLog {
	const result: MemoryLog = { records: [], skippedLines: 0 };
	const coverage = parseCoverage(join(taskMemoryDir, "coverage.json"));
	if (!coverage) return result;
	// Fall back to scanning segment files when coverage.segments is missing/broken.
	const files = Array.isArray(coverage.segments) && coverage.segments.length > 0
		? coverage.segments.map((s) => s.file)
		: readdirSync(taskMemoryDir).filter((f) => /^seg-.*\.json$/.test(f)).sort();
	for (const file of files) readBlock(join(taskMemoryDir, file), result);
	result.records.sort((a, b) => a.seq - b.seq);
	return result;
}

function readBlock(path: string, result: MemoryLog): void {
	const raw = readFileSync(path, "utf-8");
	for (const line of raw.split("\n").filter((l) => l.trim().length > 0)) {
		try {
			const record = JSON.parse(line) as MemoryRecord;
			if (typeof record.seq !== "number" || !Array.isArray(record.tools)) {
				result.skippedLines++;
				continue;
			}
			result.records.push(record);
		} catch {
			result.skippedLines++;
		}
	}
}

export class MemoryWriter {
	readonly dir: string;
	private coverage: MemoryCoverage;
	private lastSeq = 0;
	private currentSegmentFile: string;
	private recordsInSegment = 0;

	constructor(
		private readonly journalsRoot: string,
		private readonly projectKey: string,
		private readonly taskId: string,
		private readonly modelName = "session-model",
	) {
		this.dir = memoryTaskDir(journalsRoot, projectKey, taskId);
		mkdirSync(this.dir, { recursive: true });
		const exist = parseCoverage(join(this.dir, "coverage.json"));
		if (exist) {
			this.coverage = exist;
			this.lastSeq = 0;
			for (const seg of this.coverage.segments) {
				// Count records already written into each segment file lazily below.
				void seg;
			}
			// Re-derive last record seq by scanning segments (authoritative).
			this.lastSeq = readMemoryLog(this.dir).records.reduce((max, r) => Math.max(max, r.seq), 0);
			const open = this.coverage.segments.at(-1);
			this.currentSegmentFile = open ? open.file : this.nextSegmentFile();
			// Freshen open segment for writing (may create a new one if we write a new trigger span).
		} else {
			this.coverage = {
				taskId,
				projectKey,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				distilledUpTo: 0,
				stale: false,
				segments: [],
			};
			this.currentSegmentFile = this.nextSegmentFile();
			this.writeCoverage();
		}
	}

	/** Mark an existing coverage stale (task reopened) WITHOUT touching old segments. */
	markStale(): void {
		if (this.coverage.stale) return;
		this.coverage.stale = true;
		this.coverage.updatedAt = new Date().toISOString();
		this.writeCoverage();
	}

	get distilledUpTo(): number {
		return this.coverage.distilledUpTo;
	}

	get isStale(): boolean {
		return this.coverage.stale;
	}

	get lastRecordSeq(): number {
		return this.lastSeq;
	}

	/** Register a new segment boundary; subsequent append()s go into this file. */
	private beginSegment(fromTurnSeq: number, toTurnSeq: number, trigger: MemoryTrigger): void {
		const file = String(this.coverage.segments.length + 1).padStart(3, "0");
		this.currentSegmentFile = `seg-${file}.json`;
		this.recordsInSegment = 0;
		this.coverage.segments.push({
			file: this.currentSegmentFile,
			fromTurnSeq,
			toTurnSeq,
			trigger,
			model: this.modelName,
			recordedAt: new Date().toISOString(),
		});
	}

	/**
	 * Append a distilled record. Reassigns coverage to the record's span and
	 * advances distilledUpTo. Records sharing the same span land in one segment.
	 */
	append(record: MemoryRecordDataWithSpan, trigger: MemoryTrigger = "compact"): MemoryRecord {
		this.lastSeq += 1;
		const full: MemoryRecord = { ...record, seq: this.lastSeq, trigger, generatedAt: new Date().toISOString() };
		// Same-span record reuses the current segment; a new span opens a new segment.
		const last = this.coverage.segments.at(-1);
		if (!last || last.toTurnSeq !== record.spanToTurnSeq || recordsInSegmentReached(this.recordsInSegment)) {
			this.beginSegment(record.spanFromTurnSeq, record.spanToTurnSeq, trigger);
		}
		appendFileSync(join(this.dir, this.currentSegmentFile), `${JSON.stringify(full)}\n`);
		this.recordsInSegment += 1;
		this.coverage.distilledUpTo = Math.max(this.coverage.distilledUpTo, record.spanToTurnSeq);
		this.coverage.stale = false;
		this.coverage.updatedAt = new Date().toISOString();
		this.writeCoverage();
		return full;
	}

	private nextSegmentFile(): string {
		return `seg-${String(this.coverage.segments.length + 1).padStart(3, "0")}.json`;
	}

	private writeCoverage(): void {
		const target = join(this.dir, "coverage.json");
		const temp = `${target}.tmp-${process.pid}`;
		writeFileSync(temp, `${JSON.stringify(this.coverage, null, "\t")}\n`);
		renameSync(temp, target);
	}
}

function recordsInSegmentReached(recordsInSegment: number): boolean {
	return recordsInSegment >= 200;
}