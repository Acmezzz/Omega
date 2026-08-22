/** Electron main process. Agent stays privileged here; renderer only receives safe DTOs. */
import { app, BrowserWindow, ipcMain, Menu, Notification, session as electronSession } from "electron";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  authStatusOf,
  createRuntime,
  findModel,
  forkCandidatesOf,
  forgetSessionPath,
  listCommands,
  listModels,
  listPiSessions,
  piSessionsRoot,
  resolveSessionPath,
  sessionRecordOf,
  sessionTreeOf,
  snapshotOf,
  streamToRenderer,
  THINKING_LEVELS,
} from "./agent-bridge.js";
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
let win;
let runtime;
let unsubscribe;
let bootstrapError = null;
let shuttingDown = false;
let promptQueue = Promise.resolve();
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

function currentSession() {
  return runtime?.session;
}

function bindStream() {
  try {
    unsubscribe?.();
  } catch {
    /* best effort */
  }
  unsubscribe = undefined;
  if (!runtime || !win || win.isDestroyed()) return;
  unsubscribe = streamToRenderer(runtime.session, win.webContents, {
    // Notify when a response settles while the window is not focused.
    onSettled: () => {
      if (!win || win.isDestroyed() || win.isFocused()) return;
      if (!Notification.isSupported()) return;
      try {
        new Notification({ title: "Omega Desktop", body: "回复已完成，点击查看" }).show();
      } catch {
        /* best effort */
      }
    },
  });
  agentReady = true;
}

function requireSession() {
  const session = currentSession();
  if (!session || shuttingDown) throw new Error("session not ready");
  return session;
}

async function bootstrap() {
  const cwd = process.env.OMEGA_WORKSPACE ? resolve(process.env.OMEGA_WORKSPACE) : rootOf();
  activeCwd = cwd;
  const extensionsRoot = extensionsRootOf();
  process.stdout.write(`[main] cwd=${cwd}\n`);
  runtime = await createRuntime({ cwd, extensionsRoot });
  runtime.setRebindSession(async () => {
    bindStream();
    activeCwd = runtime.cwd;
  });
  process.stdout.write("[main] agent session ready\n");
}

function showBootstrapError(error) {
  bootstrapError = error instanceof Error ? error.stack ?? error.message : String(error);
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
  // Replace the native menu bar with the in-app TitleBar; window controls are
  // custom-drawn (window:minimize/toggleMaximize/close) and F11/F12 are kept
  // for fullscreen and devtools.
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
    unsubscribe?.();
    unsubscribe = undefined;
    win = undefined;
  });
  if (bootstrapError) {
    await win.loadFile(rendererPath());
    win.webContents.send("app:bootstrap-error", { message: bootstrapError.slice(0, 2_000) });
  } else {
    bindStream();
    await win.loadFile(rendererPath());
  }
  win.show();
  if (process.env.OMEGA_AUTOTEST === "1" && currentSession()) {
    // loadFile above has already resolved, i.e. the page finished loading —
    // waiting for another did-finish-load here would never fire.
    setTimeout(() => {
      promptInternal("Reply with exactly: hello from omega-desktop")
        .then(() => process.stdout.write("[main] autotest prompt: ok\n"))
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
              accentVar: getComputedStyle(document.documentElement).getPropertyValue("--omega-accent").trim(),
              body: pick("body", ["color", "background-color"]),
              title: pick('[data-omega-title]', ["color"]),
              tab: pick(".MuiTab-root", ["color"]),
              tabSelected: pick(".MuiTab-root.Mui-selected", ["color"]),
              chip: pick(".MuiChip-root", ["color", "background-color"]),
              toolbarBtn: pick(".MuiIconButton-root", ["color"]),
            }, null, 1);
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
          await new Promise((resolve) => setTimeout(resolve, 4000));
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
            if (!saved) await new Promise((resolve) => setTimeout(resolve, 1000));
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

function autoTitleFor(session, text) {
  // Skip placeholder/slash payloads — they make useless titles.
  if (!text || text.startsWith("/") || text === "（请查看图片）") return;
  try {
    if (!session.sessionName) {
      const name = text.replace(/\s+/g, " ").trim().slice(0, 40);
      if (name) session.setSessionName(name);
    }
  } catch {
    /* best effort */
  }
}

function promptInternal(text, behavior, images) {
  const session = requireSession();
  const options = { streamingBehavior: behavior ?? "followUp" };
  if (images) options.images = images;
  // While a turn is streaming, prompt() only enqueues (steer/followUp) and
  // resolves immediately — it must NOT sit in the serial promptQueue behind
  // the running turn, or a steer would arrive after the turn already ended.
  if (session.isStreaming) {
    return session.prompt(text, options).then(() => autoTitleFor(session, text));
  }
  const run = promptQueue.then(async () => {
    const queued = requireSession();
    await queued.prompt(text, options);
    autoTitleFor(queued, text);
  });
  promptQueue = run.catch(() => {});
  return run;
}

function requireRuntime() {
  if (!runtime || shuttingDown) throw new Error("session not ready");
  return runtime;
}

// ---------------------------------------------------------------------------
// Agent prompt + abort (legacy prompt contract kept)
// ---------------------------------------------------------------------------

ipcMain.handle("omega:sessionReady", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  return okResult({ ready: agentReady });
});

// ---------------------------------------------------------------------------
// Custom window controls (frameless TitleBar)
// ---------------------------------------------------------------------------

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

ipcMain.handle("omega:getState", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!runtime) return errorResult("bootstrap_failed", "Agent initialization failed");
  try {
    return okResult(snapshotOf(runtime));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
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
  try {
    await promptInternal(text.trim(), behavior, imageContents);
    return okResult(undefined);
  } catch (error) {
    return errorResult("prompt_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("agent:abort", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (bootstrapError) return errorResult("bootstrap_failed", "Agent initialization failed");
  try {
    await requireSession().abort();
    return okResult(undefined);
  } catch (error) {
    return errorResult("abort_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:listModels", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(listModels(requireRuntime()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:setModel", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.provider !== "string" || typeof req.modelId !== "string") {
    return errorResult("invalid_args", "provider and modelId are required");
  }
  try {
    const current = requireRuntime();
    const model = findModel(current, req.provider, req.modelId);
    if (!model) return errorResult("not_found", `Model ${req.provider}/${req.modelId} is not available`);
    await current.session.setModel(model);
    return okResult(snapshotOf(current));
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:setThinkingLevel", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.level !== "string" || !THINKING_LEVELS.includes(req.level)) {
    return errorResult("invalid_args", "level must be a supported thinking level");
  }
  try {
    const current = requireRuntime();
    current.session.setThinkingLevel(req.level);
    return okResult(snapshotOf(current));
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:listCommands", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(listCommands(requireRuntime()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:compact", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const current = requireRuntime();
    await current.session.compact();
    return okResult(snapshotOf(current));
  } catch (error) {
    return errorResult("compact_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:setSessionName", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.name !== "string" || !req.name.trim()) {
    return errorResult("invalid_args", "name must be a non-empty string");
  }
  try {
    const current = requireRuntime();
    current.session.setSessionName(req.name.trim().slice(0, 256));
    return okResult(snapshotOf(current));
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:updateSettings", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const session = requireRuntime().session;
    if (req?.steeringMode === "all" || req?.steeringMode === "one-at-a-time") session.setSteeringMode(req.steeringMode);
    if (req?.followUpMode === "all" || req?.followUpMode === "one-at-a-time") session.setFollowUpMode(req.followUpMode);
    if (typeof req?.autoCompaction === "boolean") session.setAutoCompactionEnabled(req.autoCompaction);
    if (typeof req?.autoRetry === "boolean") session.setAutoRetryEnabled(req.autoRetry);
    return okResult(snapshotOf(requireRuntime()));
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:clearQueue", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const cleared = requireRuntime().session.clearQueue();
    return okResult(cleared);
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:getSessionTree", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(sessionTreeOf(requireRuntime()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:getForkCandidates", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(forkCandidatesOf(requireRuntime()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

function sessionBusyResult(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/current response|is streaming|wait/i.test(message)) {
    return errorResult("session_busy", "生成中无法切换分支或会话，请先停止或等待完成");
  }
  return errorResult("write_failed", message);
}

ipcMain.handle("omega:fork", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.entryId !== "string" || !req.entryId.trim()) {
    return errorResult("invalid_args", "entryId is required");
  }
  try {
    const current = requireRuntime();
    const result = await current.fork(req.entryId.trim(), { position: "before" });
    if (result.cancelled) return errorResult("cancelled", "Fork cancelled");
    bindStream();
    activeCwd = runtime.cwd;
    return okResult({ record: sessionRecordOf(runtime), selectedText: result.selectedText ?? "" });
  } catch (error) {
    return sessionBusyResult(error);
  }
});

ipcMain.handle("omega:navigateTree", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req || typeof req.targetId !== "string" || !req.targetId.trim()) {
    return errorResult("invalid_args", "targetId is required");
  }
  try {
    await requireRuntime().session.navigateTree(req.targetId.trim());
    bindStream();
    return okResult(sessionRecordOf(runtime));
  } catch (error) {
    return sessionBusyResult(error);
  }
});

ipcMain.handle("omega:authStatus", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(authStatusOf(requireRuntime()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:listPiSessions", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(await listPiSessions(activeCwd ?? rootOf()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:newPiSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const current = requireRuntime();
    const workspace = req?.workspace ? resolve(req.workspace) : activeCwd ?? rootOf();
    if (workspace !== current.cwd) {
      try {
        unsubscribe?.();
      } catch {
        /* best effort */
      }
      unsubscribe = undefined;
      try {
        await runtime.dispose();
      } catch (error) {
        process.stderr.write(`[main] dispose failed: ${String(error)}\n`);
      }
      runtime = await createRuntime({ cwd: workspace, extensionsRoot: extensionsRootOf() });
      runtime.setRebindSession(async () => {
        bindStream();
        activeCwd = runtime.cwd;
      });
    }
    const cancelled = await runtime.newSession();
    if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
    bindStream();
    activeCwd = runtime.cwd;
    if (req?.title && typeof req.title === "string") {
      runtime.session.setSessionName(req.title.slice(0, 256));
    }
    return okResult(sessionRecordOf(runtime));
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:switchPiSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  try {
    const current = requireRuntime();
    const sessionPath = await resolveSessionPath(req.sessionId);
    if (!sessionPath) return errorResult("not_found", "Session not found");
    const cancelled = await current.switchSession(sessionPath);
    if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
    bindStream();
    activeCwd = runtime.cwd;
    return okResult(sessionRecordOf(runtime));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

// ---------------------------------------------------------------------------
// Extension state query (read-only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Sessions (JSON cache kept as a UI fallback; JSONL is authoritative)
// ---------------------------------------------------------------------------

ipcMain.handle("omega:listSessions", async (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const pi = await listPiSessions(activeCwd ?? rootOf());
    if (pi.length > 0) return okResult(pi);
    return okResult(persistence.list(sessionsRoot()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:newSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const workspace = req?.workspace ? resolve(req.workspace) : activeCwd ?? rootOf();
    const current = requireRuntime();
    if (workspace !== current.cwd) {
      try {
        unsubscribe?.();
      } catch {
        /* best effort */
      }
      unsubscribe = undefined;
      try {
        await runtime.dispose();
      } catch (error) {
        process.stderr.write(`[main] dispose failed: ${String(error)}\n`);
      }
      runtime = await createRuntime({ cwd: workspace, extensionsRoot: extensionsRootOf() });
      runtime.setRebindSession(async () => {
        bindStream();
        activeCwd = runtime.cwd;
      });
      const cancelled = await runtime.newSession();
      if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
    } else {
      const cancelled = await current.newSession();
      if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
    }
    bindStream();
    activeCwd = runtime.cwd;
    if (req?.title && typeof req.title === "string") {
      runtime.session.setSessionName(req.title.slice(0, 256));
    }
    return okResult(sessionRecordOf(runtime));
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:loadSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  try {
    // JSONL sessions are the only authority. The legacy JSON cache under
    // userData was never updated after creation and pointed at stale
    // workspaces — loading from it desynced the UI from the active runtime.
    const sessionPath = await resolveSessionPath(req.sessionId);
    if (!sessionPath) return errorResult("not_found", "Session not found");
    const cancelled = await requireRuntime().switchSession(sessionPath);
    if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
    bindStream();
    activeCwd = runtime.cwd;
    return okResult(sessionRecordOf(runtime));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
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
    // Deleting the active session: move to a fresh one first so the runtime
    // never holds an open handle to the file being removed.
    if (runtime && runtime.session.sessionId === target) {
      const cancelled = await runtime.newSession();
      if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
      bindStream();
      activeCwd = runtime.cwd;
    }
    const sessionPath = await resolveSessionPath(target);
    if (sessionPath) {
      // Defense in depth: only ever delete files inside the pi sessions root.
      const root = resolve(piSessionsRoot()).toLowerCase();
      const resolved = resolve(sessionPath).toLowerCase();
      const inRoot = resolved === root || resolved.startsWith(`${root}\\`) || resolved.startsWith(`${root}/`);
      if (!inRoot) return errorResult("forbidden", "Refusing to delete a file outside the pi sessions directory");
      if (existsSync(resolved)) unlinkSync(resolved);
      forgetSessionPath(target);
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

// ---------------------------------------------------------------------------
// Diff + approval (privileged git operations)
// ---------------------------------------------------------------------------

ipcMain.handle("omega:diffWorkspace", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const cwd = activeCwd ?? rootOf();
    return okResult(diffService.computeDiff(cwd));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

// ---------------------------------------------------------------------------
// Workspace layer: file tree / viewer / @ index / bash passthrough / git review
// ---------------------------------------------------------------------------

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

ipcMain.handle("omega:bash", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  const command = typeof req?.command === "string" ? req.command.trim() : "";
  if (!command) return errorResult("invalid_args", "command is required");
  if (command.length > 8192) return errorResult("invalid_args", "command too long");
  try {
    const session = requireSession();
    const result = await session.executeBash(command, undefined, {
      excludeFromContext: req?.excludeFromContext === true,
      id: `user-bash-${Date.now()}`,
    });
    return okResult({ output: result.output, exitCode: result.exitCode, cancelled: result.cancelled });
  } catch (error) {
    return errorResult("bash_failed", error instanceof Error ? error.message : String(error));
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
  try {
    unsubscribe?.();
  } catch {
    /* best effort */
  }
  unsubscribe = undefined;
  try {
    await runtime?.dispose();
  } catch (error) {
    process.stderr.write(`[main] dispose failed: ${String(error)}\n`);
  }
  runtime = undefined;
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
