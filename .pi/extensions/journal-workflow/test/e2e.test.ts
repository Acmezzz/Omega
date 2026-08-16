/**
 * S1: offline end-to-end. One wire() instance over a FakePi, driven through
 * the full chain: match → inject → checkpoint validation → escape/advance →
 * journal + distill → evolution (evidence/escape bookkeeping).
 * All LLM behavior scripted via a routing fake.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { readTask, taskDirOf } from "../core/journal/writer.ts";
import { WorkflowStore } from "../core/library/store.ts";
import { FakePi } from "./helpers/fake-pi.ts";
import { RouterLlm, type LlmCallInput } from "./helpers/fake-llm.ts";

const seedDir = fileURLToPath(new URL("../fixtures/workflows/seed", import.meta.url));
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jw-e2e-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function makeRig(taskId: string): { fakePi: FakePi; runtime: ReturnType<typeof wire>; workflowsRoot: string } {
	const workflowsRoot = join(root, `wf-${taskId}`);
	cpSync(seedDir, workflowsRoot, { recursive: true });
	const llm = new RouterLlm(routeScriptedLlm);
	const fakePi = new FakePi();
	const runtime = wire(fakePi as unknown as ExtensionAPI, {
		config: { enabled: true, journalsRoot: join(root, "journals"), workflowsRoot },
		llm,
	});
	return { fakePi, runtime, workflowsRoot };
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: "G:/try/agent/demo",
		sessionManager: { getHeader: () => ({ id: "task-e2e" }), getEntries: () => [] },
	};
}

function routeScriptedLlm(input: LlmCallInput): string {
	const payload = JSON.parse(input.userPayload) as Record<string, unknown>;
	if (input.systemPrompt.startsWith("You select a workflow-library entry")) {
		return JSON.stringify({ id: "l2-fix-failing-test" });
	}
	if (input.systemPrompt.startsWith("You judge whether a tool result satisfies")) {
		const result = String(payload.result ?? "");
		if (result.includes("(no output")) {
			return JSON.stringify({ satisfied: false, reason: "测试命令无输出，拿不到失败信息" });
		}
		return JSON.stringify({ satisfied: true, reason: "" });
	}
	if (input.systemPrompt.startsWith("You distill")) {
		const toolCalls = (payload.toolCalls ?? []) as Array<{ refSequence: number }>;
		return JSON.stringify({
			intent: "修复失败的测试",
			relation: "new",
			plan: "复现→定位→修复→验证",
			toolPatches: toolCalls.map((tc) => ({
				refSequence: tc.refSequence,
				argsSummary: "调用",
				resultSummary: "见原始记录",
				followUp: null,
			})),
			unfinished: [],
			errorSummary: null,
		});
	}
	return JSON.stringify({});
}

function toolPayload(toolCallId: string, toolName: string, text: string, isError = false) {
	return {
		toolCallId,
		toolName,
		result: { content: [{ type: "text", text }] },
		isError,
	};
}

async function drain(runtime: ReturnType<typeof wire>): Promise<void> {
	await Promise.all([...runtime.getPendingChecks(), ...runtime.getPendingDistills()]);
}

function messageText(m: { content: unknown }): string {
	const c = m.content;
	if (typeof c === "string") return c;
	if (c && typeof c === "object" && "content" in (c as object)) {
		const inner = (c as { content: unknown }).content;
		if (typeof inner === "string") return inner;
	}
	return String(c);
}

describe("S1: escape path (checkpoint fails twice → hard escape)", () => {
	it("records failure, steers escape, escapes are booked, distill lands", async () => {
		const { fakePi, runtime, workflowsRoot } = makeRig("escape");
		const ctx = makeCtx();
		await fakePi.emit("session_start", {}, ctx);
		await fakePi.emit(
			"message_end",
			{ message: { role: "user", content: "修一下这个失败的测试" } },
			ctx,
		);
		const startResults = await fakePi.emit(
			"before_agent_start",
			{ prompt: "修一下这个失败的测试", systemPrompt: "BASE" },
			ctx,
		);
		// Guidance appended to the system prompt
		const augmented = startResults.find((r): r is { systemPrompt: string } =>
			Boolean(r && typeof r === "object" && "systemPrompt" in (r as object)),
		);
		expect(augmented?.systemPrompt).toContain("BASE");
		expect(augmented?.systemPrompt).toContain("<workflow_guidance>");
		expect(augmented?.systemPrompt).toContain("l2-fix-failing-test");
		expect(runtime.getActiveWorkflowId()).toBe("l2-fix-failing-test");

		await fakePi.emit("tool_execution_start", { toolCallId: "c1", toolName: "bash", args: {} }, ctx);
		await fakePi.emit("tool_execution_end", toolPayload("c1", "bash", "(no output, exit 1)", true), ctx);
		await drain(runtime); // retry-hint issued
		expect(fakePi.sentMessages).toHaveLength(1);
		expect(messageText(fakePi.sentMessages[0])).toContain("检查点未通过");

		await fakePi.emit("tool_execution_start", { toolCallId: "c2", toolName: "bash", args: {} }, ctx);
		await fakePi.emit("tool_execution_end", toolPayload("c2", "bash", "(no output, exit 1)", true), ctx);
		await drain(runtime); // escape issued
		expect(fakePi.sentMessages).toHaveLength(2);
		const escapeMsg = messageText(fakePi.sentMessages[1]);
		expect(escapeMsg).toContain("放弃该工作流");
		expect(fakePi.sentMessages.every((m) => m.options?.deliverAs === "steer")).toBe(true);

		await fakePi.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await fakePi.emit("agent_settled", {}, ctx);
		await drain(runtime);
		await fakePi.emit("session_shutdown", {}, ctx);

		// Journal: workflowRef + failure record + distill patch
		const taskDir = taskDirOf(join(root, "journals"), "--G--try-agent-demo--", "task-e2e");
		const result = readTask(taskDir);
		expect(result.turns[0].toolCalls.every((tc) => tc.workflowRef === "l2-fix-failing-test")).toBe(true);
		expect(result.turns[0].intent).toBe("修复失败的测试");
		const failuresFile = join(taskDir, "failures.jl");
		expect(existsSync(failuresFile)).toBe(true);
		const failure = JSON.parse(readFileSync(failuresFile, "utf-8").split("\n")[0]);
		expect(failure.workflowId).toBe("l2-fix-failing-test");
		expect(failure.stepIndex).toBe(0);

		// Evolution: usage bumped at match (+1) and at escape (+1); no evidence bump
		const store = WorkflowStore.load(workflowsRoot);
		const entry = store.getEntry("l2-fix-failing-test")!;
		expect(entry.usage).toBe(2);
		expect(entry.escapes).toBe(1);
		expect(entry.evidence).toBe(2); // seed value unchanged
	});
});

describe("S1: success path (checkpoints pass → evidence grows)", () => {
	it("advances through checkpoints and strengthens the entry", async () => {
		const { fakePi, runtime, workflowsRoot } = makeRig("success");
		const ctx = makeCtx();
		await fakePi.emit("session_start", {}, ctx);
		await fakePi.emit("message_end", { message: { role: "user", content: "修复这个失败的测试" } }, ctx);
		await fakePi.emit("before_agent_start", { prompt: "修复这个失败的测试", systemPrompt: "BASE" }, ctx);

		await fakePi.emit("tool_execution_start", { toolCallId: "s1", toolName: "bash", args: {} }, ctx);
		await fakePi.emit("tool_execution_end", toolPayload("s1", "bash", "1 failing: AuthLogin"), ctx);
		await drain(runtime); // checkpoint 0 passes → advance steer with next-step detail
		expect(fakePi.sentMessages).toHaveLength(1);
		expect(messageText(fakePi.sentMessages[0])).toContain("l1-locate-symbol");

		// Steps without checkpoints: grep → read → edit (no steer expected)
		for (const [id, tool] of [
			["s2", "grep"],
			["s3", "read"],
			["s4", "edit"],
		] as const) {
			await fakePi.emit("tool_execution_start", { toolCallId: id, toolName: tool, args: {} }, ctx);
			await fakePi.emit("tool_execution_end", toolPayload(id, tool, "ok"), ctx);
			await drain(runtime);
		}
		expect(fakePi.sentMessages).toHaveLength(1);

		// Final verification checkpoint passes → tracker completes (advance with null message)
		await fakePi.emit("tool_execution_start", { toolCallId: "s5", toolName: "bash", args: {} }, ctx);
		await fakePi.emit("tool_execution_end", toolPayload("s5", "bash", "all passing"), ctx);
		await drain(runtime);

		await fakePi.emit("turn_end", { message: { role: "assistant", stopReason: "stop" } }, ctx);
		await fakePi.emit("agent_settled", {}, ctx);
		await drain(runtime);
		await fakePi.emit("session_shutdown", {}, ctx);

		const store = WorkflowStore.load(workflowsRoot);
		const entry = store.getEntry("l2-fix-failing-test")!;
		expect(entry.usage).toBe(1);
		expect(entry.escapes).toBe(0);
		expect(entry.evidence).toBe(3); // seed 2 + 1 for guided completion
	});
});
