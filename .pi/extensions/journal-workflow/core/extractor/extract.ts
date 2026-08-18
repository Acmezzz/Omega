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
import { BackupReader } from "../journal/backup.ts";
import { distillTurn } from "../journal/distill.ts";
import type { TurnRecord } from "../journal/types.ts";
import type { LlmClient } from "../llm.ts";
import type { WorkflowStore } from "../library/store.ts";
import type { CatalogFeature, L1Template, L2Workflow, Step } from "../library/types.ts";
import { alignSkeletons, findRecurringPatterns, toolSequenceOfTurn } from "./segment.ts";
import {
		judgeSimilarity,
		matchExistingCatalog,
		proposeAlternative,
		proposeNewCatalog,

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
	catalogFeaturesCreated: string[];
	catalogEntriesAssigned: string[];
	catalogEntriesUnmatched: string[];
	catalogPhaseSkipped: string | null;
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
	backupsRoot?: string;
	backupEnabled?: boolean;
	allowSensitiveFragments?: boolean;
	maxFragmentCharsPerRequest?: number;
	maxFragmentsPerRequest?: number;
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
			catalogFeaturesCreated: [],
			catalogEntriesAssigned: [],
			catalogEntriesUnmatched: [],
			catalogPhaseSkipped: null,
			alternativesProposed: [],

		skeleton: [],
		recurringPatterns: [],
	};

	const tasks = loadTasks(opts.journalsRoot, opts.projectKey);
	report.tasksScanned = tasks.length;
	const catalogEntryIds = new Set<string>();

	// ---- 0. Re-distill pending turns first (crash/timeout recovery) ----
	if (!opts.dryRun) {
		for (const task of tasks) {
			const pending = task.turns.filter((t) => t.extractedAt === undefined);
			if (pending.length === 0) continue;
				const writer = new JournalWriter(opts.journalsRoot, opts.projectKey, task.taskId);
				const backupDir = opts.backupEnabled === false ? null : join(opts.backupsRoot ?? join(opts.journalsRoot, ".backups"), opts.projectKey, task.taskId);
				const backupReader = backupDir ? new BackupReader(backupDir, { allowSensitive: opts.allowSensitiveFragments }) : null;
				for (const turn of pending) {
					const availableFragments = backupReader?.listFragments()
						.filter((fragment) => fragment.turnSeq === turn.seq)
						.filter((fragment) => opts.allowSensitiveFragments || fragment.sensitivity !== "restricted")
						.map(({ fragmentId, field, side, originalChars, sensitivity }) => ({ fragmentId, field, side, originalChars, sensitivity }));
					const patch = await distillTurn(turn, null, opts.llm, {
						availableFragments,
						readFragments: (request) => backupReader?.getFragments(request) ?? [],
						allowSensitiveFragments: opts.allowSensitiveFragments,
						maxFragmentChars: opts.maxFragmentCharsPerRequest,
						maxFragments: opts.maxFragmentsPerRequest,
					});

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
			const similarTo = await judgeSimilarity(proposed.intent, opts.store.getRegistry(), opts.llm, 1);
			if (similarTo) {
				const merged = opts.dryRun ? opts.store.getEntry(similarTo) : opts.store.mergeInto({ ...proposed, variants: [] } as unknown as L1Template, similarTo, 1);
				if (merged) {
					report.mergedInto.push(similarTo);
					catalogEntryIds.add(similarTo);
					continue;
				}
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
			catalogEntryIds.add(proposed.id);
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
					const similarTo = await judgeSimilarity(proposed.intent, opts.store.getRegistry(), opts.llm, 2);
					const entity: L2Workflow = {

					id: proposed.id,
					intent: proposed.intent,
					steps: stepsFromProposal(proposed),
				};
						if (similarTo) {
							const merged = opts.dryRun ? opts.store.getEntry(similarTo) : opts.store.mergeInto(entity, similarTo, 2);
							if (merged) {
								report.mergedInto.push(similarTo);
								catalogEntryIds.add(similarTo);
							} else {
								if (!opts.dryRun) opts.store.upsertEntity(entity, 2);
								report.l2Created.push(proposed.id);
								catalogEntryIds.add(proposed.id);
							}
					} else {

						if (!opts.dryRun) opts.store.upsertEntity(entity, 2);
						report.l2Created.push(proposed.id);
						catalogEntryIds.add(proposed.id);
					}

			}
		}
	}

		// ---- 3. Functional catalog maintenance: existing categories first, new ones second ----
		const existingCatalog = opts.store.getCatalogFeatures();
		const indexedIds = new Set(existingCatalog.flatMap((feature) => feature.entryIds));
		if (existingCatalog.length === 0) {
			for (const entry of opts.store.getRegistry()) catalogEntryIds.add(entry.id);
		} else {
			for (const entry of opts.store.getRegistry()) {
				if (!indexedIds.has(entry.id)) catalogEntryIds.add(entry.id);
			}
		}
		const catalogEntries = opts.store
			.getRegistry()
			.filter((entry) => catalogEntryIds.has(entry.id))
			.map(({ id, level, intent, excludes }) => ({ id, level, intent, excludes }));
		const featureCards = existingCatalog.map(({ id, label, description, aliases }) => ({ id, label, description, aliases }));
		const knownEntryIds = new Set(catalogEntries.map((entry) => entry.id));
		const matchedExistingIds = new Set<string>();
		let unmatchedEntries = catalogEntries;

		if (catalogEntries.length > 0 && existingCatalog.length > 0) {
			const existingMatch = await matchExistingCatalog(featureCards, catalogEntries, opts.llm);
			if (!existingMatch) {
				report.catalogPhaseSkipped = "existing-match-failed";
			} else {
				const knownFeatureIds = new Set(existingCatalog.map((feature) => feature.id));
				for (const assignment of existingMatch.assignments) {
					if (!knownEntryIds.has(assignment.entryId)) continue;
					const validFeatureIds = [...new Set(assignment.featureIds)].filter((id) => knownFeatureIds.has(id));
					if (validFeatureIds.length === 0) continue;
					matchedExistingIds.add(assignment.entryId);
					for (const featureId of validFeatureIds) {
						if (!opts.dryRun) {
							const feature = existingCatalog.find((item) => item.id === featureId)!;
							opts.store.upsertCatalogFeature({ ...feature, entryIds: [assignment.entryId] });
						}
						report.catalogEntriesAssigned.push(`${assignment.entryId}→${featureId}`);
					}
				}
				unmatchedEntries = catalogEntries.filter((entry) => !matchedExistingIds.has(entry.id));
			}
		} else {
			report.catalogPhaseSkipped = existingCatalog.length === 0 ? "no-existing-categories" : null;
		}

		if (report.catalogPhaseSkipped !== "existing-match-failed") {
			report.catalogEntriesUnmatched.push(...unmatchedEntries.map((entry) => entry.id));
			if (unmatchedEntries.length > 0) {
				const newProposal = await proposeNewCatalog(featureCards, unmatchedEntries, opts.llm);
				if (!newProposal) {
					report.catalogPhaseSkipped = report.catalogPhaseSkipped ?? "new-category-proposal-failed";
				} else {
					const existingFeatureIds = new Set(existingCatalog.map((feature) => feature.id));
					const validNewFeatures = newProposal.newFeatures.filter(
						(feature) => /^feature-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(feature.id) && !existingFeatureIds.has(feature.id),
					);
					const newFeatureIds = new Set(validNewFeatures.map((feature) => feature.id));
					const proposedFeatures = new Map(validNewFeatures.map((feature) => [feature.id, feature]));
					for (const feature of validNewFeatures) {
						if (!opts.dryRun) opts.store.upsertCatalogFeature({ ...feature, entryIds: [] });
						report.catalogFeaturesCreated.push(feature.id);
					}
					const unmatchedIds = new Set(unmatchedEntries.map((entry) => entry.id));
					for (const assignment of newProposal.assignments) {
						if (!unmatchedIds.has(assignment.entryId)) continue;
						for (const featureId of new Set(assignment.featureIds)) {
							if (!newFeatureIds.has(featureId)) continue;
							if (!opts.dryRun) {
								const feature = proposedFeatures.get(featureId)!;
								opts.store.upsertCatalogFeature({ ...feature, entryIds: [assignment.entryId] });
							}
							report.catalogEntriesAssigned.push(`${assignment.entryId}→${featureId}`);
						}
					}
				}
			}
		}


	// ---- 4. Failure replay → alternatives ----
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
