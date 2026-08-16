/**
 * Checkpoint validation: one small LLM call judging whether an actual tool
 * result satisfies the step's expect description. 宁松勿紧: parse failures
 * return null, which the tracker treats as a pass.
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { CheckpointOutcome } from "./tracker.ts";

export const VALIDATE_SYSTEM_PROMPT = `You judge whether a tool result satisfies an expected-outcome description from a workflow checkpoint.
Be lenient: only report "satisfied: false" when the result clearly contradicts the expectation. When unsure, return true.
Output ONLY JSON: {"satisfied": boolean, "reason": string}`;

export async function checkExpect(
	expect: string,
	resultText: string,
	llm: LlmClient,
	resultLimit = 1000,
): Promise<CheckpointOutcome | null> {
	const truncated = resultText.length > resultLimit ? `${resultText.slice(0, resultLimit)}…` : resultText;
	try {
		const text = await llm.complete({
			systemPrompt: VALIDATE_SYSTEM_PROMPT,
			userPayload: JSON.stringify({ expect, result: truncated }),
			maxTokens: 300,
		});
		const parsed = parseJsonLoose(text);
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.satisfied !== "boolean") return null;
		return { satisfied: obj.satisfied, reason: typeof obj.reason === "string" ? obj.reason : "" };
	} catch {
		return null;
	}
}
