/**
 * Global application state (single Zustand store).
 *
 * A store (not React Context) is used because the agent event stream is
 * high-frequency, append-only deltas. Selector subscriptions let granular
 * components (a single message bubble, a single tool card) re-render without
 * re-rendering the whole tree. See system_design.md §2.2.
 */
import { create } from "zustand";
import type {
  SessionSummary,
  SessionRecord,
  SessionMessage,
  ExtensionStateBundle,
  WorkspaceDiff,
  ChangeApprovalResult,
  AgentPermissionState,
  AgentPlan,
} from "../types/dto";
import type {
  ToolExecutionSummaryEvent,
  MessageStartEvent,
  MessageUpdateEvent,
  ToolExecutionStartEvent,
  ToolExecutionEndEvent,
} from "../types/events";

export type ConnectionState = "connecting" | "ready" | "running" | "error";

export interface ToolCardState {
  toolCallId: string;
  toolName: string;
  kind: ToolExecutionSummaryEvent["kind"];
  target?: string;
  op?: string;
  status: "running" | "done" | "error";
  startedAt?: string;
  endedAt?: string;
}

export interface LayoutState {
  rightPanelOpen: boolean;
  rightTab: "workflow" | "scout" | "diff";
  commandPaletteOpen: boolean;
}

export interface AppState {
  connection: ConnectionState;
  bootstrapError: string | null;

  sessions: SessionSummary[];
  activeSessionId: string | null;
  messages: SessionMessage[];
  toolCards: ToolCardState[];

  extensionState: ExtensionStateBundle;
  extensionLoading: boolean;
  diff: WorkspaceDiff | null;
  approval: ChangeApprovalResult | null;

  permission: AgentPermissionState | null;
  plan: AgentPlan | null;

  layout: LayoutState;

  // ----- connection / lifecycle -----
  setConnection: (state: ConnectionState) => void;
  setBootstrapError: (message: string | null) => void;

  // ----- sessions -----
  setSessions: (sessions: SessionSummary[]) => void;
  setActiveSession: (id: string | null) => void;
  loadTranscript: (record: SessionRecord) => void;
  clearConversation: () => void;

  // ----- message stream -----
  appendMessage: (message: SessionMessage) => void;
  appendDelta: (messageId: string, delta: string) => void;

  // ----- tool cards -----
  upsertToolCard: (summary: ToolExecutionSummaryEvent) => void;

  // ----- extension state / diff / approval -----
  setExtensionState: (bundle: ExtensionStateBundle) => void;
  setExtensionLoading: (loading: boolean) => void;
  setDiff: (diff: WorkspaceDiff | null) => void;
  setApproval: (result: ChangeApprovalResult | null) => void;

  // ----- layout -----
  setLayout: (patch: Partial<LayoutState>) => void;
  toggleRightPanel: () => void;
  setRightTab: (tab: LayoutState["rightTab"]) => void;
  setCommandPaletteOpen: (open: boolean) => void;
}

export const useAppStore = create<AppState>((set) => ({
  connection: "connecting",
  bootstrapError: null,

  sessions: [],
  activeSessionId: null,
  messages: [],
  toolCards: [],

  extensionState: {},
  extensionLoading: false,
  diff: null,
  approval: null,

  permission: null,
  plan: null,

  layout: {
    rightPanelOpen: true,
    rightTab: "workflow",
    commandPaletteOpen: false,
  },

  setConnection: (connection) => set({ connection }),
  setBootstrapError: (bootstrapError) => set({ bootstrapError }),

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  loadTranscript: (record) =>
    set({
      activeSessionId: record.id,
      messages: [...record.messages],
      toolCards: (record.toolCards ?? []).map((card) => ({
        toolCallId: card.toolCallId,
        toolName: card.toolName,
        kind: "other",
        status: card.status === "error" ? "error" : "done",
      })),
    }),
  clearConversation: () => set({ messages: [], toolCards: [] }),

  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),
  appendDelta: (messageId, delta) =>
    set((state) => ({
      messages: state.messages.map((message) =>
        message.id === messageId
          ? { ...message, text: message.text + delta }
          : message,
      ),
    })),

  upsertToolCard: (summary) =>
    set((state) => {
      const existing = state.toolCards.find(
        (card) => card.toolCallId === summary.toolCallId,
      );
      if (existing) {
        return {
          toolCards: state.toolCards.map((card) =>
            card.toolCallId === summary.toolCallId
              ? {
                  ...card,
                  toolName: summary.toolName,
                  kind: summary.kind,
                  target: summary.target ?? card.target,
                  op: summary.op ?? card.op,
                  status: summary.status,
                  startedAt: card.startedAt ?? summary.startedAt,
                  endedAt: summary.endedAt ?? card.endedAt,
                }
              : card,
          ),
        };
      }
      return {
        toolCards: [
          ...state.toolCards,
          {
            toolCallId: summary.toolCallId,
            toolName: summary.toolName,
            kind: summary.kind,
            target: summary.target,
            op: summary.op,
            status: summary.status,
            startedAt: summary.startedAt,
            endedAt: summary.endedAt,
          },
        ],
      };
    }),

  setExtensionState: (extensionState) => set({ extensionState }),
  setExtensionLoading: (extensionLoading) => set({ extensionLoading }),
  setDiff: (diff) => set({ diff }),
  setApproval: (approval) => set({ approval }),

  setLayout: (patch) =>
    set((state) => ({ layout: { ...state.layout, ...patch } })),
  toggleRightPanel: () =>
    set((state) => ({
      layout: {
        ...state.layout,
        rightPanelOpen: !state.layout.rightPanelOpen,
      },
    })),
  setRightTab: (rightTab) =>
    set((state) => ({
      layout: { ...state.layout, rightTab, rightPanelOpen: true },
    })),
  setCommandPaletteOpen: (commandPaletteOpen) =>
    set((state) => ({
      layout: { ...state.layout, commandPaletteOpen },
    })),
}));

/** Helper used by the event subscriber to fold a `message_start` into state. */
export function applyMessageStart(
  store: typeof useAppStore,
  event: MessageStartEvent,
): void {
  if (event.message.role === "user") {
    store.getState().appendMessage({
      role: "user",
      id: event.message.id ?? `user-${Date.now()}`,
      text: event.message.text ?? "",
      ts: new Date().toISOString(),
    });
  } else if (event.message.role === "assistant") {
    store.getState().appendMessage({
      role: "assistant",
      id: event.message.id ?? `assistant-${Date.now()}`,
      text: event.message.text ?? "",
      ts: new Date().toISOString(),
    });
  }
}

/** Helper for `text_delta` updates — append to the last assistant message. */
export function applyMessageDelta(
  store: typeof useAppStore,
  event: MessageUpdateEvent,
): void {
  if (event.assistantMessageEvent.type !== "text_delta") return;
  let id: string | undefined;
  const state = store.getState();
  for (let i = state.messages.length - 1; i >= 0; i -= 1) {
    if (state.messages[i].role === "assistant") {
      id = state.messages[i].id;
      break;
    }
  }
  if (id) store.getState().appendDelta(id, event.assistantMessageEvent.delta);
}

export function applyToolStart(
  store: typeof useAppStore,
  event: ToolExecutionStartEvent,
): void {
  if (!event.toolCallId) return;
  store.getState().upsertToolCard({
    type: "tool_execution_summary",
    toolCallId: event.toolCallId,
    toolName: event.toolName ?? "tool",
    kind: "other",
    status: "running",
    startedAt: new Date().toISOString(),
  });
}

export function applyToolEnd(
  store: typeof useAppStore,
  event: ToolExecutionEndEvent,
): void {
  if (!event.toolCallId) return;
  store.getState().upsertToolCard({
    type: "tool_execution_summary",
    toolCallId: event.toolCallId,
    toolName: event.toolName ?? "tool",
    kind: "other",
    status: event.isError ? "error" : "done",
    endedAt: new Date().toISOString(),
  });
}
