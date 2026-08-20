import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { Markdown } from "../common/Markdown";
import type { SessionMessage } from "../../types/dto";

const STATUS_COLOR: Record<string, string> = {
  user: "#5d86f2",
  assistant: "#86a9ff",
  tool: "#8d99ad",
  error: "#f17f8d",
};

export interface MessageBubbleProps {
  message: SessionMessage;
}

export function MessageBubble({ message }: MessageBubbleProps): React.ReactElement {
  const isUser = message.role === "user";
  const isError = message.role === "assistant" && message.text.startsWith("⚠️");

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
      }}
    >
      {!isUser ? (
        <Box
          sx={{
            flex: "0 0 auto",
            width: 30,
            height: 30,
            display: "grid",
            placeItems: "center",
            borderRadius: "10px",
            color: "#86a9ff",
            background: "rgba(134,169,255,0.14)",
            fontSize: 14,
            fontWeight: 700,
          }}
        >
          Ω
        </Box>
      ) : null}
      <Box
        sx={{
          minWidth: 0,
          maxWidth: "min(78%, 720px)",
          ...(isUser
            ? {
                order: 2,
                color: "#fff",
                background: "linear-gradient(135deg, rgba(93,134,242,0.22), rgba(128,103,219,0.22))",
                border: "1px solid rgba(134,169,255,0.24)",
                borderRadius: "16px 4px 16px 16px",
                px: 1.75,
                py: 1.1,
                whiteSpace: "pre-wrap",
                overflowWrap: "anywhere",
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
    </Box>
  );
}
