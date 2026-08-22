import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { useAppStore } from "../../store/useAppStore";

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** Read-only file viewer dialog (text, size-capped; binary guarded). */
export function FileViewer(): React.ReactElement {
  const viewer = useAppStore((s) => s.viewer);
  const closeViewer = useAppStore((s) => s.closeViewer);
  const [copied, setCopied] = React.useState(false);

  const copy = React.useCallback(async () => {
    if (!viewer.file?.content) return;
    try {
      await navigator.clipboard.writeText(viewer.file.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* sandboxed clipboard may be blocked */
    }
  }, [viewer.file?.content]);

  return (
    <Dialog open={viewer.open} onClose={closeViewer} fullWidth maxWidth="md">
      <DialogTitle sx={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 1, pr: 6 }}>
        <Typography component="span" sx={{ fontSize: 15, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {viewer.path ?? ""}
        </Typography>
        {viewer.file ? (
          <Typography component="span" sx={{ fontSize: 11, color: "var(--omega-text-dim)", flex: "0 0 auto" }}>
            {formatSize(viewer.file.size)}
            {viewer.file.truncated ? "（已截断）" : ""}
          </Typography>
        ) : null}
      </DialogTitle>
      <DialogContent sx={{ position: "relative", minHeight: 200 }}>
        {viewer.loading ? (
          <Box sx={{ display: "grid", placeItems: "center", py: 6 }}>
            <CircularProgress size={22} sx={{ color: "var(--omega-accent)" }} />
          </Box>
        ) : viewer.error ? (
          <Typography sx={{ fontSize: 13, color: "var(--omega-danger)" }}>{viewer.error}</Typography>
        ) : viewer.file?.binary ? (
          <Typography sx={{ fontSize: 13, color: "var(--omega-text-muted)" }}>二进制文件，无法预览。</Typography>
        ) : (
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.25,
              borderRadius: "10px",
              border: "1px solid var(--omega-border)",
              background: "var(--omega-bg-code)",
              fontSize: 12,
              lineHeight: 1.6,
              fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
              color: "var(--omega-text-soft)",
              whiteSpace: "pre",
              overflow: "auto",
              maxHeight: "64vh",
            }}
          >
            {viewer.file?.content ?? ""}
          </Box>
        )}
        {viewer.file?.content ? (
          <Tooltip title={copied ? "已复制" : "复制内容"}>
            <IconButton
              size="small"
              onClick={() => void copy()}
              sx={{ position: "absolute", top: 8, right: 12, color: "var(--omega-text-dim)", "&:hover": { color: "var(--omega-accent)" } }}
            >
              <ContentCopyIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
