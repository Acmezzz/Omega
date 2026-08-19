/**
 * MemoryWriter: append-only memory-log writer with block rotation and
 * tolerant reading. Memory records are never rewritten; each context
 * compaction appends one record.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	MEMORY_BLOCK_BYTE_LIMIT,
	MEMORY_BLOCK_TURN_LIMIT,
	type MemoryLog,
	type MemoryRecord,
	type MemoryRecordDataWithSpan,
} from "./types.ts";

export interface MemoryMeta {
	taskId: string;
	projectKey: string;
	createdAt: string;
	updatedAt: string;
	recordCount: number;
	blocks: Array<{ file: string; fromSeq: number; toSeq: number }>;
}

export function memoryTaskDir(journalsRoot: string, projectKey: string, taskId: string): string {
	return join(journalsRoot, projectKey, taskId, "memory");
}

/** Read all memory records of one task, tolerating a truncated last block line. */
export function readMemoryLog(taskMemoryDir: string): MemoryLog {
	const result: MemoryLog = { records: [], skippedLines: 0 };
	let meta: MemoryMeta | null = null;
	const metaPath = join(taskMemoryDir, "memory-meta.json");
	if (existsSync(metaPath)) {
		try {
			meta = JSON.parse(readFileSync(metaPath, "utf-8")) as MemoryMeta;
		} catch {
			meta = null;
		}
	}
	if (!meta) {
		// Fall back to scanning block files directly when meta is missing/broken.
		if (existsSync(taskMemoryDir)) {
			for (const file of readdirSync(taskMemoryDir).filter((f) => /\.jl$/.test(f)).sort()) {
				readBlock(join(taskMemoryDir, file), result);
			}
		}
		return result;
	}
	for (const block of meta.blocks) {
		const blockPath = join(taskMemoryDir, block.file);
		if (!existsSync(blockPath)) continue;
		readBlock(blockPath, result);
	}
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
	private meta: MemoryMeta;
	private lastSeq = 0;
	private recordsInCurrentBlock = 0;

	constructor(journalsRoot: string, projectKey: string, taskId: string) {
		this.dir = memoryTaskDir(journalsRoot, projectKey, taskId);
		mkdirSync(this.dir, { recursive: true });
		const metaPath = join(this.dir, "memory-meta.json");
		if (existsSync(metaPath)) {
			this.meta = JSON.parse(readFileSync(metaPath, "utf-8")) as MemoryMeta;
			this.lastSeq = this.meta.recordCount;
			this.recordsInCurrentBlock = this.meta.blocks.at(-1)?.toSeq === 0
				? 0
				: (this.meta.blocks.at(-1)?.toSeq ?? 0) - (this.meta.blocks.at(-1)?.fromSeq ?? 0) + 1;
		} else {
			this.meta = {
				taskId,
				projectKey,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				recordCount: 0,
				blocks: [{ file: "001-memory.jl", fromSeq: 1, toSeq: 0 }],
			};
			this.writeMeta();
		}
	}

	get lastRecordSeq(): number {
		return this.lastSeq;
	}

	append(record: MemoryRecordDataWithSpan): MemoryRecord {
		this.lastSeq += 1;
		const full: MemoryRecord = { ...record, seq: this.lastSeq, generatedAt: new Date().toISOString() };
		this.rotateBlockIfNeeded();
		appendFileSync(join(this.dir, this.meta.blocks.at(-1)!.file), `${JSON.stringify(full)}\n`);
		this.recordsInCurrentBlock += 1;
		this.meta.recordCount = this.lastSeq;
		this.meta.blocks.at(-1)!.toSeq = this.lastSeq;
		this.meta.updatedAt = new Date().toISOString();
		this.writeMeta();
		return full;
	}

	private rotateBlockIfNeeded(): void {
		const current = this.meta.blocks.at(-1)!;
		const blockPath = join(this.dir, current.file);
		let bytes = 0;
		if (existsSync(blockPath)) bytes = statSync(blockPath).size;
		if (this.recordsInCurrentBlock >= MEMORY_BLOCK_TURN_LIMIT || bytes >= MEMORY_BLOCK_BYTE_LIMIT) {
			const nextFile = `${String(this.meta.blocks.length + 1).padStart(3, "0")}-memory.jl`;
			this.meta.blocks.push({ file: nextFile, fromSeq: this.lastSeq + 1, toSeq: this.lastSeq });
			this.recordsInCurrentBlock = 0;
		}
	}

	private writeMeta(): void {
		const target = join(this.dir, "memory-meta.json");
		const temp = `${target}.tmp-${process.pid}`;
		writeFileSync(temp, `${JSON.stringify(this.meta, null, "\t")}\n`);
		renameSync(temp, target);
	}
}