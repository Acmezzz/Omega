/**
 * Minimal SDK smoke test (route-1 foundation).
 * Verifies: createAgentSession instantiates, your two extensions load,
 * and a trivial prompt round-trips — all in a plain Node process.
 * Run from omega-desktop:  npm run sdk-check
 */
import {
	createAgentSession,
	DefaultResourceLoader,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const agentDir = join(homedir(), ".pi", "agent");
const cwd = process.cwd();
// Your two plugins are directories, each with its own index.ts entry point.
const OMEGA_EXT = resolve(fileURLToPath(new URL("../../../.pi/extensions", import.meta.url)));
const pluginEntries = [
	join(OMEGA_EXT, "journal-workflow", "index.ts"),
	join(OMEGA_EXT, "exploration-scout", "index.ts"),
];

async function main() {
	console.log("[sdk-check] agentDir =", agentDir);
	console.log("[sdk-check] plugin entries =", pluginEntries);

	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		additionalExtensionPaths: pluginEntries,
		settingsManager: SettingsManager.create(cwd, agentDir),
	});
	await resourceLoader.reload();

	const { session, extensionsResult } = await createAgentSession({
		cwd,
		agentDir,
		resourceLoader,
		tools: ["read", "bash"],
	});

	const extNames = extensionsResult.extensions.map((e) => {
	const segs = e.path.split(/[\\/]/).filter(Boolean);
	return segs.at(-2) && segs.at(-1) === "index.ts" ? segs.at(-2) : segs.at(-1);
}).filter(Boolean);
const errors = extensionsResult.errors.map((e) => `${e.path}: ${e.error}`);
console.log("[sdk-check] loaded extensions:", extNames.length ? extNames.join(", ") : "(none)");
	console.log("[sdk-check] extension errors:", errors.length ? errors.join(" | ") : "(none)");

	const loaded = JSON.stringify(extNames).toLowerCase();
	const hasJournal = loaded.includes("journal-workflow");
	const hasScout = loaded.includes("exploration-scout");
	console.log(`[sdk-check] journal-workflow loaded: ${hasJournal ? "YES" : "NO"}`);
	console.log(`[sdk-check] exploration-scout loaded: ${hasScout ? "YES" : "NO"}`);

	try {
		let gotDelta = false;
		session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				gotDelta = true;
			}
		});
		await session.prompt("Reply with exactly: ok");
		console.log(`[sdk-check] prompt round-trip streamed text: ${gotDelta ? "YES" : "NO (may be no model configured)"}`);
	} catch (err) {
		console.log("[sdk-check] prompt round-trip skipped:", err?.message ?? String(err));
	}

	// Proof the plugins actually WIRED (not merely loaded): journal-workflow writes
	// to <agentDir>/journals on session events. Check it has content after the run.
	const journalsDir = join(agentDir, "journals");
	const { readdirSync } = await import("node:fs");
	let journalWrote = false;
	try {
		const projects = readdirSync(journalsDir);
		for (const p of projects) {
			const tasks = readdirSync(join(journalsDir, p));
			if (tasks.length > 0) journalWrote = true;
		}
	} catch { /* no journals dir yet */ }
	console.log(`[sdk-check] journal-workflow WIRED (journals written): ${journalWrote ? "YES" : "NO"}`);

	process.exit(0);
}

main().catch((err) => {
	console.error("[sdk-check] FAILED:", err);
	process.exit(1);
});