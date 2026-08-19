/**
 * X: extraction over the memory log (sole input).
 * Builds fact turns → memory records → runs the single-pass LLM synthesis
 * extraction and verifies the three granularities land in feature dirs and the
 * catalog is updated, plus watermark/evidence idempotency.
 */
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExtraction } from "../core/extractor/extract.ts";
import { synthesizeLibrary, SYNTHESIZE_SYSTEM_PROMPT } from "../core/extractor/pack.ts";
import { WorkflowStore } from "../core/library/store.ts";
import { MemoryWriter } from "../core/memory/writer.ts";
import { JournalWriter } from "../core/journal/writer.ts";
import { RouterLlm } from "./helpers/fake-llm.ts";

const PROJECT = "--G--try-agent-demo--";
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jw-extract2-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Write a memory record directly into a task's memory dir. */
function seedMemory(taskId: string, tools: Array<{ tool: string; status: "success" | "error"; resultSummary: string | null; failureAnalysis: string | null; significance: string | null }>): void {
	// A real task dir carries a journal; extraction keys per-task via task.json.
	new JournalWriter(root, PROJECT, taskId);
	const w = new MemoryWriter(root, PROJECT, taskId);
	w.append({
		spanFromTurnSeq: 1,
		spanToTurnSeq: 1,
		userIntent: "修复登录崩溃",
		thinking: "先跑测试再定位",
		memories: ["空密码导致 login.ts 崩溃"],
		tools: tools.map((t, i) => ({
			index: i,
			turnSeq: 1,
			refSequence: i + 1,
			tool: t.tool,
			status: t.status,
			args: "args",
			resultSummary: t.resultSummary,
			failureAnalysis: t.failureAnalysis,
			intent: null,
			significance: t.significance as never,
		})),
		sourceTurns: [1],
	});
}

describe("X: extraction from memory log", () => {
	it("synthesizes and persists L1/L2/L3 across features, then watermark-skips re-run", async () => {
		// One task contributes three granularities across two business features.
		seedMemory("task-mixed", [
			{ tool: "bash", status: "error", resultSummary: null, failureAnalysis: "测试失败：空密码崩溃", significance: "essential" },
			{ tool: "bash", status: "success", resultSummary: "拿到失败信息", failureAnalysis: null, significance: "essential" },
			{ tool: "grep", status: "success", resultSummary: "定位登录相关代码", failureAnalysis: null, significance: "helpful" },
		]);

		const llm = new RouterLlm((input) => {
			if (!input.systemPrompt.startsWith("You distill a reusable workflow library")) return "{}";
			expect(input.userPayload).toContain("修复登录崩溃"); // memory log is the sole input
			return JSON.stringify({
				features: [
					{ id: "feature-repro", label: "缺陷复现", description: "复现与确认失败", aliases: [], levelSemantics: "L1/L2/L3 是执行粒度" },
					{ id: "feature-navigation", label: "代码导航", description: "定位理解代码", aliases: [] },
				],
				codeAssets: [
					{ id: "asset-repro-shell", name: "复现脚本", language: "sh", summary: "一键复现登录崩溃", code: "npm test -- AuthLogin" },
				],
				workflows: [
					{ id: "l1-locate-symbol", featureId: "feature-navigation", level: 1, intent: "定位符号", calls: [{ tool: "grep", argsTemplate: "(grep)" }], variants: [] },
					{ id: "l2-fix-failing-test", featureId: "feature-repro", level: 2, intent: "修复失败测试", steps: [{ intent: "复现失败", action: { tool: "run_code", argsTemplate: "{codeAsset:asset-repro-shell}" }, expect: "test" }] },
					{ id: "ws-debug-login", featureId: "feature-repro", level: 3, intent: "调试登录崩溃", reasoning: "先复现拿到失败信息，再定位崩溃点，修复后回归", caveats: ["保留失败现场"], steps: [{ intent: "复现失败", ref: "l2-fix-failing-test", note: "先跑复现脚本" }] },
				],
			});
		});

		const workflowsRoot = join(root, "workflows");
		const store = WorkflowStore.createEmpty(workflowsRoot);
		const report = await runExtraction({ journalsRoot: root, projectKey: PROJECT, store, llm });

		expect(report.tasksScanned).toBeGreaterThanOrEqual(1);
		expect(report.memoryRecords).toBeGreaterThanOrEqual(1);
		expect(report.l1Created).toContain("l1-locate-symbol");
		expect(report.l2Created).toContain("l2-fix-failing-test");
		expect(report.l3Created).toContain("ws-debug-login");
		expect(report.codeAssetsCreated).toContain("asset-repro-shell");
		expect(report.catalogFeaturesCreated).toEqual(["feature-repro", "feature-navigation"]);

		// L1 stays under features/<featureId>/<id>.json
		expect(existsSync(join(workflowsRoot, "features", "feature-navigation", "l1-locate-symbol.json"))).toBe(true);
		// WorkStrategy is stored independently in workstrategies/
		expect(existsSync(join(workflowsRoot, "workstrategies", "ws-debug-login.json"))).toBe(true);
		expect(store.getL3("ws-debug-login")?.reasoning).toContain("再定位崩溃点");
		expect(store.getEntry("ws-debug-login")?.featureId).toBe("feature-repro");
		// code asset written as a true script file on disk + index json
		expect(existsSync(join(workflowsRoot, "code-assets", "asset-repro-shell.json"))).toBe(true);
		expect(existsSync(join(workflowsRoot, "code-assets", "asset-repro-shell.sh"))).toBe(true);
		expect(store.getL2("l2-fix-failing-test")?.steps).toHaveLength(1);
		expect(store.getEntry("l2-fix-failing-test")?.featureId).toBe("feature-repro");

		// progressive disclosure: catalog lists the two features with L semantics
		const catalog = store.getCatalogFeatures();
		expect(catalog.find((f) => f.id === "feature-repro")?.levelSemantics).toBe("L1/L2/L3 是执行粒度");
		expect(catalog.find((f) => f.id === "feature-navigation")?.entryIds).toContain("l1-locate-symbol");

		// watermark idempotency: identical re-run is a no-op (no double evidence)
		const evBefore = store.getEntry("l1-locate-symbol")!.evidence;
		const again = await runExtraction({ journalsRoot: root, projectKey: PROJECT, store, llm });
		expect(again.catalogPhaseSkipped).toBe("watermark-unchanged");
		expect(store.getEntry("l1-locate-symbol")!.evidence).toBe(evBefore);
	});

	it("dryRun leaves the library untouched", async () => {
		seedMemory("task-dry", [
			{ tool: "grep", status: "success", resultSummary: "定位", failureAnalysis: null, significance: "helpful" },
		]);
		const workflowsRoot = join(root, "wf-dry");
		const store = WorkflowStore.createEmpty(workflowsRoot);
		const llm = new RouterLlm(() => JSON.stringify({
			features: [{ id: "feature-nav", label: "代码导航", description: "定位", aliases: [] }],
			workflows: [{ id: "l1-grep-read", featureId: "feature-nav", level: 1, intent: "locate", calls: [{ tool: "grep", argsTemplate: "(grep)" }], variants: [] }],
		}));
		const dry = await runExtraction({ journalsRoot: root, projectKey: PROJECT, store, llm, dryRun: true });
		expect(dry.l1Created).toContain("l1-grep-read");
		// dryRun reports but never writes (registry stays empty; no entity files)
		expect(WorkflowStore.load(workflowsRoot).getRegistry()).toHaveLength(0);
		expect(existsSync(join(workflowsRoot, "catalog.json"))).toBe(false);
	});

	it("no memory log is a no-op (skipped)", async () => {
		const store = WorkflowStore.createEmpty(join(root, "wf-empty"));
		const llm = new RouterLlm(() => "{}");
		const report = await runExtraction({ journalsRoot: join(root, "empty"), projectKey: "no-such-project", store, llm });
		expect(report.memoryRecords).toBe(0);
		expect(report.catalogPhaseSkipped).toBe("no-memory-log");
	});
});

describe("synthesizeLibrary prompt surface", () => {
	it("accepts memory records and exposes the synthesis prompt", async () => {
		const records = [{ seq: 1, spanFromTurnSeq: 1, spanToTurnSeq: 1, generatedAt: "", userIntent: "x", thinking: null, memories: [], tools: [], sourceTurns: [1] }] as never as Parameters<typeof synthesizeLibrary>[0];
		const llm = new RouterLlm((input) => {
			expect(input.systemPrompt).toBe(SYNTHESIZE_SYSTEM_PROMPT);
			return JSON.stringify({ features: [], workflows: [] });
		});
		const result = await synthesizeLibrary(records, llm);
		// empty workflows => parse returns null
		expect(result).toBeNull();
	});
});