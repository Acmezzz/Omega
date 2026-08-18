import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type BackupField = "userInput" | "assistantText" | "assistantThinking" | "tool.args" | "tool.result" | "tool.reasoning";
export type FragmentSide = "head" | "middle" | "tail";

export interface BackupEvent {
	kind: "event";
	schemaVersion: 1;
	eventSeq: number;
	sessionId: string;
	projectKey: string;
	eventType: string;
	turnSeq: number | null;
	toolCallId: string | null;
	receivedAt: string;
	payload: unknown;
}

export interface FragmentRecord {
	kind: "fragment";
	fragmentId: string;
	eventSeq: number;
	turnSeq: number | null;
	field: BackupField;
	side: FragmentSide;
	ordinal: number;
	start: number;
	end: number;
	text: string;
	originalChars: number;
	sensitivity: "normal" | "restricted";
}

export interface FragmentIndexEntry extends Omit<FragmentRecord, "kind" | "text"> {
	line: number;
}

export interface BackupIndex {
	version: 1;
	updatedAt: string;
	events: number;
	fragments: FragmentIndexEntry[];
}

export interface BackupTextInput {
	field: BackupField;
	text: string;
	sensitivity?: "normal" | "restricted";
}

export interface BackupAppendResult {
	eventSeq: number;
	fragmentIds: Record<string, string[]>;
}

export interface BackupEventScan {
	events: BackupEvent[];
	skippedLines: number;
	duplicateSeqs: number[];
	outOfOrder: boolean;
}

export interface FragmentRequest {
	fragmentIds: string[];
	maxChars?: number;
	maxFragments?: number;
	allowSensitive?: boolean;
}

export interface FragmentResult {
	fragmentId: string;
	text: string;
	eventSeq: number;
	turnSeq: number | null;
	field: BackupField;
	side: FragmentSide;
	start: number;
	end: number;
	originalChars: number;
	sensitivity: "normal" | "restricted";
}

const SCHEMA_VERSION = 1;
const DEFAULT_FRAGMENT_SIZE = 1000;
const DEFAULT_FRAGMENT_OVERLAP = 100;
const DEFAULT_MAX_FRAGMENTS = 3;
const DEFAULT_MAX_CHARS = 3000;

function safeSnapshot(value: unknown): unknown {
	try {
		return JSON.parse(JSON.stringify(value, (_key, item) => {
			if (typeof item === "bigint") return `${item}n`;
			if (item instanceof Error) return { name: item.name, message: item.message, stack: item.stack };
			return item;
		}));
	} catch {
		return String(value);
	}
}

function readJsonLines<T>(path: string): T[] {
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try { return [JSON.parse(line) as T]; } catch { return []; }
		});
}

function chunkStarts(length: number, size: number, overlap: number): number[] {
	if (length <= size) return [0];
	const step = Math.max(1, size - overlap);
	const starts: number[] = [];
	for (let start = 0; start < length; start += step) {
		starts.push(start);
		if (start + size >= length) break;
	}
	const last = Math.max(0, length - size);
	if (starts.at(-1) !== last) starts.push(last);
	return [...new Set(starts)];
}

function makeFragments(
	eventSeq: number,
	turnSeq: number | null,
	field: BackupField,
	text: string,
	size: number,
	overlap: number,
	sensitivity: "normal" | "restricted",
): FragmentRecord[] {
	if (!text) return [];
	const starts = chunkStarts(text.length, size, overlap);
	const total = starts.length;
	return starts.map((start, index) => {
		const end = Math.min(text.length, start + size);
		const side: FragmentSide = total === 1 ? "middle" : index === 0 ? "head" : index === total - 1 ? "tail" : "middle";
		const ordinal = side === "tail" ? 1 : side === "head" ? index + 1 : index;
		const sideCode = side === "head" ? "h" : side === "tail" ? "t" : "m";
		return {
			kind: "fragment",
			fragmentId: `e${eventSeq}-${field.replace(/[^a-z]+/g, "-")}-${sideCode}${String(ordinal).padStart(2, "0")}`,
			eventSeq, turnSeq, field, side, ordinal, start, end,
			text: text.slice(start, end), originalChars: text.length, sensitivity,
		};
	});
}

export class BackupWriter {
	readonly dir: string;
	private readonly eventsPath: string;
	private readonly fragmentsPath: string;
	private readonly indexPath: string;
	private index: BackupIndex;
	private eventSeq: number;
	private fragmentSize: number;
	private fragmentOverlap: number;

	constructor(
		backupsRoot: string,
		readonly projectKey: string,
		readonly taskId: string,
		readonly sessionId: string,
		options: { fragmentSize?: number; fragmentOverlap?: number } = {},
	) {
		this.dir = join(backupsRoot, projectKey, taskId);
		mkdirSync(this.dir, { recursive: true });
		this.eventsPath = join(this.dir, "events.jl");
		this.fragmentsPath = join(this.dir, "fragments.jl");
		this.indexPath = join(this.dir, "index.json");
		this.index = this.loadIndex();
		this.eventSeq = this.index.events;
		this.fragmentSize = Math.max(100, options.fragmentSize ?? DEFAULT_FRAGMENT_SIZE);
		this.fragmentOverlap = Math.max(0, Math.min(this.fragmentSize - 1, options.fragmentOverlap ?? DEFAULT_FRAGMENT_OVERLAP));
	}

	appendEvent(
		eventType: string,
		payload: unknown,
		options: { turnSeq?: number | null; toolCallId?: string | null; texts?: BackupTextInput[] } = {},
	): BackupAppendResult {
		const eventSeq = ++this.eventSeq;
		const event: BackupEvent = {
			kind: "event", schemaVersion: SCHEMA_VERSION, eventSeq,
			sessionId: this.sessionId, projectKey: this.projectKey,
			eventType, turnSeq: options.turnSeq ?? null, toolCallId: options.toolCallId ?? null,
			receivedAt: new Date().toISOString(), payload: safeSnapshot(payload),
		};
		appendFileSync(this.eventsPath, `${JSON.stringify(event)}\n`);
		const fragmentIds: Record<string, string[]> = {};
		for (const input of options.texts ?? []) {
			const fragments = makeFragments(eventSeq, options.turnSeq ?? null, input.field, input.text, this.fragmentSize, this.fragmentOverlap, input.sensitivity ?? "normal");
			const ids: string[] = [];
			for (const fragment of fragments) {
				const line = this.index.fragments.length + 1;
				appendFileSync(this.fragmentsPath, `${JSON.stringify(fragment)}\n`);
				const { text: _text, ...indexEntry } = fragment;
				this.index.fragments.push({ ...indexEntry, line });
				ids.push(fragment.fragmentId);
			}
			fragmentIds[input.field] = ids;
		}
		this.index.events = eventSeq;
		this.index.updatedAt = new Date().toISOString();
		this.saveIndex();
		return { eventSeq, fragmentIds };
	}

	getIndex(): BackupIndex {
		return { ...this.index, fragments: this.index.fragments.map((item) => ({ ...item })) };
	}

	reader(options: { allowSensitive?: boolean } = {}): BackupReader {
		return new BackupReader(this.dir, options);
	}

	private loadIndex(): BackupIndex {
		if (existsSync(this.indexPath)) {
			try {
				const parsed = JSON.parse(readFileSync(this.indexPath, "utf8")) as BackupIndex;
				if (parsed.version === 1 && Array.isArray(parsed.fragments)) return parsed;
			} catch { /* rebuild below */ }
		}
		const fragments = readJsonLines<FragmentRecord>(this.fragmentsPath).map((fragment, index) => {
			const { text: _text, ...indexEntry } = fragment;
			return { ...indexEntry, line: index + 1 };
		});
		const events = readJsonLines<BackupEvent>(this.eventsPath).reduce((max, event) => Math.max(max, event.eventSeq), 0);
		return { version: 1, updatedAt: new Date().toISOString(), events, fragments };
	}

	private saveIndex(): void {
		writeFileSync(this.indexPath, `${JSON.stringify(this.index, null, "\t")}\n`);
	}
}

export class BackupReader {
	private readonly index: BackupIndex;
	private readonly fragments = new Map<string, FragmentRecord>();
	private readonly allowSensitive: boolean;

	constructor(private readonly dir: string, options: { allowSensitive?: boolean } = {}) {
		this.allowSensitive = options.allowSensitive ?? false;
		const indexPath = join(dir, "index.json");
		let index: BackupIndex | null = null;
		if (existsSync(indexPath)) {
			try {
				const parsed = JSON.parse(readFileSync(indexPath, "utf8")) as BackupIndex;
				if (parsed.version === 1 && Array.isArray(parsed.fragments)) index = parsed;
			} catch { /* rebuild below */ }
		}
		if (!index) {
			const records = readJsonLines<FragmentRecord>(join(dir, "fragments.jl"));
			index = { version: 1, updatedAt: new Date().toISOString(), events: readJsonLines<BackupEvent>(join(dir, "events.jl")).length, fragments: records.map((record, i) => {
				const { text: _text, ...indexEntry } = record;
				return { ...indexEntry, line: i + 1 };
			}) };
		}
		this.index = index;
		for (const record of readJsonLines<FragmentRecord>(join(dir, "fragments.jl"))) this.fragments.set(record.fragmentId, record);
	}

	scanEvents(): BackupEventScan {
		const eventsPath = join(this.dir, "events.jl");
		const events: BackupEvent[] = [];
		let skippedLines = 0;
		let outOfOrder = false;
		const duplicates: number[] = [];
		const seen = new Set<number>();
		if (existsSync(eventsPath)) {
			let previous = 0;
			for (const line of readFileSync(eventsPath, "utf8").split("\n").filter(Boolean)) {
				try {
					const event = JSON.parse(line) as BackupEvent;
					if (event.kind !== "event" || typeof event.eventSeq !== "number") { skippedLines += 1; continue; }
					if (seen.has(event.eventSeq)) duplicates.push(event.eventSeq);
					if (event.eventSeq < previous) outOfOrder = true;
					seen.add(event.eventSeq);
					previous = event.eventSeq;
					events.push(event);
				} catch { skippedLines += 1; }
			}
		}
		return { events, skippedLines, duplicateSeqs: [...new Set(duplicates)], outOfOrder };
	}

	listFragments(): FragmentIndexEntry[] {
		return this.index.fragments.map((entry) => ({ ...entry }));
	}

	getFragments(request: FragmentRequest): FragmentResult[] {
		const maxFragments = Math.min(request.maxFragments ?? DEFAULT_MAX_FRAGMENTS, DEFAULT_MAX_FRAGMENTS);
		const maxChars = Math.min(request.maxChars ?? DEFAULT_MAX_CHARS, DEFAULT_MAX_CHARS);
		if (request.fragmentIds.length > maxFragments) throw new Error("too many fragments requested");
		const out: FragmentResult[] = [];
		let used = 0;
		for (const id of request.fragmentIds) {
			const entry = this.index.fragments.find((item) => item.fragmentId === id);
			if (!entry) throw new Error(`unknown fragment: ${id}`);
			if (entry.sensitivity === "restricted" && !this.allowSensitive) throw new Error("sensitive fragment is not allowed");
			const record = this.fragments.get(id);
			if (!record) throw new Error(`missing fragment data: ${id}`);
			if (used + record.text.length > maxChars) throw new Error("fragment character budget exceeded");
			used += record.text.length;
			out.push({ fragmentId: record.fragmentId, text: record.text, eventSeq: record.eventSeq, turnSeq: record.turnSeq, field: record.field, side: record.side, start: record.start, end: record.end, originalChars: record.originalChars, sensitivity: record.sensitivity });
		}
		return out;
	}
}
