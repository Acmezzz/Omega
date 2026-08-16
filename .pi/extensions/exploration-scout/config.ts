import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ExplorationBudget } from "./core/types.ts";

export interface ExplorationScoutConfig {
	enabled: boolean;
	explorationsRoot: string;
	policy: "explore-first" | "off";
	auxModel?: string;
	budget?: Partial<ExplorationBudget>;
}

interface SettingsFile { explorationScout?: Partial<Omit<ExplorationScoutConfig, "enabled">> & { enabled?: boolean } }

function defaultAgentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }

export function loadConfig(agentDir: string = defaultAgentDir()): ExplorationScoutConfig {
	const defaults: ExplorationScoutConfig = { enabled: true, explorationsRoot: join(agentDir, "explorations"), policy: "explore-first" };
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return envOverrides(defaults);
	try {
		const section = (JSON.parse(readFileSync(path, "utf8")) as SettingsFile).explorationScout ?? {};
		return envOverrides({ ...defaults, ...section, explorationsRoot: section.explorationsRoot ?? defaults.explorationsRoot, policy: section.policy ?? defaults.policy });
	} catch { return envOverrides(defaults); }
}

function envOverrides(config: ExplorationScoutConfig): ExplorationScoutConfig {
	return process.env.PI_EXPLORATION_DISABLE === "1" ? { ...config, enabled: false } : config;
}
