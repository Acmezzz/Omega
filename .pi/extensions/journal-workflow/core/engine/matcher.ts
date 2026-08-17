/**
 * Workflow matching: functional catalog routing followed by bounded entry matching.
 * The catalog is an index; workflow entities are loaded only after an entry wins.
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { CatalogFeature, RegistryEntry } from "../library/types.ts";

export const MAX_MATCH_CANDIDATES = 12;

export const FEATURE_MATCH_SYSTEM_PROMPT = `You route a user task to one or more functional catalog features.
The catalog groups what workflows do (for example web research, document synthesis, code navigation, testing, or deployment); it is not an L1/L2/L3 hierarchy.
Choose only relevant feature IDs. If none apply, output an empty list.
Output ONLY JSON: {"featureIds":["feature-id"]}`;

export const MATCH_SYSTEM_PROMPT = `You select a workflow-library entry for a user task, or none.
L1 is a fine-grained, general atomic tool combination; L2 is a reusable medium-grained workflow with checkpoints and retries; L3 is a coarse-grained multi-phase orchestration.
These levels describe execution granularity, not functional category. Pick the smallest level that fully covers the task, while respecting exclusions; do not choose a smaller entry that cannot cover the whole task.
Output ONLY JSON: {"id": "<entry id>"} or {"id": null}`;

/** Pure candidate filter: active status, exclusion cues, ordering and a hard budget. */
export function filterCandidates(
	registry: RegistryEntry[],
	taskText: string,
	allowedEntryIds?: Set<string>,
): RegistryEntry[] {
	if (taskText.trim().startsWith("/")) return [];
	return registry
		.filter((e) => e.status === "active")
		.filter((e) => !allowedEntryIds || allowedEntryIds.has(e.id))
		.filter((e) => !(e.excludes ?? []).some((x) => taskText.includes(x)))
		.sort((a, b) => a.level - b.level || b.evidence - a.evidence)
		.slice(0, MAX_MATCH_CANDIDATES);
}

export function buildFeaturePayload(taskText: string, features: CatalogFeature[]): string {
	return JSON.stringify({
		task: taskText,
		features: features.map((feature) => ({
			id: feature.id,
			label: feature.label,
			description: feature.description,
			aliases: feature.aliases,
		})),
	}, null, 1);
}

export function buildMatchPayload(taskText: string, candidates: RegistryEntry[]): string {
	return JSON.stringify(
		{
			task: taskText,
			entries: candidates.map((c) => ({ id: c.id, level: c.level, intent: c.intent, excludes: c.excludes ?? [] })),
		},
		null,
		1,
	);
}

export interface MatchCache {
	get(key: string): RegistryEntry | null | undefined;
	set(key: string, value: RegistryEntry | null): void;
}

export async function matchFeatures(taskText: string, features: CatalogFeature[], llm: LlmClient): Promise<string[]> {
	if (features.length === 0 || taskText.trim().startsWith("/")) return [];
	try {
		const text = await llm.complete({
			systemPrompt: FEATURE_MATCH_SYSTEM_PROMPT,
			userPayload: buildFeaturePayload(taskText, features),
			maxTokens: 120,
		});
		const parsed = parseJsonLoose(text);
		const ids = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).featureIds : undefined;
		if (!Array.isArray(ids)) return [];
		const known = new Set(features.map((feature) => feature.id));
		return ids.filter((id): id is string => typeof id === "string" && known.has(id));
	} catch {
		return [];
	}
}

export async function matchWorkflow(
	taskText: string,
	registry: RegistryEntry[],
	llm: LlmClient,
	cache?: MatchCache,
	catalog?: CatalogFeature[],
): Promise<RegistryEntry | null> {
	let allowedEntryIds: Set<string> | undefined;
	if (catalog && catalog.length > 0) {
		const featureIds = await matchFeatures(taskText, catalog, llm);
		if (featureIds.length > 0) {
			const selected = new Set(featureIds);
			const ids = catalog.flatMap((feature) => selected.has(feature.id) ? feature.entryIds : []);
			if (ids.length > 0) allowedEntryIds = new Set(ids);
		}
	}
	let candidates = filterCandidates(registry, taskText, allowedEntryIds);
	if (candidates.length === 0 && allowedEntryIds) {
		candidates = filterCandidates(registry, taskText);
	}
	if (candidates.length === 0) return null;
	const cacheKey = candidates.map((c) => `${c.id}:${c.level}`).join("|") + "::" + taskText;
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
