/**
 * JournalWriter: append-only fact-line writer with block rotation and
 * half-line-tolerant reading. LLM patches are appended as separate lines
 * and merged by seq at read time; fact lines are never rewritten.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
	BLOCK_BYTE_LIMIT,
	BLOCK_TURN_LIMIT,
	type JournalLine,
	type SimEvent,
	type TaskMeta,
	type ToolCallRecord,
	type TruncationMeta,
	type TurnOutcome,
	type TurnPatch,
	type TurnRecord,
	parseSkillUsage,
	stopReasonToOutcome,
	toolStatusFromError,
} from "./types.ts";

const RAW_ARGS_LIMIT = 800;
const RAW_RESULT_LIMIT = 500;
const RAW_TEXT_LIMIT = 2000;
const RAW_REASONING_LIMIT = 800;

export function truncateWithMeta(text: string, max: number): { text: string; meta?: TruncationMeta } {
	const value = typeof text === "string" ? text : String(text ?? "");
	if (value.length <= max) return { text: value };
	const headChars = Math.ceil(max / 2);
	const tailChars = Math.floor(max / 2);
	const omittedChars = value.length - headChars - tailChars;
	return {
		text: `${value.slice(0, headChars)}…[truncated ${omittedChars} chars]…${value.slice(value.length - tailChars)}`,
		meta: {
			originalChars: value.length,
			storedChars: headChars + tailChars,
			omittedChars,
			headChars,
			tailChars,
			strategy: "head-tail",
		},
	};
}

export function truncate(text: string, max: number): string {
	return truncateWithMeta(text, max).text;
}

export function taskDirOf(journalsRoot: string, projectKey: string, taskId: string): string {
	return join(journalsRoot, projectKey, taskId);
}

export function projectDirOf(journalsRoot: string, projectKey: string): string {
	return join(journalsRoot, projectKey);
}

export interface ReadTaskResult {
	meta: TaskMeta | null;
	turns: TurnRecord[];
	skippedLines: number;
}

/** Read one task dir: merge patches onto fact lines, tolerate a truncated last line. */
export function readTask(taskDir: string): ReadTaskResult {
	const result: ReadTaskResult = { meta: null, turns: [], skippedLines: 0 };
	const metaPath = join(taskDir, "task.json");
	if (!existsSync(metaPath)) return result;
	try {
		result.meta = JSON.parse(readFileSync(metaPath, "utf-8")) as TaskMeta;
	} catch {
		return result;
	}
	const bySeq = new Map<number, TurnRecord>();
	for (const block of result.meta.blocks ?? []) {
		const blockPath = join(taskDir, block.file);
		if (!existsSync(blockPath)) continue;
		const raw = readFileSync(blockPath, "utf-8");
		const lines = raw.split("\n").filter((l) => l.trim().length > 0);
		for (const line of lines) {
			let parsed: JournalLine;
			try {
				parsed = JSON.parse(line) as JournalLine;
			} catch {
				result.skippedLines++;
				continue;
			}
			if (parsed.kind === "turn") {
				bySeq.set(parsed.seq, parsed.turn);
			} else if (parsed.kind === "patch") {
				const turn = bySeq.get(parsed.seq);
				if (turn) applyPatch(turn, parsed.patch, parsed.extractedAt);
			}
		}
	}
	result.turns = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
	return result;
}

export function applyPatch(turn: TurnRecord, patch: TurnPatch, extractedAt: string): void {
	turn.intent = patch.intent;
	turn.taskEssence = patch.taskEssence;
	turn.deliverable = patch.deliverable;
	turn.relation = patch.relation;
	turn.plan = patch.plan;
	turn.unfinished = patch.unfinished ?? [];
		turn.errorSummary = patch.errorSummary;
		turn.sourceFragments = patch.sourceFragments;
		turn.extractedAt = extractedAt;

	for (const tp of patch.toolPatches ?? []) {
		const tc = turn.toolCalls.find((c) => c.refSequence === tp.refSequence);
		if (tc) {
			tc.intent = tp.intent;
			tc.argsSummary = tp.argsSummary;
			tc.resultSummary = tp.resultSummary;
			tc.significance = tp.significance;
			tc.followUp = tp.followUp;
		}
	}
}

/** List task dirs under a project key. */
export function listTasks(journalsRoot: string, projectKey: string): string[] {
	const projectDir = projectDirOf(journalsRoot, projectKey);
	if (!existsSync(projectDir)) return [];
	return readdirSync(projectDir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => join(projectDir, e.name));
}

export class JournalWriter {
	private readonly taskDir: string;
	private meta: TaskMeta;
	private currentTurn: TurnRecord | null = null;
	private pendingTools = new Map<string, ToolCallRecord>();
	private lastSeq = 0;
	private turnsInCurrentBlock = 0;

	constructor(journalsRoot: string, projectKey: string, taskId: string) {
		this.taskDir = taskDirOf(journalsRoot, projectKey, taskId);
		mkdirSync(this.taskDir, { recursive: true });
		const metaPath = join(this.taskDir, "task.json");
			if (existsSync(metaPath)) {
				this.meta = JSON.parse(readFileSync(metaPath, "utf-8")) as TaskMeta;
				const recovered = readTask(this.taskDir);
				const maxSeq = recovered.turns.reduce((max, turn) => Math.max(max, turn.seq), 0);
				this.lastSeq = Math.max(this.meta.turnCount, maxSeq);
				this.meta.turnCount = this.lastSeq;
				this.turnsInCurrentBlock = this.meta.blocks.at(-1)
					? this.meta.blocks.at(-1)!.toSeq - this.meta.blocks.at(-1)!.fromSeq + 1
					: 0;
		} else {
			this.meta = {
				taskId,
				projectKey,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
				outcome: null,
				turnCount: 0,
				blocks: [{ file: "0001.jl", fromSeq: 1, toSeq: 0 }],
			};
			this.writeMeta();
		}
	}

	get taskId(): string {
		return this.meta.taskId;
	}

	get projectKey(): string {
		return this.meta.projectKey;
	}

	get dir(): string {
		return this.taskDir;
	}

	/** Entry ids resolved by the adapter via object identity (events don't carry them). */
	setEntryIds(userEntryId: string | null, assistantEntryId: string | null): void {
		if (this.currentTurn) {
			this.currentTurn.userEntryId = userEntryId;
			this.currentTurn.assistantEntryId = assistantEntryId;
		}
	}

	/** Attach the active workflow id to tool calls recorded from now on. */
	setActiveWorkflow(ref: string | null): void {
		if (this.currentTurn && ref) {
			for (const tc of this.currentTurn.toolCalls) {
				if (!tc.workflowRef) tc.workflowRef = ref;
			}
			this._activeRef = ref;
		} else {
			this._activeRef = ref;
		}
	}
	private _activeRef: string | null = null;

	handleEvent(ev: SimEvent): void {
		switch (ev.kind) {
			case "session_start":
				break;
				case "message_end_user":
					this.beginTurn(ev.text, ev.fragmentIds);
					break;
				case "tool_start":
					this.onToolStart(ev.toolCallId, ev.tool, ev.args, ev.argsFragmentIds);
					break;
				case "tool_end":
					this.onToolEnd(ev.toolCallId, ev.resultContent, ev.isError, ev.reasoning, ev.resultFragmentIds, ev.reasoningFragmentIds);
					break;
				case "turn_end":
					this.onTurnEnd(ev.stopReason, ev.assistantText, ev.assistantFragmentIds);

				break;
			case "agent_settled":
				this.flushTurn();
				break;
			case "session_shutdown":
				this.finalizeTask();
				break;
		}
	}

	/** Append fact turns recovered from a backup; existing seq values are not overwritten. */
	appendRecoveredTurns(turns: TurnRecord[]): number {
		let written = 0;
		for (const turn of [...turns].sort((a, b) => a.seq - b.seq)) {
			if (turn.seq <= this.lastSeq) continue;
			this.lastSeq = turn.seq;
			this.rotateBlockIfNeeded();
			this.appendLine({ kind: "turn", seq: turn.seq, turn });
			this.meta.blocks.at(-1)!.toSeq = turn.seq;
			this.meta.turnCount = this.lastSeq;
			this.meta.outcome = turn.outcome;
			this.meta.updatedAt = new Date().toISOString();
			written += 1;
		}
		if (written > 0) this.writeMeta();
		return written;
	}

	/** Distillation writes its result as an append-only patch line. */
	appendPatch(seq: number, patch: TurnPatch): void {
		const line: JournalLine = { kind: "patch", seq, patch, extractedAt: new Date().toISOString() };
		this.appendLine(line);
	}

	appendFailure(record: { workflowId: string; stepIndex: number; observedResult: string; expect: string; escapeReason: string }): void {
		appendFileSync(
			join(this.taskDir, "failures.jl"),
			`${JSON.stringify({ timestamp: new Date().toISOString(), ...record })}\n`,
		);
		this.meta.extractionPriority = "recovery";
		this.meta.pendingReason = "workflow-escape-recovery";
		this.meta.updatedAt = new Date().toISOString();
		this.writeMeta();
	}

	readFailures(): Array<Record<string, unknown>> {
		const p = join(this.taskDir, "failures.jl");
		if (!existsSync(p)) return [];
		return readFileSync(p, "utf-8")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => {
				try {
					return JSON.parse(l) as Record<string, unknown>;
				} catch {
					return null;
				}
			})
			.filter((x): x is Record<string, unknown> => x !== null);
	}

	private beginTurn(userInput: string, fragmentIds?: string[]): void {
		if (this.currentTurn) this.flushTurn();
		this.lastSeq += 1;
		const bounded = truncateWithMeta(userInput, RAW_TEXT_LIMIT);
		this.currentTurn = {
			seq: this.lastSeq,
			userEntryId: null,
			assistantEntryId: null,
			userInput: bounded.text,
			...(bounded.meta ? { userInputTruncation: { ...bounded.meta, fragmentIds } } : {}),
			assistantTextRaw: null,
			intent: null,
			taskEssence: null,
			deliverable: null,
			relation: null,
			plan: null,
			toolCalls: [],
			skills: parseSkillUsage(userInput),
			outcome: "partial",
			unfinished: [],
			errorSummary: null,
		};
		this.pendingTools.clear();
	}

	private onToolStart(toolCallId: string, tool: string, args: unknown, fragmentIds?: string[]): void {
		if (!this.currentTurn) return;
			const argsBounded = truncateWithMeta(safeStringify(args), RAW_ARGS_LIMIT);
			const record: ToolCallRecord = {
				tool,
				argsRaw: argsBounded.text,

			argsSummary: null,
			intent: null,
			reasoningRaw: null,
			status: "success",
			resultRaw: null,
			resultSummary: null,
			significance: null,
			followUp: null,
				workflowRef: this._activeRef,
				refSequence: this.currentTurn.toolCalls.length + 1,
				...(argsBounded.meta ? { argsTruncation: { ...argsBounded.meta, fragmentIds } } : {}),

		};
		this.currentTurn.toolCalls.push(record);
		this.pendingTools.set(toolCallId, record);
	}

	private onToolEnd(toolCallId: string, resultContent: string, isError: boolean, reasoning?: string, resultFragmentIds?: string[], reasoningFragmentIds?: string[]): void {
		const record = this.pendingTools.get(toolCallId);
		if (!record) return;
		record.status = toolStatusFromError(isError);
		const resultBounded = truncateWithMeta(resultContent, RAW_RESULT_LIMIT);
		record.resultRaw = resultBounded.text;
		if (resultBounded.meta) record.resultTruncation = { ...resultBounded.meta, fragmentIds: resultFragmentIds };
		if (reasoning && reasoning.trim().length > 0) {
			const reasoningBounded = truncateWithMeta(reasoning, RAW_REASONING_LIMIT);
			record.reasoningRaw = reasoningBounded.text;
			if (reasoningBounded.meta) record.reasoningTruncation = { ...reasoningBounded.meta, fragmentIds: reasoningFragmentIds };
		}
		this.pendingTools.delete(toolCallId);
	}

	private onTurnEnd(stopReason: string, assistantText?: string, fragmentIds?: string[]): void {
		if (!this.currentTurn) return;
		this.currentTurn.outcome = stopReasonToOutcome(stopReason);
		if (assistantText && assistantText.trim().length > 0) {
			const assistantBounded = truncateWithMeta(assistantText, RAW_TEXT_LIMIT);
			this.currentTurn.assistantTextRaw = assistantBounded.text;
			if (assistantBounded.meta) this.currentTurn.assistantTextTruncation = { ...assistantBounded.meta, fragmentIds };
		}
	}

	private lastFlushedTurn: TurnRecord | null = null;

	/** The most recently flushed fact turn (input for distillation). */
	get flushedTurn(): TurnRecord | null {
		return this.lastFlushedTurn;
	}

	get currentTurnSeq(): number | null {
		return this.currentTurn?.seq ?? null;
	}

	get nextTurnSeq(): number {
		return this.currentTurn?.seq ?? this.lastSeq + 1;
	}

	private flushTurn(): TurnRecord | null {
		if (!this.currentTurn) return null;
		this.rotateBlockIfNeeded();
		this.appendLine({ kind: "turn", seq: this.currentTurn.seq, turn: this.currentTurn });
		this.meta.turnCount = this.lastSeq;
		this.meta.outcome = this.currentTurn.outcome as TurnOutcome;
		this.meta.updatedAt = new Date().toISOString();
		this.meta.blocks.at(-1)!.toSeq = this.lastSeq;
		this.writeMeta();
		this.lastFlushedTurn = this.currentTurn;
		this.currentTurn = null;
		return this.lastFlushedTurn;
	}

	private rotateBlockIfNeeded(): void {
		const current = this.meta.blocks.at(-1)!;
		const blockPath = join(this.taskDir, current.file);
		let bytes = 0;
		if (existsSync(blockPath)) {
			bytes = statSync(blockPath).size;
		}
		if (this.turnsInCurrentBlock >= BLOCK_TURN_LIMIT || bytes >= BLOCK_BYTE_LIMIT) {
			const nextFile = `${String(this.meta.blocks.length + 1).padStart(4, "0")}.jl`;
				this.meta.blocks.push({ file: nextFile, fromSeq: this.lastSeq + 1, toSeq: this.lastSeq });
			this.turnsInCurrentBlock = 0;
		}
	}

	private appendLine(line: JournalLine): void {
		const current = this.meta.blocks.at(-1)!;
		appendFileSync(join(this.taskDir, current.file), `${JSON.stringify(line)}\n`);
		if (line.kind === "turn") this.turnsInCurrentBlock += 1;
	}

	private writeMeta(): void {
		const target = join(this.taskDir, "task.json");
		const temp = `${target}.tmp-${process.pid}`;
		writeFileSync(temp, `${JSON.stringify(this.meta, null, "\t")}\n`);
		renameSync(temp, target);
	}

	private finalizeTask(): void {
		if (this.currentTurn) this.flushTurn();
		this.meta.updatedAt = new Date().toISOString();
		this.writeMeta();
	}
}

function safeStringify(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value);
	} catch {
		return String(value);
	}
}
