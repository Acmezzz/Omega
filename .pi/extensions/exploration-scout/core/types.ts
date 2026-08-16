/** Exploration-only data. No journal or workflow implementation types cross this boundary. */
import type { WorkflowPriorSummary } from "../../_shared/interop.ts";

export type ExplorationAngle = "prior-first" | "evidence-first" | "alternative-first" | "counterexample-first";
export type PriorStatus = "matched" | "none" | "unavailable";
export type ProbeStatus = "observed" | "not-observed" | "error" | "unknown";

export interface KnownFact { fact: string; source: string }

export interface TaskBrief {
	rawUserInput: string;
	objective: string;
	deliverable: string;
	acceptanceCriteria: string[];
	constraints: string[];
	knownFacts: KnownFact[];
	unknowns: string[];
	relevantPaths: string[];
	forbiddenAssumptions: string[];
}

export interface ExplorationBudget {
	maxScouts: number;
	maxConcurrent: number;
	maxToolCallsPerScout: number;
	maxProposalsPerScout: number;
	maxScoutOutputChars: number;
	maxPacketChars: number;
	timeoutMsPerScout: number;
	maxRoundsPerTask: number;
}

export const DEFAULT_EXPLORATION_BUDGET: ExplorationBudget = {
	maxScouts: 3, maxConcurrent: 3, maxToolCallsPerScout: 4, maxProposalsPerScout: 2,
	maxScoutOutputChars: 8_000, maxPacketChars: 18_000, timeoutMsPerScout: 45_000, maxRoundsPerTask: 2,
};

export type PriorResolution =
	| { kind: "matched"; summary: WorkflowPriorSummary; reason: string }
	| { kind: "none"; reason: string }
	| { kind: "unavailable"; reason: string };

export interface ProbeRecord { question: string; action: string; observation: string; status: ProbeStatus; source?: string }
export interface Proposal { id: string; idea: string; steps: string[]; assumptions: string[]; expectedEvidence: string[]; disqualifiers: string[]; probes: ProbeRecord[] }
export interface ScoutReport {
	scoutId: string; angle: ExplorationAngle; priorStatus: PriorStatus; proposals: Proposal[];
	sourcesChecked: string[]; searchesPerformed: string[]; verifiedFacts: KnownFact[]; negativeEvidence: KnownFact[];
	openQuestions: string[]; limitations: string[]; noWorkPerformed: true;
}
export type ScoutRunStatus = "completed" | "timed_out" | "aborted" | "budget_exceeded" | "parse_failed" | "spawn_failed";
export interface ScoutRunRecord { scoutId: string; angle: ExplorationAngle; status: ScoutRunStatus; toolCallCount: number; durationMs: number; report: ScoutReport | null; rawOutput?: string; error?: string }
export interface ExplorationPacket { round: number; prior: PriorResolution; runs: ScoutRunRecord[]; content: string }
export interface ScoutRoundRecord {
	roundId: string; taskId: string; projectKey: string; trigger: "initial" | "replan" | "targeted";
	taskBrief: TaskBrief; model: string; budget: ExplorationBudget; prior: PriorResolution; runs: ScoutRunRecord[];
	packet: ExplorationPacket; adoptedProposalIds: string[]; combinedPlanSummary?: string;
	verifiedOutcome: "not-yet-executed" | "succeeded" | "failed" | "aborted";
}
export interface ExplorationSelection { selectedProposalIds: string[]; combinedPlanSummary: string | null; reason: string | null }
export type ExplorationJournalLine =
	| { kind: "round"; record: ScoutRoundRecord }
	| { kind: "selection"; roundId: string; selection: ExplorationSelection };
