import { existsSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire as wireJournal } from "../../journal-workflow/adapter.ts";
import { readTask, taskDirOf } from "../../journal-workflow/core/journal/writer.ts";
import { wire as wireScout } from "../adapter.ts";
import { explorationTaskDir } from "../core/journal.ts";
import type { ScoutRunRecord } from "../core/types.ts";
import { projectKeyFromCwd } from "../../_shared/task-identity.ts";
import { FakePi } from "./helpers/fake-pi.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";

const root = mkdtempSync(join(tmpdir(), "extensions-coexistence-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const scoutRuns: ScoutRunRecord[] = [{
	scoutId: "evidence-first",
	angle: "evidence-first",
	status: "completed",
	toolCallCount: 1,
	durationMs: 1,
	report: {
		scoutId: "evidence-first",
		angle: "evidence-first",
		priorStatus: "none",
		proposals: [{ id: "proposal-1", idea: "读取失败输出并定位调用关系", steps: ["读取输出"], assumptions: [], expectedEvidence: [], disqualifiers: [], probes: [] }],
		sourcesChecked: ["tests"],
		searchesPerformed: ["failure"],
		verifiedFacts: [],
		negativeEvidence: [],
		openQuestions: [],
		limitations: [],
		noWorkPerformed: true,
	},
}];

describe("independent plugin coexistence", () => {
	it("records formal work in journals and exploration in rounds separately", async () => {
		const fakePi = new FakePi();
		const cwd = "G:/try/agent/coexistence";
		const taskId = "task-coexistence";
		const ctx = {
			cwd,
			model: { provider: "fake", id: "model" },
			sessionManager: { getHeader: () => ({ id: taskId }), getEntries: () => [] },
		};
		const llm = new FakeLlm([]);
		const journalRuntime = wireJournal(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, journalsRoot: join(root, "journals"), workflowsRoot: join(root, "workflows"), workflowPolicy: "off" },
			llm,
		});
		wireScout(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, explorationsRoot: join(root, "explorations"), policy: "explore-first" },
			llm,
			exploration: { runScouts: async () => scoutRuns },
		});

		await fakePi.emit("session_start", {}, ctx);
		await fakePi.emit("message_end", { message: { role: "user", content: "分析失败测试" } }, ctx);
		const starts = await fakePi.emit("before_agent_start", { prompt: "分析失败测试", systemPrompt: "BASE" }, ctx);
		expect(starts.some((value) => typeof value === "object" && value !== null && "systemPrompt" in value && String((value as { systemPrompt: string }).systemPrompt).includes("exploration_protocol"))).toBe(true);

		const explore = fakePi.tools.find((tool) => (tool as { name?: string }).name === "explore_space") as { execute: Function };
		await explore.execute("explore-1", {
			taskBrief: {
				rawUserInput: "分析失败测试",
				objective: "理解失败原因",
				deliverable: "可验证的方向",
				acceptanceCriteria: ["结果可验证"],
				constraints: [],
				knownFacts: [],
				unknowns: ["根因"],
				relevantPaths: [],
				forbiddenAssumptions: [],
			},
			round: 1,
		}, undefined, undefined, ctx);

		await fakePi.emit("tool_execution_start", { toolCallId: "formal-1", toolName: "read", args: { path: "README.md" } }, ctx);
		await fakePi.emit("tool_execution_end", { toolCallId: "formal-1", toolName: "read", result: { content: [{ type: "text", text: "ok" }] }, isError: false }, ctx);
		await fakePi.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await fakePi.emit("agent_settled", {}, ctx);
		await Promise.all(journalRuntime.getPendingDistills());
		await fakePi.emit("session_shutdown", {}, ctx);

		const projectKey = projectKeyFromCwd(cwd);
		const journalDir = taskDirOf(join(root, "journals"), projectKey, taskId);
		const explorationDir = explorationTaskDir(join(root, "explorations"), projectKey, taskId);
		expect(readTask(journalDir).turns[0]?.toolCalls[0]?.tool).toBe("read");
		expect(existsSync(join(journalDir, "rounds.jl"))).toBe(false);
		const roundsFile = join(explorationDir, "rounds.jl");
		expect(existsSync(roundsFile)).toBe(true);
		expect(readFileSync(roundsFile, "utf8")).toContain("proposal-1");
	});
});
