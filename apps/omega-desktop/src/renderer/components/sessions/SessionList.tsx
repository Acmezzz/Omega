import * as React from "react";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import DeleteIcon from "@mui/icons-material/DeleteOutline";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";

export function SessionList(): React.ReactElement {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setSessions = useAppStore((s) => s.setSessions);
  const loadTranscript = useAppStore((s) => s.loadTranscript);
  const clearConversation = useAppStore((s) => s.clearConversation);

  const handleLoad = React.useCallback(
    async (id: string) => {
      const res = await ipc.loadSession({ sessionId: id });
      if (res.ok) {
        setActiveSession(id);
        loadTranscript(res.data);
      }
    },
    [setActiveSession, loadTranscript],
  );

  const handleDelete = React.useCallback(
    async (id: string, event: React.MouseEvent) => {
      event.stopPropagation();
      const res = await ipc.deleteSession({ sessionId: id });
      if (res.ok) {
        const list = await ipc.listSessions();
        if (list.ok) setSessions(list.data);
        if (activeSessionId === id) clearConversation();
      }
    },
    [setSessions, activeSessionId, clearConversation],
  );

  if (sessions.length === 0) {
    return (
      <Box sx={{ p: 2, color: "#697589", fontSize: 12, textAlign: "center" }}>
        暂无会话，点击「新建」开始。
      </Box>
    );
  }

  return (
    <List dense sx={{ p: 0 }}>
      {sessions.map((session) => {
        const active = session.id === activeSessionId;
        return (
          <ListItemButton
            key={session.id}
            selected={active}
            onClick={() => void handleLoad(session.id)}
            sx={{
              borderRadius: "10px",
              mb: 0.5,
              "&.Mui-selected": { background: "rgba(93,134,242,0.16)" },
            }}
          >
            <ListItemText
              primary={
                <Typography sx={{ fontSize: 13, fontWeight: active ? 700 : 500, color: "#f3f6fb" }} noWrap>
                  {session.title}
                </Typography>
              }
              secondary={
                <Typography sx={{ fontSize: 11, color: "#8d99ad" }} noWrap>
                  {session.workspace || "—"}
                </Typography>
              }
            />
            <Tooltip title="删除会话">
              <IconButton
                size="small"
                edge="end"
                onClick={(e) => void handleDelete(session.id, e)}
                sx={{ color: "#697589", "&:hover": { color: "#f17f8d" } }}
              >
                <DeleteIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </ListItemButton>
        );
      })}
    </List>
  );
}
