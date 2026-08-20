/** Narrow, validated bridge exposed to the renderer. */
const { contextBridge, ipcRenderer } = require("electron");
const MAX_PROMPT_CHARS = 40_000;

contextBridge.exposeInMainWorld("omega", {
	prompt: (text) => {
		if (typeof text !== "string" || !text.trim()) return Promise.resolve({ ok: false, code: "invalid_prompt", message: "Prompt must be a non-empty string" });
		if (text.length > MAX_PROMPT_CHARS) return Promise.resolve({ ok: false, code: "prompt_too_large", message: `Prompt exceeds ${MAX_PROMPT_CHARS} characters` });
		return ipcRenderer.invoke("agent:prompt", text);
	},
	onStatus: (callback) => {
		if (typeof callback !== "function") return () => {};
		const handler = (_event, data) => {
			try { callback(data); } catch (error) { console.error("omega status callback failed", error); }
		};
		ipcRenderer.on("app:bootstrap-error", handler);
		return () => ipcRenderer.removeListener("app:bootstrap-error", handler);
	},
	onEvent: (callback) => {
		if (typeof callback !== "function") return () => {};
		const handler = (_event, data) => {
			try { callback(data); } catch (error) { console.error("omega event callback failed", error); }
		};
		ipcRenderer.on("agent:event", handler);
		return () => ipcRenderer.removeListener("agent:event", handler);
	},
});
