/** Electron main process. Agent stays privileged here; renderer only receives safe DTOs. */
import { app, BrowserWindow, ipcMain, Menu, Notification, session as electronSession } from "electron";
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  authStatusOf,
  createRuntime,
  findModel,
  forgetSessionPath,
  listCommands,
  listModels,
  listPiSessions,
  piSessionsRoot,
  resolveSessionPath,
  sessionRecordOf,
  snapshotOf,
  streamToRenderer,
  THINKING_LEVELS,
} from "./agent-bridge.js";
import * as persistence from "./persistence.js";
import * as stateReader from "./state-reader.js";
import * as diffService from "./diff-service.js";

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
      const screenshotPath = process.env.OMEGA_SCREENSHOT;
      if (screenshotPath && win && !win.isDestroyed()) {
        try {
          const image = await win.webContents.capturePage();
          writeFileSync(screenshotPath, image.toPNG());
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

function promptInternal(text, behavior, images) {
  const run = promptQueue.then(async () => {
    const session = requireSession();
    const options = behavior ? { streamingBehavior: behavior } : { streamingBehavior: "followUp" };
    if (images) options.images = images;
    await session.prompt(text, options);
    // Auto-title: name the session after the first user message so the list
    // stays readable without an extra LLM round-trip.
    try {
      if (!session.sessionName) {
        const name = text.replace(/\s+/g, " ").trim().slice(0, 40);
        if (name) session.setSessionName(name);
      }
    } catch {
      /* best effort */
    }
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
    const record = sessionRecordOf(runtime);
    try {
      persistence.create(sessionsRoot(), {
        title: record.title,
        workspace: record.workspace,
        projectKey: typeof req?.projectKey === "string" ? req.projectKey : undefined,
      });
    } catch {
      /* cache is optional */
    }
    return okResult(record);
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:loadSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  try {
    const sessionPath = await resolveSessionPath(req.sessionId);
    if (sessionPath) {
      const cancelled = await requireRuntime().switchSession(sessionPath);
      if (cancelled.cancelled) return errorResult("cancelled", "Session switch cancelled");
      bindStream();
      activeCwd = runtime.cwd;
      return okResult(sessionRecordOf(runtime));
    }
    const record = persistence.load(sessionsRoot(), req.sessionId);
    if (!record) return errorResult("not_found", "Session not found");
    if (record.workspace) {
      const workspace = resolve(record.workspace);
      if (workspace !== requireRuntime().cwd) {
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
        bindStream();
        activeCwd = workspace;
      }
    }
    return okResult(record);
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
