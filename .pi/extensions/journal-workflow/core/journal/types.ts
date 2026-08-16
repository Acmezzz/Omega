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
	tool: string; argsRaw: string; argsSummary: string | null; intent: string | null; reasoningRaw: string | null;
	status: "success" | "error" | "timeout" | "cancelled"; resultRaw: string | null; resultSummary: string | null;
	significance: "essential" | "helpful" | "neutral" | "wasted" | null; followUp: string | null;
	workflowRef: string | null; refSequence: number;
}
export interface SkillUsage { name: string; result: string | null }
export interface TurnRecord {
	seq: number; userEntryId: string | null; assistantEntryId: string | null; userInput: string; assistantTextRaw: string | null;
	intent: string | null; taskEssence: string | null; deliverable: string | null; relation: TurnRelation | null; plan: string | null;
	toolCalls: ToolCallRecord[]; skills: SkillUsage[]; outcome: TurnOutcome; unfinished: string[]; errorSummary: string | null; extractedAt?: string;
}
export interface TurnPatch {
	intent: string | null; taskEssence: string | null; deliverable: string | null; relation: TurnRelation | null; plan: string | null;
	toolPatches: Array<{ refSequence: number; intent: string | null; argsSummary: string | null; resultSummary: string | null; significance: ToolCallRecord["significance"]; followUp: string | null }>;
	unfinished: string[]; errorSummary: string | null;
}
export type JournalLine = { kind: "turn"; seq: number; turn: TurnRecord } | { kind: "patch"; seq: number; patch: TurnPatch; extractedAt: string };
export interface TaskBlockIndex { file: string; fromSeq: number; toSeq: number }
export interface TaskMeta { taskId: string; projectKey: string; createdAt: string; updatedAt: string; outcome: TurnOutcome | null; turnCount: number; blocks: TaskBlockIndex[] }
export interface FailureRecord { timestamp: string; workflowId: string; stepIndex: number; observedResult: string; expect: string; escapeReason: string }
export const BLOCK_TURN_LIMIT = 100;
export const BLOCK_BYTE_LIMIT = 1024 * 1024;
export function stopReasonToOutcome(stopReason: string): TurnOutcome {
	switch (stopReason) { case "stop": return "completed"; case "length": return "partial"; case "error": return "failed"; case "aborted": return "aborted"; default: return "partial"; }
}
export function toolStatusFromError(isError: boolean): ToolCallRecord["status"] { return isError ? "error" : "success"; }
export function parseSkillUsage(text: string): SkillUsage[] {
	const usages: SkillUsage[] = []; const re = /<skill\s+name="([^"]+)"/g; let match = re.exec(text);
	while (match) { usages.push({ name: match[1], result: null }); match = re.exec(text); }
	return usages;
}

/** Project key mirrors Pi's session directory encoding. */
export { projectKeyFromCwd } from "../../../_shared/task-identity.ts";
