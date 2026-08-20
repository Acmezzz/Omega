import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import TextField from "@mui/material/TextField";
import Button from "@mui/material/Button";
import { useAppStore } from "../../store/useAppStore";
import { ipc, unwrap } from "../../ipc/client";

export interface NewSessionDialogProps {
  open: boolean;
  onClose: () => void;
}

export function NewSessionDialog({ open, onClose }: NewSessionDialogProps): React.ReactElement {
  const [title, setTitle] = React.useState("");
  const [workspace, setWorkspace] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const setSessions = useAppStore((s) => s.setSessions);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const loadTranscript = useAppStore((s) => s.loadTranscript);

  React.useEffect(() => {
    if (!open) {
      setTitle("");
      setWorkspace("");
      setBusy(false);
    }
  }, [open]);

  const handleCreate = React.useCallback(async () => {
    setBusy(true);
    try {
      const record = await unwrap(await ipc.newSession({ title: title || undefined, workspace: workspace || undefined }));
      setActiveSession(record.id);
      loadTranscript(record);
      const list = await ipc.listSessions();
      if (list.ok) setSessions(list.data);
      onClose();
    } catch (error) {
      console.error("newSession failed", error);
    } finally {
      setBusy(false);
    }
  }, [title, workspace, setActiveSession, loadTranscript, setSessions, onClose]);

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ fontWeight: 700 }}>新建会话</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2, pt: 1 }}>
        <TextField
          label="标题"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="未命名会话"
          size="small"
          fullWidth
        />
        <TextField
          label="工作区路径"
          value={workspace}
          onChange={(e) => setWorkspace(e.target.value)}
          placeholder="留空则使用当前工作区"
          size="small"
          fullWidth
        />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose} sx={{ textTransform: "none" }}>
          取消
        </Button>
        <Button variant="contained" onClick={() => void handleCreate()} disabled={busy} sx={{ textTransform: "none" }}>
          创建
        </Button>
      </DialogActions>
    </Dialog>
  );
}
