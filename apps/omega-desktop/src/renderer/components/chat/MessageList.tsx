import * as React from "react";
import Box from "@mui/material/Box";
import { useAppStore } from "../../store/useAppStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";

export function MessageList(): React.ReactElement {
  const messages = useAppStore((s) => s.messages);
  const toolCards = useAppStore((s) => s.toolCards);
  const thinkingActive = useAppStore((s) => s.thinkingActive);
  const compacting = useAppStore((s) => s.compacting);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);

  React.useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages.length, toolCards.length, thinkingActive, compacting]);

  const visible = messages.filter((m) => m.role !== "tool");
  const used = new Set<string>();

  return (
    <Box sx={{ height: "100%", overflowY: "auto", px: { xs: 2, sm: 4 }, py: 3 }}>
      {visible.map((message) => {
        const attached = toolCards.filter((card) => card.afterMessageId === message.id);
        for (const card of attached) used.add(card.toolCallId);
        return (
          <React.Fragment key={message.id}>
            <MessageBubble message={message} />
            {attached.map((card) => (
              <ToolCard key={card.toolCallId} card={card} />
            ))}
          </React.Fragment>
        );
      })}
      {toolCards
        .filter((card) => !used.has(card.toolCallId))
        .map((card) => (
          <ToolCard key={card.toolCallId} card={card} />
        ))}
      {thinkingActive ? (
        <Box sx={{ color: "#8d99ad", fontSize: 12, mb: 2 }}>思考中…</Box>
      ) : null}
      {compacting ? (
        <Box sx={{ color: "#e8bd68", fontSize: 12, mb: 2 }}>正在压缩上下文…</Box>
      ) : null}
      <div ref={bottomRef} />
    </Box>
  );
}
