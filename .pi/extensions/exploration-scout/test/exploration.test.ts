/** Offline exploration protocol tests: no pi process and no network. */
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { validateTaskBrief, normalizeTaskBrief } from "../core/brief.ts";
import { DEFAULT_EXPLORATION_BUDGET } from "../core/types.ts";
import { buildMainExplorationProtocol, buildScoutPrompt, renderPrior } from "../core/prompts.ts";
import { DEFAULT_SCOUT_ROLES, selectScoutRoles } from "../core/roles.ts";
import { makePacket, parseScoutReport, renderPacketContent } from "../core/packet.ts";
import { resolvePrior } from "../core/prior.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

const root = mkdtempSync(join(tmpdir(), "exploration-scout-"));

afterAll(() => rmSync(root, { recursive: true, force: true }));

function brief() {
	return {
		rawUserInput: "分析这个失败测试并确认结果",
		objective: "理解失败测试对应的问题并形成可执行的修复方向",
		deliverable: "一份经过验证的修复结果",
		acceptanceCriteria: ["测试结果能说明当前问题已处理"],
		constraints: ["不要扩大修改范围"],
		knownFacts: [{ fact: "测试命令返回失败", source: "terminal:test" }],
		unknowns: ["失败根因", "最小修改位置"],
		relevantPaths: ["src/"],
		forbiddenAssumptions: ["不能假设错误一定在测试文件"],
	};
}

describe("exploration brief and role contract", () => {
	it("accepts neutral understanding and rejects solution-biased wording", () => {
		expect(validateTaskBrief(brief()).valid).toBe(true);
		expect(validateTaskBrief({ ...brief(), objective: "应该修改 login.ts 来修复它" }).valid).toBe(false);
		expect(normalizeTaskBrief({ objective: "only" })).toBeNull();
	});

	it("keeps roles as preferences while sharing the broad exploration contract", () => {
		const prompts = DEFAULT_SCOUT_ROLES.map((role) => buildScoutPrompt(role, brief(), { kind: "none", reason: "empty" }));
		for (const prompt of prompts) {
			expect(prompt).toContain("必须从用户目标和仓库事实独立发散");
			expect(prompt).toContain("不限制工具、目录、信息源或结论");
			expect(prompt).toContain("Optional prior: none matched");
		}
		expect(selectScoutRoles(3)).toHaveLength(3);
		expect(selectScoutRoles(4, true)).toHaveLength(4);
	});

		it("renders matched prior as advisory, never as execution instructions", () => {
			const text = renderPrior({ kind: "matched", summary: { id: "workflow-demo", intent: "定位失败", summary: "读取错误并寻找证据", reason: "只读 advisory" }, reason: "只读 advisory" });
			expect(text).toContain("Optional prior (not a boundary)");
			expect(text).toContain("必须继续从零搜索");
			expect(text).not.toContain("检查点未通过");
		});
});

describe("exploration report and packet", () => {
	const report = {
		angle: "evidence-first",
		priorStatus: "none",
		proposals: [
			{
				id: "p-local",
				idea: "先从测试堆栈定位实际调用路径",
				steps: ["读取失败输出", "搜索调用点"],
				assumptions: ["错误输出包含有效位置"],
				expectedEvidence: ["找到调用链"],
				disqualifiers: ["没有任何可定位输出"],
				probes: [{ question: "堆栈是否包含路径", action: "read test output", observation: "包含 src/x.ts:10", status: "observed", source: "terminal" }],
			},
		],
		sourcesChecked: ["tests", "source"],
		searchesPerformed: ["grep call site"],
		verifiedFacts: [{ fact: "调用点存在", source: "src/x.ts:10" }],
		negativeEvidence: [],
		openQuestions: ["是否还有第二个调用方"],
		limitations: ["未运行完整测试"],
		noWorkPerformed: true,
	};

	it("accepts objective reports and rejects ranking language", () => {
		const parsed = parseScoutReport(JSON.stringify(report), "s1", "evidence-first", "none");
		expect(parsed?.proposals).toHaveLength(1);
		expect(parsed?.noWorkPerformed).toBe(true);
		const banned = parseScoutReport(JSON.stringify({ ...report, recommendation: "best" }), "s1", "evidence-first", "none");
		expect(banned).toBeNull();
	});

	it("bounds packet content while preserving run metadata", () => {
		const runs = Array.from({ length: 4 }, (_, i) => ({
			scoutId: `s${i}`,
			angle: "evidence-first" as const,
			status: "completed" as const,
			toolCallCount: 4,
			durationMs: 10,
			report: parseScoutReport(JSON.stringify(report), `s${i}`, "evidence-first", "none"),
		}));
		const packet = makePacket(1, { kind: "none", reason: "no prior" }, runs, { ...DEFAULT_EXPLORATION_BUDGET, maxPacketChars: 500 });
		expect(packet.content.length).toBeLessThanOrEqual(500);
		expect(packet.runs).toHaveLength(4);
	});
});

describe("prior resolution fallback", () => {
	it("returns none without a workflow implementation dependency", async () => {
		const result = await resolvePrior("一个完全不同的图像任务");
		expect(result.kind).toBe("none");
	});

	it("accepts a read-only advisory provider without activating anything", async () => {
		const result = await resolvePrior("修复一个失败测试", {
			resolve: async () => ({ id: "workflow-demo", intent: "定位失败", summary: "读取错误并寻找证据", reason: "advisory" }),
		});
		expect(result.kind).toBe("matched");
		if (result.kind === "matched") expect(result.summary.id).toBe("workflow-demo");
	});

	it("degrades provider failures to unavailable", async () => {
		const result = await resolvePrior("修复测试", { resolve: async () => { throw new Error("lookup unavailable"); } });
		expect(result.kind).toBe("unavailable");
	});
});

describe("main exploration protocol", () => {
	it("tells the main agent to understand first and validate later", () => {
		const text = buildMainExplorationProtocol();
		expect(text).toContain("中立 TaskBrief");
		expect(text).toContain("正式执行前自行验证");
		expect(text).toContain("Scout 只提供未验证候选");
	});
});
