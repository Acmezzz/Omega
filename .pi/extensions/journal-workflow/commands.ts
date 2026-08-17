/**
 * Slash commands: /wf-extract, /wf-list, /wf-catalog, /wf-stats.
 * Output goes through a notify callback so the module stays testable
 * (the adapter wires it to ctx.ui.notify with a console fallback).
 */
import type { LlmClient } from "./core/llm.ts";
import { runExtraction } from "./core/extractor/extract.ts";
import { WorkflowStore } from "./core/library/store.ts";
import { listTasks, readTask } from "./core/journal/writer.ts";
import type { JournalWorkflowConfig } from "./config.ts";

export interface CommandDeps {
	config: JournalWorkflowConfig;
	llm: LlmClient;
	resolveProjectKey: (cwd: string) => string;
}

export interface CommandPi {
	registerCommand(
		name: string,
		options: { description?: string; handler: (args: string, ctx: { cwd: string }) => Promise<void> },
	): void;
}

export function registerWorkflowCommands(pi: CommandPi, deps: CommandDeps, notify: (text: string) => void): void {
	pi.registerCommand("wf-extract", {
		description: "从会话日志提取工作流并更新工作流库",
		handler: async (_args, ctx) => {
			const store = WorkflowStore.load(deps.config.workflowsRoot);
			const projectKey = deps.resolveProjectKey(ctx.cwd);
			notify("wf-extract: 开始提取…");
			const report = await runExtraction({
				journalsRoot: deps.config.journalsRoot,
				projectKey,
				store,
				llm: deps.llm,
			});
			const lines = [
				`任务 ${report.tasksScanned}（完成 ${report.completedTasks}），回合 ${report.turnsDistilled}（待提炼 ${report.turnsPendingDistill}）`,
				`共现模式：${report.recurringPatterns.map((p) => `${p.tools.join("→")}×${p.count}`).join("、") || "无"}`,
				`骨架：${report.skeleton.join(" → ") || "无"}`,
				`新建 L1：${report.l1Created.join("、") || "无"}；新建 L2：${report.l2Created.join("、") || "无"}`,
					`归并：${report.mergedInto.join("、") || "无"}`,
					`目录：新建 ${report.catalogFeaturesCreated.join("、") || "无"}；归类 ${report.catalogEntriesAssigned.join("、") || "无"}；未归类 ${report.catalogEntriesUnmatched.join("、") || "无"}`,
					`目录阶段：${report.catalogPhaseSkipped ?? "完整执行"}`,
					`补充分支：${report.alternativesProposed.map((a) => `${a.workflowId}#${a.stepIndex}→${a.alternative}`).join("、") || "无"}`,

			];
			notify(lines.join("\n"));
		},
	});

	pi.registerCommand("wf-list", {
		description: "列出工作流库条目",
		handler: async (_args, _ctx) => {
			const store = WorkflowStore.load(deps.config.workflowsRoot);
			const entries = store.getRegistry();
			if (entries.length === 0) {
				notify("工作流库为空");
				return;
			}
			notify(
				entries
					.map(
						(e) =>
							`L${e.level} ${e.id} [${e.status}] evidence=${e.evidence} usage=${e.usage} escapes=${e.escapes} — ${e.intent}`,
					)
					.join("\n"),
			);
		},
	});

	pi.registerCommand("wf-catalog", {
		description: "查看按功能组织的工作流目录",
		handler: async (_args, _ctx) => {
			const store = WorkflowStore.load(deps.config.workflowsRoot);
			const features = store.getCatalogFeatures();
			if (features.length === 0) {
				notify("功能目录为空；请先运行 /wf-extract");
				return;
			}
			notify(features.map((feature) => `${feature.label} (${feature.id})：${feature.description}\n  ${feature.entryIds.join("、") || "无条目"}`).join("\n"));
		},
	});

	pi.registerCommand("wf-stats", {
		description: "统计当前项目的会话日志",
		handler: async (_args, ctx) => {
			const projectKey = deps.resolveProjectKey(ctx.cwd);
			const dirs = listTasks(deps.config.journalsRoot, projectKey);
			let turns = 0;
			let pending = 0;
			let failures = 0;
			for (const dir of dirs) {
				const result = readTask(dir);
				turns += result.turns.length;
				pending += result.turns.filter((t) => t.extractedAt === undefined).length;
				const { existsSync, readFileSync } = await import("node:fs");
				const { join } = await import("node:path");
				if (existsSync(join(dir, "failures.jl"))) {
					failures += readFileSync(join(dir, "failures.jl"), "utf-8")
						.split("\n")
						.filter((l) => l.trim().length > 0).length;
				}
			}
			notify(`项目 ${projectKey}：任务 ${dirs.length}，回合 ${turns}（待提炼 ${pending}），跳出记录 ${failures}`);
		},
	});
}
