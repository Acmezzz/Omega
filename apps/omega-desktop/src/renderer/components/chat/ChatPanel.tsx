import * as React from "react";
import Box from "@mui/material/Box";
import { useAppStore } from "../../store/useAppStore";
import { MessageList } from "./MessageList";
import { Composer } from "./Composer";
import { EmptyState } from "./EmptyState";

export function ChatPanel(): React.ReactElement {
  const messageCount = useAppStore((s) => s.messages.length);
  const hasMessages = messageCount > 0;

  return (
    <Box
      sx={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        background: "var(--omega-bg-panel)",
        borderLeft: "1px solid var(--omega-border)",
        borderRight: "1px solid var(--omega-border)",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <Box sx={{ flexGrow: 1, minHeight: 0, position: "relative" }}>
        {!hasMessages ? <EmptyState /> : <MessageList />}
      </Box>
      <Composer />
    </Box>
  );
}
