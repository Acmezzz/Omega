import * as React from "react";
import Box from "@mui/material/Box";
import { useAppStore } from "../../store/useAppStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";

export function MessageList(): React.ReactElement {
  const messages = useAppStore((s) => s.messages);
  const toolCards = useAppStore((s) => s.toolCards);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, toolCards.length]);

  return (
    <Box sx={{ height: "100%", overflowY: "auto", px: { xs: 2, sm: 4 }, py: 3 }}>
      {messages
        .filter((m) => m.role !== "tool")
        .map((message) => (
          <MessageBubble key={message.id} message={message} />
        ))}
      {toolCards.length > 0 ? (
        <Box sx={{ mt: 1, mb: 3, opacity: 0.96 }}>
          {toolCards.map((card) => (
            <ToolCard key={card.toolCallId} card={card} />
          ))}
        </Box>
      ) : null}
      <div ref={bottomRef} />
    </Box>
  );
}
