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
} from "../types/dto";

export interface OmegaBridge {
  prompt(text: string): Promise<IpcResult<void>>;
  onStatus(callback: (data: unknown) => void): () => void;
  onEvent(callback: (data: unknown) => void): () => void;
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
  prompt: async (text: string): Promise<IpcResult<void>> => ok(await window.omega?.prompt?.(text)),
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
