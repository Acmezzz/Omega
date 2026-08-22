import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import IconButton from "@mui/material/IconButton";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import EmojiObjectsIcon from "@mui/icons-material/EmojiObjectsOutlined";
import { ipc } from "../../ipc/client";

/** Module-level LRU for fetched thinking blocks (port of pi-web, MIT). */
const thinkingCache = new Map<string, string>();
const CACHE_MAX = 100;

function cacheGet(key: string): string | undefined {
  const value = thinkingCache.get(key);
  if (value !== undefined) {
    thinkingCache.delete(key);
    thinkingCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: string): void {
  if (thinkingCache.size >= CACHE_MAX) {
    const oldest = thinkingCache.keys().next().value;
    if (oldest !== undefined) thinkingCache.delete(oldest);
  }
  thinkingCache.set(key, value);
}

export interface ThinkingBlockProps {
  text: string;
  streaming: boolean;
  /** Transcript marks deferred blocks; the content is fetched on first expand. */
  deferred?: boolean;
  entryId?: string;
}

/**
 * Collapsed-by-default reasoning block (design ported from pi-app/pi-web).
 * While streaming, the label shimmers; once done it shows the elapsed time.
 * History blocks are deferred — expanded content is fetched per entry.
 */
export function ThinkingBlock({ text, streaming, deferred, entryId }: ThinkingBlockProps): React.ReactElement | null {
  const [open, setOpen] = React.useState(false);
  const [elapsed, setElapsed] = React.useState(0);
  const [loaded, setLoaded] = React.useState<string | null>(deferred ? null : text);
  const [loading, setLoading] = React.useState(false);

  React.useEffect(() => {
    setLoaded(deferred ? (entryId ? cacheGet(entryId) ?? null : null) : text);
  }, [deferred, entryId, text]);

  React.useEffect(() => {
    if (!streaming) return;
    const started = Date.now();
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [streaming]);

  const fetchDeferred = React.useCallback(async () => {
    if (!entryId || loaded !== null || loading) return;
    setLoading(true);
    const res = await ipc.getThinking({ entryId });
    setLoading(false);
    if (res.ok && res.data.text) {
      cacheSet(entryId, res.data.text);
      setLoaded(res.data.text);
    } else {
      setLoaded("（无法加载思考内容）");
    }
  }, [entryId, loaded, loading]);

  const handleToggle = React.useCallback(() => {
    const next = !open;
    setOpen(next);
    if (next && deferred) void fetchDeferred();
  }, [open, deferred, fetchDeferred]);

  if (!text && !streaming && !deferred) return null;

  return (
    <Box sx={{ mb: 1.25, maxWidth: "100%" }}>
      <Box
        onClick={handleToggle}
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
          {streaming
            ? ["思考中", "推理中", "整理中", "斟酌中"][Math.floor(Date.now() / 1600) % 4]
            : deferred
              ? "思考（点击加载）"
              : `思考了 ${elapsed || 1}s`}
        </Typography>
        {loading ? <CircularProgress size={10} sx={{ color: "var(--omega-accent)" }} /> : null}
        <ExpandMoreIcon sx={{ fontSize: 14, color: "var(--omega-text-dim)", transform: open ? "rotate(180deg)" : "none", transition: "transform .15s" }} />
      </Box>
      {open && (loaded ?? "") ? (
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
            {loaded ?? (loading ? "加载中…" : "")}
          </Typography>
        </Box>
      ) : null}
    </Box>
  );
}
