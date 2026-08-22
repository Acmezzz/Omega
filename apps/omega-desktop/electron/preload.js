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
const MAX_PROMPT_IMAGES = 4;
const MAX_IMAGE_CHARS = 8_000_000;

function validImage(image) {
  return (
    image !== null &&
    typeof image === "object" &&
    typeof image.mimeType === "string" &&
    image.mimeType.startsWith("image/") &&
    typeof image.data === "string" &&
    image.data.length > 0 &&
    image.data.length <= MAX_IMAGE_CHARS
  );
}

// ----- custom window controls (frameless TitleBar) -----
const windowApi = {
  minimize: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximize: () => ipcRenderer.invoke("window:toggleMaximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  isMaximized: () => ipcRenderer.invoke("window:isMaximized"),
  onWindowStateChanged: (callback) => {
    if (typeof callback !== "function") return () => {};
    const handler = (_event, data) => {
      try {
        callback(data);
      } catch (error) {
        console.error("omega window state callback failed", error);
      }
    };
    ipcRenderer.on("window:maximizedChanged", handler);
    return () => ipcRenderer.removeListener("window:maximizedChanged", handler);
  },
};

function safeString(value, max) {
  return typeof value === "string" ? value.slice(0, max) : undefined;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

contextBridge.exposeInMainWorld("omega", {
  ...windowApi,
  // ----- legacy contract (unchanged) -----
  prompt: (text, behavior, images) => {
    if (typeof text !== "string" || !text.trim()) return Promise.resolve({ ok: false, code: "invalid_prompt", message: "Prompt must be a non-empty string" });
    if (text.length > MAX_PROMPT_CHARS) return Promise.resolve({ ok: false, code: "prompt_too_large", message: `Prompt exceeds ${MAX_PROMPT_CHARS} characters` });
    if (behavior !== undefined && behavior !== "steer" && behavior !== "followUp") {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "behavior must be steer|followUp" });
    }
    if (images !== undefined) {
      if (!Array.isArray(images) || images.length === 0 || images.length > MAX_PROMPT_IMAGES || !images.every(validImage)) {
        return Promise.resolve({ ok: false, code: "invalid_args", message: `images must be 1-${MAX_PROMPT_IMAGES} {mimeType,data} entries` });
      }
    }
    return ipcRenderer.invoke("agent:prompt", text, behavior, images);
  },
  abort: () => ipcRenderer.invoke("agent:abort"),
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
  sessionReady: () => ipcRenderer.invoke("omega:sessionReady"),
  getState: () => ipcRenderer.invoke("omega:getState"),
  listModels: () => ipcRenderer.invoke("omega:listModels"),
  setModel: (req) => {
    if (!req || typeof req.provider !== "string" || typeof req.modelId !== "string") {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "provider and modelId are required" });
    }
    return ipcRenderer.invoke("omega:setModel", {
      provider: req.provider.slice(0, 256),
      modelId: req.modelId.slice(0, 256),
    });
  },
  setThinkingLevel: (req) => {
    const allowed = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
    if (!req || typeof req.level !== "string" || !allowed.includes(req.level)) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "level must be a supported thinking level" });
    }
    return ipcRenderer.invoke("omega:setThinkingLevel", { level: req.level });
  },
  listCommands: () => ipcRenderer.invoke("omega:listCommands"),
  compact: () => ipcRenderer.invoke("omega:compact"),
  authStatus: () => ipcRenderer.invoke("omega:authStatus"),
  listPiSessions: () => ipcRenderer.invoke("omega:listPiSessions"),
  newPiSession: (req) => {
    if (req && req.title !== undefined && (typeof req.title !== "string" || req.title.length > 256)) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "title must be a short string" });
    }
    if (req && req.workspace !== undefined && typeof req.workspace !== "string") {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "workspace must be a string" });
    }
    return ipcRenderer.invoke("omega:newPiSession", {
      title: safeString(req?.title, 256),
      workspace: safeString(req?.workspace, 4096),
    });
  },
  switchPiSession: (req) => {
    if (!req || typeof req.sessionId !== "string" || !req.sessionId.trim()) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "sessionId is required" });
    }
    return ipcRenderer.invoke("omega:switchPiSession", { sessionId: req.sessionId });
  },
  setSessionName: (req) => {
    if (!req || typeof req.name !== "string" || !req.name.trim()) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "name must be a non-empty string" });
    }
    return ipcRenderer.invoke("omega:setSessionName", { name: req.name.slice(0, 256) });
  },
  updateSettings: (req) => {
    const payload = {};
    if (req?.steeringMode === "all" || req?.steeringMode === "one-at-a-time") payload.steeringMode = req.steeringMode;
    if (req?.followUpMode === "all" || req?.followUpMode === "one-at-a-time") payload.followUpMode = req.followUpMode;
    if (typeof req?.autoCompaction === "boolean") payload.autoCompaction = req.autoCompaction;
    if (typeof req?.autoRetry === "boolean") payload.autoRetry = req.autoRetry;
    return ipcRenderer.invoke("omega:updateSettings", payload);
  },
  clearQueue: () => ipcRenderer.invoke("omega:clearQueue"),
  getSessionTree: () => ipcRenderer.invoke("omega:getSessionTree"),
  getForkCandidates: () => ipcRenderer.invoke("omega:getForkCandidates"),
  fork: (req) => {
    if (!req || typeof req.entryId !== "string" || !req.entryId.trim()) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "entryId is required" });
    }
    return ipcRenderer.invoke("omega:fork", { entryId: req.entryId });
  },
  navigateTree: (req) => {
    if (!req || typeof req.targetId !== "string" || !req.targetId.trim()) {
      return Promise.resolve({ ok: false, code: "invalid_args", message: "targetId is required" });
    }
    return ipcRenderer.invoke("omega:navigateTree", { targetId: req.targetId });
  },
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
