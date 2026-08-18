/**
 * E1/E2/E3: matcher filtering & caching, injector rendering, tracker state machine.
 */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterCandidates, matchWorkflow } from "../core/engine/matcher.ts";
import { renderGuidance } from "../core/engine/injector.ts";
import { EngineTracker } from "../core/engine/tracker.ts";
import { WorkflowStore } from "../core/library/store.ts";
import type { RegistryEntry, Step } from "../core/library/types.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

const seedDir = fileURLToPath(new URL("../fixtures/workflows/seed", import.meta.url));

function seedRegistry(): RegistryEntry[] {
	return WorkflowStore.load(seedDir).getRegistry();
}

describe("E1: matcher", () => {
	it("filters by status, excludes and orders by level then evidence", () => {
		const registry: RegistryEntry[] = [
			{ id: "l3-big", level: 3, intent: "大任务", evidence: 5, usage: 0, escapes: 0, status: "active", updatedAt: "" },
			{ id: "l2-a", level: 2, intent: "A", evidence: 1, usage: 0, escapes: 0, status: "active", updatedAt: "" },
			{ id: "l2-b", level: 2, intent: "B", evidence: 9, usage: 0, escapes: 0, status: "active", updatedAt: "" },
			{ id: "l1-x", level: 1, intent: "X", evidence: 1, usage: 0, escapes: 0, status: "active", updatedAt: "" },
			{ id: "l1-prob", level: 1, intent: "观察中", evidence: 1, usage: 0, escapes: 0, status: "probation", updatedAt: "" },
			{
				id: "l2-excl",
				level: 2,
				intent: "会被排除",
				excludes: ["登录页面 UI"],
				evidence: 9,
				usage: 0,
				escapes: 0,
				status: "active",
				updatedAt: "",
			},
		];
		const candidates = filterCandidates(registry, "修复登录页面 UI 的样式问题");
		const ids = candidates.map((c) => c.id);
		expect(ids).toEqual(["l1-x", "l2-b", "l2-a", "l3-big"]); // probation dropped, excluded dropped, level asc + evidence desc
	});

	it("slash-prefixed input never matches", () => {
		expect(filterCandidates(seedRegistry(), "/wf-extract")).toEqual([]);
	});

	it("matchWorkflow returns the LLM-chosen entry and caches identical prompts", async () => {
		const llm = new FakeLlm(['{"id": "l2-fix-failing-test"}']);
		const cache = new Map<string, RegistryEntry | null>();
		const adapt = {
			get: (k: string) => cache.get(k),
			set: (k: string, v: RegistryEntry | null) => {
				cache.set(k, v);
			},
		};
		const hit1 = await matchWorkflow("修复测试失败", seedRegistry(), llm, adapt);
		expect(hit1?.id).toBe("l2-fix-failing-test");
		expect(llm.callCount).toBe(1);
		const hit2 = await matchWorkflow("修复测试失败", seedRegistry(), llm, adapt);
		expect(hit2?.id).toBe("l2-fix-failing-test");
		expect(llm.callCount).toBe(1); // served from cache
	});

	it("unparsable LLM output yields null (no match, no crash)", async () => {
		const llm = new FakeLlm(["我认为没有合适的"]);
		const hit = await matchWorkflow("画一张架构图", seedRegistry(), llm);
		expect(hit).toBeNull();
	});

	it("matches an independent L2 through its functional catalog without an L3", async () => {
		const llm = new FakeLlm([JSON.stringify({ featureIds: ["feature-web-research"] }), JSON.stringify({ id: "l2-research-docs" })]);
		const registry: RegistryEntry[] = [
			{ id: "l2-research-docs", level: 2, intent: "联网查阅并整理文档", evidence: 2, usage: 0, escapes: 0, status: "active", updatedAt: "" },
		];
		const hit = await matchWorkflow(
			"查阅官方文档并整理成对比表",
			registry,
			llm,
			undefined,
			[{ id: "feature-web-research", label: "网络研究", description: "检索和整理外部文档", aliases: ["文档查阅"], entryIds: ["l2-research-docs"], updatedAt: "" }],
		);
		expect(hit?.id).toBe("l2-research-docs");
		expect(llm.calls[1].userPayload).toContain('"level": 2');
		expect(llm.calls[1].systemPrompt).toContain("L3 is a coarse-grained");
	});
});

describe("E2: injector", () => {
	it("renders an L2 skeleton with steps, checkpoints, first-step detail and escape policy", () => {
		const store = WorkflowStore.load(seedDir);
		const entry = store.getEntry("l2-fix-failing-test")!;
		const text = renderGuidance(entry, { getEntity: (id) => store.getEntity(id) });
		expect(text).toContain("[工作流 l2-fix-failing-test]");
		expect(text).toContain("参考步骤");
		expect(text).toContain("◆检查点");
		expect(text).toContain("首步细节");
		expect(text).toContain("l1-locate-symbol");
		expect(text).toContain("放弃本工作流");
	});

	it("renders an L1 directly (light task path)", () => {
		const store = WorkflowStore.load(seedDir);
		const entry = store.getEntry("l1-locate-symbol")!;
		const text = renderGuidance(entry, { getEntity: (id) => store.getEntity(id) });
		expect(text).toContain("grep");
		expect(text).toContain("检查点：grep 返回非空匹配");
	});
});

describe("E3: tracker state machine", () => {
	function makeTracker(steps: Step[]): EngineTracker {
		const store = WorkflowStore.load(seedDir);
		return new EngineTracker("l2-fix-failing-test", steps, { getL1: (id) => store.getL1(id) });
	}

	it("checkpoint pass advances and renders the next step detail", () => {
		const tracker = makeTracker([
			{ intent: "复现", action: { tool: "bash", argsTemplate: "跑测试" }, expect: "有失败信息", retries: 2 },
			{ intent: "定位", ref: "l1-locate-symbol" },
		]);
		const actions = tracker.handleCheckpoint({ satisfied: true, reason: "" }, "1 failing...");
		expect(actions).toHaveLength(1);
		expect(actions[0].type).toBe("advance");
		expect((actions[0] as { message: string | null }).message).toContain("l1-locate-symbol");
	});

	it("restores a compatible tracker snapshot without restoring an incompatible one", () => {
		const tracker = makeTracker([{ intent: "复现", action: { tool: "bash", argsTemplate: "x" }, expect: "y", retries: 2 }]);
		tracker.recordToolCompletion("snapshot-call", "bash");
		const restored = EngineTracker.fromSnapshot(tracker.toSnapshot(), [{ intent: "复现", action: { tool: "bash", argsTemplate: "x" }, expect: "y", retries: 2 }], { getL1: () => undefined });
		expect(restored?.workflowId).toBe("l2-fix-failing-test");
		expect(restored?.currentStepIndex).toBe(0);
		expect(restored?.recordToolCompletion("snapshot-call", "bash").matched).toBe(false);
		expect(EngineTracker.fromSnapshot(tracker.toSnapshot(), [], { getL1: () => undefined })).toBeNull();
	});

	it("null outcome keeps the checkpoint active", () => {
			const tracker = makeTracker([{ intent: "复现", action: { tool: "bash", argsTemplate: "x" }, expect: "y", retries: 2 }]);
			const actions = tracker.handleCheckpoint(null, "");
			expect(actions[0].type).toBe("retry-hint");
			expect(tracker.currentStepIndex).toBe(0);
		});

	it("advances non-checkpoint steps and deduplicates tool calls", () => {
		const tracker = makeTracker([
			{ intent: "定位", action: { tool: "grep", argsTemplate: "x" } },
			{ intent: "修改", action: { tool: "edit", argsTemplate: "y" } },
		]);
		const first = tracker.recordToolCompletion("call-1", "grep");
		expect(first.actions[0].type).toBe("advance");
		expect(tracker.currentStepIndex).toBe(1);
		const duplicate = tracker.recordToolCompletion("call-1", "edit");
		expect(duplicate.matched).toBe(false);
	});


	it("retries then escapes with a hard directive and failure record", () => {
		const tracker = makeTracker([
			{ intent: "复现", action: { tool: "bash", argsTemplate: "跑测试" }, expect: "有失败信息", retries: 2 },
		]);
		const first = tracker.handleCheckpoint({ satisfied: false, reason: "输出为空" }, "");
		expect(first[0].type).toBe("retry-hint");
		expect((first[0] as { message: string }).message).toContain("检查点未通过");
		const second = tracker.handleCheckpoint({ satisfied: false, reason: "仍为空" }, "");
		expect(second[0].type).toBe("escape");
		const escape = second[0] as { message: string; failure: { stepIndex: number; expect: string } };
		expect(escape.message).toContain("放弃该工作流");
		expect(escape.failure.stepIndex).toBe(0);
		expect(escape.failure.expect).toBe("有失败信息");
		expect(tracker.active).toBe(false);
		expect(tracker.handleCheckpoint({ satisfied: true, reason: "" }, "")).toEqual([]);
	});

	it("exhausted retries switch to the alternative branch", () => {
		const tracker = makeTracker([
			{
				intent: "验证",
				action: { tool: "bash", argsTemplate: "重跑" },
				expect: "通过",
				retries: 2,
				alternative: "l1-locate-symbol",
			},
		]);
		tracker.handleCheckpoint({ satisfied: false, reason: "还是失败" }, "");
		const second = tracker.handleCheckpoint({ satisfied: false, reason: "还是失败" }, "");
		expect(second[0].type).toBe("switch-alternative");
		const alt = second[0] as { alternativeId: string; message: string };
		expect(alt.alternativeId).toBe("l1-locate-symbol");
		expect(alt.message).toContain("切换到备选方案");
		expect(tracker.escapedFlag).toBe(false);
	});
});
