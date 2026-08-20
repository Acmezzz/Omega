/** Electron main process. Agent stays privileged here; renderer only receives safe DTOs. */
import { app, BrowserWindow, ipcMain, session as electronSession } from "electron";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSession, streamToRenderer } from "./agent-bridge.js";
import * as persistence from "./persistence.js";
import * as stateReader from "./state-reader.js";
import * as diffService from "./diff-service.js";

const MAIN_DIR = dirname(fileURLToPath(import.meta.url));
const DEV_ROOT = resolve(MAIN_DIR, "..", "..", "..");
const MAX_PROMPT_CHARS = 40_000;
let win;
let session;
let unsubscribe;
let bootstrapError = null;
let shuttingDown = false;
let promptQueue = Promise.resolve();
let activeCwd = null;
let activeSessionId = null;

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

async function bootstrap() {
  const cwd = process.env.OMEGA_WORKSPACE ? resolve(process.env.OMEGA_WORKSPACE) : rootOf();
  activeCwd = cwd;
  const extensionsRoot = extensionsRootOf();
  process.stdout.write(`[main] cwd=${cwd}\n`);
  session = await createSession({ cwd, extensionsRoot });
  process.stdout.write("[main] agent session ready\n");
}

function showBootstrapError(error) {
  bootstrapError = error instanceof Error ? error.stack ?? error.message : String(error);
}

/** Recreate the agent session bound to a different workspace (session switch). */
async function switchWorkspace(workspace) {
  try { unsubscribe?.(); } catch { /* best effort */ }
  unsubscribe = undefined;
  try { session?.dispose(); } catch (error) { process.stderr.write(`[main] dispose failed: ${String(error)}\n`); }
  session = undefined;
  session = await createSession({ cwd: workspace, extensionsRoot: extensionsRootOf() });
  if (win && !win.isDestroyed()) unsubscribe = streamToRenderer(session, win.webContents);
  activeCwd = workspace;
  process.stdout.write(`[main] switched workspace -> ${workspace}\n`);
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 760,
    minHeight: 560,
    show: false,
    title: "Omega Desktop",
    webPreferences: {
      preload: join(MAIN_DIR, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event, url) => { if (url !== expectedPageUrl()) event.preventDefault(); });
  electronSession.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.webContents.on("console-message", (_e, _level, message) => process.stdout.write(`[renderer] ${message}\n`));
  win.on("closed", () => { unsubscribe?.(); unsubscribe = undefined; win = undefined; });
  if (bootstrapError) {
    await win.loadFile(rendererPath());
    win.webContents.send("app:bootstrap-error", { message: bootstrapError.slice(0, 2_000) });
  } else {
    unsubscribe = streamToRenderer(session, win.webContents);
    await win.loadFile(rendererPath());
  }
  win.show();
  if (process.env.OMEGA_AUTOTEST === "1" && session) {
    win.webContents.once("did-finish-load", () => { setTimeout(() => { void promptInternal("Reply with exactly: hello from omega-desktop"); }, 500); });
    setTimeout(() => {
      process.stdout.write("[main] autotest done, quitting\n");
      void shutdown().finally(() => app.quit());
    }, 25_000);
  }
}

function promptInternal(text) {
  const run = promptQueue.then(async () => {
    if (!session || shuttingDown) throw new Error("session not ready");
    await session.prompt(text, { streamingBehavior: "followUp" });
  });
  promptQueue = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------------------
// Agent prompt (legacy contract)
// ---------------------------------------------------------------------------

ipcMain.handle("agent:prompt", async (event, text) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (typeof text !== "string" || !text.trim()) return errorResult("invalid_prompt", "Prompt must be a non-empty string");
  if (text.length > MAX_PROMPT_CHARS) return errorResult("prompt_too_large", `Prompt exceeds ${MAX_PROMPT_CHARS} characters`);
  if (bootstrapError) return errorResult("bootstrap_failed", "Agent initialization failed");
  try {
    await promptInternal(text.trim());
    return okResult(undefined);
  } catch (error) {
    return errorResult("prompt_failed", error instanceof Error ? error.message : String(error));
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
// Sessions (persistence)
// ---------------------------------------------------------------------------

ipcMain.handle("omega:listSessions", (event) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    return okResult(persistence.list(sessionsRoot()));
  } catch (error) {
    return errorResult("read_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:newSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  try {
    const workspace = req?.workspace ? resolve(req.workspace) : activeCwd ?? rootOf();
    const projectKey = req?.projectKey ?? (activeCwd ? stateReader.projectKeyFromCwd?.(activeCwd) : undefined);
    const record = persistence.create(sessionsRoot(), {
      projectKey: typeof projectKey === "string" ? projectKey : undefined,
      title: req?.title,
      workspace,
    });
    activeSessionId = record.id;
    // Bind the agent session to the chosen workspace (single active session model).
    await switchWorkspace(workspace);
    return okResult(record);
  } catch (error) {
    return errorResult("write_failed", error instanceof Error ? error.message : String(error));
  }
});

ipcMain.handle("omega:loadSession", async (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  try {
    const record = persistence.load(sessionsRoot(), req.sessionId);
    if (!record) return errorResult("not_found", "Session not found");
    activeSessionId = record.id;
    if (record.workspace) await switchWorkspace(resolve(record.workspace));
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

ipcMain.handle("omega:deleteSession", (event, req) => {
  if (!senderAllowed(event)) return errorResult("forbidden", "Invalid renderer sender");
  if (!req?.sessionId) return errorResult("invalid_args", "sessionId is required");
  try {
    persistence.remove(sessionsRoot(), req.sessionId);
    if (activeSessionId === req.sessionId) activeSessionId = null;
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
  try { unsubscribe?.(); } catch { /* best effort */ }
  unsubscribe = undefined;
  try { session?.dispose(); } catch (error) { process.stderr.write(`[main] dispose failed: ${String(error)}\n`); }
  session = undefined;
}

app.whenReady().then(async () => {
  try { await bootstrap(); } catch (error) { showBootstrapError(error); process.stderr.write(`[main] bootstrap failed: ${bootstrapError}\n`); }
  try { await createWindow(); } catch (error) { process.stderr.write(`[main] window failed: ${String(error)}\n`); await shutdown(); app.exit(1); }
  app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) void createWindow(); });
}).catch((error) => { process.stderr.write(`[main] startup failed: ${String(error)}\n`); app.exit(1); });

app.on("before-quit", () => { void shutdown(); });
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });
