import type { BackupEvent, BackupEventScan } from "./backup.ts";
import type { ToolCallRecord, TurnOutcome, TurnRecord } from "./types.ts";

export interface RestorePlan {
	projectKey: string;
	taskId: string;
	eventsRead: number;
	eventsValid: number;
	eventsSkipped: number;
	turnsSeen: number;
	turnsEligible: number;
	turnsSkippedExisting: number;
	toolsRecovered: number;
	openTools: number;
	syntheticFlush: number;
	turns: TurnRecord[];
	turnsWritten?: number;
	warnings: string[];
	status: "no-op" | "planned" | "applied" | "partial" | "blocked";
}

function textFromPayload(payload: unknown): string {
	if (typeof payload === "string") return payload;
	if (Array.isArray(payload)) return payload.filter((part) => part && typeof part === "object" && (part as { type?: string }).type === "text").map((part) => String((part as { text?: unknown }).text ?? "")).join("\n");
	if (payload && typeof payload === "object") {
		const content = (payload as { content?: unknown }).content;
		if (content !== undefined) return textFromPayload(content);
	}
	return "";
}

function outcome(stopReason: string | undefined): TurnOutcome {
	switch (stopReason) {
		case "stop": return "completed";
		case "length": return "partial";
		case "error": return "failed";
		case "aborted": return "aborted";
		default: return "partial";
	}
}

function emptyTool(tool: string, refSequence: number, args: unknown): ToolCallRecord {
	return { tool, argsRaw: typeof args === "string" ? args : JSON.stringify(args) ?? String(args), argsSummary: null, intent: null, reasoningRaw: null, status: "success", resultRaw: null, resultSummary: null, significance: null, followUp: null, workflowRef: null, refSequence };
}

function reduceTurn(events: BackupEvent[], projectKey: string, taskId: string, synthetic: boolean): TurnRecord | null {
	const user = events.find((event) => event.eventType === "user_message");
	if (!user || typeof user.turnSeq !== "number") return null;
	const toolMap = new Map<string, ToolCallRecord>();
	let assistantText: string | null = null;
	let stopReason: string | undefined;
	for (const event of events) {
		if (event.eventType === "tool_execution_start" && event.toolCallId) {
			const payload = event.payload as { toolName?: unknown; args?: unknown };
			toolMap.set(event.toolCallId, emptyTool(typeof payload.toolName === "string" ? payload.toolName : "unknown", toolMap.size + 1, payload.args));
		}
		if (event.eventType === "tool_execution_end" && event.toolCallId) {
			const record = toolMap.get(event.toolCallId);
			const payload = event.payload as { result?: unknown; isError?: unknown };
			if (record) {
				record.resultRaw = textFromPayload(payload.result);
				record.status = payload.isError === true ? "error" : "success";
			} else {
				const created = emptyTool("unknown", toolMap.size + 1, null);
				created.resultRaw = textFromPayload(payload.result);
				created.status = payload.isError === true ? "error" : "success";
				toolMap.set(event.toolCallId, created);
			}
		}
		if (event.eventType === "assistant_message") assistantText = textFromPayload((event.payload as { content?: unknown }).content);
		if (event.eventType === "turn_end") stopReason = String((event.payload as { message?: { stopReason?: unknown }; stopReason?: unknown }).message?.stopReason ?? (event.payload as { stopReason?: unknown }).stopReason ?? "");
	}
	return {
		seq: user.turnSeq,
		userEntryId: null,
		assistantEntryId: null,
		userInput: textFromPayload((user.payload as { content?: unknown }).content),
		assistantTextRaw: assistantText,
		intent: null,
		taskEssence: null,
		deliverable: null,
		relation: null,
		plan: null,
		toolCalls: [...toolMap.values()],
		skills: [],
		outcome: outcome(stopReason),
		unfinished: [],
		errorSummary: null,
		...(synthetic ? { sourceFragments: [] } : {}),
	};
}

export function buildRestorePlan(scan: BackupEventScan, projectKey: string, taskId: string, existingSeqs: Set<number>): RestorePlan {
	const warnings: string[] = [];
	if (scan.skippedLines > 0) warnings.push(`备份存在 ${scan.skippedLines} 个无法解析的事件行`);
	if (scan.duplicateSeqs.length > 0) warnings.push(`备份存在重复 eventSeq：${scan.duplicateSeqs.join(",")}`);
	if (scan.outOfOrder) warnings.push("备份 eventSeq 存在乱序");
	const groups = new Map<number, BackupEvent[]>();
	for (const event of scan.events) {
		if (event.projectKey !== projectKey || event.sessionId.length === 0) { warnings.push(`事件 ${event.eventSeq} 的 project/session 元数据不匹配`); continue; }
		if (typeof event.turnSeq !== "number") continue;
		const group = groups.get(event.turnSeq) ?? [];
		group.push(event);
		groups.set(event.turnSeq, group);
	}
	const turns = [...groups.entries()].sort(([a], [b]) => a - b).map(([seq, events]) => reduceTurn(events, projectKey, taskId, !events.some((event) => event.eventType === "agent_settled" || event.eventType === "session_shutdown"))).filter((turn): turn is TurnRecord => turn !== null);
	const eligible = turns.filter((turn) => !existingSeqs.has(turn.seq));
	const openTools = eligible.reduce((sum, turn) => sum + turn.toolCalls.filter((call) => call.resultRaw === null).length, 0);
	if (openTools > 0) warnings.push(`有 ${openTools} 个工具调用缺少结果`);
	return {
		projectKey, taskId, eventsRead: scan.events.length + scan.skippedLines, eventsValid: scan.events.length, eventsSkipped: scan.skippedLines,
		turnsSeen: turns.length, turnsEligible: eligible.length, turnsSkippedExisting: turns.length - eligible.length,
		toolsRecovered: eligible.reduce((sum, turn) => sum + turn.toolCalls.length, 0), openTools, syntheticFlush: eligible.filter((turn) => turn.sourceFragments !== undefined).length,
		turns: eligible, warnings, status: eligible.length === 0 ? "no-op" : warnings.length > 0 ? "partial" : "planned",
	};
}
