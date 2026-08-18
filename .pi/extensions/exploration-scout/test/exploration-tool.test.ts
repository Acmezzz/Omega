/** Offline tool-level tests with an injected Scout runner. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { createExploreSpaceTool, createSelectExplorationTool } from "../tool.ts";
import type { ScoutRoundRecord, ScoutRunRecord } from "../core/types.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

const root = mkdtempSync(join(tmpdir(), "jw-exploration-tool-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const brief = {
	rawUserInput: "分析失败测试",
	objective: "理解失败原因并确定需要验证的方向",
	deliverable: "可验证的修复",
	acceptanceCriteria: ["测试能验证结果"],
	constraints: [],
	knownFacts: [],
	unknowns: ["根因"],
	relevantPaths: [],
	forbiddenAssumptions: [],
};

function fakeRuns(): ScoutRunRecord[] {
	return [
		{
			scoutId: "evidence-first",
			angle: "evidence-first",
			status: "completed",
			toolCallCount: 2,
			durationMs: 10,
			report: {
				scoutId: "evidence-first",
				angle: "evidence-first",
				priorStatus: "none",
				proposals: [
						{
							id: "p1",
							idea: "从失败堆栈定位调用路径",
							steps: ["读取错误", "搜索调用方"],
							assumptions: [],
							expectedEvidence: ["找到调用路径"],
							disqualifiers: [],
							probes: [],
						},
						{
							id: "p2",
							idea: "比较相关测试的共同现象",
							steps: ["读取测试输出", "归纳共同现象"],
							assumptions: [],
							expectedEvidence: ["确认共同现象"],
							disqualifiers: [],
							probes: [],
						},
					],
				sourcesChecked: ["tests"],
				searchesPerformed: ["stack trace"],
				verifiedFacts: [],
				negativeEvidence: [],
				openQuestions: ["根因"],
				limitations: [],
				noWorkPerformed: true,
			},
		},
	];
}

describe("explore_space tool", () => {
		it("fails closed when manual Scout mode is disabled", async () => {
			const tool = createExploreSpaceTool({ llm: new FakeLlm([]), isExplorationEnabled: () => false, runScouts: async () => fakeRuns() });
			const result = await tool.execute("id", { taskBrief: brief, round: 1 }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } } as never);
			expect((result.details as { status: string }).status).toBe("exploration_disabled");
		});

		it("rejects a duplicate or over-budget round", async () => {
			const tool = createExploreSpaceTool({ llm: new FakeLlm([]), getBudget: () => ({ maxRoundsPerTask: 1 }), getRounds: () => [{ packet: { round: 1 } } as never], runScouts: async () => fakeRuns() });
			const result = await tool.execute("id", { taskBrief: brief, round: 1 }, undefined, undefined, { cwd: root, model: { provider: "fake", id: "model" } } as never);
			expect((result.details as { status: string }).status).toBe("round_budget_exceeded");
		});

		it("returns independent scout packet without spawning a real process", async () => {

		let captured: unknown;
		const tool = createExploreSpaceTool({
				llm: new FakeLlm([]),
			runScouts: async () => fakeRuns(),
			onRound: (input) => {
				captured = input;
			},
		});
		const result = await tool.execute("id", { taskBrief: brief, round: 1 }, undefined, undefined, {
			cwd: root,
			model: { provider: "fake", id: "model" },
		} as never);
		expect(result.content[0]).toMatchObject({ type: "text" });
		expect(String((result.content[0] as { text: string }).text)).toContain("p1");
		expect((captured as { packet: { runs: ScoutRunRecord[] } }).packet.runs).toHaveLength(1);
	});
});

describe("select_exploration tool", () => {
		it("fails closed when manual Scout mode is disabled", async () => {
			const tool = createSelectExplorationTool({ llm: new FakeLlm([]), isExplorationEnabled: () => false, getCurrentRound: () => ({ packet: { runs: fakeRuns() } } as never) });
			const result = await tool.execute("id", { selectedProposalIds: ["p1"] }, undefined, undefined, {} as never);
			expect((result.details as { status: string }).status).toBe("exploration_disabled");
		});

		it("rejects proposal IDs outside the current round", async () => {
			const tool = createSelectExplorationTool({ llm: new FakeLlm([]), getCurrentRound: () => ({ packet: { runs: fakeRuns() } } as never) });
			const result = await tool.execute("id", { selectedProposalIds: ["missing"] }, undefined, undefined, {} as never);
			expect((result.details as { status: string }).status).toBe("invalid_selection");
		});

		it("returns a record and leaves execution to the caller", async () => {

			let selected: unknown;
			const currentRound: ScoutRoundRecord = {
				roundId: "round-1",
				taskId: "id",
				projectKey: "project",
				trigger: "initial",
				taskBrief: brief,
				model: "fake/model",
				budget: { maxScouts: 1, maxConcurrent: 1, maxToolCallsPerScout: 2, maxProposalsPerScout: 2, maxScoutOutputChars: 1000, maxPacketChars: 2000, timeoutMsPerScout: 1000, maxRoundsPerTask: 2 },
				prior: { kind: "none", reason: "empty" },
				runs: fakeRuns(),
				packet: { round: 1, prior: { kind: "none", reason: "empty" }, runs: fakeRuns(), content: "" },
				adoptedProposalIds: [],
				verifiedOutcome: "not-yet-executed",
			};
				const tool = createSelectExplorationTool({
					llm: new FakeLlm([]),
					getCurrentRound: () => currentRound,
				onSelection: (value) => {
				selected = value;
			},
		});
		const result = await tool.execute(
			"id",
			{ selectedProposalIds: ["p1", "p2"], combinedPlanSummary: "组合两个候选", reason: "事实互补" },
			undefined,
			undefined,
			{} as never,
		);
		expect(String((result.content[0] as { text: string }).text)).toContain("正式执行");
		expect((selected as { selectedProposalIds: string[] }).selectedProposalIds).toEqual(["p1", "p2"]);
	});
});
