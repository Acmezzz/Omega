/**
 * J1/J2: journal fact-line writing, patch merging, half-line tolerance.
 * Drives wire() on a FakePi with fixture event scripts — the same wiring code
 * used against the real Pi extension API.
 */
import { mkdtempSync, readFileSync, existsSync, appendFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { JournalWriter, readTask, taskDirOf } from "../core/journal/writer.ts";
import { resolveEntryIds } from "../core/journal/refs.ts";
import { FakePi } from "./helpers/fake-pi.ts";
import { loadFixture, replayEvents } from "./helpers/replay.ts";
import { fileURLToPath } from "node:url";

const fixturesDir = fileURLToPath(new URL("../fixtures/events", import.meta.url));
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jw-journal-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function fixturePath(name: string): string {
	return join(fixturesDir, name);
}

async function replay(name: string): Promise<FakePi> {
	const fakePi = new FakePi();
	const config = {
		enabled: true,
		journalsRoot: root,
		workflowsRoot: join(root, "workflows"),
	};
	wire(fakePi as unknown as ExtensionAPI, { config });
	await replayEvents(fakePi, loadFixture(fixturePath(name)));
	return fakePi;
}

describe("J1: fact-line writing", () => {
	it("single turn with 3 tools (one error) produces a correct fact line", async () => {
		await replay("single-turn-3tools.json");
		const taskDir = taskDirOf(root, "--G--try-agent-demo--", "task-demo-001");
		expect(existsSync(join(taskDir, "task.json"))).toBe(true);
		const result = readTask(taskDir);
		expect(result.meta).not.toBeNull();
		expect(result.turns).toHaveLength(1);
		const turn = result.turns[0];
		expect(turn.seq).toBe(1);
		expect(turn.userInput).toBe("修复登录崩溃：运行 npm test 报错");
		expect(turn.outcome).toBe("completed");
		expect(turn.toolCalls).toHaveLength(3);
		expect(turn.toolCalls[0].tool).toBe("bash");
		expect(turn.toolCalls[0].status).toBe("error");
		expect(turn.toolCalls[0].resultRaw).toContain("crashes on empty password");
		expect(turn.toolCalls[1].tool).toBe("grep");
		expect(turn.toolCalls[1].status).toBe("success");
		expect(turn.toolCalls[2].refSequence).toBe(3);
		// LLM fields stay null until a patch arrives
		expect(turn.intent).toBeNull();
		expect(turn.toolCalls[0].resultSummary).toBeNull();
		expect(result.meta?.outcome).toBe("completed");
		expect(result.meta?.turnCount).toBe(1);
		expect(result.meta?.blocks[0].file).toBe("0001.jl");
	});

	it("two-turn retry chain produces two sequential turns in one block", async () => {
		await replay("two-turn-retry.json");
		const result = readTask(taskDirOf(root, "--G--try-agent-demo--", "task-demo-002"));
		expect(result.turns).toHaveLength(2);
		expect(result.turns[0].seq).toBe(1);
		expect(result.turns[1].seq).toBe(2);
		expect(result.turns[1].userInput).toContain("还是崩");
		expect(result.turns[1].toolCalls).toHaveLength(3);
		expect(result.meta?.turnCount).toBe(2);
	});

	it("skill usage markers in expanded user input are captured", async () => {
		const fakePi = new FakePi();
		wire(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, journalsRoot: root, workflowsRoot: join(root, "wf") },
		});
		const ctx = {
			cwd: "G:/try/agent/demo",
			sessionManager: { getHeader: () => ({ id: "task-skill-1" }), getEntries: () => [] },
		};
		await fakePi.emit(
			"session_start",
			{},
			ctx,
		);
		await fakePi.emit(
			"message_end",
			{ message: { role: "user", content: '<skill name="fix-flow" location="/x/SKILL.md">References...</skill>\n修复它' } },
			ctx,
		);
		await fakePi.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await fakePi.emit("agent_settled", {}, ctx);
		const result = readTask(taskDirOf(root, "--G--try-agent-demo--", "task-skill-1"));
		expect(result.turns[0].skills).toHaveLength(1);
		expect(result.turns[0].skills[0].name).toBe("fix-flow");
	});
});

describe("J2: patch merging and robustness", () => {
	it("appendPatch merges by seq and leaves fact lines untouched", async () => {
		const taskDir = taskDirOf(root, "--G--try-agent-demo--", "task-demo-001");
		const blockPath = join(taskDir, "0001.jl");
		const before = readFileSync(blockPath, "utf-8");
		const writer = new JournalWriter(root, "--G--try-agent-demo--", "task-demo-001");
		writer.appendPatch(1, {
			intent: "修复登录测试失败",
			taskEssence: "缺陷复现+定位+修复+回归验证",
			deliverable: "通过测试的登录修复",
			relation: "new",
			plan: "跑测试→定位→读实现",
			toolPatches: [
				{
					refSequence: 1,
					intent: "复现失败拿到报错",
					argsSummary: "跑全量测试",
					resultSummary: "1 个测试失败：空密码崩溃",
					significance: "essential",
					followUp: "随后 grep 定位 login 相关代码",
				},
			],
			unfinished: [],
			errorSummary: null,
		});
		// Fact line content unchanged (append-only)
		expect(readFileSync(blockPath, "utf-8").startsWith(before)).toBe(true);
		const result = readTask(taskDir);
		const turn = result.turns[0];
		expect(turn.intent).toBe("修复登录测试失败");
		expect(turn.relation).toBe("new");
		expect(turn.extractedAt).toBeTruthy();
		expect(turn.toolCalls[0].resultSummary).toBe("1 个测试失败：空密码崩溃");
		expect(turn.toolCalls[0].followUp).toContain("grep");
	});

	it("a truncated last line is skipped without failing the read", async () => {
		const taskDir = taskDirOf(root, "--G--try-agent-demo--", "task-demo-002");
		appendFileSync(join(taskDir, "0001.jl"), '{"kind":"turn","seq":3,"turn":{"userInput":"半行');
		const result = readTask(taskDir);
		expect(result.skippedLines).toBeGreaterThanOrEqual(1);
		expect(result.turns).toHaveLength(2); // the two complete turns survive
	});

	it("patch for unknown seq is ignored", () => {
		const writer = new JournalWriter(root, "--G--try-agent-demo--", "task-demo-002");
		writer.appendPatch(99, {
			intent: "x",
			taskEssence: null,
			deliverable: null,
			relation: "new",
			plan: null,
			toolPatches: [],
			unfinished: [],
			errorSummary: null,
		});
		const result = readTask(taskDirOf(root, "--G--try-agent-demo--", "task-demo-002"));
		expect(result.turns.every((t) => t.intent === null)).toBe(true);
	});
});

describe("refId resolution (object identity)", () => {
	it("matches user and assistant messages against entry tail", () => {
		const userMessage = { role: "user", content: "hi" };
		const assistantMessage = { role: "assistant", content: [] };
		const entries = [
			{ id: "old1", type: "message", message: { role: "user", content: "stale" } },
			{ id: "u1", type: "message", message: userMessage },
			{ id: "a1", type: "message", message: assistantMessage },
			{ id: "meta1", type: "session_info" },
		];
		const resolved = resolveEntryIds(userMessage, assistantMessage, entries);
		expect(resolved.userEntryId).toBe("u1");
		expect(resolved.assistantEntryId).toBe("a1");
	});

	it("returns nulls when messages are absent from entries", () => {
		const resolved = resolveEntryIds({ role: "user" }, { role: "assistant" }, []);
		expect(resolved.userEntryId).toBeNull();
		expect(resolved.assistantEntryId).toBeNull();
	});
});
