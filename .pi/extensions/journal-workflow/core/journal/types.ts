/**
 * Journal types: fact layer (program-written) + patch layer (LLM-distilled).
 * All records are append-only; LLM distillation never rewrites a fact line,
 * it appends a patch line that readers merge by seq.
 */

/** Simulated event stream — the adapter translates Pi extension events into these. */
export type SimEvent =
	| { kind: "session_start"; taskId: string; projectKey: string }
	| { kind: "message_end_user"; text: string; messageRef?: unknown }
	| { kind: "tool_start"; toolCallId: string; tool: string; args: unknown }
	| { kind: "tool_end"; toolCallId: string; resultContent: string; isError: boolean; reasoning?: string }
	| { kind: "turn_end"; stopReason: string; assistantText?: string }
	| { kind: "agent_settled" }
	| { kind: "session_shutdown" };

export type TurnOutcome = "completed" | "partial" | "aborted" | "failed";

export type TurnRelation = "new" | "retry" | "fix_success" | "fix_failed" | "clarify";

export interface ToolCallRecord {
	/** Tool name, program-written. */
	tool: string;
	/** Raw args truncated by the program (placeholder before distillation). */
	argsRaw: string;
	/** LLM: compact semantic summary of the arguments; null until patched. */
	argsSummary: string | null;
	/** LLM: why this tool was called (the purpose behind the call). */
	intent: string | null;
	/** Visible CoT segment immediately preceding this tool call (why THIS tool),
	 *  truncated per-call — captured when the model exposes reasoning. */
	reasoningRaw: string | null;
	status: "success" | "error" | "timeout" | "cancelled";
	/** Program-level placeholder (first text content, truncated). */
	resultRaw: string | null;
	/** LLM: what was obtained / why it failed. */
	resultSummary: string | null;
	/** LLM: actual contribution to the task — essential | helpful | neutral | wasted. */
	significance: "essential" | "helpful" | "neutral" | "wasted" | null;
	/** LLM: what the agent did next after a failure. */
	followUp: string | null;
	/** Workflow library entry id when the engine was active for this call. */
	workflowRef: string | null;
	/** Sequence number inside the turn, for patch targeting. */
	refSequence: number;
}

export interface SkillUsage {
	name: string;
	result: string | null;
}

export interface TurnRecord {
	seq: number;
	/** Session entry ids of the user / final assistant messages (object-identity resolved). */
	userEntryId: string | null;
	assistantEntryId: string | null;
	/** User input verbatim — never distilled. */
	userInput: string;
	/** Assistant's prose reply to the user, truncated — first-hand narrative of results. */
	assistantTextRaw: string | null;
	/** LLM fields below are null until a patch is applied. */
	intent: string | null;
	/** LLM: the essence of this task — what it fundamentally is ("外部检索+筛选+结构化综合"). */
	taskEssence: string | null;
	/** LLM: the essential deliverable — what the task ultimately exists to produce. */
	deliverable: string | null;
	relation: TurnRelation | null;
	plan: string | null;
	toolCalls: ToolCallRecord[];
	skills: SkillUsage[];
	outcome: TurnOutcome;
	unfinished: string[];
	errorSummary: string | null;
	/** Set on the patch line; absent on the fact line means "distillation pending". */
	extractedAt?: string;
}

/** LLM-distilled fields for one turn, merged onto the fact line by seq. */
export interface TurnPatch {
	intent: string | null;
	taskEssence: string | null;
	deliverable: string | null;
	relation: TurnRelation | null;
	plan: string | null;
	toolPatches: Array<{
		refSequence: number;
		intent: string | null;
		argsSummary: string | null;
		resultSummary: string | null;
		significance: ToolCallRecord["significance"];
		followUp: string | null;
	}>;
	unfinished: string[];
	errorSummary: string | null;
}

export type JournalLine =
	| { kind: "turn"; seq: number; turn: TurnRecord }
	| { kind: "patch"; seq: number; patch: TurnPatch; extractedAt: string };

export interface TaskBlockIndex {
	file: string;
	fromSeq: number;
	toSeq: number;
}

export interface TaskMeta {
	taskId: string;
	projectKey: string;
	createdAt: string;
	updatedAt: string;
	outcome: TurnOutcome | null;
	turnCount: number;
	blocks: TaskBlockIndex[];
}

export interface FailureRecord {
	timestamp: string;
	workflowId: string;
	stepIndex: number;
	observedResult: string;
	expect: string;
	escapeReason: string;
}

/** Max block size in turns before rotating to a new block file. */
export const BLOCK_TURN_LIMIT = 100;
/** Max block size in bytes before rotating (soft check between turns). */
export const BLOCK_BYTE_LIMIT = 1024 * 1024;

export function stopReasonToOutcome(stopReason: string): TurnOutcome {
	switch (stopReason) {
		case "stop":
			return "completed";
		case "length":
			return "partial";
		case "error":
			return "failed";
		case "aborted":
			return "aborted";
		default:
			return "partial";
	}
}

export function toolStatusFromError(isError: boolean): ToolCallRecord["status"] {
	return isError ? "error" : "success";
}

/** Extract `<skill name="...">` markers from an expanded user message. */
export function parseSkillUsage(text: string): SkillUsage[] {
	const usages: SkillUsage[] = [];
	const re = /<skill\s+name="([^"]+)"/g;
	let match = re.exec(text);
	while (match) {
		usages.push({ name: match[1], result: null });
		match = re.exec(text);
	}
	return usages;
}

/** Project key mirrors Pi's session directory encoding: cwd → --path-with-dashes--. */
export function projectKeyFromCwd(cwd: string): string {
	const normalized = cwd.replace(/\\/g, "/").replace(/^\/+/, "");
	return `--${normalized.replace(/^[/\\]/, "").replace(/[/\:]/g, "-")}--`;
}
