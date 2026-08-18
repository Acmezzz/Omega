import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { DEFAULT_EXPLORATION_BUDGET, type TaskBrief } from "../core/types.ts";
import { DEFAULT_SCOUT_ROLES } from "../core/roles.ts";
import { runScout, type ScoutSpawn } from "../runner.ts";

const brief: TaskBrief = {
	rawUserInput: "分析失败测试",
	objective: "理解失败原因",
	deliverable: "可验证的方向",
	acceptanceCriteria: ["能验证结果"],
	constraints: [],
	knownFacts: [],
	unknowns: ["根因"],
	relevantPaths: [],
	forbiddenAssumptions: [],
};

class FakeChild extends EventEmitter {
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	killSignals: string[] = [];

	kill(signal?: NodeJS.Signals): boolean {
		this.killSignals.push(signal ?? "");
		queueMicrotask(() => this.emit("close", null));
		return true;
	}
}

function spawnScript(lines: string[], capture: { command?: string; args?: string[]; child?: FakeChild }): ScoutSpawn {
	return (command, args) => {
		const child = new FakeChild();
		capture.command = command;
		capture.args = args;
		capture.child = child;
		setTimeout(() => {
			for (const line of lines) child.stdout.emit("data", `${line}\n`);
			child.emit("close", 0);
		}, 0);
		return child as never;
	};
}

describe("Scout runner", () => {
	it("passes isolated read-only invocation settings and parses current JSON events", async () => {
		const capture: { command?: string; args?: string[]; child?: FakeChild } = {};
		const report = JSON.stringify({
			noWorkPerformed: true,
			priorStatus: "none",
			proposals: [{ id: "p1", idea: "检查调用路径", steps: ["读取错误", "搜索调用方"] }],
		});
		const result = await runScout({
			cwd: process.cwd(),
			model: { provider: "fake", id: "model" },
			role: DEFAULT_SCOUT_ROLES[0],
			brief,
			prior: { kind: "none", reason: "empty" },
			budget: { ...DEFAULT_EXPLORATION_BUDGET, timeoutMsPerScout: 1_000 },
			spawn: spawnScript([
			JSON.stringify({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { path: "src/example.ts" } }),
			JSON.stringify({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", isError: false }),
				JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: report }] } }),
			], capture),
		});

		expect(result.status).toBe("completed");
		expect(result.toolCallCount).toBe(1);
		expect(result.report?.proposals[0]?.id).toBe("p1");
		expect(result.footprint?.paths).toContain("src/example.ts");
		expect(result.footprint?.toolCalls[0]).toMatchObject({ tool: "read", target: "src/example.ts", success: true });
		expect(capture.args).toEqual(expect.arrayContaining([
			"--mode", "json", "--no-session", "--tools", "read,grep,find,ls",
			"--model", "fake/model", "--append-system-prompt",
		]));
		expect(capture.args).not.toContain("--thinking");
	});

	it("cancels and reports a tool-call budget breach", async () => {
		const capture: { child?: FakeChild } = {};
		const result = await runScout({
			cwd: process.cwd(),
			role: DEFAULT_SCOUT_ROLES[0],
			brief,
			prior: { kind: "none", reason: "empty" },
			budget: { ...DEFAULT_EXPLORATION_BUDGET, maxToolCallsPerScout: 1 },
			spawn: spawnScript([
				JSON.stringify({ type: "tool_execution_start", toolName: "read" }),
				JSON.stringify({ type: "tool_execution_start", toolName: "grep" }),
			], capture),
		});

		expect(result.status).toBe("budget_exceeded");
		expect(result.toolCallCount).toBe(2);
		expect(capture.child?.killSignals).toContain("SIGTERM");
	});

	it("reports an external abort without treating it as a spawn failure", async () => {
		const capture: { child?: FakeChild } = {};
		const controller = new AbortController();
		const resultPromise = runScout({
			cwd: process.cwd(),
			role: DEFAULT_SCOUT_ROLES[0],
			brief,
			prior: { kind: "none", reason: "empty" },
			budget: { ...DEFAULT_EXPLORATION_BUDGET, timeoutMsPerScout: 1_000 },
			spawn: (command, args, options) => {
				const child = new FakeChild();
				capture.child = child;
				setTimeout(() => controller.abort(), 0);
				return child as never;
			},
			signal: controller.signal,
		});
		const result = await resultPromise;

		expect(result.status).toBe("aborted");
		expect(capture.child?.killSignals).toContain("SIGTERM");
	});
});
