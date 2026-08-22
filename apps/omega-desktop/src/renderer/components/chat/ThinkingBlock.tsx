import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import EmojiObjectsIcon from "@mui/icons-material/EmojiObjectsOutlined";

export interface ThinkingBlockProps {
  text: string;
  streaming: boolean;
}

/**
 * Collapsed-by-default reasoning block (design ported from pi-app/pi-web).
 * While streaming, the label shimmers; once done it shows the elapsed time.
 */
export function ThinkingBlock({ text, streaming }: ThinkingBlockProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!streaming) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  if (!text && !streaming) return null;

  return (
    <Box sx={{ mb: 1.25, maxWidth: "100%" }}>
      <Box
        onClick={() => setOpen((prev) => !prev)}
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.75,
          px: 1.25,
          py: 0.4,
          borderRadius: "10px",
          border: "1px solid var(--omega-border)",
          background: "var(--omega-bg-soft)",
          cursor: "pointer",
          userSelect: "none",
          "&:hover": { borderColor: "var(--omega-border-strong)" },
        }}
      >
        <EmojiObjectsIcon sx={{ fontSize: 14, color: "var(--omega-text-muted)" }} />
        <Typography
          className={streaming ? "thinking-shimmer" : undefined}
          sx={{ fontSize: 11.5, color: "var(--omega-text-muted)", fontWeight: 600 }}
        >
          {streaming ? ["思考中", "推理中", "整理中", "斟酌中"][Math.floor(Date.now() / 1600) % 4] : `思考了 ${elapsed || 1}s`}
        </Typography>
        <ExpandMoreIcon sx={{ fontSize: 14, color: "var(--omega-text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </Box>
      {open && text ? (
        <Box
          sx={{
            mt: 0.75,
            p: 1.25,
            borderRadius: "10px",
            border: "1px dashed var(--omega-border)",
            background: "var(--omega-bg-code)",
            maxHeight: 260,
            overflowY: "auto",
          }}
        >
          <Typography component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", fontSize: 12, lineHeight: 1.6, color: "var(--omega-text-muted)", fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace" }}>
            {text}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}
