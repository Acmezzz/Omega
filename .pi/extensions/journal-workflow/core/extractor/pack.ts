/**
 * Packing: single-pass LLM synthesis of the workflow library from the memory
 * log. The LLM reads the distilled memory records and emits three granularities
 * (L3 complete orchestration, L2 workflow, L1 atomic ops), each assigned to a
 * functional feature. Unlike the old frequency-mining approach, the LLM judges
 * value itself: it keeps useful operations and drops failed / non-advancing ones
 * based on the memory log's distilled significance and failure analysis.
 *
 * The LLM never touches files or the registry; it returns a structured proposal
 * that extract.ts persists idempotently (evidence ledger + manifest watermark).
 */
import type { LlmClient } from "../llm.ts";
import { parseJsonLoose } from "../llm.ts";
import type { MemoryRecord } from "../memory/types.ts";
import type { L1Template, L2Workflow, WorkStrategy } from "../library/types.ts";

export const SYNTHESIZE_SYSTEM_PROMPT = `You distill a reusable workflow library from memory-log records.
The memory log is a faithful timeline of real tool calls (successes AND failures) with distilled results and failure analysis.
Your job: produce structured workflows, a functional catalog, AND reusable code assets.

Three levels (execution granularity, not category):
- L3 WorkStrategy 完整任务方案: a full-task solution PLAN — how to think about and approach a whole concrete task (reasoning), things to watch out for (caveats), and which L2/L1 workflows to run (steps, advisory). It is macro guidance, not a phase executor.
- L2 工作流: a medium-grained reusable workflow with checkpoints/retries, a reusable slice of a task.
- L1 原子操作: a fine-grained atomic tool-combination template.

Code assets:
- When the log shows the model wrote a self-contained, reusable script/code snippet to accomplish a step, extract it as a "codeAssets" entry. This makes previously-thrown-away code a reusable asset.
- In an L2 step (or L1 call) that runs such a snippet, use {"tool":"run_code","argsTemplate":"{codeAsset:<id>}"}. The model will read the asset and run it via bash; you do not need a real tool.

Rules:
- Base everything ONLY on tools/facts present in the input memory log; never invent steps, tools, or code.
- Learn from what worked: include useful operations. Drop calls that are failed-without-information or did not advance the task (significance "wasted"/"neutral"), but DO keep a failed call when the memory log shows a learned recovery or a useful negative result.
- Assign each L3/L2/L1 to one functional feature. A single task can contribute different levels to DIFFERENT features. Prefer generic, reusable workflows over task-specific ones.
- ALIGN WITH EXISTING features first: the input includes "existingFeatures". Reuse an existing feature id (match by id, label, or aliases) whenever a workflow fits one already present. Only create NEW features for workflows that do NOT fit any existing feature. Reusing existing ids keeps the catalog from fragmenting.
- Naming: L2 id = "l2-<kebab>", L1 = "l1-<kebab>", L3 WorkStrategy id = "ws-<kebab>"; keep ids stable so re-extraction merges.
- Code asset id = "asset-<kebab>";
Output ONLY JSON:
{
  "features": [{"id":"feature-...","label":"...","description":"...","aliases":["..."],"levelSemantics":"..."}],
  "codeAssets": [{"id":"asset-...","name":"...","language":"py|js|sh|...","summary":"...","code":"<full source>"}],
  "workflows": [
    {"id":"ws-...","featureId":"feature-...","level":3,"intent":"...","excludes":["..."],
     "reasoning":"...","caveats":["..."],"steps":[{"intent":"...","ref":"l2-...","note":"..."}]},
    {"id":"l2-...","featureId":"feature-...","level":2,"intent":"...","excludes":["..."],
     "steps":[{"intent":"...","action":{"tool":"...","argsTemplate":"..."},"expect":null,"retries":2}]},
    {"id":"l1-...","featureId":"feature-...","level":1,"intent":"...","excludes":["..."],
     "calls":[{"tool":"...","argsTemplate":"..."}],"expect":null,"variants":[]}
  ]
}`;

export interface SynthesizeFeature {
	id: string;
	label: string;
	description: string;
	aliases: string[];
	levelSemantics?: string;
}

export interface SynthesizedCodeAsset {
	id: string;
	name: string;
	language: string;
	summary: string;
	code: string;
}

export type SynthesizedWorkflow =
	| { id: string; featureId: string; level: 1; intent: string; excludes?: string[]; calls: Array<{ tool: string; argsTemplate: string }>; expect?: string | null; variants: string[] }
	| { id: string; featureId: string; level: 2; intent: string; excludes?: string[]; steps: Array<{ intent: string; action?: { tool: string; argsTemplate: string }; expect?: string | null; retries?: number }> }
	| { id: string; featureId: string; level: 3; intent: string; excludes?: string[]; reasoning: string; caveats: string[]; steps: Array<{ intent: string; ref?: string; note?: string }> };

export interface SynthesisResult {
	features: SynthesizeFeature[];
	codeAssets: SynthesizedCodeAsset[];
	workflows: SynthesizedWorkflow[];
}

export function buildMemoryPayload(records: MemoryRecord[], existingFeatures: Array<{ id: string; label: string; aliases: string[] }> = []): string {
	return JSON.stringify(
		{
			existingFeatures,
			memoryRecords: records.map((record) => ({
				seq: record.seq,
				span: [record.spanFromTurnSeq, record.spanToTurnSeq],
				userIntent: record.userIntent,
				thinking: record.thinking,
				memories: record.memories,
				tools: record.tools.map((tool) => ({
					index: tool.index,
					tool: tool.tool,
					status: tool.status,
					args: tool.args,
					resultSummary: tool.resultSummary,
					failureAnalysis: tool.failureAnalysis,
					intent: tool.intent,
					significance: tool.significance,
				})),
			})),
		},
		null,
		1,
	);
}

/** Parse the single-pass synthesis response; null when unusable. */
export function parseSynthesis(text: string): SynthesisResult | null {
	const parsed = parseJsonLoose(text);
	if (!parsed || typeof parsed !== "object") return null;
	const obj = parsed as Record<string, unknown>;
	const safeId = (value: unknown, prefix?: string): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && (!prefix || value.startsWith(`${prefix}-`));
	const features = Array.isArray(obj.features)
		? (obj.features as unknown[])
			.map((item): SynthesizeFeature | null => {
				if (!item || typeof item !== "object") return null;
				const f = item as Record<string, unknown>;
				if (!safeId(f.id, "feature") || typeof f.label !== "string" || typeof f.description !== "string") return null;
				return {
					id: f.id,
					label: f.label,
					description: f.description,
					aliases: Array.isArray(f.aliases) ? f.aliases.filter((x): x is string => typeof x === "string") : [],
					levelSemantics: typeof f.levelSemantics === "string" ? f.levelSemantics : undefined,
				};
			})
			.filter((item): item is SynthesizeFeature => item !== null)
		: [];
	const workflowsRaw = Array.isArray(obj.workflows) ? (obj.workflows as Array<Record<string, unknown>>) : [];
	const workflows: SynthesizedWorkflow[] = [];
	const featureIds = new Set(features.map((f) => f.id));
	for (const w of workflowsRaw) {
		if (!w || typeof w !== "object") continue;
		if (!safeId(w.id) || !safeId(w.featureId, "feature") || typeof w.intent !== "string") continue;
		if (!featureIds.has(w.featureId)) continue; // workflow must belong to a known feature
		const level = typeof w.level === "number" ? w.level : inferLevel(w.id);
		const excludes = Array.isArray(w.excludes) ? w.excludes.filter((x): x is string => typeof x === "string") : undefined;
		if (level === 1 && Array.isArray(w.calls)) {
			workflows.push({
				id: w.id, featureId: w.featureId, level: 1, intent: w.intent, excludes,
				calls: exportCalls(w.calls),
				expect: typeof w.expect === "string" ? w.expect : null,
				variants: Array.isArray(w.variants) ? w.variants.filter((x): x is string => typeof x === "string") : [],
			});
		} else if (level === 2 && Array.isArray(w.steps)) {
			workflows.push({
				id: w.id, featureId: w.featureId, level: 2, intent: w.intent, excludes,
				steps: exportSteps(w.steps),
			});
		} else if (level === 3 && typeof w.reasoning === "string") {
			workflows.push({
				id: w.id, featureId: w.featureId, level: 3, intent: w.intent, excludes,
				reasoning: w.reasoning,
				caveats: Array.isArray(w.caveats) ? w.caveats.filter((x): x is string => typeof x === "string") : [],
				steps: exportWorkStrategySteps(w.steps),
			});
		}
	}
	const codeAssets = Array.isArray(obj.codeAssets)
		? (obj.codeAssets as unknown[])
			.map((item): SynthesizedCodeAsset | null => {
				if (!item || typeof item !== "object") return null;
				const a = item as Record<string, unknown>;
				if (!safeId(a.id, "asset") || typeof a.code !== "string") return null;
				return {
					id: a.id,
					name: typeof a.name === "string" ? a.name : a.id,
					language: typeof a.language === "string" && /^[a-z0-9]+$/.test(a.language) ? a.language : "txt",
					summary: typeof a.summary === "string" ? a.summary : "",
					code: a.code,
				};
			})
			.filter((item): item is SynthesizedCodeAsset => item !== null)
		: [];
	return workflows.length > 0 || codeAssets.length > 0 ? { features, codeAssets, workflows } : null;
}

function inferLevel(id: string): 1 | 2 | 3 {
	if (/^ws-/.test(id) || /^l3-/.test(id)) return 3;
	if (/^l2-/.test(id)) return 2;
	return 1;
}

function exportCalls(calls: unknown): Array<{ tool: string; argsTemplate: string }> {
	if (!Array.isArray(calls)) return [];
	return calls.filter((c): c is { tool: string; argsTemplate: string } =>
			!!c && typeof c === "object" && typeof (c as { tool?: unknown }).tool === "string" && typeof (c as { argsTemplate?: unknown }).argsTemplate === "string")
		.map((c) => ({ tool: (c as { tool: string }).tool, argsTemplate: (c as { argsTemplate: string }).argsTemplate }));
}

function exportSteps(steps: unknown): L2Workflow["steps"] {
	if (!Array.isArray(steps)) return [];
	const out: L2Workflow["steps"] = [];
	for (const raw of steps) {
		if (!raw || typeof raw !== "object") continue;
		const step = raw as Record<string, unknown>;
		if (typeof step.intent !== "string") continue;
		const entry: Exclude<L2Workflow["steps"][number], undefined> = {
			intent: step.intent,
			retries: typeof step.retries === "number" ? step.retries : undefined,
			expect: typeof step.expect === "string" ? step.expect : undefined,
		};
		if (step.action && typeof step.action === "object") {
			const action = step.action as Record<string, unknown>;
			if (typeof action.tool === "string" && typeof action.argsTemplate === "string") {
				entry.action = { tool: action.tool, argsTemplate: action.argsTemplate };
			}
		}
		out.push(entry);
	}
	return out;
}

function exportWorkStrategySteps(steps: unknown): WorkStrategy["steps"] {
	if (!Array.isArray(steps)) return [];
	const out: WorkStrategy["steps"] = [];
	for (const raw of steps) {
		if (!raw || typeof raw !== "object") continue;
		const step = raw as Record<string, unknown>;
		if (typeof step.intent !== "string") continue;
		out.push({
			intent: step.intent,
			ref: typeof step.ref === "string" ? step.ref : undefined,
			note: typeof step.note === "string" ? step.note : undefined,
		});
	}
	return out;
}

export async function synthesizeLibrary(
	records: MemoryRecord[],
	llm: LlmClient,
	existingFeatures: Array<{ id: string; label: string; aliases: string[] }> = [],
): Promise<SynthesisResult | null> {
	if (records.length === 0) return null;
	try {
		const text = await llm.complete({
			systemPrompt: SYNTHESIZE_SYSTEM_PROMPT,
			userPayload: buildMemoryPayload(records, existingFeatures),
			maxTokens: 5000,
		});
		return parseSynthesis(text);
	} catch {
		return null;
	}
}

// ---- WorkStrategy transformer (used by extract.ts) ----
export function workStrategyFrom(entity: SynthesizedWorkflow & { level: 3 }): WorkStrategy {
	return {
		id: entity.id,
		intent: entity.intent,
		excludes: entity.excludes,
		featureId: entity.featureId,
		reasoning: entity.reasoning,
		caveats: entity.caveats,
		steps: entity.steps,
	};
}

export function l2FromSteps(entity: SynthesizedWorkflow & { level: 2 }): L2Workflow {
	return {
		id: entity.id,
		intent: entity.intent,
		excludes: entity.excludes,
		steps: entity.steps.map((s) => ({
			intent: s.intent,
			action: s.action,
			expect: s.expect ?? undefined,
			retries: s.retries,
		})),
	};
}

export function l1FromCalls(entity: SynthesizedWorkflow & { level: 1 }): L1Template {
	return {
		id: entity.id,
		intent: entity.intent,
		excludes: entity.excludes,
		calls: entity.calls,
		expect: entity.expect ?? undefined,
		variants: entity.variants,
	};
}