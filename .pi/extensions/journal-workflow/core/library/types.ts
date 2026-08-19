/**
 * Workflow library types: L1 templates (minimal reusable tool combos),
 * L2 workflows (main granularity, carry checkpoints), L3 orchestrations
 * (phase sequences referencing L2). References, never copies.
 */

export type WorkflowLevel = 1 | 2 | 3;
export type EntryStatus = "probation" | "active" | "deprecated";

export interface RegistryEntry {
	id: string;
	/** Functional category this workflow belongs to (progressive-disclosure grouping). */
	featureId: string;
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

/** Functional grouping is orthogonal to execution level (L1/L2/L3). */
export interface CatalogFeature {
	id: string;
	label: string;
	description: string;
	aliases: string[];
	/** Short summary injected during disclosure to explain the L-level semantics. */
	levelSemantics?: string;
	/** Registry IDs; entity contents remain in their level-specific files. */
	entryIds: string[];
	updatedAt: string;
}

export interface CatalogFile {
	version: 1;
	updatedAt: string;
	features: CatalogFeature[];
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

export interface WorkStrategyStep {
	intent: string;
	/** Reference to an L1/L2 workflow this step uses. */
	ref?: string;
	/** Extra guidance/attention for this step. */
	note?: string;
}

/**
 * L3 WorkStrategy: a full-task solution plan (macro guidance).
 * Unlike L2/L1 (execution workflow / atomic ops), this is the top-level
 * "how to think about and approach the whole task": reasoning + caveats +
 * which L2/L1 workflows to run. It is advisory, not a phase executor.
 * Stored under workstrategies/ but indexed by the functional catalog.
 */
export interface WorkStrategy {
	id: string;
	intent: string;
	excludes?: string[];
	featureId: string;
	/** Problem-solving outline: how to think about the whole task. */
	reasoning: string;
	/** Things to watch out for. */
	caveats: string[];
	/** Concrete sub-workflows referenced (L2/L1) with notes. */
	steps: WorkStrategyStep[];
}

/** @deprecated Use WorkStrategy. Retained as a semantic alias. */
export type L3Orchestration = WorkStrategy;

/** A reusable code asset: an independent script extracted from history. */
export interface CodeAsset {
	id: string;
	name: string;
	/** "py" | "js" | "sh" | ... used to pick the file extension. */
	language: string;
	summary: string;
	code: string;
	createdAt: string;
	sources: Array<{ taskId: string; recordSeq: number }>;
}

export type LibraryEntity = L1Template | L2Workflow | WorkStrategy;

export function isL1(entity: LibraryEntity): entity is L1Template {
	return "calls" in entity;
}

export function isL2(entity: LibraryEntity): entity is L2Workflow {
	return "steps" in entity && !("reasoning" in entity);
}

export function isL3(entity: LibraryEntity): entity is WorkStrategy {
	return "reasoning" in entity;
}
