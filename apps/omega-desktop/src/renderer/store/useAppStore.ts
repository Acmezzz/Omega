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
  AgentStateSnapshot,
  ModelInfo,
  ThinkingLevel,
  SlashCommandInfo,
  AuthStatus,
  UsageSnapshot,
} from "../types/dto";
import type { Palette, ThemeMode } from "../theme/palettes";
import { applyModeWithTransition, paletteForMode } from "../theme/palettes";
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
  argsJson?: string;
  resultText?: string;
  isError?: boolean;
  afterMessageId?: string;
}

export interface QueuedMessages {
  steering: string[];
  followUp: string[];
}

export interface LayoutState {
  rightPanelOpen: boolean;
  rightTab: "workflow" | "scout" | "diff";
  commandPaletteOpen: boolean;
  treeOpen: boolean;
}

export interface AppState {
  connection: ConnectionState;
  bootstrapError: string | null;

  themeMode: ThemeMode;
  resolvedMode: "light" | "dark";
  setThemeMode: (mode: ThemeMode, origin?: { x: number; y: number }) => void;

  sessions: SessionSummary[];
  activeSessionId: string | null;
  messages: SessionMessage[];
  toolCards: ToolCardState[];
  queuedMessages: QueuedMessages;
  /** Content signature of the pending optimistic user bubble (id `optimistic-*`). */
  optimisticKey: string | null;
  /** Assistant message id of the in-flight streaming run (deltas target it). */
  streamingAssistantId: string | null;
  /** Epoch of the last agent_start — lets late prompt failures skip rollback. */
  lastAgentStartAt: number;

  agent: AgentStateSnapshot | null;
  models: ModelInfo[];
  commands: SlashCommandInfo[];
  auth: AuthStatus | null;
  thinkingActive: boolean;
  compacting: boolean;
  retrying: boolean;
  composerError: string | null;
  composerPrefill: string | null;
  bashTail: string;

  extensionState: ExtensionStateBundle;
  extensionLoading: boolean;
  diff: WorkspaceDiff | null;
  approval: ChangeApprovalResult | null;

  permission: AgentPermissionState | null;
  plan: AgentPlan | null;

  layout: LayoutState;

  setConnection: (state: ConnectionState) => void;
  setBootstrapError: (message: string | null) => void;
  setComposerError: (message: string | null) => void;
  setComposerPrefill: (text: string | null) => void;

  setSessions: (sessions: SessionSummary[]) => void;
  setActiveSession: (id: string | null) => void;
  loadTranscript: (record: SessionRecord) => void;
  clearConversation: () => void;

  appendMessage: (message: SessionMessage) => void;
  appendDelta: (messageId: string, delta: string) => void;
  appendThinkingDelta: (delta: string) => void;
  /** Replace-or-consume the trailing optimistic bubble with the delivered user message. */
  consumeOptimisticWith: (delivered: SessionMessage) => void;
  dropLastIfOptimistic: (key: string) => void;
  setStreamingAssistantId: (id: string | null) => void;
  /** Ensure a streaming assistant bubble exists for this run; returns its id. */
  ensureStreamingAssistant: () => string;

  upsertToolCard: (summary: ToolExecutionSummaryEvent) => void;
  appendBashTail: (delta: string) => void;

  setQueuedMessages: (queued: QueuedMessages) => void;
  setAgent: (agent: AgentStateSnapshot | null) => void;
  patchAgent: (patch: Partial<AgentStateSnapshot>) => void;
  setModels: (models: ModelInfo[]) => void;
  setCommands: (commands: SlashCommandInfo[]) => void;
  setAuth: (auth: AuthStatus | null) => void;
  setThinkingActive: (active: boolean) => void;
  setCompacting: (compacting: boolean) => void;
  setRetrying: (retrying: boolean) => void;

  setExtensionState: (bundle: ExtensionStateBundle) => void;
  setExtensionLoading: (loading: boolean) => void;
  setDiff: (diff: WorkspaceDiff | null) => void;
  setApproval: (result: ChangeApprovalResult | null) => void;

  setLayout: (patch: Partial<LayoutState>) => void;
  toggleRightPanel: () => void;
  setRightTab: (tab: LayoutState["rightTab"]) => void;
  setCommandPaletteOpen: (open: boolean) => void;
  setTreeOpen: (open: boolean) => void;
}

const EMPTY_USAGE: UsageSnapshot = {
  tokens: null,
  contextWindow: null,
  percent: null,
  input: 0,
  output: 0,
  total: 0,
  cost: 0,
};

export const useAppStore = create<AppState>((set, get) => ({
  connection: "connecting",
  bootstrapError: null,

  themeMode: "system",
  resolvedMode: "dark",
  setThemeMode: (mode, origin) => {
    const systemDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
    const resolved = mode === "system" ? (systemDark ? "dark" : "light") : mode;
    try {
      localStorage.setItem("omega-theme", JSON.stringify(mode));
    } catch {
      /* best effort */
    }
    applyModeWithTransition(resolved, origin);
    set({ themeMode: mode, resolvedMode: resolved });
  },

  sessions: [],
  activeSessionId: null,
  messages: [],
  toolCards: [],
  queuedMessages: { steering: [], followUp: [] },
  optimisticKey: null,
  streamingAssistantId: null,
  lastAgentStartAt: 0,

  agent: null,
  models: [],
  commands: [],
  auth: null,
  thinkingActive: false,
  compacting: false,
  retrying: false,
  composerError: null,
  composerPrefill: null,
  bashTail: "",

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
    treeOpen: false,
  },

  setConnection: (connection) => set({ connection }),
  setBootstrapError: (bootstrapError) => set({ bootstrapError }),
  setComposerError: (composerError) => set({ composerError }),
  setComposerPrefill: (composerPrefill) => set({ composerPrefill }),

  setSessions: (sessions) => set({ sessions }),
  setActiveSession: (activeSessionId) => set({ activeSessionId }),
  loadTranscript: (record) =>
    set({
      activeSessionId: record.id,
      messages: [...record.messages],
      toolCards: (record.toolCards ?? []).map((card) => ({
        toolCallId: card.toolCallId,
        toolName: card.toolName,
        kind: (card.kind as ToolCardState["kind"]) ?? "other",
        target: card.target,
        argsJson: card.argsJson,
        resultText: card.resultText,
        isError: card.isError,
        status: card.status === "error" ? "error" : "done",
        afterMessageId: card.afterMessageId,
      })),
      queuedMessages: { steering: [], followUp: [] },
      optimisticKey: null,
      streamingAssistantId: null,
      thinkingActive: false,
      compacting: false,
      retrying: false,
      composerError: null,
      bashTail: "",
    }),
  clearConversation: () =>
    set({
      messages: [],
      toolCards: [],
      queuedMessages: { steering: [], followUp: [] },
      optimisticKey: null,
      streamingAssistantId: null,
      thinkingActive: false,
      compacting: false,
      retrying: false,
      composerError: null,
      bashTail: "",
    }),

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
  appendThinkingDelta: (delta) =>
    set((state) => {
      for (let i = state.messages.length - 1; i >= 0; i -= 1) {
        if (state.messages[i].role === "assistant") {
          const message = state.messages[i];
          const next = { ...message, thinking: (message.thinking ?? "") + delta };
          const messages = [...state.messages];
          messages[i] = next;
          return { messages };
        }
      }
      return {};
    }),
  consumeOptimisticWith: (delivered) =>
    set((state) => {
      const last = state.messages[state.messages.length - 1];
      if (state.optimisticKey && last?.role === "user" && last.id.startsWith("optimistic-")) {
        const messages = [...state.messages];
        // Same content: keep the optimistic bubble as-is. Different content
        // (slash expansion, image placeholder): replace with the authoritative
        // version instead of duplicating.
        messages[messages.length - 1] =
          last.text === delivered.text ? { ...last, id: delivered.id || last.id, entryId: delivered.entryId } : delivered;
        return { messages, optimisticKey: null };
      }
      return { messages: [...state.messages, delivered], optimisticKey: null };
    }),
  dropLastIfOptimistic: (key) =>
    set((state) => {
      if (state.optimisticKey !== key) return {};
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== "user" || !last.id.startsWith("optimistic-")) return { optimisticKey: null };
      return {
        messages: state.messages.slice(0, -1),
        optimisticKey: null,
      };
    }),
  setStreamingAssistantId: (streamingAssistantId) => set({ streamingAssistantId }),
  ensureStreamingAssistant: () => {
    const state = get();
    if (state.streamingAssistantId) {
      const exists = state.messages.some((message) => message.id === state.streamingAssistantId);
      if (exists) return state.streamingAssistantId;
    }
    const message: SessionMessage = {
      role: "assistant",
      id: `streaming-${Date.now()}`,
      text: "",
      ts: new Date().toISOString(),
    };
    set((current) => ({
      messages: [...current.messages, message],
      streamingAssistantId: message.id,
    }));
    return message.id;
  },

  upsertToolCard: (summary) =>
    set((state) => {
      const lastAssistant = [...state.messages].reverse().find((message) => message.role === "assistant");
      const existing = state.toolCards.find((card) => card.toolCallId === summary.toolCallId);
      if (existing) {
        return {
          toolCards: state.toolCards.map((card) =>
            card.toolCallId === summary.toolCallId
              ? {
                  ...card,
                  toolName: summary.toolName,
                  kind: (summary.kind ?? card.kind) as ToolCardState["kind"],
                  target: summary.target ?? card.target,
                  op: summary.op ?? card.op,
                  status: summary.status,
                  startedAt: card.startedAt ?? summary.startedAt,
                  endedAt: summary.endedAt ?? card.endedAt,
                  argsJson: summary.argsJson ?? card.argsJson,
                  resultText: summary.resultText ?? card.resultText,
                  isError: summary.isError ?? card.isError,
                  afterMessageId: card.afterMessageId ?? lastAssistant?.id,
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
            argsJson: summary.argsJson,
            resultText: summary.resultText,
            isError: summary.isError,
            afterMessageId: lastAssistant?.id,
          },
        ],
      };
    }),

  appendBashTail: (delta) =>
    set((state) => {
      const next = (state.bashTail + delta).slice(-4_000);
      return { bashTail: next };
    }),

  setQueuedMessages: (queuedMessages) => set({ queuedMessages }),
  setAgent: (agent) => set({ agent, compacting: agent?.isCompacting ?? false }),
  patchAgent: (patch) =>
    set((state) => ({
      agent: state.agent
        ? { ...state.agent, ...patch, usage: patch.usage ?? state.agent.usage ?? EMPTY_USAGE }
        : (patch as AgentStateSnapshot),
    })),
  setModels: (models) => set({ models }),
  setCommands: (commands) => set({ commands }),
  setAuth: (auth) => set({ auth }),
  setThinkingActive: (thinkingActive) => set({ thinkingActive }),
  setCompacting: (compacting) => set({ compacting }),
  setRetrying: (retrying) => set({ retrying }),

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
  setTreeOpen: (treeOpen) =>
    set((state) => ({
      layout: { ...state.layout, treeOpen },
    })),
}));

/** Active palette derived from the resolved mode (re-renders on theme change). */
export function usePalette(): Palette {
  const resolvedMode = useAppStore((s) => s.resolvedMode);
  return paletteForMode(resolvedMode);
}

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
    isError: event.isError,
    resultText: event.resultText,
    endedAt: new Date().toISOString(),
  });
}

export type { ThinkingLevel };
