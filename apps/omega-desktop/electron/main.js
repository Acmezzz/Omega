/**
 * Electron main process — UI host + IPC surface.
 *
 * R4: the agent runtime lives in a utilityProcess worker (electron/worker.mjs,
 * architecture ported from pi-app, MIT). Main owns the window, all privileged
 * fs/git operations, and proxies every agent RPC to the worker with
 * requestId correlation + timeouts. A crashing extension no longer kills the
 * window. Renderer-facing IPC contracts are unchanged.
 */
import {
  app,
  BrowserWindow,
  ipcMain,
  Menu,
  Notification,
  session as electronSession,
  shell,
  utilityProcess,
} from "electron";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { piSessionsRoot, THINKING_LEVELS } from "./agent-bridge.js";
import { buildSessionHtml } from "./export-html.js";
import * as persistence from "./persistence.js";
import * as stateReader from "./state-reader.js";
import * as diffService from "./diff-service.js";
import * as workspaceService from "./workspace-service.js";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = resolve(MAIN_DIR, "..", "..", "..");
const MAX_PROMPT_CHARS = 40_000;
const PROMPT_BEHAVIORS = ["steer", "followUp"];
const MAX_PROMPT_IMAGES = 4;
const MAX_IMAGE_CHARS = 8_000_000;
const WORKER_RPC_TIMEOUT = 120_000;
let win;
let worker = null;
let bootstrapError = null;
let shuttingDown = false;
let activeCwd = null;
let agentReady = false;

function rootOf() {
  return app.isPackaged ? (process.resourcesPath ? join(process.resourcesPath, "omega-runtime") : app.getAppPath()) : DEV_ROOT;
}

function extensionsRootOf() {
  return process.env.OMEGA_EXTENSIONS_ROOT ?? (app.isPackaged ? join(rootOf(), ".pi", "extensions") : join(DEV_ROOT, ".pi", "extensions"));
}

function sessionsRoot() {
  return join(app.getPath("userData"), "omega", "sessions");
}

function rendererPath() {
  const candidate = app.isPackaged ? join(app.getAppPath(), "index.html") : join(MAIN_DIR, "..", "index.html");
  if (!existsSync(candidate)) throw new Error(`Renderer entry not found: ${candidate}`);
  return candidate;
}

function expectedPageUrl() {
  return pathToFileURL(rendererPath()).toString();
}

function senderAllowed(event) {
  return Boolean(win && !win.isDestroyed() && event.sender === win.webContents && event.senderFrame === win.webContents.mainFrame);
}

function errorResult(code, message) {
  return { ok: false, code, message };
}

function okResult(data) {
  return { ok: true, data: data };
}

// ---------------------------------------------------------------------------
// Worker host (requestId RPC + event forwarding, port of pi-app's slot logic)
// ---------------------------------------------------------------------------

class WorkerHost {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.seq = 0;
    this.onEvent = null;
    this.onSettled = null;
    this.onError = null;
    this._initResolve = null;
    this._initReject = null;
  }

  async start(cwd, extensionsRoot) {
    this.child = utilityProcess.fork(join(MAIN_DIR, "worker.mjs"), [], { stdio: "ignore" });
    this.child.on("message", (message) => this._handle(message));
    const done = new Promise((resolvePromise, rejectPromise) => {
      this._initResolve = resolvePromise;
      this._initReject = rejectPromise;
      setTimeout(() => rejectPromise(new Error("Worker init timeout (60s)")), 60_000);
    });
    this.child.postMessage({ type: "init", cwd, extensionsRoot });
    return done;
  }

  _handle(message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "init-done") {
      this._initResolve?.(message);
      return;
    }
    if (message.type === "init-error") {
      this._initReject?.(new Error(message.error));
      return;
    }
    if (message.type === "app-event") {
      this.onEvent?.(message.event);
      return;
    }
    if (message.type === "settled") {
      this.onSettled?.();
      return;
    }
    if (message.type === "worker-error") {
      process.stderr.write(`[worker] ${message.error}\n`);
      this.onError?.(message.error);
      return;
    }
    if (message.type === "resp") {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        const error = new Error(message.error);
        if (message.code) error.code = message.code;
        pending.reject(error);
      } else {
        pending.resolve(message.data ?? null);
      }
    }
  }

  call(method, args) {
    if (!this.child) return Promise.reject(new Error("session not ready"));
    const id = `req-${++this.seq}`;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPromise(new Error(`Worker RPC timeout: ${method}`));
      }, WORKER_RPC_TIMEOUT);
      this.pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      this.child.postMessage({ type: "req", id, method, args: args ?? {} });
    });
  }

  async kill() {
    if (!this.child) return;
    try {
      await this.call("dispose");
    } catch {
      /* best effort */
    }
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("worker disposed"));
    }
    this.pending.clear();
    try {
      this.child.kill();
    } catch {
      /* already gone */
    }
    this.child = null;
  }
}

/** Wrap a worker RPC into an IpcResult, mapping worker error codes through. */
async function rpc(method, args, fallbackCode = "call_failed") {
  try {
    return okResult(await worker.call(method, args));
  } catch (error) {
    return errorResult(error?.code ?? fallbackCode, error instanceof Error ? error.message : String(error));
  }
}

async function bootstrap() {
  const cwd = process.env.OMEGA_WORKSPACE ? resolve(process.env.OMEGA_WORKSPACE) : rootOf();
  activeCwd = cwd;
  const extensionsRoot = extensionsRootOf();
  process.stdout.write(`[main] cwd=${cwd}\n`);
  worker = new WorkerHost();
  worker.onEvent = (event) => {
    if (!win || win.isDestroyed()) return;
    win.webContents.send("agent:event", event);
  };
  worker.onSettled = () => {
    if (!win || win.isDestroyed() || win.isFocused()) return;
    if (!Notification.isSupported()) return;
    try {
      new Notification({ title: "Omega Desktop", body: "回复已完成，点击查看" }).show();
    } catch {
      /* best effort */
    }
  };
  const info = await worker.start(cwd, extensionsRoot);
  activeCwd = info.cwd ?? cwd;
  agentReady = true;
  process.stdout.write("[main] agent worker ready\n");
}

function showBootstrapError(error) {
  bootstrapError = error instanceof Error ? error.stack ?? error.message : String(error);
}

function requireWorker() {
  if (!worker || shuttingDown) throw new Error("session not ready");
  return worker;
}

async function createWindow() {
  const frameless = process.platform === "win32";
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Omega Desktop",
    frame: !frameless,
    webPreferences: {
      preload: join(MAIN_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  Menu.setApplicationMenu(null);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12") {
      win?.webContents.toggleDevTools();
      event.preventDefault();
    } else if (input.key === "F11") {
      if (win) win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });
  win.on("maximize", () => win?.webContents.send("window:maximizedChanged", true));
  win.on("unmaximize", () => win?.webContents.send("window:maximizedChanged", false));
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== expectedPageUrl()) event.preventDefault();
  });
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.webContents.on("console-message", (details) => {
    process.stdout.write(`[renderer] [${details.level}] ${details.message}\n`);
  });
  win.on("closed", () => {
    win = undefined;
  });
  if (bootstrapError) {
    await win.loadFile(rendererPath());
    win.webContents.send("app:bootstrap-error", { message: bootstrapError.slice(0, 2_000) });
  } else {
    await win.loadFile(rendererPath());
  }
  win.show();
  if (process.env.OMEGA_AUTOTEST === "1" && worker) {
    setTimeout(() => {
      rpc("prompt", { text: "Reply with exactly: hello from omega-desktop" })
        .then(() => process.stdout.write("[main] autotest prompt: ok\n"))
        .then(() => rpc("sessionRecord"))
        .then((record) => {
          if (record.ok) process.stdout.write(`[main] autotest record: ${record.data.messages.length} messages\n`);
        })
        .catch((error) => process.stdout.write(`[main] autotest prompt failed: ${error instanceof Error ? error.message : String(error)}\n`));
    }, 500);
    setTimeout(async () => {
      if (process.env.OMEGA_DOMPROBE && win && !win.isDestroyed()) {
        try {
          const probe = await win.webContents.executeJavaScript(`(() => {
            const pick = (sel, props) => {
              const el = document.querySelector(sel);
              if (!el) return { sel, missing: true };
              const cs = getComputedStyle(el);
              return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]));
            };
            return JSON.stringify({
              htmlClass: document.documentElement.className,
              body: pick("body", ["color", "background-color"]),
              tab: pick(".MuiTab-root", ["color"]),
            });
          })()`);
          process.stdout.write(`[main] domprobe ${probe}\n`);
        } catch (error) {
          process.stdout.write(`[main] domprobe failed: ${String(error)}\n`);
        }
      }
      const forcedTheme = process.env.OMEGA_THEME;
      if (forcedTheme && win && !win.isDestroyed()) {
        try {
          await win.webContents.executeJavaScript(
            `localStorage.setItem("omega-theme", ${JSON.stringify(JSON.stringify(forcedTheme))})`,
          );
          await win.webContents.reload();
          await new Promise((resolveTimer) => setTimeout(resolveTimer, 4000));
        } catch (error) {
          process.stdout.write(`[main] theme force failed: ${String(error)}\n`);
        }
      }
      const screenshotPath = process.env.OMEGA_SCREENSHOT;
      if (screenshotPath && win && !win.isDestroyed()) {
        try {
          win.show();
          let saved = false;
          for (let attempt = 0; attempt < 4 && !saved; attempt += 1) {
            try {
              const image = await win.webContents.capturePage();
              if (!image.isEmpty()) {
                writeFileSync(screenshotPath, image.toPNG());
                saved = true;
              }
            } catch {
              /* capture can fail right after reload — retry */
            }
            if (!saved) await new Promise((resolveTimer) => setTimeout(resolveTimer, 1000));
          }
          if (!saved) throw new Error("capturePage failed after retries");
          process.stdout.write(`[main] screenshot saved -> ${screenshotPath}\n`);
        } catch (error) {
          process.stdout.write(`[main] screenshot failed: ${String(error)}\n`);
        }
      }
      process.stdout.write("[main] autotest done, quitting\n");
      void shutdown().finally(() => app.quit());
    }, 25_000);
  }
}

// ---------------------------------------------------------------------------
// IPC: agent surface (proxied to the worker)
// ---------------------------------------------------------------------------

ipcMain.handle("omega:sessionReady", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return okResult({ ready: agentReady });
});

ipcMain.handle("window:minimize", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  win?.minimize();
  return okResult(undefined);
});

ipcMain.handle("window:toggleMaximize", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (win) {
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  }
  return okResult({ maximized: Boolean(win?.isMaximized()) });
});

ipcMain.handle("window:close", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  win?.close();
  return okResult(undefined);
});

ipcMain.handle("window:isMaximized", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return okResult({ maximized: Boolean(win?.isMaximized()) });
});

function normalizePromptImages(images) {
  if (images === undefined) return undefined;
  if (!Array.isArray(images) || images.length === 0) return undefined;
  if (images.length > MAX_PROMPT_IMAGES) {
    throw new Error(`At most ${MAX_PROMPT_IMAGES} images per prompt`);
  }
  return images.map((image) => {
    if (
      !image ||
      typeof image !== "object" ||
      typeof image.mimeType !== "string" ||
      !image.mimeType.startsWith("image/") ||
      typeof image.data !== "string" ||
      !image.data
    ) {
      throw new Error("Each image needs an image/* mimeType and base64 data");
    }
    if (image.data.length > MAX_IMAGE_CHARS) {
      throw new Error("Image exceeds the size limit");
    }
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
}

ipcMain.handle("agent:prompt", async (event, text, behavior, images) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (typeof text !== "string" || !text.trim()) return errorResult("invalid_prompt", "Prompt must be a non-empty string");
  if (text.length > MAX_PROMPT_CHARS) return errorResult("prompt_too_large", `Prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (behavior !== undefined && !PROMPT_BEHAVIORS.includes(behavior)) {
    return errorResult("invalid_args", "behavior must be 'steer' or 'followUp'");
  }
  if (bootstrapError) return errorResult("bootstrap_failed", "Agent initialization failed");
  let imageContents;
  try {
    imageContents = normalizePromptImages(images);
  } catch (error) {
    return errorResult("invalid_args", error instanceof Error ? error.message : String(error));
  }
  return rpc("prompt", { text: text.trim(), behavior, images: imageContents }, "prompt_failed");
});

ipcMain.handle("agent:abort", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (bootstrapError) return errorResult("bootstrap_failed", "Agent initialization failed");
  return rpc("abort", {}, "abort_failed");
});

ipcMain.handle("omega:getState", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (bootstrapError) return errorResult("bootstrap_failed", "Agent initialization failed");
  return rpc("getState", {}, "read_failed");
});

ipcMain.handle("omega:listModels", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("listModels", {}, "read_failed");
});

ipcMain.handle("omega:setModel", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.provider !== "string" || typeof req.modelId !== "string") {
    return errorResult("invalid_args", "provider and modelId are required");
  }
  return rpc("setModel", { provider: req.provider, modelId: req.modelId }, "write_failed");
});

ipcMain.handle("omega:setThinkingLevel", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.level !== "string" || !THINKING_LEVELS.includes(req.level)) {
    return errorResult("invalid_args", "level must be a supported thinking level");
  }
  return rpc("setThinkingLevel", { level: req.level }, "write_failed");
});

ipcMain.handle("omega:listCommands", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("listCommands", {}, "read_failed");
});

ipcMain.handle("omega:compact", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("compact", {}, "compact_failed");
});

ipcMain.handle("omega:updateSettings", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const payload = {};
  if (req?.steeringMode === "all" || req?.steeringMode === "one-at-a-time") payload.steeringMode = req.steeringMode;
  if (req?.followUpMode === "all" || req?.followUpMode === "one-at-a-time") payload.followUpMode = req.followUpMode;
  if (typeof req?.autoCompaction === "boolean") payload.autoCompaction = req.autoCompaction;
  if (typeof req?.autoRetry === "boolean") payload.autoRetry = req.autoRetry;
  return rpc("updateSettings", payload, "write_failed");
});

ipcMain.handle("omega:clearQueue", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("clearQueue", {}, "write_failed");
});

ipcMain.handle("omega:getSessionTree", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("getSessionTree", {}, "read_failed");
});

ipcMain.handle("omega:getForkCandidates", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("getForkCandidates", {}, "read_failed");
});

ipcMain.handle("omega:fork", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.entryId !== "string" || !req.entryId.trim()) {
    return errorResult("invalid_args", "entryId is required");
  }
  return rpc("fork", { entryId: req.entryId }, "write_failed");
});

ipcMain.handle("omega:navigateTree", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.targetId !== "string" || !req.targetId.trim()) {
    return errorResult("invalid_args", "targetId is required");
  }
  return rpc("navigateTree", { targetId: req.targetId }, "write_failed");
});

ipcMain.handle("omega:authStatus", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("authStatus", {}, "read_failed");
});

ipcMain.handle("omega:listPiSessions", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("listPiSessions", { cwd: activeCwd ?? rootOf() }, "read_failed");
});

ipcMain.handle("omega:newPiSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const workspace = req?.workspace ? resolve(req.workspace) : activeCwd ?? rootOf();
  const result = await rpc("newSession", { workspace, title: req?.title }, "write_failed");
  if (result.ok) activeCwd = result.data.workspace || workspace;
  return result;
});

ipcMain.handle("omega:switchPiSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  const result = await rpc("switchSession", { sessionId: req.sessionId }, "read_failed");
  if (result.ok) activeCwd = result.data.workspace || activeCwd;
  return result;
});

ipcMain.handle("omega:setSessionName", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.name !== "string" || !req.name.trim()) {
    return errorResult("invalid_args", "name must be a non-empty string");
  }
  return rpc("setSessionName", { name: req.name.trim() }, "write_failed");
});

ipcMain.handle("omega:getThinking", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.entryId !== "string" || !req.entryId.trim()) {
    return errorResult("invalid_args", "entryId is required");
  }
  return rpc("getThinking", { entryId: req.entryId }, "read_failed");
});

ipcMain.handle("omega:listResources", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("listResources", {}, "read_failed");
});

ipcMain.handle("omega:getSystemPrompt", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return rpc("getSystemPrompt", {}, "read_failed");
});

ipcMain.handle("omega:exportHtml", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    requireWorker();
    const record = await worker.call("sessionRecord");
    const dir = join(app.getPath("userData"), "exports");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${record.id}-${Date.now()}.html`);
    writeFileSync(file, buildSessionHtml(record), "utf8");
    void shell.showItemInFolder(file);
    return okResult({ path: file });
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:bash", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const command = typeof req?.command === "string" ? req.command.trim() : "";
  if (!command) return errorResult("invalid_args", "command is required");
  if (command.length > 8192) return errorResult("invalid_args", "command too long");
  const result = await rpc("bash", { command, excludeFromContext: req?.excludeFromContext === true }, "bash_failed");
  if (result.ok && result.data) {
    return okResult({ output: result.data.output, exitCode: result.data.exitCode, cancelled: result.data.cancelled });
  }
  return result;
});

ipcMain.handle("omega:queryExtensionState", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const bundle = stateReader.readExtensionState({
      scope: req?.scope ?? "all",
      projectKey: req?.projectKey,
      taskId: req?.taskId,
      cwd: activeCwd ?? undefined,
    });
    return okResult(bundle);
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:listSessions", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const result = await rpc("listPiSessions", { cwd: activeCwd ?? rootOf() }, "read_failed");
  if (result.ok && Array.isArray(result.data) && result.data.length > 0) return result;
  try {
    return okResult(persistence.list(sessionsRoot()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:newSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const workspace = req?.workspace ? resolve(req.workspace) : activeCwd ?? rootOf();
  const result = await rpc("newSession", { workspace, title: req?.title }, "write_failed");
  if (result.ok) activeCwd = result.data.workspace || workspace;
  return result;
});

ipcMain.handle("omega:loadSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  const result = await rpc("switchSession", { sessionId: req.sessionId }, "read_failed");
  if (result.ok) activeCwd = result.data.workspace || activeCwd;
  return result;
});

ipcMain.handle("omega:saveSession", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId || !req?.transcript) return errorResult("invalid_args", "sessionId and transcript are required");
  try {
    persistence.save(sessionsRoot(), req.transcript);
    return okResult(undefined);
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:deleteSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId || typeof req.sessionId !== "string") return errorResult("invalid_args", "sessionId is required");
  try {
    const target = req.sessionId;
    const state = await requireWorker().call("getState");
    if (state?.sessionId === target) {
      const result = await rpc("newSession", {}, "write_failed");
      if (!result.ok) return result;
    }
    const sessionPath = await requireWorker().call("resolveSessionPath", { sessionId: target });
    if (sessionPath) {
      // Defense in depth: only ever delete files inside the pi sessions root.
      const root = resolve(piSessionsRoot()).toLowerCase();
      const resolved = resolve(String(sessionPath)).toLowerCase();
      const inRoot = resolved === root || resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`);
      if (!inRoot) return errorResult("forbidden", "Refusing to delete a file outside the pi sessions directory");
      if (existsSync(resolved)) unlinkSync(resolved);
    }
    try {
      persistence.remove(sessionsRoot(), target);
    } catch {
      /* JSON cache is best-effort */
    }
    return okResult(undefined);
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:diffWorkspace", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(diffService.computeDiff(activeCwd ?? rootOf()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

function requireString(req, field, max = 4096) {
  if (typeof req?.[field] !== "string" || !req[field] || req[field].length > max) {
    throw new Error(`${field} is required`);
  }
  return req[field];
}

ipcMain.handle("omega:listDir", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const rel = typeof req?.path === "string" ? req.path : "";
    if (rel.length > 4096) return errorResult("invalid_args", "path too long");
    return okResult(workspaceService.listDir(activeCwd ?? rootOf(), rel));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:readFile", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(workspaceService.readFile(activeCwd ?? rootOf(), requireString(req, "path")));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:fileIndex", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const query = typeof req?.query === "string" ? req.query.slice(0, 256) : "";
    return okResult(workspaceService.fileIndex(activeCwd ?? rootOf(), query));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:gitSnapshot", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(diffService.computeSnapshot(activeCwd ?? rootOf()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

function normalizeGitItems(req) {
  if (!Array.isArray(req?.items)) throw new Error("items[] is required");
  return req.items.slice(0, 200).map((item) => ({
    path: typeof item?.path === "string" ? item.path.slice(0, 4096) : "",
    hunks: Array.isArray(item?.hunks) ? item.hunks.filter((hunk) => typeof hunk === "string").slice(0, 100) : undefined,
  }));
}

ipcMain.handle("omega:gitStage", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(diffService.stageItems(activeCwd ?? rootOf(), normalizeGitItems(req)));
  } catch (error) {
    return errorResult("git_unavailable", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:gitUnstage", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(diffService.unstageItems(activeCwd ?? rootOf(), normalizeGitItems(req)));
  } catch (error) {
    return errorResult("git_unavailable", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:gitCommit", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const message = typeof req?.message === "string" ? req.message.trim() : "";
  if (!message) return errorResult("invalid_args", "message is required");
  if (message.length > 8000) return errorResult("invalid_args", "message too long");
  try {
    return okResult(diffService.commitIndexed(activeCwd ?? rootOf(), message));
  } catch (error) {
    return errorResult("git_unavailable", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:approveChange", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || (req.action !== "accept" && req.action !== "reject")) {
    return errorResult("invalid_args", "action must be 'accept' or 'reject'");
  }
  try {
    const cwd = activeCwd ?? rootOf();
    const result =
      req.action === "accept"
        ? diffService.acceptChanges()
        : diffService.revertFiles(Array.isArray(req.files) ? req.files : [], cwd);
    return okResult(result);
  } catch (error) {
    return errorResult("git_unavailable", error instanceof Error ? error.message : String(error));
  }
});

// ---------------------------------------------------------------------------

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  await worker?.kill();
  worker = null;
}

app
  .whenReady()
  .then(async () => {
    try {
      await bootstrap();
    } catch (error) {
      showBootstrapError(error);
      process.stderr.write(`[main] bootstrap failed: ${bootstrapError}\n`);
    }
    try {
      await createWindow();
    } catch (error) {
      process.stderr.write(`[main] window failed: ${String(error)}\n`);
      await shutdown();
      app.exit(1);
    }
    app.on("activate", () => {
      if (!BrowserWindow.getAllWindows().length) void createWindow();
    });
  })
  .catch((error) => {
    process.stderr.write(`[main] startup failed: ${String(error)}\n`);
    app.exit(1);
  });

app.on("before-quit", () => {
  void shutdown();
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
