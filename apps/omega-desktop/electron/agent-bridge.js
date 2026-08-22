/**
 * Agent bridge — keeps the agent runtime in the Electron main process and
 * projects SDK events/DTOs to the renderer.
 *
 * Security boundary (V3): process isolation, not content filtering. The
 * renderer stays sandboxed (contextIsolation/CSP/IPC whitelist in main), and —
 * like pi-web/pi-app/pi-agent-desktop — receives full-fidelity content:
 * thinking text, raw tool args/results, full paths, bash output, queued text.
 * See system_design.md §7.5.
 */
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT_DIR = join(homedir(), ".pi", "agent");
const DEV_EXTENSIONS_ROOT = resolve(fileURLToPath(new URL("../../../.pi/extensions", import.meta.url)));
const TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
/** Cap forwarded tool payloads so a pathological result cannot OOM the renderer. */
const MAX_PAYLOAD_CHARS = 64_000;
const DESKTOP_COMMANDS = [
  { name: "compact", description: "压缩当前会话上下文", source: "builtin", action: "compact" },
  { name: "new", description: "新建会话", source: "builtin", action: "new" },
];

/** sessionId -> JSONL path; never sent to the renderer. */
const sessionPaths = new Map();

function extensionsRootOf(value) {
  const root = value ?? process.env.OMEGA_EXTENSIONS_ROOT ?? DEV_EXTENSIONS_ROOT;
  if (!existsSync(root)) throw new Error(`Omega extensions directory not found: ${root}`);
  return root;
}

function additionalExtensionPaths(omegaExtensions) {
  return [
    join(omegaExtensions, "journal-workflow", "index.ts"),
    join(omegaExtensions, "exploration-scout", "index.ts"),
  ];
}

/**
 * Create an AgentSessionRuntime bound to cwd, with Omega extensions loaded.
 * First boot continues the most recent CLI JSONL session for that workspace.
 */
export async function createRuntime({ cwd, extensionsRoot }) {
  const omegaExtensions = extensionsRootOf(extensionsRoot);
  const extraPaths = additionalExtensionPaths(omegaExtensions);
  let sharedModelRuntime;

  const createRuntimeFactory = async ({ cwd: nextCwd, agentDir, sessionManager, sessionStartEvent }) => {
    const services = await createAgentSessionServices({
      cwd: nextCwd,
      agentDir,
      modelRuntime: sharedModelRuntime,
      resourceLoaderOptions: { additionalExtensionPaths: extraPaths },
    });
    sharedModelRuntime = services.modelRuntime;
    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      tools: TOOLS,
    });
    return {
      session: result.session,
      extensionsResult: result.extensionsResult,
      modelFallbackMessage: result.modelFallbackMessage,
      services,
      diagnostics: [...services.diagnostics],
    };
  };

  const sessionManager = SessionManager.continueRecent(cwd);
  rememberSessionPath(sessionManager.getSessionId(), sessionManager.getSessionFile());
  return createAgentSessionRuntime(createRuntimeFactory, {
    cwd,
    agentDir: AGENT_DIR,
    sessionManager,
    sessionStartEvent: { type: "session_start", reason: "startup" },
  });
}

function textValue(value) {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean);
  return parts.length > 0 ? parts.join("") : undefined;
}

function cap(value, max = MAX_PAYLOAD_CHARS) {
  if (typeof value !== "string") return undefined;
  if (value.length <= max) return value;
  return `…${value.slice(value.length - max)}`;
}

function safeJson(value) {
  if (value === undefined || value === null) return undefined;
  try {
    return cap(JSON.stringify(value, null, 2));
  } catch {
    return undefined;
  }
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (item.type === "toolCall" || item.type === "tool_call" || item.type === "thinking" || item.type === "thinking_delta") return "";
      if (typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function thinkingFromContent(content) {
  if (!Array.isArray(content)) return undefined;
  const parts = content
    .map((item) => (item && item.type === "thinking" && typeof item.text === "string" ? item.text : ""))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : undefined;
}

/** Full target descriptor for a tool call: file path, or command for bash. */
function extractTarget(args, toolName) {
  if (!args || typeof args !== "object") return undefined;
  const pathCandidates = [args.path, args.file, args.filePath, args.file_path];
  for (const candidate of pathCandidates) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  if (typeof args.command === "string" && args.command.length > 0) {
    return args.command.length > 80 ? `${args.command.slice(0, 80)}…` : args.command;
  }
  if (typeof args.pattern === "string" && args.pattern.length > 0) return args.pattern;
  return undefined;
}

function classifyKind(toolName) {
  if (toolName === "read") return "read";
  if (toolName === "write") return "write";
  if (toolName === "edit") return "edit";
  if (toolName === "bash") return "bash";
  if (toolName === "grep" || toolName === "find" || toolName === "ls") return "search";
  return "other";
}

function resultTextOf(result) {
  if (!result || typeof result !== "object") return undefined;
  const content = result.content ?? result.output ?? result.text;
  if (typeof content === "string") return cap(content);
  if (Array.isArray(content)) return cap(textValue(content));
  if (result.stdout !== undefined || result.stderr !== undefined) {
    return cap([result.stdout, result.stderr].filter((part) => typeof part === "string").join("\n"));
  }
  return safeJson(result);
}

/** Build a tool_execution_summary card from a raw tool event. */
function toToolSummary(event, status) {
  const toolName = textValue(event.toolName) ?? "tool";
  return {
    type: "tool_execution_summary",
    toolCallId: textValue(event.toolCallId) ?? `tool-${Date.now()}`,
    toolName,
    kind: classifyKind(toolName),
    target: extractTarget(event.args, toolName),
    op: toolName,
    status,
    argsJson: safeJson(event.args),
    ...(status === "running" ? { startedAt: new Date().toISOString() } : { endedAt: new Date().toISOString() }),
  };
}

function sanitizeLevel(level) {
  return THINKING_LEVELS.includes(level) ? level : undefined;
}

/**
 * Convert an SDK event into one or more renderer DTOs.
 * Full-fidelity projection: thinking deltas, tool args/results, bash output,
 * and queued user text are forwarded verbatim (size-capped).
 */
export function toRendererEvent(event) {
  if (!event || typeof event !== "object" || typeof event.type !== "string") return [];
  const type = event.type;
  if (type === "message_start") {
    const role = event.message?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return [];
    const id = textValue(event.message?.id);
    const text = textFromContent(event.message?.content);
    return [{ type, message: { role, ...(id ? { id } : {}), ...(text ? { text } : {}) } }];
  }
  if (type === "message_end") {
    // Finalized message: lets the renderer replace its streaming bubble with
    // the authoritative text (covers deltas missed across reloads).
    const role = event.message?.role;
    if (role !== "user" && role !== "assistant" && role !== "toolResult") return [];
    const id = textValue(event.message?.id);
    const text = textFromContent(event.message?.content);
    return [{ type, message: { role, ...(id ? { id } : {}), ...(text ? { text } : {}) } }];
  }
  if (type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update || typeof update !== "object" || typeof update.type !== "string") return [];
    if (update.type === "thinking_start" || update.type === "thinking_delta" || update.type === "thinking_end") {
      return [
        { type: "thinking_status", active: update.type !== "thinking_end" },
        {
          type,
          assistantMessageEvent: {
            type: update.type,
            ...(typeof update.delta === "string" ? { delta: update.delta } : {}),
          },
        },
      ];
    }
    if (update.type === "text_delta") {
      return [{ type, assistantMessageEvent: { type: update.type, delta: textValue(update.delta) ?? "" } }];
    }
    if (update.type === "toolcall_start" || update.type === "toolcall_end" || update.type === "tool_call") {
      return [{ type, assistantMessageEvent: { type: update.type, toolName: textValue(update.toolName) ?? textValue(update.tool) } }];
    }
    return [];
  }
  if (type === "tool_execution_start") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
    return [toToolSummary(event, "running"), safe];
  }
  if (type === "tool_execution_update") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
    return [safe];
  }
  if (type === "tool_execution_end") {
    const isError = event.isError === true;
    const safe = {
      type,
      toolCallId: textValue(event.toolCallId),
      toolName: textValue(event.toolName) ?? "tool",
      isError,
      resultText: resultTextOf(event.result),
    };
    const summary = toToolSummary(event, isError ? "error" : "done");
    summary.isError = isError;
    summary.resultText = resultTextOf(event.result);
    // Summary first: the renderer folds cards from summaries, so the correct
    // kind/target must land before the raw end event.
    return [summary, safe];
  }
  if (type === "bash_execution_update") {
    return [{ type, delta: cap(typeof event.delta === "string" ? event.delta : "", 4_000) }];
  }
  if (["agent_start", "agent_end", "turn_start", "turn_end", "agent_settled", "session_start", "session_shutdown"].includes(type)) {
    return [{ type }];
  }
  if (type === "compaction_start") {
    return [{ type, status: "start" }];
  }
  if (type === "compaction_end") {
    const status = event.aborted === true ? "aborted" : event.errorMessage ? "error" : "done";
    return [{ type, status }];
  }
  if (type === "thinking_level_changed") {
    const level = sanitizeLevel(event.level);
    return level ? [{ type, level }] : [];
  }
  if (type === "thinking_status") {
    return [{ type, active: event.active === true }];
  }
  if (type === "queue_update") {
    const steering = Array.isArray(event.steering) ? event.steering.map(String) : [];
    const followUp = Array.isArray(event.followUp) ? event.followUp.map(String) : [];
    return [{ type, steering, followUp, pendingCount: steering.length + followUp.length }];
  }
  if (type === "session_info_changed") {
    const name = textValue(event.name);
    return [{ type, ...(name ? { name } : {}) }];
  }
  if (type === "auto_retry_start") {
    return [{ type, status: "start" }];
  }
  if (type === "auto_retry_end") {
    return [{ type, status: event.success === true ? "done" : "error" }];
  }
  if (type === "error" || type.endsWith("_error")) {
    return [{ type: "error", message: textValue(event.message) ?? "Agent error" }];
  }
  return [];
}

export function streamToRenderer(session, webContents, options) {
  const onSettled = typeof options?.onSettled === "function" ? options.onSettled : undefined;
  const unsubscribe = session.subscribe((event) => {
    if (webContents.isDestroyed()) return;
    if (onSettled && event?.type === "agent_settled") {
      try {
        onSettled();
      } catch {
        /* notification is best-effort */
      }
    }
    const safeEvents = toRendererEvent(event);
    for (const safeEvent of safeEvents) {
      if (safeEvent) webContents.send("agent:event", safeEvent);
    }
  });
  return unsubscribe;
}

function messageTimestamp(message) {
  if (typeof message?.timestamp === "string") return message.timestamp;
  if (message?.timestamp instanceof Date) return message.timestamp.toISOString();
  return new Date().toISOString();
}

/**
 * Build the full transcript from session branch entries (authoritative: has
 * entry ids for forking) with tool results paired by toolCallId. Includes
 * thinking text and raw tool args/results — full fidelity, size-capped.
 */
export function sanitizeTranscript(messagesOrSession) {
  const outMessages = [];
  const toolCards = [];
  const resultByToolCallId = new Map();

  let entries = null;
  const maybeSession = messagesOrSession;
  if (maybeSession && typeof maybeSession === "object" && typeof maybeSession.sessionManager?.getBranch === "function") {
    entries = maybeSession.sessionManager.getBranch().filter((entry) => entry.type === "message");
  }
  const items =
    entries ??
    (Array.isArray(messagesOrSession)
      ? messagesOrSession.map((message, index) => ({ id: String(message?.id ?? `entry-${index}`), timestamp: messageTimestamp(message), message }))
      : []);

  // First pass: collect tool results keyed by toolCallId.
  for (const entry of items) {
    const message = entry.message;
    if (!message || message.role !== "toolResult") continue;
    const toolCallId = textValue(message.toolCallId);
    if (!toolCallId) continue;
    resultByToolCallId.set(toolCallId, {
      resultText: cap(textFromContent(message.content)),
      isError: message.isError === true,
    });
  }

  for (const entry of items) {
    const message = entry.message;
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      outMessages.push({
        role: "user",
        id: textValue(message.id) ?? `user-${outMessages.length}`,
        text: textFromContent(message.content),
        ts: messageTimestamp(message),
        entryId: entry.id,
      });
      continue;
    }
    if (message.role === "assistant") {
      const id = textValue(message.id) ?? `assistant-${outMessages.length}`;
      const thinking = cap(thinkingFromContent(message.content));
      outMessages.push({
        role: "assistant",
        id,
        text: textFromContent(message.content),
        ts: messageTimestamp(message),
        entryId: entry.id,
        // Deferred: the thinking text is NOT embedded in the transcript (long
        // sessions stay light); the viewer fetches it per entry on demand.
        ...(thinking ? { thinkingDeferred: true } : {}),
      });
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object") continue;
          if (part.type !== "toolCall" && part.type !== "tool_call") continue;
          const toolName = textValue(part.name) ?? textValue(part.toolName) ?? "tool";
          const toolCallId = textValue(part.id) ?? textValue(part.toolCallId) ?? `tool-${toolCards.length}`;
          const args = part.arguments ?? part.args ?? part.input;
          const paired = resultByToolCallId.get(toolCallId);
          toolCards.push({
            toolCallId,
            toolName,
            kind: classifyKind(toolName),
            target: extractTarget(args, toolName),
            op: toolName,
            status: paired?.isError ? "error" : "done",
            argsJson: safeJson(args),
            resultText: paired?.resultText,
            isError: paired?.isError === true,
            afterMessageId: id,
          });
        }
      }
    }
  }
  return { messages: outMessages, toolCards };
}

function rememberSessionPath(id, filePath) {
  if (id && filePath) sessionPaths.set(id, filePath);
}

/** Fetch the thinking text of one entry (deferred thinking, on demand). */
export function getThinking(runtime, entryId) {
  const entry = runtime.session.sessionManager.getBranch().find((item) => item.id === entryId);
  if (!entry || entry.type !== "message") return null;
  return cap(thinkingFromContent(entry.message.content)) ?? null;
}

export async function resolveSessionPath(sessionId) {
  if (!sessionId) return undefined;
  if (sessionPaths.has(sessionId)) return sessionPaths.get(sessionId);
  const all = await SessionManager.listAll();
  for (const session of all) rememberSessionPath(session.id, session.path);
  return sessionPaths.get(sessionId);
}

export function forgetSessionPath(sessionId) {
  sessionPaths.delete(sessionId);
}

/** Canonical CLI JSONL sessions root; deletions must stay inside it. */
export function piSessionsRoot() {
  return join(AGENT_DIR, "sessions");
}

function toSessionSummary(session) {
  const title =
    (typeof session.name === "string" && session.name.trim()) ||
    (session.firstMessage ? String(session.firstMessage).slice(0, 80) : "") ||
    "未命名会话";
  rememberSessionPath(session.id, session.path);
  // JSONL file names are the session id (…/<id>.jsonl); derive the parent id
  // from the recorded parent path instead of self-referencing our own id.
  let parentSessionId;
  if (session.parentSessionPath) {
    const base = String(session.parentSessionPath).split(/[\\/]/).pop() ?? "";
    const stem = base.replace(/\.jsonl$/i, "");
    if (stem) parentSessionId = stem;
  }
  return {
    id: session.id,
    title,
    workspace: session.cwd || "",
    createdAt: session.created instanceof Date ? session.created.toISOString() : String(session.created ?? ""),
    updatedAt: session.modified instanceof Date ? session.modified.toISOString() : String(session.modified ?? ""),
    status: "active",
    messageCount: typeof session.messageCount === "number" ? session.messageCount : 0,
    ...(parentSessionId ? { parentSessionId } : {}),
  };
}

export async function listPiSessions(cwd) {
  const local = cwd ? await SessionManager.list(cwd) : [];
  const all = await SessionManager.listAll();
  const seen = new Set();
  const merged = [];
  for (const session of [...local, ...all]) {
    if (!session?.id || seen.has(session.id)) continue;
    seen.add(session.id);
    merged.push(session);
  }
  merged.sort((a, b) => {
    const am = a.modified instanceof Date ? a.modified.getTime() : 0;
    const bm = b.modified instanceof Date ? b.modified.getTime() : 0;
    return bm - am;
  });
  return merged.map(toSessionSummary);
}

export function snapshotOf(runtime) {
  const session = runtime.session;
  const model = session.model;
  const stats = session.getSessionStats();
  const usage = stats.contextUsage;
  rememberSessionPath(session.sessionId, session.sessionFile);
  return {
    ready: true,
    cwd: runtime.cwd,
    sessionId: session.sessionId,
    sessionName: session.sessionName ?? null,
    model: model
      ? {
          provider: model.provider,
          id: model.id,
          name: model.name ?? model.id,
          contextWindow: model.contextWindow ?? 0,
          reasoning: Boolean(model.reasoning),
        }
      : null,
    thinkingLevel: session.thinkingLevel,
    thinkingLevels: session.getAvailableThinkingLevels(),
    supportsThinking: session.supportsThinking(),
    isStreaming: session.isStreaming,
    isIdle: session.isIdle,
    isCompacting: session.isCompacting,
    usage: {
      tokens: usage?.tokens ?? null,
      contextWindow: usage?.contextWindow ?? model?.contextWindow ?? null,
      percent: usage?.percent ?? null,
      input: stats.tokens?.input ?? 0,
      output: stats.tokens?.output ?? 0,
      total: stats.tokens?.total ?? 0,
      cost: stats.cost ?? 0,
    },
    steeringMode: session.steeringMode,
    followUpMode: session.followUpMode,
    autoCompaction: session.autoCompactionEnabled,
    autoRetry: Boolean(session.settingsManager?.getRetrySettings?.()?.enabled),
    stats: {
      userMessages: stats.userMessages ?? 0,
      assistantMessages: stats.assistantMessages ?? 0,
      toolCalls: stats.toolCalls ?? 0,
      totalMessages: stats.totalMessages ?? 0,
    },
    modelFallbackMessage: runtime.modelFallbackMessage ?? null,
    ...sanitizeTranscript(session),
  };
}

export function sessionRecordOf(runtime) {
  const snap = snapshotOf(runtime);
  return {
    id: snap.sessionId,
    title: snap.sessionName || "未命名会话",
    workspace: snap.cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    messages: snap.messages ?? [],
    toolCards: snap.toolCards ?? [],
  };
}

export function listModels(runtime) {
  const current = runtime.session.model;
  return runtime.session.modelRuntime.getAvailableSnapshot().map((model) => ({
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    contextWindow: model.contextWindow ?? 0,
    reasoning: Boolean(model.reasoning),
    selected: Boolean(current && current.provider === model.provider && current.id === model.id),
  }));
}

export function findModel(runtime, provider, modelId) {
  return runtime.session.modelRuntime.getAvailableSnapshot().find((model) => model.provider === provider && model.id === modelId);
}

export function listCommands(runtime) {
  const session = runtime.session;
  const runner = session.extensionRunner;
  const extensionCommands = runner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    description: command.description ?? "",
    source: "extension",
    action: "prompt",
  }));
  const templates = session.promptTemplates.map((template) => ({
    name: template.name,
    description: template.description ?? "",
    source: "prompt",
    action: "prompt",
  }));
  const skills = session.resourceLoader.getSkills().skills.map((skill) => ({
    name: `skill:${skill.name}`,
    description: skill.description ?? "",
    source: "skill",
    action: "prompt",
  }));
  const seen = new Set();
  const out = [];
  for (const command of [...DESKTOP_COMMANDS, ...extensionCommands, ...templates, ...skills]) {
    if (seen.has(command.name)) continue;
    seen.add(command.name);
    out.push(command);
  }
  return out;
}

/** Flatten sessionManager.getTree() into a preview list for the tree overlay. */
export function sessionTreeOf(runtime) {
  const leafId = runtime.session.sessionManager.getLeafId();
  const activePath = new Set();
  const byId = new Map();

  const markPath = (targetId) => {
    let current = byId.get(targetId);
    while (current) {
      activePath.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
  };

  const rows = [];
  const walk = (nodes, depth, parentId) => {
    for (const node of nodes) {
      const entry = node.entry;
      if (entry.type !== "message") {
        walk(node.children, depth, parentId);
        continue;
      }
      const message = entry.message;
      const preview =
        message.role === "user" || message.role === "assistant"
          ? (textFromContent(message.content) ?? "").replace(/\s+/g, " ").slice(0, 60)
          : "";
      const row = {
        id: entry.id,
        parentId: parentId ?? null,
        depth,
        role: message.role,
        preview,
        isLeaf: node.children.length === 0,
        label: node.label,
      };
      rows.push(row);
      byId.set(row.id, row);
      walk(node.children, depth + 1, row.id);
    }
  };
  walk(runtime.session.sessionManager.getTree(), 0, undefined);
  if (leafId) markPath(leafId);
  return { nodes: rows, activePath: [...activePath], leafId: leafId ?? null };
}

export function forkCandidatesOf(runtime) {
  return runtime.session.getUserMessagesForForking().map((candidate) => ({
    entryId: candidate.entryId,
    text: candidate.text.length > 80 ? `${candidate.text.slice(0, 80)}…` : candidate.text,
  }));
}

export function authStatusOf(runtime) {
  const providers = runtime.session.modelRuntime.getProviders();
  const items = providers.map((provider) => {
    const status = runtime.session.modelRuntime.getProviderAuthStatus(provider.id);
    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      configured: Boolean(status?.configured),
      source: status?.source ?? status?.label ?? null,
    };
  });
  const local = items.some((item) => item.configured && (item.id === "local-qwen" || item.id.includes("local")));
  const any = items.some((item) => item.configured);
  return {
    providers: items,
    label: local ? "本地可用" : any ? "已配置" : "未登录",
    ready: any,
  };
}

export { THINKING_LEVELS };
