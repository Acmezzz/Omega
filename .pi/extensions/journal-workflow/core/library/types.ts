/**
 * Workflow library types: L1 templates (minimal reusable tool combos),
 * L2 workflows (main granularity, carry checkpoints), L3 orchestrations
 * (phase sequences referencing L2). References, never copies.
 */

export type WorkflowLevel = 1 | 2 | 3;
export type EntryStatus = "probation" | "active" | "deprecated";

export interface RegistryEntry {
	id: string;
	level: WorkflowLevel;
	/** Trigger semantics — what task family this entry covers. */
	intent: string;
	/** Exclusion cues: entry is skipped when any of these appear in the task text. */
	excludes?: string[];
	/** Successfully verified instances. */
	evidence: number;
	usage: number;
	escapes: number;
	status: EntryStatus;
	updatedAt: string;
}

export interface L1Template {
	id: string;
	intent: string;
	excludes?: string[];
	calls: Array<{ tool: string; argsTemplate: string }>;
	expect?: string;
	/** Alternative L1 ids to try when this template fails. */
	variants: string[];
}

export interface Step {
	intent: string;
	/** Reference to an L1 template (shared part) — mutually exclusive with action. */
	ref?: string;
	/** Inline action template (workflow-specific part). */
	action?: { tool: string; argsTemplate: string };
	/** Checkpoint description: what a healthy result looks like. */
	expect?: string;
	/** Retry budget before switching to the alternative or escaping (default 2). */
	retries?: number;
	/** Branch: L1/L2 id to switch to when this step exhausts retries. */
	alternative?: string;
}

export interface L2Workflow {
	id: string;
	intent: string;
	excludes?: string[];
	steps: Step[];
}

export interface L3Phase {
	goal: string;
	/** Default L2 id — advisory; runtime may rematch. */
	defaultRef?: string;
	fallback: "inline" | "abort";
	loop?: { onFailOf: string; goToPhase: number };
}

export interface L3Orchestration {
	id: string;
	intent: string;
	excludes?: string[];
	phases: L3Phase[];
}

export type LibraryEntity = L1Template | L2Workflow | L3Orchestration;

export function entityDir(level: WorkflowLevel): string {
	switch (level) {
		case 1:
			return "atoms";
		case 2:
			return "workflows";
		case 3:
			return "orchestrations";
	}
}

export function isL1(entity: LibraryEntity): entity is L1Template {
	return "calls" in entity;
}

export function isL2(entity: LibraryEntity): entity is L2Workflow {
	return "steps" in entity;
}

export function isL3(entity: LibraryEntity): entity is L3Orchestration {
	return "phases" in entity;
}
