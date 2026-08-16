/** Optional prior resolver. It accepts only a read-only advisory provider. */
import type { WorkflowPriorProvider } from "../../_shared/interop.ts";
import type { PriorResolution } from "./types.ts";

export async function resolvePrior(
	taskText: string,
	provider?: WorkflowPriorProvider,
): Promise<PriorResolution> {
	if (!provider) return { kind: "none", reason: "没有提供可选的工作流先验，从任务和仓库事实开始探索" };
	try {
		const summary = await provider.resolve(taskText);
		if (!summary) return { kind: "none", reason: "先验提供者没有返回相关 advisory" };
		return { kind: "matched", summary, reason: summary.reason };
	} catch (error) {
		return { kind: "unavailable", reason: error instanceof Error ? error.message : String(error) };
	}
}
