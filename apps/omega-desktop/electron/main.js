/**
 * Electron main process.
 * - Hosts the agent session (Node env: bash/fs + your two plugins).
 * - Creates the window, streams agent events to the renderer over IPC,
 *   and forwards user prompts back into the session.
 */
import { app, BrowserWindow, ipcMain } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSession, streamToRenderer } from "./agent-bridge.js";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));

let win;
let session;
let unsubscribe;

async function bootstrap() {
	// Work in the Omega monorepo root (electron → omega-desktop → apps → root).
	const cwd = join(MAIN_DIR, "..", "..", "..");
	process.stdout.write(`[main] cwd=${cwd}\n`);
	const { session: s, extensionsResult } = await createSession({ cwd });
	session = s;
	const names = extensionsResult.extensions.map((e) => e.path.split(/[\\/]/).filter(Boolean).slice(-2, -1)[0] ?? e.path).filter(Boolean);
	process.stdout.write(`[main] extensions: ${names.join(", ") || "(none)"}\n`);
	process.stdout.write("[main] agent session ready\n");
}

function createWindow() {
	win = new BrowserWindow({
		width: 1100,
		height: 800,
		title: "Omega Desktop",
		webPreferences: {
			preload: join(MAIN_DIR, "preload.js"),
			contextIsolation: true,
			nodeIntegration: false,
		},
	});
	win.loadFile(join(MAIN_DIR, "..", "index.html"));
	if (session) unsubscribe = streamToRenderer(session, win.webContents);

	// Forward renderer console to the terminal (useful for autotest / debugging GUIs).
	win.webContents.on("console-message", (_e, _level, message) => {
		process.stdout.write(`[renderer] ${message}\n`);
	});

	// End-to-end self test: auto-send a prompt once the window is ready, then quit.
	if (process.env.OMEGA_AUTOTEST === "1") {
		win.webContents.once("did-finish-load", () => {
			setTimeout(() => { session?.prompt("Reply with exactly: hello from omega-desktop").catch(() => {}); }, 500);
		});
		setTimeout(() => { process.stdout.write("[main] autotest done, quitting\n"); app.quit(); }, 25000);
	}
}

ipcMain.handle("agent:prompt", async (_e, text) => {
	if (!session) return { ok: false, error: "session not ready" };
	await session.prompt(text);
	return { ok: true };
});

app.whenReady().then(async () => {
	try {
		await bootstrap();
	} catch (err) {
		process.stdout.write(`[main] bootstrap failed: ${String(err)}\n`);
	}
	createWindow();
});

app.on("window-all-closed", () => {
	unsubscribe?.();
	app.quit();
});