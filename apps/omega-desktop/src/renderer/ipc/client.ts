/**
 * Thin wrapper around the narrow, validated `window.omega` preload bridge.
 * Every method returns the unified `IpcResult<T>` envelope. The renderer never
 * touches `ipcRenderer` directly — only this sanitized surface.
 */
import type {
  IpcResult,
  ExtensionStateBundle,
  SessionSummary,
  SessionRecord,
  WorkspaceDiff,
  ChangeApprovalResult,
  AgentStateSnapshot,
  ModelInfo,
  ThinkingLevel,
  SlashCommandInfo,
  AuthStatus,
  PromptImage,
} from "../types/dto";

export interface OmegaBridge {
  prompt(text: string, behavior?: "steer" | "followUp", images?: PromptImage[]): Promise<IpcResult<void>>;
  abort(): Promise<IpcResult<void>>;
  updateSettings(req: {
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    autoCompaction?: boolean;
    autoRetry?: boolean;
  }): Promise<IpcResult<AgentStateSnapshot>>;
  minimize(): Promise<IpcResult<void>>;
  toggleMaximize(): Promise<IpcResult<{ maximized: boolean }>>;
  closeWindow(): Promise<IpcResult<void>>;
  isMaximized(): Promise<IpcResult<{ maximized: boolean }>>;
  onWindowStateChanged(callback: (data: { maximized: boolean }) => void): () => void;
  onStatus(callback: (data: unknown) => void): () => void;
  onEvent(callback: (data: unknown) => void): () => void;
  sessionReady(): Promise<IpcResult<{ ready: boolean }>>;
  getState(): Promise<IpcResult<AgentStateSnapshot>>;
  listModels(): Promise<IpcResult<ModelInfo[]>>;
  setModel(req: { provider: string; modelId: string }): Promise<IpcResult<AgentStateSnapshot>>;
  setThinkingLevel(req: { level: ThinkingLevel }): Promise<IpcResult<AgentStateSnapshot>>;
  setSessionName(req: { name: string }): Promise<IpcResult<AgentStateSnapshot>>;
  listCommands(): Promise<IpcResult<SlashCommandInfo[]>>;
  compact(): Promise<IpcResult<AgentStateSnapshot>>;
  authStatus(): Promise<IpcResult<AuthStatus>>;
  listPiSessions(): Promise<IpcResult<SessionSummary[]>>;
  newPiSession(req: { title?: string; workspace?: string }): Promise<IpcResult<SessionRecord>>;
  switchPiSession(req: { sessionId: string }): Promise<IpcResult<SessionRecord>>;
  queryExtensionState(req: {
    scope?: "all" | "workflow" | "scout";
    projectKey?: string;
    taskId?: string;
  }): Promise<IpcResult<ExtensionStateBundle>>;
  listSessions(): Promise<IpcResult<SessionSummary[]>>;
  newSession(req: {
    projectKey?: string;
    title?: string;
    workspace?: string;
  }): Promise<IpcResult<SessionRecord>>;
  loadSession(req: { sessionId: string }): Promise<IpcResult<SessionRecord>>;
  saveSession(req: {
    sessionId: string;
    transcript: SessionRecord;
  }): Promise<IpcResult<void>>;
  deleteSession(req: { sessionId: string }): Promise<IpcResult<void>>;
  diffWorkspace(req: { taskId?: string }): Promise<IpcResult<WorkspaceDiff>>;
  approveChange(req: {
    action: "accept" | "reject";
    files?: string[];
  }): Promise<IpcResult<ChangeApprovalResult>>;
}

declare global {
  interface Window {
    omega: OmegaBridge;
  }
}

function ok<T>(value: IpcResult<T> | undefined): IpcResult<T> {
  if (value && typeof value === "object" && "ok" in value) return value;
  return { ok: false, code: "bridge_error", message: "No response from host" };
}

export const ipc = {
  prompt: async (text: string, behavior?: "steer" | "followUp", images?: PromptImage[]): Promise<IpcResult<void>> =>
    ok(await window.omega?.prompt?.(text, behavior, images)),
  abort: async (): Promise<IpcResult<void>> => ok(await window.omega?.abort?.()),
  updateSettings: async (req: {
    steeringMode?: "all" | "one-at-a-time";
    followUpMode?: "all" | "one-at-a-time";
    autoCompaction?: boolean;
    autoRetry?: boolean;
  }): Promise<IpcResult<AgentStateSnapshot>> => ok(await window.omega?.updateSettings?.(req)),
  minimize: async (): Promise<IpcResult<void>> => ok(await window.omega?.minimize?.()),
  toggleMaximize: async (): Promise<IpcResult<{ maximized: boolean }>> => ok(await window.omega?.toggleMaximize?.()),
  closeWindow: async (): Promise<IpcResult<void>> => ok(await window.omega?.closeWindow?.()),
  isMaximized: async (): Promise<IpcResult<{ maximized: boolean }>> => ok(await window.omega?.isMaximized?.()),
  onWindowStateChanged: (callback: (data: { maximized: boolean }) => void): (() => void) =>
    window.omega?.onWindowStateChanged?.(callback) ?? (() => {}),
  sessionReady: async (): Promise<IpcResult<{ ready: boolean }>> =>
    ok(await window.omega?.sessionReady?.()),
  getState: async (): Promise<IpcResult<AgentStateSnapshot>> => ok(await window.omega?.getState?.()),
  listModels: async (): Promise<IpcResult<ModelInfo[]>> => ok(await window.omega?.listModels?.()),
  setModel: async (req: { provider: string; modelId: string }): Promise<IpcResult<AgentStateSnapshot>> =>
    ok(await window.omega?.setModel?.(req)),
  setThinkingLevel: async (req: { level: ThinkingLevel }): Promise<IpcResult<AgentStateSnapshot>> =>
    ok(await window.omega?.setThinkingLevel?.(req)),
  setSessionName: async (req: { name: string }): Promise<IpcResult<AgentStateSnapshot>> =>
    ok(await window.omega?.setSessionName?.(req)),
  listCommands: async (): Promise<IpcResult<SlashCommandInfo[]>> => ok(await window.omega?.listCommands?.()),
  compact: async (): Promise<IpcResult<AgentStateSnapshot>> => ok(await window.omega?.compact?.()),
  authStatus: async (): Promise<IpcResult<AuthStatus>> => ok(await window.omega?.authStatus?.()),
  listPiSessions: async (): Promise<IpcResult<SessionSummary[]>> => ok(await window.omega?.listPiSessions?.()),
  newPiSession: async (req: { title?: string; workspace?: string }): Promise<IpcResult<SessionRecord>> =>
    ok(await window.omega?.newPiSession?.(req)),
  switchPiSession: async (req: { sessionId: string }): Promise<IpcResult<SessionRecord>> =>
    ok(await window.omega?.switchPiSession?.(req)),
  queryExtensionState: async (req: {
    scope?: "all" | "workflow" | "scout";
    projectKey?: string;
    taskId?: string;
  }): Promise<IpcResult<ExtensionStateBundle>> => ok(await window.omega?.queryExtensionState?.(req)),
  listSessions: async (): Promise<IpcResult<SessionSummary[]>> => ok(await window.omega?.listSessions?.()),
  newSession: async (req: {
    projectKey?: string;
    title?: string;
    workspace?: string;
  }): Promise<IpcResult<SessionRecord>> => ok(await window.omega?.newSession?.(req)),
  loadSession: async (req: { sessionId: string }): Promise<IpcResult<SessionRecord>> => ok(await window.omega?.loadSession?.(req)),
  saveSession: async (req: {
    sessionId: string;
    transcript: SessionRecord;
  }): Promise<IpcResult<void>> => ok(await window.omega?.saveSession?.(req)),
  deleteSession: async (req: { sessionId: string }): Promise<IpcResult<void>> => ok(await window.omega?.deleteSession?.(req)),
  diffWorkspace: async (req: { taskId?: string }): Promise<IpcResult<WorkspaceDiff>> => ok(await window.omega?.diffWorkspace?.(req)),
  approveChange: async (req: {
    action: "accept" | "reject";
    files?: string[];
  }): Promise<IpcResult<ChangeApprovalResult>> => ok(await window.omega?.approveChange?.(req)),
};

/** Convenience helper that throws on `!ok` so callers can use try/catch. */
export async function unwrap<T>(result: IpcResult<T>): Promise<T> {
  if (result.ok) return result.data;
  throw new Error(`${result.code}: ${result.message}`);
}
