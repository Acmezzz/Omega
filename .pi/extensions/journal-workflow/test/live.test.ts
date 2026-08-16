/**
 * Optional live-mode tests: exercise the REAL prompts (distill / match /
 * validate) against a real model to eyeball output quality.
 * Skipped unless PI_JW_LIVE=1. Model selection:
 *   PI_JW_MODEL="anthropic/claude-haiku-4-5" (provider/model id)
 * Credentials come from the environment (e.g. ANTHROPIC_API_KEY) via
 * pi-ai's automatic auth resolution.
 * Run: PI_JW_LIVE=1 PI_JW_MODEL=... npx vitest run -t live
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { LlmClient } from "../core/llm.ts";
import { distillTurn, buildUserPayload } from "../core/journal/distill.ts";
import { matchWorkflow } from "../core/engine/matcher.ts";
import { checkExpect } from "../core/engine/validator.ts";
import { WorkflowStore } from "../core/library/store.ts";
import type { TurnRecord } from "../core/journal/types.ts";

const live = process.env.PI_JW_LIVE === "1";
const fixturesDir = fileURLToPath(new URL("../fixtures", import.meta.url));

async function makeLiveLlm(): Promise<LlmClient> {
	const ref = process.env.PI_JW_MODEL ?? "anthropic/claude-haiku-4-5";
	const [provider, modelId] = ref.split("/");
	const models = builtinModels();
	const model = models.getModel(provider ?? "anthropic", modelId ?? "");
	if (!model) throw new Error(`live: model not found: ${ref}`);
	return {
		async complete(input) {
			const result = await models.completeSimple(model, {
				systemPrompt: input.systemPrompt,
				messages: [{ role: "user", content: input.userPayload, timestamp: Date.now() }],
			});
			const text = (result.content ?? [])
				.filter((c): c is { type: "text"; text: string } => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			return text;
		},
	};
}

function sampleTurn(): TurnRecord {
	return {
		seq: 1,
		userEntryId: null,
		assistantEntryId: null,
		userInput: "修复登录崩溃：npm test 报错",
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
				resultRaw: "1 failing: AuthLogin crashes on empty password",
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
				resultRaw: "export function login(u, p) { if (!p) throw",
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

describe.skipIf(!live)("live: real-model prompt quality", () => {
	it("live distill produces a full patch", async () => {
		const llm = await makeLiveLlm();
		const turn = sampleTurn();
		const patch = await distillTurn(turn, null, llm);
		expect(patch).not.toBeNull();
		const outDir = join(fixturesDir, "live-output");
		mkdirSync(outDir, { recursive: true });
		writeFileSync(
			join(outDir, "distill-sample.json"),
			`${JSON.stringify({ payload: JSON.parse(buildUserPayload(turn, null)), patch }, null, "\t")}\n`,
		);
	});

	it("live match selects the seed workflow", async () => {
		const llm = await makeLiveLlm();
		const store = WorkflowStore.load(join(fixturesDir, "workflows", "seed"));
		const hit = await matchWorkflow("修复一个失败的测试", store.getRegistry(), llm);
		expect(hit?.id).toBe("l2-fix-failing-test");
	});

	it("live validator judges both directions", async () => {
		const llm = await makeLiveLlm();
		const pass = await checkExpect("得到明确的失败信息（断言差异或堆栈）", "1 failing: AuthLogin crashes on empty password", llm);
		const fail = await checkExpect("得到明确的失败信息（断言差异或堆栈）", "(no output, exit 1)", llm);
		expect(pass?.satisfied).toBe(true);
		expect(fail?.satisfied).toBe(false);
	});
});

void tmpdir;
