import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { explorationTaskDir } from "../core/journal.ts";
import type { ScoutRunRecord } from "../core/types.ts";
import { FakePi } from "./helpers/fake-pi.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

let root: string;
beforeAll(() => { root = mkdtempSync(join(tmpdir(), "exploration-scout-e2e-")); });
afterAll(() => rmSync(root, { recursive: true, force: true }));

const brief = {
	rawUserInput: "分析失败测试",
	objective: "理解失败原因并形成候选方向",
	deliverable: "一份可验证的执行方向",
	acceptanceCriteria: ["外部结果可验证"],
	constraints: [], knownFacts: [], unknowns: ["根因"], relevantPaths: [], forbiddenAssumptions: [],
};

function fakeRuns(): ScoutRunRecord[] {
	return [{ scoutId: "evidence-first", angle: "evidence-first", status: "completed", toolCallCount: 1, durationMs: 1,
		report: { scoutId: "evidence-first", angle: "evidence-first", priorStatus: "none", proposals: [{
			id: "p1", idea: "从失败输出反查调用关系", steps: ["读取失败输出", "搜索调用方"], assumptions: [], expectedEvidence: ["找到调用路径"], disqualifiers: [], probes: [],
		}], sourcesChecked: ["tests"], searchesPerformed: ["failure"], verifiedFacts: [], negativeEvidence: [], openQuestions: ["根因"], limitations: [], noWorkPerformed: true },
	}];
}

describe("explore-first adapter flow", () => {
	it("injects protocol, records a free selection, and writes only exploration storage", async () => {
		const explorationsRoot = join(root, "explorations");
		const fakePi = new FakePi();
		wire(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, explorationsRoot, policy: "explore-first" },
			llm: new FakeLlm([]),
			exploration: { runScouts: async () => fakeRuns() },
		});
		const ctx = { cwd: "G:/try/agent/exploration-e2e", model: { provider: "fake", id: "model" }, sessionManager: { getHeader: () => ({ id: "task-explore" }) } };
		await fakePi.emit("session_start", {}, ctx);
		await fakePi.emit("message_end", { message: { role: "user", content: "分析失败测试" } }, ctx);
		const starts = await fakePi.emit("before_agent_start", { prompt: "分析失败测试", systemPrompt: "BASE" }, ctx);
		const augmented = starts.find((value): value is { systemPrompt: string } => Boolean(value && typeof value === "object" && "systemPrompt" in (value as object)));
		expect(augmented?.systemPrompt).toContain("<exploration_protocol>");

		const explore = fakePi.tools.find((tool) => (tool as { name?: string }).name === "explore_space") as { execute: Function };
		const select = fakePi.tools.find((tool) => (tool as { name?: string }).name === "select_exploration") as { execute: Function };
		const exploreResult = await explore.execute("call-1", { taskBrief: brief, round: 1 }, undefined, undefined, ctx);
		expect(String(exploreResult.content[0].text)).toContain("p1");
		const selectResult = await select.execute("call-2", { selectedProposalIds: ["p1"], combinedPlanSummary: "先验证调用关系" }, undefined, undefined, ctx);
		expect(String(selectResult.content[0].text)).toContain("不会执行任务或激活工作流");

		const taskDir = explorationTaskDir(explorationsRoot, "--G--try-agent-exploration-e2e--", "task-explore");
		const roundsFile = join(taskDir, "rounds.jl");
		expect(existsSync(roundsFile)).toBe(true);
		const lines = readFileSync(roundsFile, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { kind: string });
		expect(lines.map((line) => line.kind)).toEqual(["round", "selection"]);
	});
});
