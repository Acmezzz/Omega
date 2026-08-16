/** Scout roles are soft search-order preferences, never source/tool restrictions. */
import type { ExplorationAngle } from "./types.ts"

export interface ScoutRole {
	id: ExplorationAngle;
	preference: string;
}

export const DEFAULT_SCOUT_ROLES: ScoutRole[] = [
	{
		id: "prior-first",
		preference: "先检查可选的历史工作流先验及其适用条件；如果不匹配、缺失或被事实否定，立即从仓库和任务本身从零探索。",
	},
	{
		id: "evidence-first",
		preference: "优先从代码、测试、错误、配置和调用关系寻找直接证据，但仍可查看文档、历史、工作流和其他相关来源。",
	},
	{
		id: "alternative-first",
		preference: "优先尝试不同的问题分解、证据来源或工具路径；如果替代方向没有依据，可以回到任何相关先验或通用搜索。",
	},
	{
		id: "counterexample-first",
		preference: "优先寻找候选方向的前置条件、反例和兼容性风险，同时提出自己的独立方案。",
	},
];

export function selectScoutRoles(maxScouts: number, includeCounterexample = false): ScoutRole[] {
	const roles = includeCounterexample ? DEFAULT_SCOUT_ROLES : DEFAULT_SCOUT_ROLES.slice(0, 3);
	return roles.slice(0, Math.max(0, maxScouts));
}
