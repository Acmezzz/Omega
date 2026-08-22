import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import MenuItem from "@mui/material/MenuItem";
import TextField from "@mui/material/TextField";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";

const MODE_LABEL: Record<"all" | "one-at-a-time", string> = {
  all: "全部合并发送",
  "one-at-a-time": "逐条发送",
};

export interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

/**
 * Agent behavior settings backed by pi's SettingsManager (steering/follow-up
 * queue modes, auto compaction, auto retry). Every change applies immediately
 * through the guarded omega:updateSettings IPC.
 */
export function SettingsDialog({ open, onClose }: SettingsDialogProps): React.ReactElement {
  const agent = useAppStore((s) => s.agent);
  const setAgent = useAppStore((s) => s.setAgent);

  const apply = React.useCallback(
    async (patch: {
      steeringMode?: "all" | "one-at-a-time";
      followUpMode?: "all" | "one-at-a-time";
      autoCompaction?: boolean;
      autoRetry?: boolean;
    }) => {
      const res = await ipc.updateSettings(patch);
      if (res.ok) setAgent(res.data);
    },
    [setAgent],
  );

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 700 }}>设置</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2.5, pt: 1 }}>
        <TextField
          select
          fullWidth
          size="small"
          label="转向模式（生成中插入消息）"
          value={agent?.steeringMode ?? "all"}
          onChange={(e) => void apply({ steeringMode: e.target.value as "all" | "one-at-a-time" })}
        >
          {(Object.keys(MODE_LABEL) as Array<"all" | "one-at-a-time">).map((mode) => (
            <MenuItem key={mode} value={mode}>
              {MODE_LABEL[mode]}
            </MenuItem>
          ))}
        </TextField>
        <TextField
          select
          fullWidth
          size="small"
          label="后续消息模式（排队消息）"
          value={agent?.followUpMode ?? "all"}
          onChange={(e) => void apply({ followUpMode: e.target.value as "all" | "one-at-a-time" })}
        >
          {(Object.keys(MODE_LABEL) as Array<"all" | "one-at-a-time">).map((mode) => (
            <MenuItem key={mode} value={mode}>
              {MODE_LABEL[mode]}
            </MenuItem>
          ))}
        </TextField>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={agent?.autoCompaction ?? true}
                onChange={(e) => void apply({ autoCompaction: e.target.checked })}
              />
            }
            label={<Typography sx={{ fontSize: 13 }}>上下文接近上限时自动压缩</Typography>}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={agent?.autoRetry ?? true}
                onChange={(e) => void apply({ autoRetry: e.target.checked })}
              />
            }
            label={<Typography sx={{ fontSize: 13 }}>请求失败时自动重试</Typography>}
          />
        </Box>
        <Typography sx={{ fontSize: 11, color: "var(--omega-text-dim)" }}>
          设置通过 pi 的 SettingsManager 持久化，与 CLI 共享。
        </Typography>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button variant="contained" onClick={onClose} sx={{ textTransform: "none" }}>
          完成
        </Button>
      </DialogActions>
    </Dialog>
  );
}
