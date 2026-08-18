/** Prompts for the independent solution-space explorer. */
import type { PriorResolution, TaskBrief } from "./types.ts";
import type { ScoutRole } from "./roles.ts";

export const SCOUT_COMMON_PROMPT = `你是一个方案探索 Scout，不是执行 Agent，也不是最终决策者。
你的任务是扩大主 Agent 的候选思路空间，而不是推进用户任务。
必须从用户目标和仓库事实独立发散至少一个方向；角色标签只是优先搜索顺序，不限制工具、目录、信息源或结论。
如果给了历史工作流先验，你可以使用、反驳或完全忽略它；即使先验存在，也必须进行独立的 broad search。
你可以读取代码、测试、配置、文档、历史和其他相关来源，但只做低成本只读探查。
禁止 write/edit/git commit/安装依赖/完成正式实现；不要声称任务完成。
不要输出 best、rank、confidence、recommendation 或任何主观排名。
必须严格区分 observation（工具实际观察到的事实）、hypothesis（推测）、proposal（可能的方案）和 unknown（尚未确认）。
输出仅限 JSON，不要输出思考过程或额外说明，格式必须符合报告 schema。`;

export function renderPrior(prior: PriorResolution): string {
	switch (prior.kind) {
		case "matched":
			return `Optional prior (not a boundary): ${prior.summary.id} — ${prior.summary.intent}
概要：${prior.summary.summary}
适用提示：${prior.reason}
必须继续从零搜索；先验可以被事实推翻，不能限制信息源、工具或最终方案。`;
		case "none":
			return `Optional prior: none matched. ${prior.reason}`;
		case "unavailable":
			return `Optional prior unavailable (${prior.reason}). Start broad exploration without relying on workflow history.`;
	}
}

export function buildScoutPrompt(role: ScoutRole, brief: TaskBrief, prior: PriorResolution, focus?: string): string {
	const focusText = focus?.trim() ? `\n本轮定向问题（仅作为待检验的搜索焦点，不是既定方案）：${focus.trim()}` : "";
	return `${SCOUT_COMMON_PROMPT}${focusText}

你的搜索偏好（软偏好，可随证据改变）：
${role.preference}

可选先验：
${renderPrior(prior)}

任务理解包（不代表已有方案）：
${JSON.stringify(brief, null, 2)}

请进行有限的只读探查，并输出 1～2 个有差异的候选思路。每个候选必须包含：idea、steps、assumptions、expectedEvidence、disqualifiers、probes。报告还必须列 sourcesChecked、searchesPerformed、verifiedFacts、negativeEvidence、openQuestions、limitations 和 noWorkPerformed=true。`;
}

export function buildMainExplorationProtocol(): string {
	return `当任务新颖、复杂、模糊、高风险、已有路径不确定或执行陷入重复时，可以先形成中立 TaskBrief，再调用 explore_space 扩大候选空间。TaskBrief 只写目标、交付物、完成条件、约束、来源明确的事实和未知，不写解决方案或根因判断。Scout 只提供未验证候选和客观探查，不负责执行或排名；你可以组合、否定或重新设计。正式执行前自行验证关键假设。探索插件只记录探索结果，不执行正式任务、不激活工作流，也不修改任务日志。`;
}
