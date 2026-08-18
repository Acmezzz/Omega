/** Scout roles are soft search-order preferences, never source/tool restrictions. */
import type { ExplorationAngle, ScoutBias, ScoutSearchPolicy } from "./types.ts";

export type ScoutContextExposure = "blind" | "focus" | "prior";

export interface ScoutRole {
	id: ExplorationAngle;
	bias: ScoutBias;
	searchPolicy: ScoutSearchPolicy;
	contextExposure: ScoutContextExposure;
	preference: string;
}

const COMMON_SOFT_CONTRACT = "这只是搜索起点偏好，不是边界；随证据改变，可被反驳，不限制目录、工具、信息源或结论。";

export const DEFAULT_SCOUT_ROLES: ScoutRole[] = [
	{
		id: "independent",
		bias: "none",
		searchPolicy: "broad-read-only",
		contextExposure: "blind",
		preference: `从任务目标和仓库事实自由选择搜索起点，不接收 prior 或 focus。${COMMON_SOFT_CONTRACT}`,
	},
	{
		id: "prior-first",
		bias: "soft",
		searchPolicy: "broad-read-only",
		contextExposure: "prior",
		preference: `先检查可选先验及其适用条件；如果不匹配、缺失或被事实否定，立即从仓库和任务本身从零探索。${COMMON_SOFT_CONTRACT}`,
	},
	{
		id: "evidence-first",
		bias: "soft",
		searchPolicy: "broad-read-only",
		contextExposure: "focus",
		preference: `优先从代码、测试、配置和调用关系寻找直接证据，但仍可查看工作区内其他相关文件。${COMMON_SOFT_CONTRACT}`,
	},
	{
		id: "alternative-first",
		bias: "soft",
		searchPolicy: "broad-read-only",
		contextExposure: "blind",
		preference: `优先尝试不同的问题分解和证据路径；没有依据时回到任务和仓库事实自由搜索。${COMMON_SOFT_CONTRACT}`,
	},
	{
		id: "counterexample-first",
		bias: "soft",
		searchPolicy: "broad-read-only",
		contextExposure: "blind",
		preference: `优先寻找前置条件、反例和兼容性风险，同时提出独立的可能方向。${COMMON_SOFT_CONTRACT}`,
	},
];

export function selectScoutRoles(maxScouts: number, includeCounterexample = false, rotationSeed = 0): ScoutRole[] {
	const limit = Math.max(0, Math.floor(maxScouts));
	if (limit === 0) return [];
	const independent = DEFAULT_SCOUT_ROLES[0];
	const others = DEFAULT_SCOUT_ROLES.slice(1);
	const rotation = ((Math.floor(rotationSeed) % others.length) + others.length) % others.length;
	const rotated = [...others.slice(rotation), ...others.slice(0, rotation)];
	if (includeCounterexample && limit > 1) {
		const counterexample = DEFAULT_SCOUT_ROLES.find((role) => role.id === "counterexample-first")!;
		return [independent, counterexample, ...rotated.filter((role) => role.id !== counterexample.id)].slice(0, limit);
	}
	return [independent, ...rotated].slice(0, limit);
}
