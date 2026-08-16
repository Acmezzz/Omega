/**
 * Configuration: reads the "journalWorkflow" custom section from settings.json.
 * The extension API has no settings accessor, so we read the file directly —
 * unknown keys survive Pi's settings merge (verified), this stays forward-compatible.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface JournalWorkflowConfig {
	enabled: boolean;
	journalsRoot: string;
	workflowsRoot: string;
	/** Optional dedicated aux model ("provider/model"); default: session model. */
	auxModel?: string;
	workflowPolicy?: "workflow-first" | "off";
}

interface SettingsFile {
	journalWorkflow?: {
		enabled?: boolean;
		journalsRoot?: string;
		workflowsRoot?: string;
			auxModel?: string;
			workflowPolicy?: "workflow-first" | "off";

	};
}

export function defaultAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function loadConfig(agentDir: string = defaultAgentDir()): JournalWorkflowConfig {
	const defaults: JournalWorkflowConfig = {
		enabled: true,
		journalsRoot: join(agentDir, "journals"),
			workflowsRoot: join(agentDir, "workflows"),
			workflowPolicy: "workflow-first",

	};
	const settingsPath = join(agentDir, "settings.json");
	if (!existsSync(settingsPath)) return envOverrides(defaults);
	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as SettingsFile;
		const section = parsed.journalWorkflow ?? {};
		return envOverrides({
			...defaults,
			enabled: section.enabled ?? defaults.enabled,
			journalsRoot: section.journalsRoot ?? defaults.journalsRoot,
		workflowsRoot: section.workflowsRoot ?? defaults.workflowsRoot,
				auxModel: section.auxModel ?? defaults.auxModel,
				workflowPolicy: section.workflowPolicy ?? defaults.workflowPolicy,

		});
	} catch {
		return envOverrides(defaults);
	}
}

function envOverrides(config: JournalWorkflowConfig): JournalWorkflowConfig {
	if (process.env.PI_JW_DISABLE === "1") return { ...config, enabled: false };
	return config;
}
