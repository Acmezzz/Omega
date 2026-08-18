import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BackupReader } from "./journal/backup.ts";
import { listTasks, readTask } from "./journal/writer.ts";
import type { TaskMeta } from "./journal/types.ts";
import { WorkflowStore } from "./library/store.ts";

export type HealthSeverity = "info" | "warning" | "error";
export interface HealthIssue { code: string; severity: HealthSeverity; path: string; detail: string }
export interface HealthReport {
	status: "ok" | "warn" | "error";
	projectKey: string;
	taskId?: string;
	roots: { journals: string; backups: string; workflows: string };
	summary: { tasks: number; journalTurns: number; backupEvents: number; fragments: number; pendingRestore: number; skippedLines: number; restricted: number };
	issues: HealthIssue[];
}

function addIssue(issues: HealthIssue[], code: string, severity: HealthSeverity, path: string, detail: string): void {
	issues.push({ code, severity, path, detail });
}

function inspectMeta(meta: TaskMeta | null, taskDir: string, projectKey: string, issues: HealthIssue[]): void {
	if (!meta) {
		addIssue(issues, "JOURNAL_META_MISSING_OR_INVALID", "error", join(taskDir, "task.json"), "task.json 缺失或无法解析");
		return;
	}
	if (meta.projectKey !== projectKey) addIssue(issues, "JOURNAL_PROJECT_MISMATCH", "error", join(taskDir, "task.json"), "task.json projectKey 与扫描项目不一致");
	if (!Array.isArray(meta.blocks)) addIssue(issues, "JOURNAL_BLOCKS_INVALID", "error", join(taskDir, "task.json"), "blocks 不是数组");
	for (const block of meta.blocks ?? []) if (!existsSync(join(taskDir, block.file))) addIssue(issues, "JOURNAL_BLOCK_MISSING", "error", join(taskDir, block.file), "task.json 声明的 block 文件不存在");
}

export function checkProjectHealth(options: { journalsRoot: string; backupsRoot: string; workflowsRoot: string; projectKey: string; taskId?: string }): HealthReport {
	const issues: HealthIssue[] = [];
	const taskDirs = options.taskId ? [join(options.journalsRoot, options.projectKey, options.taskId)] : listTasks(options.journalsRoot, options.projectKey);
	let journalTurns = 0;
	let pendingRestore = 0;
	let skippedLines = 0;
	let backupEvents = 0;
	let fragments = 0;
	let restricted = 0;
	for (const taskDir of taskDirs) {
		const result = readTask(taskDir);
		inspectMeta(result.meta, taskDir, options.projectKey, issues);
		journalTurns += result.turns.length;
		skippedLines += result.skippedLines;
		if (result.skippedLines > 0) addIssue(issues, "JOURNAL_BAD_LINES", "warning", taskDir, `跳过 ${result.skippedLines} 个无法解析的 journal 行`);
		if (result.turns.some((turn) => turn.extractedAt === undefined)) pendingRestore += 1;
		const seqs = result.turns.map((turn) => turn.seq);
		if (new Set(seqs).size !== seqs.length) addIssue(issues, "JOURNAL_DUPLICATE_SEQ", "error", taskDir, "存在重复 turn seq");
		if (result.meta && result.meta.turnCount !== Math.max(0, ...seqs)) addIssue(issues, "JOURNAL_TURNCOUNT_MISMATCH", "warning", join(taskDir, "task.json"), "turnCount 与实际最大 turn seq 不一致");
		const backupDir = join(options.backupsRoot, options.projectKey, result.meta?.taskId ?? taskDir.split(/[\\/]/).at(-1) ?? "");
		if (existsSync(backupDir)) {
			const reader = new BackupReader(backupDir);
			const scan = reader.scanEvents();
			backupEvents += scan.events.length;
			fragments += reader.listFragments().length;
			restricted += reader.listFragments().filter((fragment) => fragment.sensitivity === "restricted").length;
			if (scan.skippedLines > 0) addIssue(issues, "BACKUP_BAD_LINES", "warning", join(backupDir, "events.jl"), `跳过 ${scan.skippedLines} 个无法解析的 backup 事件行`);
			if (scan.duplicateSeqs.length > 0) addIssue(issues, "BACKUP_DUPLICATE_EVENT_SEQ", "error", join(backupDir, "events.jl"), `重复 eventSeq 数量 ${scan.duplicateSeqs.length}`);
			if (scan.outOfOrder) addIssue(issues, "BACKUP_EVENT_OUT_OF_ORDER", "warning", join(backupDir, "events.jl"), "eventSeq 存在乱序");
			if (scan.events.some((event) => event.projectKey !== options.projectKey)) addIssue(issues, "BACKUP_PROJECT_MISMATCH", "error", join(backupDir, "events.jl"), "事件 projectKey 与目录不一致");
			if (scan.events.some((event) => typeof event.turnSeq === "number" && event.turnSeq > Math.max(0, ...seqs))) pendingRestore += 1;
		}
	}

	const workflowRoot = options.workflowsRoot;
	let store: WorkflowStore;
	try {
		store = WorkflowStore.load(workflowRoot);
		const orphans = store.detectOrphans();
		if (orphans.length > 0) addIssue(issues, "WORKFLOW_ORPHAN_ENTITIES", "warning", workflowRoot, `孤儿实体 ${orphans.length} 个`);
		const catalog = store.getCatalog();
		const known = new Set(store.getRegistry().map((entry) => entry.id));
		const dangling = catalog.features.flatMap((feature) => feature.entryIds.filter((id) => !known.has(id)));
		if (dangling.length > 0) addIssue(issues, "CATALOG_DANGLING_ENTRIES", "warning", join(workflowRoot, "catalog.json"), `悬空 entry 引用 ${dangling.length} 个`);
			for (const entry of store.getRegistry()) if (!store.getEntity(entry.id)) addIssue(issues, "WORKFLOW_ENTITY_MISSING", "error", workflowRoot, `registry 条目 ${entry.id} 缺少实体文件`);

			const ledgerPath = join(workflowRoot, ".evidence-ledger.json");
			if (existsSync(ledgerPath)) {
				try {
					const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { version?: unknown; entries?: unknown };
					if (ledger.version !== 1 || !Array.isArray(ledger.entries)) {
						addIssue(issues, "EVIDENCE_LEDGER_INVALID", "warning", ledgerPath, "evidence ledger version 或 entries 无效");
					} else {
						const known = new Set(store.getRegistry().map((entry) => entry.id));
						const seen = new Set<string>();
						for (const record of ledger.entries) {
							if (!record || typeof record !== "object") {
								addIssue(issues, "EVIDENCE_LEDGER_INVALID", "warning", ledgerPath, "存在无效 evidence 记录");
								continue;
							}
							const item = record as { evidenceKey?: unknown; entryId?: unknown };
							if (typeof item.evidenceKey !== "string" || !item.evidenceKey.trim()) addIssue(issues, "EVIDENCE_LEDGER_INVALID", "warning", ledgerPath, "存在空 evidenceKey");
							else if (seen.has(item.evidenceKey)) addIssue(issues, "EVIDENCE_LEDGER_DUPLICATE_KEY", "error", ledgerPath, "存在重复 evidenceKey");
							else seen.add(item.evidenceKey);
							if (typeof item.entryId !== "string" || !known.has(item.entryId)) addIssue(issues, "EVIDENCE_LEDGER_ORPHAN", "warning", ledgerPath, "evidence 关联的 entry 不存在");
						}
					}
				} catch {
					addIssue(issues, "EVIDENCE_LEDGER_INVALID", "warning", ledgerPath, "evidence ledger 无法解析");
				}
			}
		} catch {
			addIssue(issues, "WORKFLOW_REGISTRY_INVALID", "error", join(workflowRoot, "registry.json"), "registry 或 catalog 无法读取");
		}

	const manifestPath = join(workflowRoot, "manifests", `${options.projectKey}.json`);
	if (existsSync(manifestPath)) {
		try {
			const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
			if (manifest.version !== 2 || manifest.projectKey !== options.projectKey) {
				addIssue(issues, "EXTRACTION_MANIFEST_INVALID", "warning", manifestPath, "manifest version 或 projectKey 不匹配");
			}
		} catch {
			addIssue(issues, "EXTRACTION_MANIFEST_INVALID", "warning", manifestPath, "提取 manifest 无法解析");
		}
	}
	const status = issues.some((issue) => issue.severity === "error") ? "error" : issues.length > 0 ? "warn" : "ok";
	return { status, projectKey: options.projectKey, ...(options.taskId ? { taskId: options.taskId } : {}), roots: { journals: options.journalsRoot, backups: options.backupsRoot, workflows: options.workflowsRoot }, summary: { tasks: taskDirs.length, journalTurns, backupEvents, fragments, pendingRestore, skippedLines, restricted }, issues };
}

