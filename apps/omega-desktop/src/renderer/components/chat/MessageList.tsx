import * as React from "react";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import { useAppStore } from "../../store/useAppStore";
import { MessageBubble } from "./MessageBubble";
import { ToolCard } from "./ToolCard";
import type { SessionMessage } from "../../types/dto";
import type { ToolCardState } from "../../store/useAppStore";

const WINDOW_SIZE = 60;
/** Per-session scroll memory: scrollTop + whether it was at the bottom. */
const scrollMemory = new Map<string, { scrollTop: number; atBottom: boolean }>();

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
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const bottomRef = React.useRef<HTMLDivElement | null>(null);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const bashRef = React.useRef<HTMLPreElement | null>(null);
  const stickRef = React.useRef(true);
  const [windowSize, setWindowSize] = React.useState(WINDOW_SIZE);

  // Reset the render window when the session changes.
  React.useEffect(() => {
    setWindowSize(WINDOW_SIZE);
  }, [activeSessionId]);

  const visibleAll = React.useMemo(() => messages.filter((m) => m.role !== "tool"), [messages]);
  const hiddenCount = Math.max(0, visibleAll.length - windowSize);
  const visible = React.useMemo(
    () => (hiddenCount > 0 ? visibleAll.slice(visibleAll.length - windowSize) : visibleAll),
    [visibleAll, windowSize, hiddenCount],
  );
  const lastAssistantId = React.useMemo(() => {
    for (let i = visible.length - 1; i >= 0; i -= 1) {
      if (visible[i].role === "assistant") return visible[i].id;
    }
    return null;
  }, [visible]);
  const { byMessage, loose } = React.useMemo(() => buildAttachmentIndex(visible, toolCards), [visible, toolCards]);

  // Save the outgoing session's scroll position; restore the incoming one.
  const prevSessionRef = React.useRef<string | null>(activeSessionId);
  React.useLayoutEffect(() => {
    const el = scrollRef.current;
    const prev = prevSessionRef.current;
    if (prev !== null && prev !== activeSessionId && el) {
      scrollMemory.set(prev, { scrollTop: el.scrollTop, atBottom: stickRef.current });
    }
    if (prev !== activeSessionId) {
      prevSessionRef.current = activeSessionId;
      const saved = activeSessionId ? scrollMemory.get(activeSessionId) : undefined;
      if (saved && el) {
        stickRef.current = saved.atBottom;
        requestAnimationFrame(() => {
          if (scrollRef.current) scrollRef.current.scrollTop = saved.scrollTop;
        });
      } else {
        stickRef.current = true;
      }
    }
  }, [activeSessionId]);

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
        {hiddenCount > 0 ? (
          <Box sx={{ display: "flex", justifyContent: "center", mb: 2 }}>
            <Button
              size="small"
              variant="outlined"
              onClick={() => setWindowSize((prev) => prev + WINDOW_SIZE)}
              sx={{ textTransform: "none", borderRadius: "999px" }}
            >
              加载更早消息（剩余 {hiddenCount} 条）
            </Button>
          </Box>
        ) : null}
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
