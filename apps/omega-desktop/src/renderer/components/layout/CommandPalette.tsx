import * as React from "react";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import TextField from "@mui/material/TextField";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Box from "@mui/material/Box";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";

interface Command {
  id: string;
  label: string;
  hint: string;
}

const COMMANDS: Command[] = [
  { id: "/wf-extract", label: "/wf-extract", hint: "重新提炼工作流并演进目录" },
  { id: "/wf-list", label: "/wf-list", hint: "查看 registry / 状态 / 统计" },
  { id: "/wf-catalog", label: "/wf-catalog", hint: "查看功能类别目录" },
  { id: "/wf-stats", label: "/wf-stats", hint: "查看项目任务与回合统计" },
  { id: "/wf-health", label: "/wf-health", hint: "只读健康检查" },
  { id: "/journal-restore", label: "/journal-restore", hint: "从备份恢复未落盘事实回合（dry-run）" },
  { id: "/exploration-scout on", label: "/exploration-scout on", hint: "开启 Scout 探索模式" },
  { id: "/exploration-scout off", label: "/exploration-scout off", hint: "关闭 Scout 探索模式" },
  { id: "/exploration-scout status", label: "/exploration-scout status", hint: "查看 Scout 状态" },
];

export function CommandPalette(): React.ReactElement {
  const open = useAppStore((s) => s.layout.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const setConnection = useAppStore((s) => s.setConnection);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const filtered = COMMANDS.filter(
    (c) => c.label.includes(query) || c.hint.includes(query),
  );

  const run = React.useCallback(
    async (command: string) => {
      setOpen(false);
      setConnection("running");
      try {
        await ipc.prompt(command);
      } catch (error) {
        console.error("command failed", error);
      }
    },
    [setOpen, setConnection],
  );

  return (
    <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 700, pb: 1 }}>命令面板</DialogTitle>
      <Box sx={{ px: 3, pb: 1 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder="输入 / 选择命令…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && filtered[0]) void run(filtered[0].id);
          }}
        />
      </Box>
      <List sx={{ px: 2, pb: 2, pt: 0 }}>
        {filtered.map((c) => (
          <ListItemButton key={c.id} onClick={() => void run(c.id)} sx={{ borderRadius: "10px", mb: 0.5 }}>
            <ListItemText
              primary={<span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, color: "#86a9ff" }}>{c.label}</span>}
              secondary={<span style={{ fontSize: 12, color: "#8d99ad" }}>{c.hint}</span>}
            />
          </ListItemButton>
        ))}
        {filtered.length === 0 ? (
          <ListItemText primary={<span style={{ fontSize: 12, color: "#697589" }}>无匹配命令</span>} />
        ) : null}
      </List>
    </Dialog>
  );
}
