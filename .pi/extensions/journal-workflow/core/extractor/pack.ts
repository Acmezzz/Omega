/**
 * Packing: LLM-assisted semantic labeling over programmatic candidates.
 * The LLM never decides boundaries or counts — it names intents and judges
 * similarity against the existing registry.
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { RegistryEntry } from "../library/types.ts";

export const PROPOSE_SYSTEM_PROMPT = `You convert successful task logs into a reusable workflow draft.
Rules:
- Only use tools and facts present in the input; do not invent steps.
- Each step: short intent + the tool used; mark expect ONLY where the logs show a clear success criterion.
Output ONLY JSON:
{"id": "l2-kebab-case-id", "intent": "一句话任务族描述", "steps": [{"intent": "...", "tool": "...", "expect": string|null}]}`;

export const PROPOSE_L1_SYSTEM_PROMPT = `You name a reusable tool-combo template from recurring tool sequences.
Rules: derive the intent from the example tasks only; keep argsTemplate as a generic placeholder description.
Output ONLY JSON:
{"id": "l1-kebab-case-id", "intent": "一句话模板用途", "calls": [{"tool": "...", "argsTemplate": "..."}], "expect": string|null}`;

export const JUDGE_SYSTEM_PROMPT = `You judge whether a new workflow/template candidate is semantically the same as an existing registry entry (same task family / same tool purpose).
Output ONLY JSON: {"similarTo": "<existing id>"} or {"similarTo": null}`;

export const ALTERNATIVE_SYSTEM_PROMPT = `A workflow step failed and the agent later solved the task in free mode. Propose which library entity (or free mode) should be tried first when this step fails again.
Output ONLY JSON: {"alternative": "<l1-/l2- id or \\"free\\">", "note": "一句话依据"}`;

export interface TaskSummaryForProposal {
	taskId: string;
	outcome: string;
	turns: Array<{
		seq: number;
		intent: string | null;
		relation: string | null;
		outcome: string;
		tools: string[];
	}>;
}

export interface ProposedL2 {
	id: string;
	intent: string;
	steps: Array<{ intent: string; tool: string; expect: string | null }>;
}

export interface ProposedL1 {
	id: string;
	intent: string;
	calls: Array<{ tool: string; argsTemplate: string }>;
	expect: string | null;
}

export async function proposeWorkflow(summaries: TaskSummaryForProposal[], llm: LlmClient): Promise<ProposedL2 | null> {
	try {
		const text = await llm.complete({
			systemPrompt: PROPOSE_SYSTEM_PROMPT,
			userPayload: JSON.stringify({ tasks: summaries }),
			maxTokens: 800,
		});
		const parsed = parseJsonLoose(text);
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.id !== "string" || typeof obj.intent !== "string" || !Array.isArray(obj.steps)) return null;
		const steps = (obj.steps as Array<Record<string, unknown>>)
			.filter((s) => s && typeof s.intent === "string" && typeof s.tool === "string")
			.map((s) => ({
				intent: s.intent as string,
				tool: s.tool as string,
				expect: typeof s.expect === "string" ? s.expect : null,
			}));
		if (steps.length === 0) return null;
		return { id: obj.id, intent: obj.intent, steps };
	} catch {
		return null;
	}
}

export async function proposeL1(
	pattern: { tools: string[]; count: number },
	exampleTasks: string[],
	llm: LlmClient,
): Promise<ProposedL1 | null> {
	try {
		const text = await llm.complete({
			systemPrompt: PROPOSE_L1_SYSTEM_PROMPT,
			userPayload: JSON.stringify({ recurringTools: pattern.tools, seenInTasks: pattern.count, exampleTasks }),
			maxTokens: 400,
		});
		const parsed = parseJsonLoose(text);
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.id !== "string" || typeof obj.intent !== "string" || !Array.isArray(obj.calls)) return null;
		const calls = (obj.calls as Array<Record<string, unknown>>)
			.filter((c) => c && typeof c.tool === "string" && typeof c.argsTemplate === "string")
			.map((c) => ({ tool: c.tool as string, argsTemplate: c.argsTemplate as string }));
		if (calls.length === 0) return null;
		return {
			id: obj.id,
			intent: obj.intent,
			calls,
			expect: typeof obj.expect === "string" ? obj.expect : null,
		};
	} catch {
		return null;
	}
}

export async function judgeSimilarity(
	candidateIntent: string,
	registry: RegistryEntry[],
	llm: LlmClient,
): Promise<string | null> {
	if (registry.length === 0) return null;
	try {
		const text = await llm.complete({
			systemPrompt: JUDGE_SYSTEM_PROMPT,
			userPayload: JSON.stringify({
				candidate: candidateIntent,
				registry: registry.map((e) => ({ id: e.id, intent: e.intent, level: e.level })),
			}),
			maxTokens: 100,
		});
		const parsed = parseJsonLoose(text);
		if (!parsed || typeof parsed !== "object") return null;
		const similarTo = (parsed as Record<string, unknown>).similarTo;
		if (typeof similarTo !== "string") return null;
		return registry.some((e) => e.id === similarTo) ? similarTo : null;
	} catch {
		return null;
	}
}

export async function proposeAlternative(
	failure: { workflowId: string; stepIndex: number; expect: string; escapeReason: string },
	recoveryTools: string[],
	registry: RegistryEntry[],
	llm: LlmClient,
): Promise<{ alternative: string; note: string } | null> {
	try {
		const text = await llm.complete({
			systemPrompt: ALTERNATIVE_SYSTEM_PROMPT,
			userPayload: JSON.stringify({
				failure,
				recoveryPathTools: recoveryTools,
				registry: registry.map((e) => ({ id: e.id, intent: e.intent, level: e.level })),
			}),
			maxTokens: 200,
		});
		const parsed = parseJsonLoose(text);
		if (!parsed || typeof parsed !== "object") return null;
		const obj = parsed as Record<string, unknown>;
		if (typeof obj.alternative !== "string") return null;
		const known = obj.alternative === "free" || registry.some((e) => e.id === obj.alternative);
		if (!known) return null;
		return { alternative: obj.alternative, note: typeof obj.note === "string" ? obj.note : "" };
	} catch {
		return null;
	}
}
