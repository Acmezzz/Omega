/**
 * Renderer event-stream types. These mirror the sanitized events produced by
 * `electron/agent-bridge.js` `toRendererEvent`. The renderer never receives the
 * raw SDK event; everything here is scrubbed.
 */

export interface MessageStartEvent {
  type: "message_start";
  message: {
    role: "user" | "assistant" | "toolResult";
    id?: string;
    text?: string;
  };
}

export interface MessageUpdateEvent {
  type: "message_update";
  assistantMessageEvent:
    | { type: "text_delta"; delta: string }
    | { type: "toolcall_start" | "toolcall_end" | "tool_call"; toolName?: string };
}

export interface ToolExecutionStartEvent {
  type: "tool_execution_start";
  toolCallId?: string;
  toolName?: string;
}

export interface ToolExecutionUpdateEvent {
  type: "tool_execution_update";
  toolCallId?: string;
  toolName?: string;
}

export interface ToolExecutionEndEvent {
  type: "tool_execution_end";
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export type LifecycleEventType =
  | "agent_start"
  | "agent_end"
  | "turn_start"
  | "turn_end"
  | "agent_settled"
  | "session_start"
  | "session_shutdown";

export interface LifecycleEvent {
  type: LifecycleEventType;
}

export interface ErrorEvent {
  type: "error";
  message?: string;
}

/**
 * Safe, read-only summary of a tool call. Crucially `target` is ONLY the file
 * basename — the main process strips the full path and never forwards raw tool
 * parameters or results. See system_design.md §3.2.
 */
export interface ToolExecutionSummaryEvent {
  type: "tool_execution_summary";
  toolCallId: string;
  toolName: "read" | "edit" | "write" | "bash" | string;
  kind: "read" | "edit" | "write" | "bash" | "other";
  target?: string;
  op?: string;
  status: "running" | "done" | "error";
  startedAt?: string;
  endedAt?: string;
}

export type SafeEvent =
  | MessageStartEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | LifecycleEvent
  | ErrorEvent
  | ToolExecutionSummaryEvent;

export interface BootstrapError {
  message: string;
}
