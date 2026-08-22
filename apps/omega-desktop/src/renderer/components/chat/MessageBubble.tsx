import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import { Markdown } from "../common/Markdown";
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
}

export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const [copied, setCopied] = React.useState(false);
  const isUser = message.role === "user";
  const isError = message.role === "assistant" && message.text.startsWith("⚠️");

  const handleCopy = React.useCallback(async () => {
    const ok = await copyText(message.text);
    if (ok) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }, [message.text]);

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
            color: "#86a9ff",
            background: "linear-gradient(145deg, rgba(134,169,255,0.2), rgba(93,134,242,0.1))",
            border: "1px solid rgba(134,169,255,0.28)",
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
            <Typography sx={{ fontSize: 12, fontWeight: 600, color: "#8d99ad" }}>Omega</Typography>
            {message.ts ? (
              <Typography sx={{ fontSize: 11, color: "#5c6a82" }}>{formatTime(message.ts)}</Typography>
            ) : null}
          </Box>
        ) : null}
        <Box
          sx={{
            minWidth: 0,
            ...(isUser
              ? {
                  order: 2,
                  color: "#fff",
                  background: "linear-gradient(135deg, rgba(93,134,242,0.26), rgba(128,103,219,0.24))",
                  border: "1px solid rgba(134,169,255,0.26)",
                  borderRadius: "16px 4px 16px 16px",
                  px: 1.75,
                  py: 1.1,
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                  boxShadow: "0 6px 18px rgba(93,134,242,0.12)",
                }
              : {
                  color: isError ? "#ffd4d9" : "#e7ebf3",
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
        {!isUser && !isError && message.text ? (
          <Box className="msg-actions" sx={{ opacity: 0, transition: "opacity .15s ease", mt: 0.25, px: 0.25 }}>
            <Tooltip title={copied ? "已复制" : "复制消息"}>
              <IconButton size="small" onClick={() => void handleCopy()} sx={{ color: "#697589", "&:hover": { color: "#a8c2ff" } }}>
                {copied ? <CheckIcon sx={{ fontSize: 15 }} /> : <ContentCopyIcon sx={{ fontSize: 15 }} />}
              </IconButton>
            </Tooltip>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
