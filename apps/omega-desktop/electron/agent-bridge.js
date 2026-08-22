/**
 * Agent bridge — keeps the agent runtime in the Electron main process and
 * exposes only renderer-safe event DTOs and control snapshots.
 *
 * `toRendererEvent` derives `tool_execution_summary` (basename-only target) and
 * structured status events (thinking/compaction/queue/retry). The renderer never
 * receives thinking text, full paths, raw tool args/results, or compaction
 * summaries. See system_design.md §3.2 / V2 control plane.
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

function basenameOf(value) {
  const parts = String(value).split(/[\\/]/);
  return parts[parts.length - 1] || undefined;
}

/** Extract ONLY the file basename from raw tool args (everything else is dropped). */
function extractTargetBasename(args) {
  if (!args || typeof args !== "object") return undefined;
  const candidates = [args.path, args.file, args.filePath, args.file_path];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) return basenameOf(candidate);
  }
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

/** Build a safe `tool_execution_summary` from a raw tool event (basename only). */
function toToolSummary(event, status) {
  const toolName = textValue(event.toolName) ?? "tool";
  return {
    type: "tool_execution_summary",
    toolCallId: textValue(event.toolCallId) ?? `tool-${Date.now()}`,
    toolName,
    kind: classifyKind(toolName),
    target: extractTargetBasename(event.args),
    op: toolName,
    status,
    ...(status === "running" ? { startedAt: new Date().toISOString() } : { endedAt: new Date().toISOString() }),
  };
}

function isThinkingUpdate(type) {
  return type === "thinking_start" || type === "thinking_delta" || type === "thinking_end" || type === "thinking";
}

function sanitizeLevel(level) {
  return THINKING_LEVELS.includes(level) ? level : undefined;
}

/**
 * Convert an SDK event into one or more minimal renderer DTOs.
 * Returns an array (some inputs expand into a safe event + a summary event).
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
  if (type === "message_update") {
    const update = event.assistantMessageEvent;
    if (!update || typeof update !== "object" || typeof update.type !== "string") return [];
    if (isThinkingUpdate(update.type)) {
      return [{ type: "thinking_status", active: update.type !== "thinking_end" }];
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
    return [safe, toToolSummary(event, "running")];
  }
  if (type === "tool_execution_update") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool" };
    return [safe];
  }
  if (type === "tool_execution_end") {
    const safe = { type, toolCallId: textValue(event.toolCallId), toolName: textValue(event.toolName) ?? "tool", isError: event.isError === true };
    return [safe, toToolSummary(event, event.isError === true ? "error" : "done")];
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
    const steering = Array.isArray(event.steering) ? event.steering.length : 0;
    const followUp = Array.isArray(event.followUp) ? event.followUp.length : 0;
    return [{ type, pendingCount: steering + followUp }];
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
  if (type === "error" || type.endsWith("_error")) return [{ type: type === "error" ? "error" : "error", message: textValue(event.message) ?? "Agent error" }];
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

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      if (item.type === "thinking" || item.type === "thinking_delta" || item.type === "toolCall" || item.type === "tool_call") {
        return "";
      }
      if (typeof item.text === "string") return item.text;
      return "";
    })
    .filter(Boolean)
    .join("");
}

function messageTimestamp(message) {
  if (typeof message?.timestamp === "string") return message.timestamp;
  if (message?.timestamp instanceof Date) return message.timestamp.toISOString();
  return new Date().toISOString();
}

/** Purge thinking / tool payloads from AgentSession.messages for the renderer. */
export function sanitizeTranscript(messages) {
  const outMessages = [];
  const toolCards = [];
  if (!Array.isArray(messages)) return { messages: outMessages, toolCards };
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    if (message.role === "user") {
      const id = textValue(message.id) ?? `user-${outMessages.length}`;
      outMessages.push({
        role: "user",
        id,
        text: textFromContent(message.content) ?? "",
        ts: messageTimestamp(message),
      });
      continue;
    }
    if (message.role === "assistant") {
      const id = textValue(message.id) ?? `assistant-${outMessages.length}`;
      outMessages.push({
        role: "assistant",
        id,
        text: textFromContent(message.content) ?? "",
        ts: messageTimestamp(message),
      });
      if (Array.isArray(message.content)) {
        for (const part of message.content) {
          if (!part || typeof part !== "object") continue;
          if (part.type !== "toolCall" && part.type !== "tool_call") continue;
          const toolName = textValue(part.name) ?? textValue(part.toolName) ?? "tool";
          const toolCallId = textValue(part.id) ?? textValue(part.toolCallId) ?? `tool-${toolCards.length}`;
          toolCards.push({
            toolCallId,
            toolName,
            kind: classifyKind(toolName),
            target: extractTargetBasename(part.arguments ?? part.args),
            op: toolName,
            status: "done",
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
  return {
    id: session.id,
    title,
    workspace: session.cwd || "",
    createdAt: session.created instanceof Date ? session.created.toISOString() : String(session.created ?? ""),
    updatedAt: session.modified instanceof Date ? session.modified.toISOString() : String(session.modified ?? ""),
    status: "active",
    messageCount: typeof session.messageCount === "number" ? session.messageCount : 0,
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
    modelFallbackMessage: runtime.modelFallbackMessage ?? null,
    ...sanitizeTranscript(session.messages),
  };
}

export function sessionRecordOf(runtime) {
  const snap = snapshotOf(runtime);
  const transcript = sanitizeTranscript(runtime.session.messages);
  return {
    id: snap.sessionId,
    title: snap.sessionName || "未命名会话",
    workspace: snap.cwd,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "active",
    messages: transcript.messages,
    toolCards: transcript.toolCards,
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
