import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useAppStore } from "../../store/useAppStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";
import type { SessionMessage } from "../../types/dto";
import type { ToolCardState } from "../../store/useAppStore";

/** Group cards under the message they follow; leftovers render at the end. */
function buildAttachmentIndex(messages: SessionMessage[], toolCards: ToolCardState[]) {
  const visibleIds = new Set(messages.map((message) => message.id));
  const byMessage = new Map<string, ToolCardState[]>();
  const loose: ToolCardState[] = [];
  for (const card of toolCards) {
    if (card.afterMessageId && visibleIds.has(card.afterMessageId)) {
      const list = byMessage.get(card.afterMessageId) ?? [];
      list.push(card);
      byMessage.set(card.afterMessageId, list);
    } else {
      loose.push(card);
    }
  }
  return { byMessage, loose };
}

export function MessageList(): React.ReactElement {
  const messages = useAppStore((s) => s.messages);
  const toolCards = useAppStore((s) => s.toolCards);
  const thinkingActive = useAppStore((s) => s.thinkingActive);
  const compacting = useAppStore((s) => s.compacting);
  const bashTail = useAppStore((s) => s.bashTail);
  const connection = useAppStore((s) => s.connection);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const bashRef = React.useRef<HTMLPreElement | null>(null);
  const stickRef = React.useRef(true);

  const visible = React.useMemo(() => messages.filter((m) => m.role !== "tool"), [messages]);
  const lastAssistantId = React.useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      if (visible[i].role === "assistant") return visible[i].id;
    }
    return null;
  }, [visible]);
  const { byMessage, loose } = React.useMemo(() => buildAttachmentIndex(visible, toolCards), [visible, toolCards]);

  const lastTextLength = visible.length > 0 ? visible[visible.length - 1].text.length : 0;
  React.useEffect(() => {
    if (!stickRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [visible.length, lastTextLength, toolCards.length, thinkingActive, compacting, bashTail]);

  React.useEffect(() => {
    if (bashRef.current) bashRef.current.scrollTop = bashRef.current.scrollHeight;
  }, [bashTail]);

  const runningBash = connection === "running" && bashTail.length > 0;

  return (
    <Box
      ref={scrollRef}
      onScroll={() => {
        const el = scrollRef.current;
        if (!el) return;
        stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
      }}
      sx={{ height: "100%", overflowY: "auto", px: { xs: 2, sm: 4 }, py: 3 }}
    >
      <Box sx={{ maxWidth: 860, mx: "auto" }}>
        {visible.map((message) => (
          <React.Fragment key={message.id}>
            <MessageBubble message={message} streamingRun={thinkingActive && message.id === lastAssistantId} />
            {(byMessage.get(message.id) ?? []).map((card) => (
              <ToolCard key={card.toolCallId} card={card} />
            ))}
          </React.Fragment>
        ))}
        {loose.map((card) => (
          <ToolCard key={card.toolCallId} card={card} />
        ))}
        {runningBash ? (
          <Box
            sx={{
              mb: 2,
              borderRadius: "12px",
              border: "1px solid var(--omega-border)",
              background: "var(--omega-bg-code)",
              overflow: "hidden",
            }}
          >
            <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: "var(--omega-text-dim)", px: 1.5, py: 0.5, letterSpacing: "0.05em" }}>
              BASH 实时输出
            </Typography>
            <Box
              ref={bashRef}
              component="pre"
              sx={{
                m: 0,
                px: 1.5,
                pb: 1,
                maxHeight: 160,
                overflowY: "auto",
                fontSize: 11.5,
                lineHeight: 1.55,
                fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                color: "var(--omega-text-muted)",
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
              }}
            >
              {bashTail}
            </Box>
          </Box>
        ) : null}
        {thinkingActive ? (
          <Typography className="thinking-shimmer" sx={{ fontSize: 12, mb: 2, fontWeight: 600 }}>
            思考中…
          </Typography>
        ) : null}
        {compacting ? (
          <Typography sx={{ color: "var(--omega-warning)", fontSize: 12, mb: 2 }}>正在压缩上下文…</Typography>
        ) : null}
        <div ref={bottomRef} />
      </Box>
    </Box>
  );
}
