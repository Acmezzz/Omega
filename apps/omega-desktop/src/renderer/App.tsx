import * as React from "react";
import { ThemeProvider } from "./theme/ThemeProvider";
import { Workbench } from "./components/layout/Workbench";
import { CommandPalette } from "./components/layout/CommandPalette";
import { useAppStore } from "./store/useAppStore";
import { ipc } from "./ipc/client";
import type { SafeEvent } from "./types/events";

async function refreshControlPlane(): Promise<void> {
  const store = useAppStore.getState();
  const [stateRes, modelsRes, commandsRes, authRes, sessionsRes] = await Promise.all([
    ipc.getState(),
    ipc.listModels(),
    ipc.listCommands(),
    ipc.authStatus(),
    ipc.listSessions(),
  ]);
  if (stateRes.ok) {
    store.setAgent(stateRes.data);
    store.setActiveSession(stateRes.data.sessionId);
    if (stateRes.data.messages) {
      store.loadTranscript({
        id: stateRes.data.sessionId,
        title: stateRes.data.sessionName || "未命名会话",
        workspace: stateRes.data.cwd,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        status: "active",
        messages: stateRes.data.messages,
        toolCards: stateRes.data.toolCards,
      });
    }
  }
  if (modelsRes.ok) store.setModels(modelsRes.data);
  if (commandsRes.ok) store.setCommands(commandsRes.data);
  if (authRes.ok) store.setAuth(authRes.data);
  if (sessionsRes.ok) store.setSessions(sessionsRes.data);
}

async function startNewSession(): Promise<void> {
  const record = await ipc.newSession({});
  if (!record.ok) return;
  const store = useAppStore.getState();
  store.setActiveSession(record.data.id);
  store.loadTranscript(record.data);
  const state = await ipc.getState();
  if (state.ok) store.setAgent(state.data);
  const list = await ipc.listSessions();
  if (list.ok) store.setSessions(list.data);
}

/**
 * Top-level component: wraps the app in the MUI theme and subscribes to the
 * agent event stream + bootstrap errors, folding them into the Zustand store.
 */
export function App(): React.ReactElement {
  const setConnection = useAppStore((s) => s.setConnection);
  const setBootstrapError = useAppStore((s) => s.setBootstrapError);
  const setSessions = useAppStore((s) => s.setSessions);
  const setExtensionState = useAppStore((s) => s.setExtensionState);
  const setExtensionLoading = useAppStore((s) => s.setExtensionLoading);

  React.useEffect(() => {
    // Workbench shortcuts: Ctrl+K toggles the command palette, Ctrl+Shift+N
    // starts a fresh session. (F11 fullscreen and F12 devtools live in main.)
    const onKeyDown = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const key = e.key.toLowerCase();
      if (key === "k") {
        e.preventDefault();
        const layout = useAppStore.getState().layout;
        useAppStore.getState().setCommandPaletteOpen(!layout.commandPaletteOpen);
      } else if (key === "n" && e.shiftKey) {
        e.preventDefault();
        void startNewSession();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  React.useEffect(() => {
    const handleEvent = (data: unknown) => {
      const event = data as SafeEvent;
      const store = useAppStore.getState();
      switch (event.type) {
        case "message_start":
          if (event.message.role === "user") {
            store.appendMessage({
              role: "user",
              id: event.message.id ?? `user-${Date.now()}`,
              text: event.message.text ?? "",
              ts: new Date().toISOString(),
            });
          } else if (event.message.role === "assistant") {
            store.appendMessage({
              role: "assistant",
              id: event.message.id ?? `assistant-${Date.now()}`,
              text: event.message.text ?? "",
              ts: new Date().toISOString(),
            });
          }
          break;
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            let id: string | undefined;
            for (let i = store.messages.length - 1; i >= 0; i -= 1) {
              if (store.messages[i].role === "assistant") {
                id = store.messages[i].id;
                break;
              }
            }
            if (id) store.appendDelta(id, event.assistantMessageEvent.delta);
          }
          break;
        case "tool_execution_summary":
          store.upsertToolCard(event);
          break;
        case "tool_execution_start":
          if (event.toolCallId) {
            store.upsertToolCard({
              type: "tool_execution_summary",
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? "tool",
              kind: "other",
              status: "running",
              startedAt: new Date().toISOString(),
            });
          }
          break;
        case "tool_execution_end":
          if (event.toolCallId) {
            store.upsertToolCard({
              type: "tool_execution_summary",
              toolCallId: event.toolCallId,
              toolName: event.toolName ?? "tool",
              kind: "other",
              status: event.isError ? "error" : "done",
              endedAt: new Date().toISOString(),
            });
          }
          break;
        case "thinking_status":
          store.setThinkingActive(event.active);
          break;
        case "thinking_level_changed":
          store.patchAgent({ thinkingLevel: event.level });
          break;
        case "compaction_start":
          store.setCompacting(true);
          break;
        case "compaction_end":
          store.setCompacting(false);
          void ipc.getState().then((res) => {
            if (res.ok) useAppStore.getState().setAgent(res.data);
          });
          break;
        case "queue_update":
          store.setPendingCount(event.pendingCount);
          break;
        case "session_info_changed":
          store.patchAgent({ sessionName: event.name ?? null });
          void ipc.listSessions().then((res) => {
            if (res.ok) useAppStore.getState().setSessions(res.data);
          });
          break;
        case "auto_retry_start":
          store.setRetrying(true);
          break;
        case "auto_retry_end":
          store.setRetrying(false);
          break;
        case "session_start":
          setConnection("ready");
          void refreshControlPlane();
          break;
        case "agent_start":
        case "turn_start":
          setConnection("running");
          store.setComposerError(null);
          break;
        case "agent_end":
        case "turn_end":
        case "agent_settled":
          setConnection("ready");
          store.setThinkingActive(false);
          void ipc.getState().then((res) => {
            if (res.ok) useAppStore.getState().setAgent(res.data);
          });
          break;
        case "error":
          store.appendMessage({
            role: "assistant",
            id: `error-${Date.now()}`,
            text: `⚠️ ${event.message ?? "Agent error"}`,
            ts: new Date().toISOString(),
          });
          break;
        default:
          break;
      }
    };

    const offEvent = window.omega.onEvent(handleEvent);
    const offStatus = window.omega.onStatus((data: unknown) => {
      const payload = data as { message?: string };
      if (payload?.message) setBootstrapError(payload.message);
    });

    setConnection("connecting");
    let cancelled = false;
    void (async () => {
      for (let attempt = 0; attempt < 40 && !cancelled; attempt += 1) {
        const res = await ipc.sessionReady();
        if (cancelled) return;
        if (res.ok && res.data.ready) {
          setConnection("ready");
          await refreshControlPlane();
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    })();
    void ipc.listSessions().then((res) => {
      if (res.ok) setSessions(res.data);
    });
    void (async () => {
      setExtensionLoading(true);
      const res = await ipc.queryExtensionState({ scope: "all" });
      if (res.ok) setExtensionState(res.data);
      setExtensionLoading(false);
    })();

    return () => {
      cancelled = true;
      offEvent();
      offStatus();
    };
  }, [setConnection, setBootstrapError, setSessions, setExtensionState, setExtensionLoading]);

  return (
    <ThemeProvider>
      <Workbench />
      <CommandPalette />
    </ThemeProvider>
  );
}
