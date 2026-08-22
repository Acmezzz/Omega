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
import type { SlashCommandInfo } from "../../types/dto";

function commandLabel(command: SlashCommandInfo): string {
  return command.name.startsWith("/") ? command.name : `/${command.name}`;
}

export function CommandPalette(): React.ReactElement {
  const open = useAppStore((s) => s.layout.commandPaletteOpen);
  const setOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const setConnection = useAppStore((s) => s.setConnection);
  const setAgent = useAppStore((s) => s.setAgent);
  const commands = useAppStore((s) => s.commands);
  const [query, setQuery] = React.useState("");

  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    void ipc.listCommands().then((res) => {
      if (res.ok) useAppStore.getState().setCommands(res.data);
    });
  }, [open]);

  const filtered = commands.filter((command) => {
    const hay = `${commandLabel(command)} ${command.description} ${command.source}`;
    return hay.toLowerCase().includes(query.toLowerCase());
  });

  const run = React.useCallback(
    async (command: SlashCommandInfo) => {
      setOpen(false);
      if (command.action === "compact") {
        const res = await ipc.compact();
        if (res.ok) setAgent(res.data);
        return;
      }
      if (command.action === "new") {
        const record = await ipc.newSession({});
        if (record.ok) {
          useAppStore.getState().setActiveSession(record.data.id);
          useAppStore.getState().loadTranscript(record.data);
          const list = await ipc.listSessions();
          if (list.ok) useAppStore.getState().setSessions(list.data);
        }
        return;
      }
      setConnection("running");
      try {
        const res = await ipc.prompt(commandLabel(command));
        if (!res.ok) {
          useAppStore.getState().setComposerError(`${res.code}: ${res.message ?? "未知错误"}`);
          useAppStore.getState().setConnection("ready");
        }
      } catch (error) {
        console.error("command failed", error);
        useAppStore.getState().setConnection("ready");
      }
    },
    [setOpen, setConnection, setAgent],
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
            if (e.key === "Enter" && filtered[0]) void run(filtered[0]);
          }}
        />
      </Box>
      <List sx={{ px: 2, pb: 2, pt: 0 }}>
        {filtered.map((command) => (
          <ListItemButton key={`${command.source}:${command.name}`} onClick={() => void run(command)} sx={{ borderRadius: "10px", mb: 0.5 }}>
            <ListItemText
              primary={<span style={{ fontFamily: "ui-monospace, monospace", fontSize: 13, color: "var(--omega-accent)" }}>{commandLabel(command)}</span>}
              secondary={<span style={{ fontSize: 12, color: "var(--omega-text-muted)" }}>{command.description || command.source}</span>}
            />
          </ListItemButton>
        ))}
        {filtered.length === 0 ? (
          <ListItemText primary={<span style={{ fontSize: 12, color: "var(--omega-text-dim)" }}>无匹配命令</span>} />
        ) : null}
      </List>
    </Dialog>
  );
}
