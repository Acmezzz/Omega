/**
 * M1/M2: memory-log generation (fidelity rules) + writer durability.
 * Uses the real JournalWriter to build fact turns, then drives memorizeTurn or
 * the adapter's session_before_compact hook.
 */
import { mkdtempSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { JournalWriter, readTask } from "../core/journal/writer.ts";
import { MemoryWriter, readMemoryLog, readCoverage, isFullyCovered, memoryTaskDir } from "../core/memory/writer.ts";
import { auditSkeleton } from "../core/memory/validate.ts";
import { memorizeSpan } from "../core/memory/index.ts";
import { RouterLlm } from "./helpers/fake-llm.ts";
import { FakePi } from "./helpers/fake-pi.ts";

const PROJECT = "--G--try-agent-demo--";
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jw-memory-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Build a task with one turn: first tool errors, rest succeed. */
function buildTurnTask(taskId: string): void {
	const writer = new JournalWriter(root, PROJECT, taskId);
	writer.handleEvent({ kind: "message_end_user", text: "修复登录崩溃" });
	writer.handleEvent({ kind: "tool_start", toolCallId: "t1", tool: "bash", args: { command: "npm test" } });
	writer.handleEvent({ kind: "tool_end", toolCallId: "t1", resultContent: "1 failing: AuthLogin crashes", isError: true });
	writer.handleEvent({ kind: "tool_start", toolCallId: "t2", tool: "grep", args: { query: "login" } });
	writer.handleEvent({ kind: "tool_end", toolCallId: "t2", resultContent: "src/auth/login.ts:42", isError: false });
	writer.handleEvent({ kind: "tool_start", toolCallId: "t3", tool: "edit", args: { file: "login.ts" } });
	writer.handleEvent({ kind: "tool_end", toolCallId: "t3", resultContent: "ok", isError: false });
	writer.handleEvent({ kind: "turn_end", stopReason: "stop" });
	writer.handleEvent({ kind: "agent_settled" });
}

describe("M1: memory writer durability + coverage watermark", () => {
	it("appends segments and advances coverage; reopen survives (no rewrite)", () => {
		const dir = memoryTaskDir(root, PROJECT, "task-mem-writer");
		const w = new MemoryWriter(root, PROJECT, "task-mem-writer");
		const rec = w.append({ spanFromTurnSeq: 1, spanToTurnSeq: 1, userIntent: "修复登录崩溃", thinking: null, memories: [], tools: [], sourceTurns: [1] });
		expect(rec.seq).toBe(1);
		const w2 = new MemoryWriter(root, PROJECT, "task-mem-writer");
		expect(w2.lastRecordSeq).toBe(1);
		const rec2 = w2.append({ spanFromTurnSeq: 2, spanToTurnSeq: 2, userIntent: "x", thinking: null, memories: [], tools: [], sourceTurns: [2] });
		expect(rec2.seq).toBe(2);
		// new structure: coverage.json + seg-*.json
		expect(existsSync(join(dir, "coverage.json"))).toBe(true);
		const cov = readCoverage(dir)!;
		expect(cov.distilledUpTo).toBe(2);
		expect(cov.segments.length).toBeGreaterThanOrEqual(1);
		const log = readMemoryLog(dir);
		expect(log.records.map((r) => r.seq)).toEqual([1, 2]);
	});

	it("isFullyCovered respects the watermark and stale flag", () => {
		const dir = memoryTaskDir(root, PROJECT, "task-mem-cov");
		const w = new MemoryWriter(root, PROJECT, "task-mem-cov");
		expect(isFullyCovered(readCoverage(dir)!, 0)).toBe(true);
		w.append({ spanFromTurnSeq: 1, spanToTurnSeq: 1, userIntent: "u", thinking: null, memories: [], tools: [], sourceTurns: [1] });
		// distilled 1, journal has 5 → not fully covered
		expect(isFullyCovered(readCoverage(dir)!, 5)).toBe(false);
		expect(isFullyCovered(readCoverage(dir)!, 1)).toBe(true);
		// reopening marks stale → not covered even if watermark matches
		w.markStale();
		expect(isFullyCovered(readCoverage(dir)!, 1)).toBe(false);
	});

	it("a truncated last line is skipped without failing the read", () => {
		const dir = memoryTaskDir(root, PROJECT, "task-mem-read");
		const w = new MemoryWriter(root, PROJECT, "task-mem-read");
		w.append({ spanFromTurnSeq: 1, spanToTurnSeq: 1, userIntent: "u", thinking: null, memories: [], tools: [], sourceTurns: [1] });
		// append a bad line to the active segment file
		const segPath = join(dir, w["currentSegmentFile"] as unknown as string);
		appendFileSync(segPath, '{"seq":99');
		const log = readMemoryLog(dir);
		expect(log.skippedLines).toBeGreaterThanOrEqual(1);
		expect(log.records).toHaveLength(1);
	});
});

describe("M2: memorizeTurn fidelity rules", () => {
	it("keeps every tool (success AND failure) and distills result/failure analysis", async () => {
		buildTurnTask("task-mem-fidelity");
		const { turns } = readTask(join(root, PROJECT, "task-mem-fidelity"));
		const llm = new RouterLlm(() =>
			JSON.stringify({
				userIntent: "修复登录崩溃",
				thinking: "先跑测试复现，再定位崩溃点",
				memories: ["AuthLogin 在空密码时崩溃（login.ts:42）"],
				tools: [
					{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "error", args: "npm test", resultSummary: null, failureAnalysis: "测试失败：空密码导致 login.ts 崩溃", intent: "复现失败", significance: "essential" },
					{ index: 1, turnSeq: 1, refSequence: 2, tool: "grep", status: "success", args: "login", resultSummary: "定位到 src/auth/login.ts:42", failureAnalysis: null, intent: "定位崩溃点", significance: "helpful" },
					{ index: 2, turnSeq: 1, refSequence: 3, tool: "edit", status: "success", args: "login.ts", resultSummary: "应用修复", failureAnalysis: null, intent: "修复", significance: "essential" },
				],
			}),
		);
		const data = await memorizeSpan(
			{ journalsRoot: root, projectKey: PROJECT, taskId: "task-mem-fidelity", llm },
			1,
			1,
		);
		expect(data).not.toBeNull();
		expect(data!.seq).toBe(1);
		expect(data!.tools).toHaveLength(3); // all three calls kept
		// failure call: resultSummary null, failureAnalysis present
		const failed = data!.tools[0];
		expect(failed.status).toBe("error");
		expect(failed.resultSummary).toBeNull();
		expect(failed.failureAnalysis).toContain("空密码");
		// success call: resultSummary present, failureAnalysis null
		const succeeded = data!.tools[1];
		expect(succeeded.status).toBe("success");
		expect(succeeded.resultSummary).toContain("login.ts:42");
		expect(succeeded.failureAnalysis).toBeNull();
	});

	it("rejects half-covered output (strict fidelity guard) then falls back", async () => {
		buildTurnTask("task-mem-strict");
		// First response covers only 1 of 3 tools => strict parse returns null and
		// the lenient retry is issued; a full-coverage response is then accepted.
		let called = 0;
		const llm = new RouterLlm(() => {
			called += 1;
			if (called === 1) {
				return JSON.stringify({ userIntent: "修复登录崩溃", thinking: null, memories: [], tools: [
					{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "error", args: "npm test", resultSummary: null, failureAnalysis: "测试失败", intent: null, significance: "essential" },
				] });
			}
			return JSON.stringify({ userIntent: "修复登录崩溃", thinking: null, memories: [], tools: [
				{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "error", args: "npm test", resultSummary: null, failureAnalysis: "测试失败", intent: null, significance: "essential" },
				{ index: 1, turnSeq: 1, refSequence: 2, tool: "grep", status: "success", args: "login", resultSummary: "定位", failureAnalysis: null, intent: null, significance: null },
				{ index: 2, turnSeq: 1, refSequence: 3, tool: "edit", status: "success", args: "login.ts", resultSummary: "修复", failureAnalysis: null, intent: null, significance: null },
			] });
		});
		const data = await memorizeSpan({ journalsRoot: root, projectKey: PROJECT, taskId: "task-mem-strict", llm }, 1, 1);
		expect(data).not.toBeNull();
		expect(data!.tools).toHaveLength(3);
		expect(called).toBe(2);
	});
});

describe("M3: adapter triggers memory on session_before_compact", () => {
	it("generates a memory record from flushed fact turns", async () => {
		buildTurnTask("task-mem-compact");
		const fakePi = new FakePi();
		const runtime = wire(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, journalsRoot: root, workflowsRoot: join(root, "wf"), memoryOnCompact: true },
		});
		const ctx = {
			cwd: "G:/try/agent/demo",
			sessionManager: {
				getHeader: () => ({ id: "task-mem-compact" }),
				getEntries: () => [],
			},
			model: { provider: "test", id: "fake" },
			modelRegistry: {
				complete: async () => ({
					content: [
						{
							type: "text",
							text: JSON.stringify({
								userIntent: "修复登录崩溃",
								thinking: null,
								memories: [],
								tools: [
									{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "error", args: "npm test", resultSummary: null, failureAnalysis: "测试失败", intent: null, significance: null },
									{ index: 1, turnSeq: 1, refSequence: 2, tool: "grep", status: "success", args: "login", resultSummary: "定位", failureAnalysis: null, intent: null, significance: null },
									{ index: 2, turnSeq: 1, refSequence: 3, tool: "edit", status: "success", args: "login.ts", resultSummary: "修复", failureAnalysis: null, intent: null, significance: null },
								],
							}),
						},
					],
				}),
			},
		};
		await fakePi.emit("session_start", { reason: "startup" }, ctx);
		// Re-play a second turn so there is un-memorized fact work at compact time.
		const w = new JournalWriter(root, PROJECT, "task-mem-compact");
		w.handleEvent({ kind: "message_end_user", text: "还是崩" });
		w.handleEvent({ kind: "tool_start", toolCallId: "c1", tool: "bash", args: {} });
		w.handleEvent({ kind: "tool_end", toolCallId: "c1", resultContent: "still failing", isError: true });
		w.handleEvent({ kind: "turn_end", stopReason: "error" });
		w.handleEvent({ kind: "agent_settled" });
		await fakePi.emit("session_before_compact", { reason: "threshold" }, ctx);
		await Promise.all(runtime.getPendingMemorizations());
		const log = readMemoryLog(memoryTaskDir(root, PROJECT, "task-mem-compact"));
		expect(log.records.length).toBeGreaterThanOrEqual(1);
	});
});

describe("M4: shutdown tail-distill closes the short-task gap", () => {
	it("a never-compacted task still gets memory on shutdown, with a review", async () => {
		buildTurnTask("task-short");
		const fakePi = new FakePi();
		const runtime = wire(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, journalsRoot: root, workflowsRoot: join(root, "wf-s"), memoryOnCompact: true },
		});
		const ctx = {
			cwd: "G:/try/agent/demo",
			sessionManager: { getHeader: () => ({ id: "task-short" }), getEntries: () => [] },
			model: { provider: "test", id: "fake" },
			modelRegistry: {
				complete: async () => ({
					content: [{ type: "text", text: JSON.stringify({ userIntent: "修复登录崩溃", thinking: null, memories: [], tools: [
						{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "error", args: "npm test", resultSummary: null, failureAnalysis: "测试失败", intent: null, significance: null },
						{ index: 1, turnSeq: 1, refSequence: 2, tool: "grep", status: "success", args: "login", resultSummary: "定位", failureAnalysis: null, intent: null, significance: null },
						{ index: 2, turnSeq: 1, refSequence: 3, tool: "edit", status: "success", args: "login.ts", resultSummary: "修复", failureAnalysis: null, intent: null, significance: null },
					] }) }],
				}),
			},
		};
		await fakePi.emit("session_start", { reason: "startup" }, ctx);
		// No compact triggers (short task). Shutdown must distill the whole gap.
		await fakePi.emit("session_shutdown", { reason: "quit" }, ctx);
		await Promise.all(runtime.getPendingMemorizations());
		const log = readMemoryLog(memoryTaskDir(root, PROJECT, "task-short"));
		expect(log.records.length).toBeGreaterThanOrEqual(1);
		const rec = log.records[0];
		expect(rec.trigger).toBe("shutdown");
		expect(rec.review).toBeDefined();
		// outcome derives from the adapter's in-memory flushed turn; in this test the
		// fact task was written by a separate writer, so it maps to a valid fallback.
		expect(["succeeded", "partial", "failed", "aborted"]).toContain(rec.review!.outcome);
		// coverage watermark now fully covers the short task
		const cov = readCoverage(memoryTaskDir(root, PROJECT, "task-short"));
		expect(cov!.distilledUpTo).toBeGreaterThanOrEqual(1);
	});
});

describe("M5: skeleton programmatic validation", () => {
	it("flags hallucinated, dropped, status-mismatch, and returns consistent for a faithful record", () => {
		buildTurnTask("task-mem-audit");
		const { turns } = readTask(join(root, PROJECT, "task-mem-audit"));
		// faithful record (matches turns)
		const good = auditSkeleton({
			seq: 1,
			spanFromTurnSeq: 1,
			spanToTurnSeq: 1,
			generatedAt: "",
			trigger: "compact",
			userIntent: "x",
			thinking: null,
			memories: [],
			tools: [
				{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "error", args: "", resultSummary: null, failureAnalysis: null, intent: null, significance: null },
				{ index: 1, turnSeq: 1, refSequence: 2, tool: "grep", status: "success", args: "", resultSummary: null, failureAnalysis: null, intent: null, significance: null },
				{ index: 2, turnSeq: 1, refSequence: 3, tool: "edit", status: "success", args: "", resultSummary: null, failureAnalysis: null, intent: null, significance: null },
			],
			sourceTurns: [1],
		}, turns);
		expect(good.consistent).toBe(true);

		// hallucinated call + status flip + dropped call
		const bad = auditSkeleton({
			seq: 1,
			spanFromTurnSeq: 1,
			spanToTurnSeq: 1,
			generatedAt: "",
			trigger: "compact",
			userIntent: "x",
			thinking: null,
			memories: [],
			tools: [
				{ index: 0, turnSeq: 1, refSequence: 1, tool: "bash", status: "success", args: "", resultSummary: null, failureAnalysis: null, intent: null, significance: null },
				{ index: 1, turnSeq: 1, refSequence: 99, tool: "curl", status: "success", args: "", resultSummary: null, failureAnalysis: null, intent: null, significance: null },
			],
			sourceTurns: [1],
		}, turns);
		expect(bad.consistent).toBe(false);
		expect(bad.statusMismatches).toHaveLength(1); // bash status flipped
		expect(bad.hallucinated.some((h) => h.kind === "hallucinated" && h.tool === "curl")).toBe(true);
		expect(bad.missing.length).toBeGreaterThanOrEqual(2); // grep + edit dropped
	});
});