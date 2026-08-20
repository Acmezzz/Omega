/**
 * Extraction pipeline (memory-log only): journals → memory → workflow library.
 *
 * Data flow (per your design):
 *   memory records (per-compaction, faithful tool timeline + distilled results)
 *     → single-pass LLM synthesis
 *     → three granularities (L3 orchestration / L2 workflow / L1 atomic ops)
 *     → functional catalog (progressive disclosure)
 *
 * The LLM judges value itself (keeps useful ops, drops failed/non-advancing
 * ones based on distilled significance + failure analysis). Nothing is mined by
 * frequency/LCS here anymore — the memory log is the sole input.
 *
 * Idempotency: an evidence ledger keyed by a stable evidence key prevents the
 * same memory source from counting twice; a manifest watermark skips identical
 * re-runs. All library writes go through WorkflowStore (probation/active/deprecated).
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmClient } from "../llm.ts";
import { listTasks, readTask } from "../journal/writer.ts";
import { WorkflowStore } from "../library/store.ts";
import { readCoverage as readTaskCoverage, isFullyCovered } from "../memory/writer.ts";
import { readTaskMemory } from "../memory/index.ts";
import type { L1Template, L2Workflow, WorkStrategy, CodeAsset } from "../library/types.ts";
import { synthesizeLibrary, l1FromCalls, l2FromSteps, workStrategyFrom, SYNTHESIZE_SYSTEM_PROMPT, type SynthesisResult } from "./pack.ts";

export interface ExtractReport {
	tasksScanned: number;
	memoryRecords: number;
	l1Created: string[];
	l2Created: string[];
	l3Created: string[];
	codeAssetsCreated: string[];
	mergedInto: string[];
	catalogFeaturesCreated: string[];
	catalogEntriesAssigned: string[];
	catalogEntriesUnmatched: string[];
	catalogPhaseSkipped: string | null;
}

export interface ExtractOptions {
	journalsRoot: string;
	projectKey: string;
	store: WorkflowStore;
	llm: LlmClient;
	dryRun?: boolean;
	/** Default false: only tasks with fully-covered memory log are consumed. */
	allowPartial?: boolean;
}

const EXTRACTION_PIPELINE_VERSION = "4";
const EXTRACTION_SCHEMA_VERSION = "4";

interface ExtractionManifest {
	version: 4;
	projectKey: string;
	inputHash: string;
	fingerprints: { pipeline: string; schema: string; prompt: string; model: string };
	completedAt: string;
}

function manifestPath(workflowsRoot: string, projectKey: string): string {
	return join(workflowsRoot, "manifests", `${projectKey}.json`);
}

function memoryTaskDirOf(journalsRoot: string, projectKey: string, taskId: string): string {
	return join(journalsRoot, projectKey, taskId, "memory");
}

function sourceRefKey(taskId: string, recordSeq: number): string {
	return `${taskId}:${recordSeq}`;
}

function extractEvidenceKey(projectKey: string, workflowId: string, sourceRefs: Array<{ taskId: string; recordSeq: number }>): string {
	const refs = [...new Set(sourceRefs.map((r) => sourceRefKey(r.taskId, r.recordSeq)))].sort().join(",") || "unknown";
	return `extract:${projectKey}:${workflowId}:${refs}`;
}

export async function runExtraction(opts: ExtractOptions): Promise<ExtractReport> {
	const report: ExtractReport = {
		tasksScanned: 0,
		memoryRecords: 0,
		l1Created: [],
		l2Created: [],
		l3Created: [],
		codeAssetsCreated: [],
		mergedInto: [],
		catalogFeaturesCreated: [],
		catalogEntriesAssigned: [],
		catalogEntriesUnmatched: [],
		catalogPhaseSkipped: null,
	};

	// ---- 1. Load memory records for the project (sole input) ----
	// Consumption gate: only tasks whose memory log is fully covered qualify.
	// Uncovered (in-progress or un-distilled) tasks are skipped so extraction
	// never builds workflows from a half-baked memory record.
	const taskDirs = listTasks(opts.journalsRoot, opts.projectKey);
	report.tasksScanned = taskDirs.length;
	const memoryRecords: Array<{ taskId: string; seq: number }> = [];
	let skippedUncovered = 0;
	for (const dir of taskDirs) {
		const meta = readTask(dir).meta;
		if (!meta) continue;
		const taskId = meta.taskId;
		const cov = readTaskCoverage(memoryTaskDirOf(opts.journalsRoot, opts.projectKey, taskId));
		const journalMaxSeq = readTask(dir).turns.reduce((max, t) => Math.max(max, t.seq), 0);
		if (!opts.allowPartial && (!cov || !isFullyCovered(cov, journalMaxSeq))) {
			skippedUncovered++;
			continue;
		}
		const log = readTaskMemory(opts.journalsRoot, opts.projectKey, taskId);
		for (const record of log.records) memoryRecords.push({ taskId, seq: record.seq });
	}
	report.memoryRecords = memoryRecords.length;
	if (memoryRecords.length === 0) {
		report.catalogPhaseSkipped = skippedUncovered > 0 ? "no-fully-covered-tasks" : "no-memory-log";
		return report;
	}

	// ---- 2. Watermark dedup: coverage + segments fingerprint skip re-run ----
	const modelFingerprint = "session-model";
	const promptFingerprint = createHash("sha256").update(SYNTHESIZE_SYSTEM_PROMPT).digest("hex");
	// Include coverage (per task) so a distilled-again task reopens extraction.
	const covFingerprint = createHash("sha256")
		.update(
			JSON.stringify(
				taskDirs
					.map((dir) => {
						const meta = readTask(dir).meta;
						if (!meta) return null;
						const cov = readTaskCoverage(memoryTaskDirOf(opts.journalsRoot, opts.projectKey, meta.taskId));
						return cov ? { taskId: meta.taskId, distilledUpTo: cov.distilledUpTo, stale: cov.stale } : null;
					})
					.filter((x): x is { taskId: string; distilledUpTo: number; stale: boolean } => x !== null)
					.sort((a, b) => a.taskId.localeCompare(b.taskId)),
			),
		)
		.digest("hex");
	const inputHash = createHash("sha256").update(JSON.stringify(memoryRecords.sort((a, b) => sourceRefKey(a.taskId, a.seq).localeCompare(sourceRefKey(b.taskId, b.seq))))).digest("hex");
	const manifest: ExtractionManifest = { version: 4, projectKey: opts.projectKey, inputHash, fingerprints: { pipeline: EXTRACTION_PIPELINE_VERSION, schema: EXTRACTION_SCHEMA_VERSION, prompt: promptFingerprint, model: modelFingerprint }, completedAt: "" };
	// Input signature = records + coverage (used for the watermark).
	const inputSignatureKey = createHash("sha256").update(inputHash + "::" + covFingerprint).digest("hex");
	const previous = readManifest(opts.store.root, opts.projectKey);
	if (!opts.dryRun && previous && previous.inputHash === inputSignatureKey && JSON.stringify(previous.fingerprints) === JSON.stringify(manifest.fingerprints)) {
		report.catalogPhaseSkipped = "watermark-unchanged";
		return report;
	}

	// ---- 3. Load full memory records and synthesize ----
	const fullRecords = [];
	for (const dir of taskDirs) {
		const meta = readTask(dir).meta;
		if (!meta) continue;
		const cov = readTaskCoverage(memoryTaskDirOf(opts.journalsRoot, opts.projectKey, meta.taskId));
		const journalMaxSeq = readTask(dir).turns.reduce((max, t) => Math.max(max, t.seq), 0);
		if (!opts.allowPartial && (!cov || !isFullyCovered(cov, journalMaxSeq))) continue;
		fullRecords.push(...readTaskMemory(opts.journalsRoot, opts.projectKey, meta.taskId).records);
	}
	if (fullRecords.length === 0) {
		report.catalogPhaseSkipped = "no-memory-records";
		return report;
	}
	const existingFeatures = opts.store.getCatalogFeatures().map((f) => ({ id: f.id, label: f.label, aliases: f.aliases }));
	const synthesis = await synthesizeLibrary(fullRecords, opts.llm, existingFeatures);
	if (!synthesis) {
		report.catalogPhaseSkipped = "synthesis-failed";
		return report;
	}

	// ---- 4. Persist features + workflows (pre-pass registration for idempotent keys) ----
	const sourceRefs = memoryRecords.map(({ taskId, seq }) => ({ taskId, recordSeq: seq }));
	if (!opts.dryRun) {
		for (const feature of synthesis.features) {
			opts.store.upsertCatalogFeature({
				id: feature.id,
				label: feature.label,
				description: feature.description,
				levelSemantics: feature.levelSemantics,
				aliases: feature.aliases,
				entryIds: [],
			});
			report.catalogFeaturesCreated.push(feature.id);
		}
		await persistWorkflows(opts.store, synthesis, sourceRefs, report, opts.projectKey, opts.dryRun ?? false);
		// persist reusable code assets (true files on disk)
		persistCodeAssets(opts.store, synthesis, report);
		// assign entry ids to features
		assignCatalogEntries(opts.store, synthesis, report);
		// de-fragment: merge features that clearly overlap (shared alias token)
		mergeOverlappingFeatures(opts.store);

		writeManifest(opts.store.root, { ...manifest, inputHash: inputSignatureKey, completedAt: new Date().toISOString() });
	} else {
		// report-only accounting for dry-run
		await persistWorkflows(opts.store, synthesis, sourceRefs, report, opts.projectKey, true);
		report.codeAssetsCreated.push(...synthesis.codeAssets.map((a) => a.id));
	}

	return report;
}

function persistCodeAssets(store: WorkflowStore, synthesis: SynthesisResult, report: ExtractReport): void {
	for (const raw of synthesis.codeAssets) {
		if (store.getCodeAsset(raw.id)) continue; // idempotent: keep existing true file
		store.upsertCodeAsset({
			id: raw.id,
			name: raw.name,
			language: raw.language,
			summary: raw.summary,
			code: raw.code,
		});
		report.codeAssetsCreated.push(raw.id);
	}
}

async function persistWorkflows(
	store: WorkflowStore,
	synthesis: SynthesisResult,
	sourceRefs: Array<{ taskId: string; recordSeq: number }>,
	report: ExtractReport,
	projectKey: string,
	dryRun: boolean,
): Promise<void> {
	for (const w of synthesis.workflows) {
		const evidenceKey = extractEvidenceKey(projectKey, w.id, sourceRefs);
		const recorded = store.getEvidenceLedger().some((record) => record.evidenceKey === evidenceKey);
		if (w.level === 1) {
			const entity = l1FromCalls(w) as L1Template;
			if (recorded && store.getEntry(w.id)) {
				report.mergedInto.push(w.id);
				continue;
			}
			if (dryRun) { report.l1Created.push(w.id); continue; }
			store.upsertEntity(entity, 1, w.featureId, { evidenceKey });
			report.l1Created.push(w.id);
		} else if (w.level === 2) {
			const entity = l2FromSteps(w) as L2Workflow;
			if (recorded && store.getEntry(w.id)) {
				report.mergedInto.push(w.id);
				continue;
			}
			if (dryRun) { report.l2Created.push(w.id); continue; }
			store.upsertEntity(entity, 2, w.featureId, { evidenceKey });
			report.l2Created.push(w.id);
		} else if (w.level === 3) {
			const entity = workStrategyFrom(w) as WorkStrategy;
			if (recorded && store.getEntry(w.id)) {
				report.mergedInto.push(w.id);
				continue;
			}
			if (dryRun) { report.l3Created.push(w.id); continue; }
			store.upsertEntity(entity, 3, w.featureId, { evidenceKey });
			report.l3Created.push(w.id);
		}
	}
}

function assignCatalogEntries(store: WorkflowStore, synthesis: SynthesisResult, report: ExtractReport): void {
	for (const w of synthesis.workflows) {
		if (!store.getEntry(w.id)) continue;
		store.upsertCatalogFeature({
			id: w.featureId,
			label: synthesis.features.find((f) => f.id === w.featureId)?.label ?? w.featureId,
			description: synthesis.features.find((f) => f.id === w.featureId)?.description ?? "",
			aliases: synthesis.features.find((f) => f.id === w.featureId)?.aliases ?? [],
			entryIds: [w.id],
		});
		report.catalogEntriesAssigned.push(`${w.id}→${w.featureId}`);
	}
}

/**
 * De-fragmentation: merge features that clearly overlap — they share at least
 * one non-trivial alias token. Deterministic, LLM-free; gives features an
 * evolution path (they currently have no probation lifecycle).
 */
function mergeOverlappingFeatures(store: WorkflowStore): void {
	const features = store.getCatalogFeatures();
	const tokenOf = (f: typeof features[number]): Set<string> =>
		new Set(
			[f.label, ...f.aliases]
				.flatMap((s) => s.toLowerCase().split(/[\s\-_/+]+/))
				.filter((t) => t.length >= 2),
		);
	for (let i = 0; i < features.length; i++) {
		const a = features[i];
		if (!store.getCatalogFeatures().some((f) => f.id === a.id)) continue; // already merged away
		const tokensA = tokenOf(a);
		for (let j = i + 1; j < features.length; j++) {
			const b = features[j];
			if (!store.getCatalogFeatures().some((f) => f.id === b.id)) continue;
			const tokensB = tokenOf(b);
			let shared = 0;
			for (const t of tokensA) if (tokensB.has(t)) shared++;
			if (shared >= 1) store.mergeCatalogFeatures(b.id, a.id);
		}
	}
}

function readManifest(workflowsRoot: string, projectKey: string): ExtractionManifest | null {
	const path = manifestPath(workflowsRoot, projectKey);
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as ExtractionManifest;
		return parsed.version === 4 && typeof parsed.inputHash === "string" && !!parsed.fingerprints ? parsed : null;
	} catch {
		return null;
	}
}

function writeManifest(workflowsRoot: string, manifest: ExtractionManifest): void {
	const dir = join(workflowsRoot, "manifests");
	mkdirSync(dir, { recursive: true });
	const target = join(dir, `${manifest.projectKey}.json`);
	const temp = `${target}.tmp-${process.pid}`;
	writeFileSync(temp, `${JSON.stringify(manifest, null, "\t")}\n`);
	renameSync(temp, target);
}