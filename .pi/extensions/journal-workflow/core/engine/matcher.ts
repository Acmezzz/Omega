/**
 * Workflow matching: flat-registry candidate filtering (pure) + one small LLM
 * classification call. "Minimal sufficient unit": candidates are ordered
 * level-ascending so the smallest covering entry wins ties.
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { RegistryEntry } from "../library/types.ts";

export const MATCH_SYSTEM_PROMPT = `You select a workflow-library entry for a user task, or none.
Pick the entry whose intent best covers the task, respecting its exclusions. Prefer the smallest entry that fully covers the task.
Output ONLY JSON: {"id": "<entry id>"} or {"id": null}`;

/** Pure candidate filter: active status, exclusion cues, ordering. */
export function filterCandidates(registry: RegistryEntry[], taskText: string): RegistryEntry[] {
	if (taskText.trim().startsWith("/")) return [];
	return registry
		.filter((e) => e.status === "active")
		.filter((e) => !(e.excludes ?? []).some((x) => taskText.includes(x)))
		.sort((a, b) => a.level - b.level || b.evidence - a.evidence);
}

export function buildMatchPayload(taskText: string, candidates: RegistryEntry[]): string {
	return JSON.stringify(
		{
			task: taskText,
			entries: candidates.map((c) => ({ id: c.id, intent: c.intent, excludes: c.excludes ?? [] })),
		},
		null,
		1,
	);
}

export interface MatchCache {
	get(key: string): RegistryEntry | null | undefined;
	set(key: string, value: RegistryEntry | null): void;
}

export async function matchWorkflow(
	taskText: string,
	registry: RegistryEntry[],
	llm: LlmClient,
	cache?: MatchCache,
): Promise<RegistryEntry | null> {
	const candidates = filterCandidates(registry, taskText);
	if (candidates.length === 0) return null;
	const cacheKey = candidates.map((c) => c.id).join("|") + "::" + taskText;
	if (cache) {
		const cached = cache.get(cacheKey);
		if (cached !== undefined) return cached;
	}
	try {
		const text = await llm.complete({
			systemPrompt: MATCH_SYSTEM_PROMPT,
			userPayload: buildMatchPayload(taskText, candidates),
			maxTokens: 100,
		});
		const parsed = parseJsonLoose(text);
		const id = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).id : undefined;
		const hit = typeof id === "string" ? candidates.find((c) => c.id === id) : undefined;
		const result = hit ?? null;
		cache?.set(cacheKey, result);
		return result;
	} catch {
		return null;
	}
}
