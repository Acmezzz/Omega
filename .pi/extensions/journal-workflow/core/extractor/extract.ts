/**
 * Extraction pipeline: journals → workflow library.
 *  1. load tasks, keep distilled turns (count pending ones)
 *  2. programmatic mining: recurring adjacent tool patterns (≥ minCoOccurrence)
 *     and cross-task skeletons (LCS over completed tasks)
 *  3. LLM: name intents / propose drafts / judge similarity vs registry
 *  4. merge: similar → evidence++; new → probation entries
 *  5. failure replay: post-escape recovery paths → alternative suggestions
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { JournalWriter, listTasks, readTask } from "../journal/writer.ts";
import { distillTurn } from "../journal/distill.ts";
import type { TurnRecord } from "../journal/types.ts";
import type { LlmClient } from "../llm.ts";
import type { WorkflowStore } from "../library/store.ts";
import type { L1Template, L2Workflow, Step } from "../library/types.ts";
import { alignSkeletons, findRecurringPatterns, toolSequenceOfTurn } from "./segment.ts";
import {
	judgeSimilarity,
	proposeAlternative,
	proposeL1,
	proposeWorkflow,
	type ProposedL2,
	type TaskSummaryForProposal,
} from "./pack.ts";

export interface ExtractReport {
	tasksScanned: number;
	turnsDistilled: number;
	turnsPendingDistill: number;
	completedTasks: number;
	l1Created: string[];
	l2Created: string[];
	mergedInto: string[];
	alternativesProposed: Array<{ workflowId: string; stepIndex: number; alternative: string }>;
	skeleton: string[];
	recurringPatterns: Array<{ tools: string[]; count: number }>;
}

export interface ExtractOptions {
	journalsRoot: string;
	projectKey: string;
	store: WorkflowStore;
	llm: LlmClient;
	minCoOccurrence?: number;
	/** Skip library writes; report what would happen (LLM calls still run). */
	dryRun?: boolean;
}

interface LoadedTask {
	taskId: string;
	turns: TurnRecord[];
	pendingDistill: number;
	outcome: string | null;
	failures: Array<Record<string, unknown>>;
}

interface FailureRecordShape {
	timestamp?: unknown;
	workflowId?: unknown;
	stepIndex?: unknown;
	expect?: unknown;
	escapeReason?: unknown;
}

function readFailureRecords(taskDir: string): Array<Record<string, unknown>> {
	const path = join(taskDir, "failures.jl");
	if (!existsSync(path)) return [];
	return readFileSync(path, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => {
			try {
				return JSON.parse(line) as Record<string, unknown>;
			} catch {
				return null;
			}
		})
		.filter((x): x is Record<string, unknown> => x !== null);
}

function loadTasks(journalsRoot: string, projectKey: string): LoadedTask[] {
	const tasks: LoadedTask[] = [];
	for (const dir of listTasks(journalsRoot, projectKey)) {
		const result = readTask(dir);
		if (!result.meta) continue;
		tasks.push({
			taskId: result.meta.taskId,
			turns: result.turns,
			pendingDistill: result.turns.filter((t) => t.extractedAt === undefined).length,
			outcome: result.meta.outcome,
			failures: readFailureRecords(dir),
		});
	}
	return tasks;
}

/** The workflow that guided a turn (from toolCall.workflowRef), if any. */
function turnWorkflowRef(turn: TurnRecord): string | null {
	return turn.toolCalls.find((tc) => tc.workflowRef)?.workflowRef ?? null;
}

function containsSubsequence(seq: string[], pattern: string[]): boolean {
	let idx = 0;
	for (const tool of seq) {
		if (idx < pattern.length && tool === pattern[idx]) idx++;
	}
	return idx === pattern.length;
}

function stepsFromProposal(proposed: ProposedL2): Step[] {
	return proposed.steps.map((s) => ({
		intent: s.intent,
		action: { tool: s.tool, argsTemplate: `(${s.tool} 调用)` },
		expect: s.expect ?? undefined,
		retries: 2,
	}));
}

export async function runExtraction(opts: ExtractOptions): Promise<ExtractReport> {
	const minCoOccurrence = opts.minCoOccurrence ?? 3;
	const report: ExtractReport = {
		tasksScanned: 0,
		turnsDistilled: 0,
		turnsPendingDistill: 0,
		completedTasks: 0,
		l1Created: [],
		l2Created: [],
		mergedInto: [],
		alternativesProposed: [],
		skeleton: [],
		recurringPatterns: [],
	};

	const tasks = loadTasks(opts.journalsRoot, opts.projectKey);
	report.tasksScanned = tasks.length;

	// ---- 0. Re-distill pending turns first (crash/timeout recovery) ----
	if (!opts.dryRun) {
		for (const task of tasks) {
			const pending = task.turns.filter((t) => t.extractedAt === undefined);
			if (pending.length === 0) continue;
			const writer = new JournalWriter(opts.journalsRoot, opts.projectKey, task.taskId);
			for (const turn of pending) {
				const patch = await distillTurn(turn, null, opts.llm);
				if (patch) {
					writer.appendPatch(turn.seq, patch);
					turn.intent = patch.intent;
					turn.taskEssence = patch.taskEssence;
					turn.deliverable = patch.deliverable;
					turn.relation = patch.relation;
					turn.plan = patch.plan;
					turn.unfinished = patch.unfinished;
					turn.errorSummary = patch.errorSummary;
					turn.extractedAt = new Date().toISOString();
					for (const tp of patch.toolPatches) {
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
			}
		}
		// Reload with fresh patches so the report reflects reality.
		tasks.length = 0;
		tasks.push(...loadTasks(opts.journalsRoot, opts.projectKey));
	}

	const distilledTurns: TurnRecord[] = [];
	for (const task of tasks) {
		report.turnsPendingDistill += task.pendingDistill;
		for (const turn of task.turns) {
			if (turn.extractedAt !== undefined) distilledTurns.push(turn);
		}
	}
	report.turnsDistilled = distilledTurns.length;

	const completedTasks = tasks.filter(
		(t) =>
			t.outcome === "completed" &&
			t.turns.some((turn) => turn.extractedAt !== undefined && turn.outcome === "completed"),
	);
	report.completedTasks = completedTasks.length;

	// ---- 1. Cross-task recurring tool patterns → L1 candidates ----
	const allSequences = distilledTurns.map(toolSequenceOfTurn).filter((s) => s.length > 0);
	const patterns = findRecurringPatterns(allSequences, 2, minCoOccurrence);
	report.recurringPatterns = patterns;
	for (const pattern of patterns) {
		const exampleTasks = distilledTurns
			.filter((turn) => containsSubsequence(toolSequenceOfTurn(turn), pattern.tools))
			.slice(0, 5)
			.map((turn) => turn.userInput);
		const proposed = await proposeL1(pattern, exampleTasks, opts.llm);
		if (!proposed) continue;
		const similarTo = await judgeSimilarity(proposed.intent, opts.store.getRegistry(), opts.llm);
		if (similarTo) {
			if (!opts.dryRun) opts.store.mergeInto({ ...proposed, variants: [] } as unknown as L1Template, similarTo, 1);
			report.mergedInto.push(similarTo);
			continue;
		}
		if (!opts.dryRun) {
			const entity: L1Template = {
				id: proposed.id,
				intent: proposed.intent,
				calls: proposed.calls,
				expect: proposed.expect ?? undefined,
				variants: [],
			};
			opts.store.upsertEntity(entity, 1);
		}
		report.l1Created.push(proposed.id);
	}

	// ---- 2. Completed-task skeletons → L2 candidate ----
	// Skeletons come from FREE-MODE completed turns only: workflow-guided turns
	// follow a template by construction and would pollute the native pattern
	// (their value is consumed by failure replay below).
	const completedSequences = completedTasks.flatMap((t) =>
		t.turns
			.filter((turn) => turn.outcome === "completed" && turn.toolCalls.length > 0 && turnWorkflowRef(turn) === null)
			.map(toolSequenceOfTurn),
	);
	if (completedSequences.length >= 2) {
		const skeleton = alignSkeletons(completedSequences);
		report.skeleton = skeleton;
		if (skeleton.length >= 3) {
			const summaries: TaskSummaryForProposal[] = completedTasks.map((t) => ({
				taskId: t.taskId,
				outcome: t.outcome ?? "unknown",
				turns: t.turns
					.filter((turn) => turn.toolCalls.length > 0)
					.map((turn) => ({
						seq: turn.seq,
						intent: turn.intent,
						relation: turn.relation,
						outcome: turn.outcome,
						tools: toolSequenceOfTurn(turn),
					})),
			}));
			const proposed: ProposedL2 | null = await proposeWorkflow(summaries, opts.llm);
			if (proposed) {
				const similarTo = await judgeSimilarity(proposed.intent, opts.store.getRegistry(), opts.llm);
				const entity: L2Workflow = {
					id: proposed.id,
					intent: proposed.intent,
					steps: stepsFromProposal(proposed),
				};
				if (similarTo) {
					if (!opts.dryRun) opts.store.mergeInto(entity, similarTo, 2);
					report.mergedInto.push(similarTo);
				} else {
					if (!opts.dryRun) opts.store.upsertEntity(entity, 2);
					report.l2Created.push(proposed.id);
				}
			}
		}
	}

	// ---- 3. Failure replay → alternatives ----
	for (const task of tasks) {
		for (const raw of task.failures) {
			const failure = raw as FailureRecordShape;
			const workflowId = typeof failure.workflowId === "string" ? failure.workflowId : null;
			const stepIndex = typeof failure.stepIndex === "number" ? failure.stepIndex : null;
			if (!workflowId || stepIndex === null) continue;
			const l2 = opts.store.getL2(workflowId);
			if (!l2) continue;
			if (l2.steps[stepIndex]?.alternative) continue; // already learned
			// Recovery path: completed turns of the same task that ran WITHOUT workflow guidance.
			const recoveryTools = task.turns
				.filter((turn) => turn.outcome === "completed" && turnWorkflowRef(turn) === null)
				.flatMap(toolSequenceOfTurn);
			const suggestion = await proposeAlternative(
				{
					workflowId,
					stepIndex,
					expect: typeof failure.expect === "string" ? failure.expect : "",
					escapeReason: typeof failure.escapeReason === "string" ? failure.escapeReason : "",
				},
				recoveryTools,
				opts.store.getRegistry(),
				opts.llm,
			);
			if (suggestion && suggestion.alternative !== "free") {
				const target = opts.store.getL2(workflowId);
				if (target && target.steps[stepIndex] && !target.steps[stepIndex].alternative) {
					if (!opts.dryRun) {
						target.steps[stepIndex].alternative = suggestion.alternative;
						opts.store.upsertEntity(target, 2);
					}
					report.alternativesProposed.push({ workflowId, stepIndex, alternative: suggestion.alternative });
				}
			}
		}
	}

	return report;
}
