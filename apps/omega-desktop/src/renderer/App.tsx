import * as React from "react";
import { ThemeProvider } from "./theme/ThemeProvider";
import { Workbench } from "./components/layout/Workbench";
import { CommandPalette } from "./components/layout/CommandPalette";
import { useAppStore } from "./store/useAppStore";
import { ipc } from "./ipc/client";
import type { SafeEvent } from "./types/events";

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
            const state = store;
            for (let i = state.messages.length - 1; i >= 0; i -= 1) {
              if (state.messages[i].role === "assistant") {
                id = state.messages[i].id;
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
        case "agent_start":
        case "turn_start":
          setConnection("running");
          break;
        case "agent_end":
        case "turn_end":
        case "agent_settled":
          setConnection("ready");
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

    // Initial data loads.
    setConnection("connecting");
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
