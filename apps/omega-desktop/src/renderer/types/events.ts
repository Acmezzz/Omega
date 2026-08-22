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

export interface MessageEndEvent {
  type: "message_end";
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
    | { type: "thinking_start" }
    | { type: "thinking_delta"; delta: string }
    | { type: "thinking_end" }
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
  resultText?: string;
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

export interface CompactionEvent {
  type: "compaction_start" | "compaction_end";
  status: "start" | "done" | "aborted" | "error";
}

export interface ThinkingLevelChangedEvent {
  type: "thinking_level_changed";
  level: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ThinkingStatusEvent {
  type: "thinking_status";
  active: boolean;
}

export interface QueueUpdateEvent {
  type: "queue_update";
  steering: string[];
  followUp: string[];
  pendingCount: number;
}

export interface BashExecutionUpdateEvent {
  type: "bash_execution_update";
  delta: string;
}

export interface SessionInfoChangedEvent {
  type: "session_info_changed";
  name?: string;
}

export interface AutoRetryEvent {
  type: "auto_retry_start" | "auto_retry_end";
  status: "start" | "done" | "error";
}

/**
 * Tool call card. V3 full-fidelity: `target` is the full path (or command),
 * `argsJson`/`resultText` carry the raw payloads, size-capped in the bridge.
 */
export interface ToolExecutionSummaryEvent {
  type: "tool_execution_summary";
  toolCallId: string;
  toolName: "read" | "edit" | "write" | "bash" | "grep" | "find" | "ls" | string;
  kind: "read" | "edit" | "write" | "bash" | "search" | "other";
  target?: string;
  op?: string;
  status: "running" | "done" | "error";
  startedAt?: string;
  endedAt?: string;
  argsJson?: string;
  resultText?: string;
  isError?: boolean;
}

export type SafeEvent =
  | MessageStartEvent
  | MessageEndEvent
  | MessageUpdateEvent
  | ToolExecutionStartEvent
  | ToolExecutionUpdateEvent
  | ToolExecutionEndEvent
  | LifecycleEvent
  | ErrorEvent
  | ToolExecutionSummaryEvent
  | CompactionEvent
  | ThinkingLevelChangedEvent
  | ThinkingStatusEvent
  | QueueUpdateEvent
  | SessionInfoChangedEvent
  | AutoRetryEvent
  | BashExecutionUpdateEvent;

export interface BootstrapError {
  message: string;
}
