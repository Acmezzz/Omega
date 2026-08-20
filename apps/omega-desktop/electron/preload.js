/**
 * Narrow, validated bridge exposed to the renderer.
 *
 * The legacy `prompt / onStatus / onEvent` methods are preserved untouched.
 * The new `omega:*` methods are appended in the same object; each performs the
 * SAME minimal validation as the main-process `senderAllowed` check (defence in
 * depth) before invoking its IPC channel. The renderer never gains raw
 * filesystem or git access. See system_design.md §1.4 / §3.3.
 */
const { contextBridge, ipcRenderer } = require("electron");
const MAX_PROMPT_CHARS = 40_000;
const MAX_FIELD_CHARS = 256_000;

function safeString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

contextBridge.exposeInMainWorld("omega", {
  // ----- legacy contract (unchanged) -----
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

  // ----- extension state (read-only) -----
  queryExtensionState: (req) => {
    const scope = typeof req?.scope === "string" ? req.scope : "all";
    if (!["all", "workflow", "scout"].includes(scope)) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "scope must be all|workflow|scout" });
    }
    return ipcRenderer.invoke("omega:queryExtensionState", {
      scope,
      projectKey: safeString(req?.projectKey, 512),
      taskId: safeString(req?.taskId, 512),
    });
  },

  // ----- sessions -----
  listSessions: () => ipcRenderer.invoke("omega:listSessions"),
  newSession: (req) => {
    if (req && req.title !== undefined && (typeof req.title !== "string" || req.title.length > 256)) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "title must be a short string" });
    }
    if (req && req.workspace !== undefined && typeof req.workspace !== "string") {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "workspace must be a string" });
    }
    return ipcRenderer.invoke("omega:newSession", {
      projectKey: safeString(req?.projectKey, 512),
      title: safeString(req?.title, 256),
      workspace: safeString(req?.workspace, 4096),
    });
  },
  loadSession: (req) => {
    if (!req || typeof req.sessionId !== "string" || !req.sessionId.trim()) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "sessionId is required" });
    }
    return ipcRenderer.invoke("omega:loadSession", { sessionId: req.sessionId });
  },
  saveSession: (req) => {
    if (!req || typeof req.sessionId !== "string" || !isPlainObject(req.transcript)) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "sessionId and transcript are required" });
    }
    return ipcRenderer.invoke("omega:saveSession", { sessionId: req.sessionId, transcript: req.transcript });
  },
  deleteSession: (req) => {
    if (!req || typeof req.sessionId !== "string" || !req.sessionId.trim()) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "sessionId is required" });
    }
    return ipcRenderer.invoke("omega:deleteSession", { sessionId: req.sessionId });
  },

  // ----- diff + approval -----
  diffWorkspace: (_req) => ipcRenderer.invoke("omega:diffWorkspace", {}),
  approveChange: (req) => {
    if (!req || (req.action !== "accept" && req.action !== "reject")) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "action must be accept|reject" });
    }
    const files = Array.isArray(req.files)
      ? req.files.filter((f) => typeof f === "string").map((f) => f.slice(0, 4096)).slice(0, 2000)
      : undefined;
    return ipcRenderer.invoke("omega:approveChange", { action: req.action, files });
  },
});
