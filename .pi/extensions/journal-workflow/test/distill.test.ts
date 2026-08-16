/**
 * D1/D2: distillation parsing, tolerance, and adapter integration.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { readTask, taskDirOf } from "../core/journal/writer.ts";
import { distillTurn, parseDistillPatch, buildUserPayload, distillMaxTokens } from "../core/journal/distill.ts";
import type { TurnRecord } from "../core/journal/types.ts";
import { FakePi } from "./helpers/fake-pi.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";
import { loadFixture, replayEvents } from "./helpers/replay.ts";

const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));
let root: string;

beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "jw-distill-"));
});

afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

function sampleTurn(): TurnRecord {
	return {
		seq: 1,
		userEntryId: null,
		assistantEntryId: null,
		userInput: "修复登录崩溃",
		assistantTextRaw: null,
		intent: null,
		taskEssence: null,
		deliverable: null,
		relation: null,
		plan: null,
		toolCalls: [
			{
				tool: "bash",
				argsRaw: '{"command":"npm test"}',
				argsSummary: null,
				intent: null,
				reasoningRaw: null,
				status: "error",
				resultRaw: "1 failing AuthLogin crashes",
				resultSummary: null,
				significance: null,
				followUp: null,
				workflowRef: null,
				refSequence: 1,
			},
			{
				tool: "grep",
				argsRaw: '{"pattern":"login"}',
				argsSummary: null,
				intent: null,
				reasoningRaw: null,
				status: "success",
				resultRaw: "src/auth/login.ts:42",
				resultSummary: null,
				significance: null,
				followUp: null,
				workflowRef: null,
				refSequence: 2,
			},
			{
				tool: "read",
				argsRaw: '{"path":"src/auth/login.ts"}',
				argsSummary: null,
				intent: null,
				reasoningRaw: null,
				status: "success",
				resultRaw: "export function login(u, p) {",
				resultSummary: null,
				significance: null,
				followUp: null,
				workflowRef: null,
				refSequence: 3,
			},
		],
		skills: [],
		outcome: "completed",
		unfinished: [],
		errorSummary: null,
	};
}

describe("D1: distillation parsing", () => {
	it("parses a well-formed reply into a full patch", async () => {
		const good = readFileSync(join(fixturesDir, "llm-responses", "distill-good.json"), "utf-8");
		const llm = new FakeLlm([good]);
		const patch = await distillTurn(sampleTurn(), null, llm);
		expect(patch).not.toBeNull();
		expect(patch!.intent).toBe("修复登录测试失败");
		expect(patch!.taskEssence).toBe("缺陷复现 + 定位 + 修复 + 回归验证");
		expect(patch!.deliverable).toBe("通过测试的登录代码修复");
		expect(patch!.relation).toBe("new");
		expect(patch!.toolPatches).toHaveLength(3);
		expect(patch!.toolPatches[0].resultSummary).toContain("空密码");
		expect(patch!.toolPatches[0].intent).toContain("复现");
		expect(patch!.toolPatches[0].significance).toBe("essential");
		expect(llm.callCount).toBe(1);
	});

	it("per-tool reasoning reaches the distill payload alongside the prose reply", () => {
		const turn = sampleTurn();
		turn.toolCalls[1].reasoningRaw = "用 grep 而非 find：已知符号名未知文件名。";
		turn.toolCalls[2].reasoningRaw = "失败原因是依赖版本冲突，改读入口文件确认导入链。";
		turn.assistantTextRaw = "已定位到 src/auth/login.ts 的空密码问题，下一步补校验。";
		const payload = JSON.parse(buildUserPayload(turn, null));
		expect(payload.toolCalls[1].reasoning).toContain("而非 find");
		expect(payload.toolCalls[2].reasoning).toContain("依赖版本冲突");
		expect(payload.assistantText).toContain("空密码问题");
	});

	it("tolerates fenced / prose-wrapped JSON", () => {
		const good = readFileSync(join(fixturesDir, "llm-responses", "distill-good.json"), "utf-8");
		const fenced = `Here is the patch:\n\`\`\`json\n${good}\n\`\`\``;
		const parsed = parseDistillPatch(fenced, sampleTurn());
		expect(parsed).not.toBeNull();
		expect(parsed!.intent).toBe("修复登录测试失败");
	});

	it("payload includes previous-turn context for relation classification", () => {
		const payload = JSON.parse(buildUserPayload(sampleTurn(), { intent: "修登录", relation: "new", unfinished: ["验证修复"] }));
		expect(payload.previousTurn.intent).toBe("修登录");
		expect(payload.previousTurn.unfinished).toContain("验证修复");
		expect(payload.toolCalls).toHaveLength(3);
	});
});

describe("D2: distillation tolerance", () => {
	it("returns null after two unusable replies (no throw)", async () => {
		const llm = new FakeLlm(["这不是 JSON", "还是不合法的输出"]);
		const patch = await distillTurn(sampleTurn(), null, llm);
		expect(patch).toBeNull();
		expect(llm.callCount).toBe(2);
	});

	it("partial coverage: strict rejects, lenient retry accepts (missing items stay null)", async () => {
		const partial = JSON.stringify({
			intent: "x",
			relation: "new",
			plan: null,
			toolPatches: [{ refSequence: 1, argsSummary: "a", resultSummary: "b", followUp: null }],
			unfinished: [],
			errorSummary: null,
		});
		const llm = new FakeLlm([partial, partial]);
		const patch = await distillTurn(sampleTurn(), null, llm);
		expect(patch).not.toBeNull(); // lenient pass
		expect(llm.callCount).toBe(2);
		expect(patch!.toolPatches).toHaveLength(1); // uncovered calls keep null in the fact layer
	});

	it("maxTokens scales with tool-call count (long turns are not truncated)", () => {
		const big = sampleTurn();
		big.toolCalls = Array.from({ length: 17 }, (_, i) => ({
			...big.toolCalls[0],
			refSequence: i + 1,
		}));
		expect(distillMaxTokens(big)).toBe(800 + 17 * 150); // 3350
	});

	it("retries once after a thrown error, then gives up", async () => {
		const llm = new FakeLlm([new Error("network"), new Error("network")]);
		const patch = await distillTurn(sampleTurn(), null, llm);
		expect(patch).toBeNull();
		expect(llm.callCount).toBe(2);
	});
});

describe("adapter integration: settled turn gets a patch line", () => {
	it("replays events with a good fake llm and produces a patched journal", async () => {
		const good = readFileSync(join(fixturesDir, "llm-responses", "distill-good.json"), "utf-8");
		const llm = new FakeLlm([good]);
		const fakePi = new FakePi();
		const runtime = wire(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, journalsRoot: root, workflowsRoot: join(root, "wf") },
			llm,
		});
		await replayEvents(fakePi, loadFixture(join(fixturesDir, "events", "single-turn-3tools.json")));
		await Promise.all(runtime.getPendingDistills());
		const result = readTask(taskDirOf(root, "--G--try-agent-demo--", "task-demo-001"));
		expect(result.turns[0].intent).toBe("修复登录测试失败");
		expect(result.turns[0].toolCalls[0].resultSummary).toContain("空密码");
		expect(result.turns[0].extractedAt).toBeTruthy();
	});

	it("distill failure leaves the fact line untouched (stays pending)", async () => {
		const llm = new FakeLlm(["垃圾输出", "垃圾输出"]);
		const fakePi = new FakePi();
		const runtime = wire(fakePi as unknown as ExtensionAPI, {
			config: { enabled: true, journalsRoot: root, workflowsRoot: join(root, "wf") },
			llm,
		});
		await replayEvents(fakePi, loadFixture(join(fixturesDir, "events", "two-turn-retry.json")));
		await Promise.all(runtime.getPendingDistills());
		const result = readTask(taskDirOf(root, "--G--try-agent-demo--", "task-demo-002"));
		expect(result.turns).toHaveLength(2);
		expect(result.turns.every((t) => t.intent === null)).toBe(true);
		expect(result.turns.every((t) => t.extractedAt === undefined)).toBe(true);
	});
});
