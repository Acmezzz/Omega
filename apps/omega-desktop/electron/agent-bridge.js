/**
 * Agent bridge — runs the agent session in the Electron main process (Node
 * environment, so bash/fs tools and the two plugins work) and streams events to
 * the renderer over IPC.
 */
import { createAgentSession, DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = join(homedir(), ".pi", "agent");
// Your two plugins live in the Omega repo's .pi/extensions (electron → omega-desktop → apps → root).
const OMEGA_EXT = resolve(fileURLToPath(new URL("../../../.pi/extensions", import.meta.url)));

/** Create a fresh agent session. Must run in the main process. */
export async function createSession({ cwd }) {
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: AGENT_DIR,
		additionalExtensionPaths: [
			join(OMEGA_EXT, "journal-workflow", "index.ts"),
			join(OMEGA_EXT, "exploration-scout", "index.ts"),
		],
		settingsManager: SettingsManager.create(cwd, AGENT_DIR),
	});
	await resourceLoader.reload();

	return createAgentSession({ cwd, agentDir: AGENT_DIR, resourceLoader, tools: ["read", "bash", "edit", "write"] });
}

/**
 * Subscribe a renderer's webContents to all agent events. Optional filters can
 * drop high-volume / sensitive events before they cross the IPC boundary.
 */
export function streamToRenderer(session, webContents) {
	const unsubscribe = session.subscribe((event) => {
		webContents.send("agent:event", event);
	});
	return unsubscribe;
}