/**
 * Preload: safe bridge (CommonJS — Electron loads preload as CJS even in ESM apps).
 * Exposes a minimal API to the renderer:
 * - prompt(text): send a user message into the agent session.
 * - onEvent(cb): subscribe to agent events (returns an unsubscribe fn).
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("omega", {
	prompt: (text) => ipcRenderer.invoke("agent:prompt", text),
	onEvent: (cb) => {
		const handler = (_event, data) => cb(data);
		ipcRenderer.on("agent:event", handler);
		return () => ipcRenderer.removeListener("agent:event", handler);
	},
});