/**
 * Guidance rendering: turns a matched library entry into a compact
 * workflow-guidance block appended to the system prompt.
 * Volume discipline: skeleton only at start; per-step details expand lazily
 * (the tracker renders those via steer/advance messages).
 */
import {
	isL1,
	isL2,
	isL3,
	type LibraryEntity,
	type L1Template,
	type L2Workflow,
	type WorkStrategy,
	type RegistryEntry,
} from "../library/types.ts";

export interface InjectorDeps {
	getEntity: (id: string) => LibraryEntity | undefined;
	/** Optional: resolve a code asset id to its disk path for run_code guidance. */
	getCodeAssetPath?: (id: string) => string | undefined;
}

export function renderGuidance(entry: RegistryEntry, deps: InjectorDeps): string {
	const entity = deps.getEntity(entry.id);
	if (!entity) return "";
	const header = `[工作流 ${entry.id}] ${entry.intent}`;
	const footer =
		"执行策略：按上述参考路线工作；每个检查点若连续失败，先换备选方案；仍失败则明确声明放弃本工作流并转入自由模式。";
	if (isL1(entity)) {
		return `${header}\n${renderL1Block(entity)}\n${footer}`;
	}
	if (isL2(entity)) {
		return `${header}\n${renderL2Block(entity, deps)}\n${footer}`;
	}
	if (isL3(entity)) {
		return `${header}\n${renderL3Block(entity)}\n${footer}`;
	}
	return "";
}

function renderL1Block(l1: L1Template): string {
	const calls = l1.calls.map((c) => `- ${c.tool} ${c.argsTemplate}`).join("\n");
	const expect = l1.expect ? `\n检查点：${l1.expect}` : "";
	const variants = l1.variants.length > 0 ? `\n失败可切换变体：${l1.variants.join(", ")}` : "";
	return `按以下组合模板执行：\n${calls}${expect}${variants}`;
}

function renderL2Block(l2: L2Workflow, deps: InjectorDeps): string {
	const lines: string[] = [];
	for (const [i, step] of l2.steps.entries()) {
		const tool = step.ref
			? `模板 ${step.ref}`
			: step.action
				? describeAction(step.action.tool, step.action.argsTemplate, deps)
				: "（自由发挥）";
		const cp = step.expect ? " ◆检查点" : "";
		lines.push(`${i + 1}. ${step.intent}（${tool}${cp}）`);
	}
	// First-step detail: expand now; later steps expand lazily via tracker.
	const first = l2.steps[0];
	if (first?.ref) {
		const l1 = deps.getEntity(first.ref);
		if (l1 && isL1(l1)) {
			lines.push(`\n首步细节：\n${renderL1Block(l1)}`);
		}
	} else if (first?.action) {
		lines.push(`\n首步细节：${describeAction(first.action.tool, first.action.argsTemplate, deps)}`);
	}
	return `参考步骤：\n${lines.join("\n")}`;
}

/** Describe a step action; run_code references expand to read+bash guidance. */
function describeAction(tool: string, argsTemplate: string, deps: InjectorDeps): string {
	if (tool === "run_code") {
		const match = /codeAsset:([A-Za-z0-9_-]+)/.exec(argsTemplate);
		const assetId = match?.[1] ?? "???";
		const path = deps.getCodeAssetPath?.(assetId);
		const pathHint = path ? `（${path}）` : "";
		return `运行已保存的脚本 ${assetId}${pathHint}：先用 read 读取代码资产内容（若未落盘则用 write 写入），再用 bash 执行`;
	}
	return `${tool} ${argsTemplate}`;
}

function renderL3Block(ws: WorkStrategy): string {
	const steps = ws.steps.length > 0
		? `\n执行路线：\n${ws.steps.map((s, i) => `${i + 1}. ${s.intent}${s.ref ? ` → ${s.ref}` : ""}${s.note ? `（${s.note}）` : ""}`).join("\n")}`
		: "";
	return `解题思路：${ws.reasoning}\n注意事项：${ws.caveats.join("；") || "无"}${steps}`;
}
