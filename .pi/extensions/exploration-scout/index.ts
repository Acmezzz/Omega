import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.ts";
import { wire } from "./adapter.ts";

export default function explorationScoutExtension(pi: ExtensionAPI): void {
	const config = loadConfig();
	if (!config.enabled) return;
	wire(pi, { config });
}
