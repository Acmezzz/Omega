/**
 * X1/X2: segmentation & co-occurrence mining (X1) and the extraction
 * pipeline over the session corpus (X2), with a routing fake LLM.
 */
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { alignSkeletons, coOccurrence, findRecurringPatterns, toolSequenceOfTurn } from "../core/extractor/segment.ts";
import { runExtraction } from "../core/extractor/extract.ts";
import { WorkflowStore } from "../core/library/store.ts";
import { listTasks, readTask } from "../core/journal/writer.ts";
import type { TurnRecord } from "../core/journal/types.ts";
import { RouterLlm, type LlmCallInput } from "./helpers/fake-llm.ts";
import { CORPUS_PROJECT_KEY, buildCorpus } from "./helpers/corpus.ts";

const seedDir = fileURLToPath(new URL("../fixtures/workflows/seed", import.meta.url));
let root: string;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "jw-extract-"));
	await buildCorpus(join(root, "journals"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function distilledTurns(): TurnRecord[] {
	const turns: TurnRecord[] = [];
	for (const dir of listTasks(join(root, "journals"), CORPUS_PROJECT_KEY)) {
		const result = readTask(dir);
		turns.push(...result.turns);
	}
	return turns;
}

describe("X1: segmentation & pattern mining", () => {
	it("counts adjacent tool pairs across distinct turns", () => {
		const sequences = distilledTurns().map(toolSequenceOfTurn);
		expect(sequences).toHaveLength(6);
		const counts = coOccurrence(sequences, 2);
		expect(counts.get("bash|grep")).toBe(5);
		expect(counts.get("grep|read")).toBe(5);
		expect(counts.get("read|edit")).toBe(3);
		expect(counts.get("edit|bash")).toBe(3);
	});

	it("finds recurring patterns at threshold 3 (the B+C cross-boundary demo)", () => {
		const sequences = distilledTurns().map(toolSequenceOfTurn);
		const patterns = findRecurringPatterns(sequences, 2, 3);
		const toolKeys = patterns.map((p) => p.tools.join("|"));
		expect(toolKeys).toContain("grep|read"); // the locate-symbol combo
		expect(toolKeys).toContain("bash|grep");
		expect(patterns.every((p) => p.count >= 3)).toBe(true);
	});

	it("aligns completed-task skeletons via LCS fold", () => {
		const completed = [
			["bash", "grep", "read", "edit", "bash"],
			["bash", "grep", "read", "edit", "bash"],
			["bash", "grep", "read"],
			["bash", "grep", "read", "edit", "bash"],
		];
		expect(alignSkeletons(completed)).toEqual(["bash", "grep", "read"]);
	});
});

function extractionRouterLlm(): RouterLlm {
	return new RouterLlm((input: LlmCallInput) => {
		const payload = JSON.parse(input.userPayload) as Record<string, unknown>;
		if (input.systemPrompt.startsWith("You name a reusable tool-combo")) {
			const tools = payload.recurringTools as string[];
			return JSON.stringify({
				id: `l1-${tools.join("-")}`,
				intent: `组合：${tools.join("→")}`,
				calls: tools.map((t) => ({ tool: t, argsTemplate: `(${t} 调用)` })),
				expect: null,
			});
		}
		if (input.systemPrompt.startsWith("You judge whether")) {
			const candidate = typeof payload.candidate === "string" ? payload.candidate : "";
			// The grep→read combo is the seed's locate-symbol → merge instead of create.
			if (candidate.includes("grep→read")) {
				return JSON.stringify({ similarTo: "l1-locate-symbol" });
			}
			return JSON.stringify({ similarTo: null });
		}
		if (input.systemPrompt.startsWith("You convert successful task logs")) {
			return JSON.stringify({
				id: "l2-login-crash",
				intent: "修复登录类崩溃",
				steps: [
					{ intent: "复现失败", tool: "bash", expect: null },
					{ intent: "定位代码", tool: "grep", expect: null },
					{ intent: "修复", tool: "edit", expect: null },
					{ intent: "验证", tool: "bash", expect: "测试通过" },
				],
			});
		}
			if (input.systemPrompt.startsWith("You create flat functional catalog categories")) {
				return JSON.stringify({
					assignments: [{ entryId: "l1-locate-symbol", featureIds: ["feature-code-navigation"] }],
					newFeatures: [{ id: "feature-code-navigation", label: "代码导航", description: "定位和理解代码", aliases: ["代码定位"] }],
				});
			}
			if (input.systemPrompt.startsWith("You assign workflow entries to an existing")) {
				return JSON.stringify({ assignments: [], unmatchedEntryIds: [] });
			}
			if (input.systemPrompt.startsWith("A workflow step failed")) {
				return JSON.stringify({ alternative: "l1-bash-grep", note: "先复现拿到输出再定位" });
			}

		return JSON.stringify({});
	});
}

describe("X2: extraction pipeline over the session corpus", () => {
	it("mines patterns, merges the known combo, creates new entries, learns an alternative", async () => {
		const workflowsRoot = join(root, "workflows");
		cpSync(seedDir, workflowsRoot, { recursive: true });
		const store = WorkflowStore.load(workflowsRoot);
		const locateBefore = store.getEntry("l1-locate-symbol")!.evidence;

		const report = await runExtraction({
			journalsRoot: join(root, "journals"),
			projectKey: CORPUS_PROJECT_KEY,
			store,
			llm: extractionRouterLlm(),
		});

		expect(report.tasksScanned).toBe(4);
		expect(report.turnsDistilled).toBe(6);
		expect(report.turnsPendingDistill).toBe(0);
		expect(report.completedTasks).toBe(4);
		expect(report.skeleton).toEqual(["bash", "grep", "read"]);

		// grep→read merged into the seed L1 (evidence grows, no new entry)
		expect(report.mergedInto).toContain("l1-locate-symbol");
		expect(store.getEntry("l1-locate-symbol")!.evidence).toBe(locateBefore + 1);

		// other patterns created as probation L1s
		expect(report.l1Created).toEqual(["l1-bash-grep", "l1-read-edit", "l1-edit-bash"]);
		for (const id of report.l1Created) {
			expect(store.getEntry(id)?.status).toBe("probation");
			expect(store.getL1(id)!.calls.length).toBeGreaterThan(0);
		}

		// skeleton produced a new L2 (judge said "not similar")
		expect(report.l2Created).toEqual(["l2-login-crash"]);
		expect(store.getEntry("l2-login-crash")?.status).toBe("probation");
		expect(store.getL2("l2-login-crash")!.steps).toHaveLength(4);

			expect(report.catalogFeaturesCreated).toContain("feature-code-navigation");
			expect(report.catalogEntriesAssigned).toContain("l1-locate-symbol→feature-code-navigation");
			expect(store.getCatalogFeatures().find((feature) => feature.id === "feature-code-navigation")?.entryIds).toContain("l1-locate-symbol");

			// failure replay attached an alternative to the seed workflow's step 0
			expect(report.alternativesProposed).toEqual([

			{ workflowId: "l2-fix-failing-test", stepIndex: 0, alternative: "l1-bash-grep" },
		]);
		expect(store.getL2("l2-fix-failing-test")!.steps[0].alternative).toBe("l1-bash-grep");
	});

	it("dryRun leaves the library untouched", async () => {
		const workflowsRoot = join(root, "workflows-dry");
		cpSync(seedDir, workflowsRoot, { recursive: true });
		const store = WorkflowStore.load(workflowsRoot);
		const before = JSON.stringify(store.getRegistry());
		const report = await runExtraction({
			journalsRoot: join(root, "journals"),
			projectKey: CORPUS_PROJECT_KEY,
			store,
			llm: extractionRouterLlm(),
			dryRun: true,
		});
		expect(report.l1Created.length + report.l2Created.length).toBeGreaterThan(0);
		expect(JSON.stringify(WorkflowStore.load(workflowsRoot).getRegistry())).toBe(before);
	});
});
