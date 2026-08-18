import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { homedir } from "node:os";
import type { ExplorationBudget } from "./core/types.ts";

export interface ExplorationScoutConfig {
	enabled: boolean;
	explorationsRoot: string;
	policy: "manual" | "explore-first" | "off";
	/** Reserved for a future dedicated aux model; currently the session model is used. */
	auxModel?: string;
	budget?: Partial<ExplorationBudget>;
}

interface SettingsFile { explorationScout?: Partial<Omit<ExplorationScoutConfig, "enabled">> & { enabled?: boolean } }

function defaultAgentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }
function resolveConfiguredPath(value: string, agentDir: string): string {
	const expanded = value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
	return isAbsolute(expanded) ? expanded : join(agentDir, expanded);
}

export function loadConfig(agentDir: string = defaultAgentDir()): ExplorationScoutConfig {
	const defaults: ExplorationScoutConfig = { enabled: true, explorationsRoot: join(agentDir, "explorations"), policy: "manual" };
	const path = join(agentDir, "settings.json");
	if (!existsSync(path)) return envOverrides(defaults);
	try {
		const section = (JSON.parse(readFileSync(path, "utf8")) as SettingsFile).explorationScout ?? {};
			return envOverrides({ ...defaults, ...section, explorationsRoot: resolveConfiguredPath(section.explorationsRoot ?? defaults.explorationsRoot, agentDir), policy: section.policy ?? defaults.policy });
	} catch { return envOverrides(defaults); }
}

function envOverrides(config: ExplorationScoutConfig): ExplorationScoutConfig {
	return process.env.PI_EXPLORATION_DISABLE === "1" ? { ...config, enabled: false } : config;
}
