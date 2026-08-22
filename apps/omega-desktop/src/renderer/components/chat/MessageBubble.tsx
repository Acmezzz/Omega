import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import CallSplitIcon from "@mui/icons-material/CallSplit";
import { Markdown } from "../common/Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { SessionMessage } from "../../types/dto";

function formatTime(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      return ok;
    } catch {
      return false;
    }
  }
}

export interface MessageBubbleProps {
  message: SessionMessage;
  /** True only for the last assistant message during the active thinking run. */
  streamingRun: boolean;
}

function MessageBubbleInner({ message, streamingRun }: MessageBubbleProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const [forking, setForking] = React.useState(false);
  const isUser = message.role === "user";
  const isError = message.role === "assistant" && message.text.startsWith("⚠️");
  const connection = useAppStore((s) => s.connection);
  const setComposerPrefill = useAppStore((s) => s.setComposerPrefill);
  const loadTranscript = useAppStore((s) => s.loadTranscript);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setAgent = useAppStore((s) => s.setAgent);

  const handleCopy = React.useCallback(async () => {
    const ok = await copyText(message.text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [message.text]);

  const handleFork = React.useCallback(async () => {
    if (!message.entryId || forking) return;
    setForking(true);
    try {
      const res = await ipc.fork({ entryId: message.entryId });
      if (res.ok) {
        setActiveSession(res.data.record.id);
        loadTranscript(res.data.record);
        const state = await ipc.getState();
        if (state.ok) setAgent(state.data);
        const list = await ipc.listSessions();
        if (list.ok) useAppStore.getState().setSessions(list.data);
        if (res.data.selectedText) setComposerPrefill(res.data.selectedText);
      }
    } finally {
      setForking(false);
    }
  }, [message.entryId, forking, setActiveSession, loadTranscript, setAgent, setComposerPrefill]);

  const canFork = Boolean(isUser && message.entryId) && connection !== "running";
  const showThinking = !isUser && !isError && (Boolean(message.thinking) || message.thinkingDeferred);
  const isStreamingTarget = streamingRun;

  return (
    <Box
      sx={{
        display: "flex",
        gap: 1.5,
        mb: 2.5,
        justifyContent: isUser ? "flex-end" : "flex-start",
        animation: "rise .22s ease both",
        "@keyframes rise": {
          from: { opacity: 0, transform: "translateY(5px)" },
          to: { opacity: 1, transform: "translateY(0)" },
        },
        "&:hover .msg-actions": { opacity: 1 },
      }}
    >
      {!isUser ? (
        <Box
          sx={{
            flex: "0 0 auto",
            mt: 0.25,
            width: 30,
            height: 30,
            display: "grid",
            placeItems: "center",
            borderRadius: "10px",
            color: "var(--omega-accent)",
            background: "var(--omega-accent-soft)",
            border: "1px solid var(--omega-border-strong)",
            fontSize: 14,
            fontWeight: 700,
            userSelect: "none",
          }}
        >
          Ω
        </Box>
      ) : null}
      <Box sx={{ minWidth: 0, maxWidth: "min(78%, 720px)" }}>
        {!isUser ? (
          <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, mb: 0.25, px: 0.25 }}>
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: "var(--omega-text-muted)" }}>Omega</Typography>
            {message.ts ? (
              <Typography sx={{ fontSize: 11, color: "var(--omega-text-dim)" }}>{formatTime(message.ts)}</Typography>
            ) : null}
          </Box>
        ) : null}
        {showThinking ? (
          <ThinkingBlock
            text={message.thinking ?? ""}
            streaming={isStreamingTarget && Boolean(message.thinking)}
            deferred={message.thinkingDeferred}
            entryId={message.entryId}
          />
        ) : null}
        <Box
          sx={{
            minWidth: 0,
            ...(isUser
              ? {
                  order: 2,
                  color: "#fff",
                  background: "var(--omega-accent-strong)",
                  border: "1px solid var(--omega-border-strong)",
                  borderRadius: "16px 4px 16px 16px",
                  px: 1.75,
                  py: 1.1,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  boxShadow: "0 4px 14px var(--omega-shadow)",
                }
              : {
                  color: isError ? "var(--omega-error-text)" : "var(--omega-text-soft)",
                }),
          }}
        >
          {isUser ? (
            <Typography sx={{ fontSize: 14, lineHeight: 1.6 }}>{message.text}</Typography>
          ) : isError ? (
            <Typography sx={{ fontSize: 14, lineHeight: 1.6 }}>{message.text}</Typography>
          ) : (
            <Markdown>{message.text}</Markdown>
          )}
        </Box>
        {!isError && message.text ? (
          <Box className="msg-actions" sx={{ opacity: 0, transition: "opacity .15s ease", mt: 0.25, px: 0.25, display: "flex", justifyContent: isUser ? "flex-end" : "flex-start" }}>
            <Tooltip title={copied ? "已复制" : "复制消息"}>
              <IconButton size="small" onClick={() => void handleCopy()} sx={{ color: "var(--omega-text-dim)", "&:hover": { color: "var(--omega-accent)" } }}>
                {copied ? <CheckIcon sx={{ fontSize: 15 }} /> : <ContentCopyIcon sx={{ fontSize: 15 }} />}
              </IconButton>
            </Tooltip>
            {canFork ? (
              <Tooltip title={forking ? "创建中…" : "从此处 Fork 新会话"}>
                <IconButton size="small" onClick={() => void handleFork()} disabled={forking} sx={{ color: "var(--omega-text-dim)", "&:hover": { color: "var(--omega-accent)" } }}>
                  <CallSplitIcon sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            ) : null}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export const MessageBubble = React.memo(MessageBubbleInner);
