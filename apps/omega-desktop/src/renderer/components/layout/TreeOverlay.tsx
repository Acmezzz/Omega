import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Chip from "@mui/material/Chip";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { SessionTree } from "../../types/dto";

/**
 * Session tree overlay: flattened branch tree from `sessionManager.getTree()`.
 * Click a node to rewind the active leaf (navigateTree) — the agent context
 * and the transcript both switch to that branch.
 */
export function TreeOverlay(): React.ReactElement {
  const open = useAppStore((s) => s.layout.treeOpen);
  const setTreeOpen = useAppStore((s) => s.setTreeOpen);
  const loadTranscript = useAppStore((s) => s.loadTranscript);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setAgent = useAppStore((s) => s.setAgent);
  const [tree, setTree] = React.useState<SessionTree | null>(null);
  const [busyId, setBusyId] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!open) {
      setTree(null);
      setError(null);
      return;
    }
    void ipc.getSessionTree().then((res) => {
      if (res.ok) setTree(res.data);
      else setError(res.message);
    });
  }, [open]);

  const activate = React.useCallback(
    async (targetId: string) => {
      setBusyId(targetId);
      setError(null);
      try {
        const res = await ipc.navigateTree({ targetId });
        if (res.ok) {
          setActiveSession(res.data.id);
          loadTranscript(res.data);
          const state = await ipc.getState();
          if (state.ok) setAgent(state.data);
          setTreeOpen(false);
        } else {
          setError(res.message);
        }
      } finally {
        setBusyId(null);
      }
    },
    [loadTranscript, setActiveSession, setAgent, setTreeOpen],
  );

  const activePath = React.useMemo(() => new Set(tree?.activePath ?? []), [tree]);
  const maxDepth = React.useMemo(
    () => Math.max(0, ...(tree?.nodes ?? []).map((node) => node.depth)),
    [tree],
  );

  return (
    <Dialog open={open} onClose={() => setTreeOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 700, pb: 1, display: "flex", alignItems: "center", gap: 1 }}>
        会话分支树
        <Chip size="small" label={`${tree?.nodes.length ?? 0} 节点`} sx={{ fontSize: 11 }} />
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: 11, color: "var(--omega-text-dim)" }}>点击节点切换分支</Typography>
      </DialogTitle>
      {error ? (
        <Box sx={{ px: 3, pb: 1 }}>
          <Typography sx={{ fontSize: 12.5, color: "var(--omega-warning)" }}>{error}</Typography>
        </Box>
      ) : null}
      <Box sx={{ px: 3, pb: 2.5, maxHeight: 460, overflowY: "auto" }}>
        {!tree ? (
          <Typography sx={{ fontSize: 12, color: "var(--omega-text-dim)" }}>加载中…</Typography>
        ) : tree.nodes.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: "var(--omega-text-dim)" }}>当前会话还没有消息。</Typography>
        ) : (
          tree.nodes.map((node) => {
            const onPath = activePath.has(node.id);
            const isLeaf = node.id === tree.leafId;
            return (
              <Box
                key={node.id}
                onClick={() => (busyId ? undefined : void activate(node.id))}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  gap: 1,
                  ml: node.depth * Math.min(22, Math.max(12, 160 / (maxDepth || 1))),
                  pl: 1,
                  py: 0.6,
                  px: 1.25,
                  mb: 0.25,
                  borderRadius: "9px",
                  cursor: busyId === node.id ? "wait" : "pointer",
                  opacity: busyId && busyId !== node.id ? 0.5 : 1,
                  border: isLeaf ? "1px solid var(--omega-accent)" : "1px solid transparent",
                  background: isLeaf ? "var(--omega-accent-soft)" : "transparent",
                  "&:hover": { background: isLeaf ? "var(--omega-accent-soft)" : "var(--omega-hover-fill)" },
                }}
              >
                <Box
                  sx={{
                    width: 8,
                    height: 8,
                    borderRadius: 999,
                    flex: "0 0 auto",
                    background: isLeaf ? "var(--omega-accent)" : onPath ? "var(--omega-text-muted)" : "var(--omega-border-strong)",
                  }}
                />
                <Chip
                  size="small"
                  label={node.role === "user" ? "U" : node.role === "assistant" ? "A" : "?"}
                  sx={{
                    flex: "0 0 auto",
                    height: 18,
                    fontSize: 10,
                    fontWeight: 700,
                    background: node.role === "user" ? "var(--omega-accent-soft)" : "var(--omega-hover-fill)",
                    color: node.role === "user" ? "var(--omega-accent)" : "var(--omega-text-muted)",
                  }}
                />
                <Typography sx={{ fontSize: 12.5, color: onPath ? "var(--omega-text)" : "var(--omega-text-muted)", minWidth: 0 }} noWrap>
                  {node.label || node.preview || "（无预览）"}
                </Typography>
                {node.isLeaf && !isLeaf ? (
                  <Typography sx={{ fontSize: 10.5, color: "var(--omega-text-dim)", ml: "auto" }} noWrap>
                    其他分支末梢
                  </Typography>
                ) : null}
              </Box>
            );
          })
        )}
      </Box>
    </Dialog>
  );
}
