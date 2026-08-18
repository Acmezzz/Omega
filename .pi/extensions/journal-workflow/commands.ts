/**
 * Slash commands: /wf-extract, /wf-list, /wf-catalog, /wf-stats.
 * Output goes through a notify callback so the module stays testable
 * (the adapter wires it to ctx.ui.notify with a console fallback).
 */
import { join } from "node:path";
import type { LlmClient } from "./core/llm.ts";
import { runExtraction } from "./core/extractor/extract.ts";
import { WorkflowStore } from "./core/library/store.ts";
import { JournalWriter, listTasks, readTask, taskDirOf } from "./core/journal/writer.ts";
import { BackupReader } from "./core/journal/backup.ts";
import { buildRestorePlan } from "./core/journal/restore.ts";
import { checkProjectHealth } from "./core/health.ts";
import type { JournalWorkflowConfig } from "./config.ts";

export interface CommandDeps {
	config: JournalWorkflowConfig;
	llm: LlmClient;
	resolveProjectKey: (cwd: string) => string;
	isTaskActive?: (projectKey: string, taskId: string) => boolean;
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
					backupsRoot: deps.config.backupsRoot,
					backupEnabled: deps.config.backupEnabled,
					allowSensitiveFragments: deps.config.allowSensitiveFragments,
					maxFragmentCharsPerRequest: deps.config.maxFragmentCharsPerRequest,
					maxFragmentsPerRequest: deps.config.maxFragmentsPerRequest,

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

	pi.registerCommand("journal-restore", {
		description: "从完整事件备份恢复尚未落盘的事实回合（默认 dry-run）",
		handler: async (args, ctx) => {
			const taskId = args.trim().split(/\s+/).find((value) => value && !value.startsWith("--"));
			if (!taskId) { notify("用法：/journal-restore <task-id> [--dry-run|--apply]"); return; }
			const projectKey = deps.resolveProjectKey(ctx.cwd);
			const source = new BackupReader(join(deps.config.backupsRoot ?? join(deps.config.journalsRoot, ".backups"), projectKey, taskId));
			if (deps.isTaskActive?.(projectKey, taskId) && args.includes("--apply")) { notify("当前任务仍在活动 session 中，拒绝 apply 以避免并发写入。"); return; }
			const targetDir = taskDirOf(deps.config.journalsRoot, projectKey, taskId);
			const existing = readTask(targetDir).turns;
			const plan = buildRestorePlan(source.scanEvents(), projectKey, taskId, new Set(existing.map((turn) => turn.seq)));
			const apply = args.includes("--apply");
			if (apply && plan.turnsEligible > 0) {
				const writer = new JournalWriter(deps.config.journalsRoot, projectKey, taskId);
				plan.turnsWritten = writer.appendRecoveredTurns(plan.turns);
				plan.status = plan.turnsWritten > 0 ? (plan.warnings.length > 0 ? "partial" : "applied") : "no-op";
			}
			notify([`journal-restore ${apply ? "apply" : "dry-run"}: ${plan.status}`, `任务=${taskId}，事件=${plan.eventsValid}/${plan.eventsRead}，回合=${plan.turnsWritten ?? 0}/${plan.turnsEligible}，工具=${plan.toolsRecovered}，未闭合工具=${plan.openTools}`, ...plan.warnings.map((warning) => `警告：${warning}`)].join("\n"));
		},
	});

	pi.registerCommand("wf-health", {
		description: "只读检查 journal、backup、workflow 和 extraction 数据健康状态",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const json = tokens.includes("--json");
			const taskId = tokens.find((token) => !token.startsWith("--"));
			const report = checkProjectHealth({
				journalsRoot: deps.config.journalsRoot,
				backupsRoot: deps.config.backupsRoot ?? join(deps.config.journalsRoot, ".backups"),
				workflowsRoot: deps.config.workflowsRoot,
				projectKey: deps.resolveProjectKey(ctx.cwd),
				...(taskId ? { taskId } : {}),
			});
			if (json) notify(JSON.stringify(report, null, 2));
			else notify([`wf-health: ${report.status}`, `项目=${report.projectKey}${report.taskId ? `，任务=${report.taskId}` : ""}`, `任务=${report.summary.tasks}，journal 回合=${report.summary.journalTurns}，backup 事件=${report.summary.backupEvents}，fragment=${report.summary.fragments}，待恢复=${report.summary.pendingRestore}，跳过行=${report.summary.skippedLines}，restricted=${report.summary.restricted}`, ...report.issues.map((issue) => `[${issue.severity}] ${issue.code}: ${issue.detail} (${issue.path})`)].join("\n"));
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
