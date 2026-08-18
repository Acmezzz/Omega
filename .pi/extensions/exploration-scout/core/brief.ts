/** Validation and normalization for the main agent's neutral TaskBrief. */
import type { TaskBrief } from "./types.ts";

const SOLUTION_FIELD_RE = /(?:方案|建议|应该|推荐|解决方案|\bimplement\b|\bfix\s+by\b|\buse\s+.+\s+to\b)/i;

export interface BriefValidation {
	valid: boolean;
	reasons: string[];
	brief: TaskBrief | null;
}

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
}

function facts(value: unknown): Array<{ fact: string; source: string }> {
	if (!Array.isArray(value)) return [];
	return value
		.filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
		.map((item) => ({ fact: typeof item.fact === "string" ? item.fact.trim() : "", source: typeof item.source === "string" ? item.source.trim() : "" }))
		.filter((item) => item.fact.length > 0 && item.source.length > 0);
}

export function normalizeTaskBrief(input: unknown): TaskBrief | null {
	if (!input || typeof input !== "object") return null;
	const value = input as Record<string, unknown>;
	if (typeof value.rawUserInput !== "string" || typeof value.objective !== "string" || typeof value.deliverable !== "string") {
		return null;
	}
	return {
		rawUserInput: value.rawUserInput,
		objective: value.objective,
		deliverable: value.deliverable,
		acceptanceCriteria: strings(value.acceptanceCriteria),
		constraints: strings(value.constraints),
		knownFacts: facts(value.knownFacts),
		unknowns: strings(value.unknowns),
		relevantPaths: strings(value.relevantPaths),
		forbiddenAssumptions: strings(value.forbiddenAssumptions),
	};
}

export function validateTaskBrief(input: unknown): BriefValidation {
	const brief = normalizeTaskBrief(input);
	if (!brief) return { valid: false, reasons: ["TaskBrief 必须包含 rawUserInput、objective 和 deliverable 字符串"], brief: null };
	const reasons: string[] = [];
	if (brief.objective.trim().length < 3) reasons.push("objective 太短");
	if (brief.deliverable.trim().length < 2) reasons.push("deliverable 太短");
	for (const field of [
		brief.rawUserInput,
		brief.objective,
		brief.deliverable,
		...brief.acceptanceCriteria,
		...brief.constraints,
		...brief.knownFacts.flatMap((fact) => [fact.fact, fact.source]),
		...brief.unknowns,
		...brief.relevantPaths,
		...brief.forbiddenAssumptions,
	]) {
		if (SOLUTION_FIELD_RE.test(field)) {
			reasons.push("TaskBrief 包含疑似方案性语言，应只描述目标、事实和未知");
			break;
		}
	}
	return { valid: reasons.length === 0, reasons, brief };
}

export function renderTaskBrief(brief: TaskBrief): string {
	return JSON.stringify(brief, null, 2);
}
