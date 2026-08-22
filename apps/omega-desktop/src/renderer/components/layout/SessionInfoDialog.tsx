import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import CircularProgress from "@mui/material/CircularProgress";
import IosShareIcon from "@mui/icons-material/IosShare";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { AgentStateSnapshot } from "../../types/dto";

function Stat({ label, value }: { label: string; value: string | number }): React.ReactElement {
  return (
    <Box sx={{ minWidth: 84 }}>
      <Typography sx={{ fontSize: 10.5, color: "var(--omega-text-dim)" }}>{label}</Typography>
      <Typography sx={{ fontSize: 14, fontWeight: 600, color: "var(--omega-text)" }}>{value}</Typography>
    </Box>
  );
}

export interface SessionInfoDialogProps {
  open: boolean;
  onClose: () => void;
}

/** Session stats + system prompt viewer + HTML export. */
export function SessionInfoDialog({ open, onClose }: SessionInfoDialogProps): React.ReactElement {
  const agent = useAppStore((s) => s.agent);
  const setAgent = useAppStore((s) => s.setAgent);
  const [snapshot, setSnapshot] = React.useState<AgentStateSnapshot | null>(null);
  const [systemPrompt, setSystemPrompt] = React.useState<string | null>(null);
  const [promptOpen, setPromptOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) {
      setPromptOpen(false);
      return;
    }
    setSnapshot(agent);
    void ipc.getState().then((res) => {
      if (res.ok) {
        setSnapshot(res.data);
        setAgent(res.data);
      }
    });
  }, [open, agent, setAgent]);

  const loadPrompt = React.useCallback(async () => {
    const next = !promptOpen;
    setPromptOpen(next);
    if (next && systemPrompt === null) {
      const res = await ipc.getSystemPrompt();
      setSystemPrompt(res.ok ? res.data.systemPrompt : "（加载失败）");
    }
  }, [promptOpen, systemPrompt]);

  const exportHtml = React.useCallback(async () => {
    setBusy(true);
    try {
      await ipc.exportHtml();
    } finally {
      setBusy(false);
    }
  }, []);

  const usage = snapshot?.usage;
  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 700, display: "flex", alignItems: "center", gap: 1 }}>
        会话信息
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          startIcon={busy ? <CircularProgress size={13} sx={{ color: "inherit" }} /> : <IosShareIcon sx={{ fontSize: 15 }} />}
          onClick={() => void exportHtml()}
          disabled={busy}
          sx={{ textTransform: "none" }}
        >
          导出 HTML
        </Button>
      </DialogTitle>
      <DialogContent sx={{ pb: 3 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap", mb: 1.5 }}>
          <Chip size="small" label={snapshot?.sessionName || "未命名会话"} />
          {snapshot?.model ? (
            <Chip size="small" variant="outlined" label={`${snapshot.model.provider}/${snapshot.model.id}`} />
          ) : null}
          <Chip size="small" variant="outlined" label={snapshot?.cwd ?? ""} sx={{ maxWidth: 260, "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" } }} />
        </Box>
        <Box sx={{ display: "flex", gap: 2.5, flexWrap: "wrap", mb: 1.5 }}>
          <Stat label="用户消息" value={snapshot?.stats.userMessages ?? 0} />
          <Stat label="助手消息" value={snapshot?.stats.assistantMessages ?? 0} />
          <Stat label="工具调用" value={snapshot?.stats.toolCalls ?? 0} />
          <Stat label="总消息" value={snapshot?.stats.totalMessages ?? 0} />
        </Box>
        <Box sx={{ display: "flex", gap: 2.5, flexWrap: "wrap", mb: 1.5 }}>
          <Stat label="输入 tokens" value={usage?.input ?? 0} />
          <Stat label="输出 tokens" value={usage?.output ?? 0} />
          <Stat label="累计 tokens" value={usage?.total ?? 0} />
          <Stat label="成本 $" value={(usage?.cost ?? 0).toFixed(4)} />
          <Stat label="上下文" value={usage?.percent !== null && usage?.percent !== undefined ? `${Math.round(usage.percent)}%` : "—"} />
        </Box>
        <Divider sx={{ my: 1.5 }} />
        <Typography
          onClick={() => void loadPrompt()}
          sx={{ fontSize: 12.5, color: "var(--omega-accent)", cursor: "pointer", userSelect: "none", fontWeight: 600 }}
        >
          {promptOpen ? "▾ 隐藏系统提示词" : "▸ 查看系统提示词"}
        </Typography>
        {promptOpen ? (
          <Box
            component="pre"
            sx={{
              m: 0,
              mt: 1,
              p: 1.25,
              borderRadius: "10px",
              border: "1px solid var(--omega-border)",
              background: "var(--omega-bg-code)",
              fontSize: 11.5,
              lineHeight: 1.6,
              fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
              color: "var(--omega-text-muted)",
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
              maxHeight: 300,
              overflowY: "auto",
            }}
          >
            {systemPrompt ?? "加载中…"}
          </Box>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
