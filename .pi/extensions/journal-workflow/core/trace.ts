import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type ExecutionOutcome = "not-started" | "in-progress" | "succeeded" | "failed" | "partial" | "aborted" | "inconclusive";
export type TraceKind = "execution-start" | "workflow-activation" | "workflow-completed" | "checkpoint" | "retry" | "alternative" | "escape" | "outcome" | "recovery-hint";

export interface TraceEvent {
	traceId: string;
	kind: TraceKind;
	timestamp: string;
	executionId?: string;
	workflowRunId?: string;
	workflowId?: string;
	projectKey?: string;
	taskId?: string;
	turnSeq?: number;
	toolCallId?: string;
	outcome?: ExecutionOutcome;
	source?: string;
	details?: Record<string, unknown>;
}

export interface ExecutionRecord {
	executionId: string;
	workflowRunId: string;	workflowId: string;
	projectKey: string;
	taskId: string;
	status: "in-progress" | "completed" | "aborted" | "failed";
	startedAt: string;
	endedAt?: string;
}

function id(prefix: string): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createExecutionIds(): { executionId: string; workflowRunId: string } {
	return { executionId: id("exec"), workflowRunId: id("run") };
}

export class WorkflowTraceWriter {
	readonly path: string;
	constructor(private readonly root: string, create = true) {
		if (create) mkdirSync(root, { recursive: true });
		this.path = join(root, "trace.jl");
	}
	append(event: Omit<TraceEvent, "traceId" | "timestamp">): TraceEvent {
		const record: TraceEvent = { ...event, traceId: id("trace"), timestamp: new Date().toISOString() };
		appendFileSync(this.path, `${JSON.stringify(record)}\n`);
		return record;
	}
	read(): TraceEvent[] {
		if (!existsSync(this.path)) return [];
		return readFileSync(this.path, "utf8").split("\n").filter(Boolean).flatMap((line) => {
			try { return [JSON.parse(line) as TraceEvent]; } catch { return []; }
		});
	}
}

export function summarizeTrace(events: TraceEvent[]): string[] {
	return events.map((event) => {
		const ids = [event.executionId, event.workflowRunId, event.workflowId, event.taskId].filter(Boolean).join("/");
		return `${event.timestamp} ${event.kind}${ids ? ` ${ids}` : ""}${event.outcome ? ` outcome=${event.outcome}` : ""}`;
	});
}
