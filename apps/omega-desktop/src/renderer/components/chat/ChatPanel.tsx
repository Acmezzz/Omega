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
        background: "rgba(21,25,35,0.78)",
        border: "1px solid #2b3444",
        borderRadius: "18px",
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
