import * as React from "react";
import List from "@mui/material/List";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import TextField from "@mui/material/TextField";
import InputAdornment from "@mui/material/InputAdornment";
import EditIcon from "@mui/icons-material/EditOutlined";
import DeleteIcon from "@mui/icons-material/DeleteOutline";
import SearchIcon from "@mui/icons-material/SearchOutlined";
import Dialog from "@mui/material/Dialog";
import DialogTitle from "@mui/material/DialogTitle";
import DialogContent from "@mui/material/DialogContent";
import DialogActions from "@mui/material/DialogActions";
import Button from "@mui/material/Button";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";

function groupKey(workspace: string): string {
  if (!workspace) return "其他工作区";
  const parts = workspace.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || workspace;
}

function relativeTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return date.toLocaleDateString();
}

export function SessionList(): React.ReactElement {
  const sessions = useAppStore((s) => s.sessions);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const setActiveSession = useAppStore((s) => s.setActiveSession);
  const setSessions = useAppStore((s) => s.setSessions);
  const loadTranscript = useAppStore((s) => s.loadTranscript);
  const clearConversation = useAppStore((s) => s.clearConversation);
  const setAgent = useAppStore((s) => s.setAgent);
  const [query, setQuery] = React.useState("");
  const [renaming, setRenaming] = React.useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = React.useState<{ id: string; title: string } | null>(null);

  const handleLoad = React.useCallback(
    async (id: string) => {
      const res = await ipc.loadSession({ sessionId: id });
      if (res.ok) {
        setActiveSession(id);
        loadTranscript(res.data);
        const state = await ipc.getState();
        if (state.ok) setAgent(state.data);
        const list = await ipc.listSessions();
        if (list.ok) setSessions(list.data);
      }
    },
    [setActiveSession, loadTranscript, setAgent, setSessions],
  );

  const openRename = React.useCallback(
    (id: string, event: React.MouseEvent) => {
      const session = sessions.find((s) => s.id === id);
      setRenaming({ id, name: session?.title ?? "" });
      event.stopPropagation();
    },
    [sessions],
  );

  const commitRename = React.useCallback(async () => {
    if (!renaming) return;
    const name = renaming.name.trim();
    setRenaming(null);
    if (!name) return;
    const res = await ipc.setSessionName({ name });
    if (res.ok) {
      setAgent(res.data);
      const list = await ipc.listSessions();
      if (list.ok) setSessions(list.data);
    }
  }, [renaming, setAgent, setSessions]);

  const commitDelete = React.useCallback(async () => {
    if (!deleting) return;
    const target = deleting;
    setDeleting(null);
    const res = await ipc.deleteSession({ sessionId: target.id });
    if (res.ok) {
      if (target.id === activeSessionId) {
        clearConversation();
        const state = await ipc.getState();
        if (state.ok) {
          setAgent(state.data);
          setActiveSession(state.data.sessionId);
        }
      }
      const list = await ipc.listSessions();
      if (list.ok) setSessions(list.data);
    }
  }, [deleting, activeSessionId, clearConversation, setAgent, setActiveSession, setSessions]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (session) => session.title.toLowerCase().includes(q) || session.workspace.toLowerCase().includes(q),
    );
  }, [sessions, query]);

  if (sessions.length === 0) {
    return (
      <Box sx={{ p: 2, color: "#697589", fontSize: 12, textAlign: "center" }}>
        暂无会话，点击「新建」开始。
      </Box>
    );
  }

  const groups = new Map<string, typeof filtered>();
  for (const session of filtered) {
    const key = groupKey(session.workspace);
    const list = groups.get(key) ?? [];
    list.push(session);
    groups.set(key, list);
  }

  return (
    <Box>
      <Box sx={{ px: 0.5, pb: 1 }}>
        <TextField
          fullWidth
          size="small"
          placeholder="搜索会话…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          InputProps={{
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon sx={{ fontSize: 15, color: "#697589" }} />
              </InputAdornment>
            ),
            sx: { fontSize: 12.5, borderRadius: "10px", background: "rgba(13,16,22,0.6)" },
          }}
        />
      </Box>
      {[...groups.entries()].map(([workspace, items]) => (
        <Box key={workspace} sx={{ mb: 1.25 }}>
          <Typography sx={{ fontSize: 11, color: "#697589", px: 1, py: 0.5 }} noWrap>
            {workspace}
          </Typography>
          <List dense sx={{ p: 0 }}>
            {items.map((session) => {
              const active = session.id === activeSessionId;
              return (
                <ListItemButton
                  key={session.id}
                  selected={active}
                  onClick={() => void handleLoad(session.id)}
                  sx={{
                    borderRadius: "10px",
                    mb: 0.5,
                    px: 1.25,
                    "&.Mui-selected": { background: "rgba(93,134,242,0.16)" },
                    "&:hover": { background: "rgba(134,169,255,0.08)" },
                    "& .row-actions": { opacity: 0 },
                    "&:hover .row-actions": { opacity: 1 },
                  }}
                >
                  <ListItemText
                    primary={
                      <Typography sx={{ fontSize: 13, fontWeight: active ? 700 : 500, color: "#f3f6fb" }} noWrap>
                        {session.title}
                      </Typography>
                    }
                    secondary={
                      <Typography sx={{ fontSize: 11, color: "#8d99ad" }} component="span" noWrap>
                        {relativeTime(session.updatedAt)}
                        {session.messageCount ? ` · ${session.messageCount} 条` : ""}
                      </Typography>
                    }
                  />
                  <Box className="row-actions" sx={{ display: "flex", transition: "opacity .12s ease" }}>
                    {active ? (
                      <Tooltip title="重命名当前会话">
                        <IconButton
                          size="small"
                          onClick={(e) => openRename(session.id, e)}
                          sx={{ color: "#697589", "&:hover": { color: "#a8c2ff" } }}
                        >
                          <EditIcon sx={{ fontSize: 15 }} />
                        </IconButton>
                      </Tooltip>
                    ) : null}
                    <Tooltip title="删除会话">
                      <IconButton
                        size="small"
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleting({ id: session.id, title: session.title });
                        }}
                        sx={{ color: "#697589", "&:hover": { color: "#f17f8d" } }}
                      >
                        <DeleteIcon sx={{ fontSize: 15 }} />
                      </IconButton>
                    </Tooltip>
                  </Box>
                </ListItemButton>
              );
            })}
          </List>
        </Box>
      ))}
      <Dialog open={renaming !== null} onClose={() => setRenaming(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontWeight: 700 }}>重命名会话</DialogTitle>
        <DialogContent sx={{ pt: 1 }}>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="会话名称"
            value={renaming?.name ?? ""}
            onChange={(e) => setRenaming((prev) => (prev ? { ...prev, name: e.target.value } : prev))}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitRename();
            }}
          />
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setRenaming(null)} sx={{ textTransform: "none" }}>
            取消
          </Button>
          <Button variant="contained" onClick={() => void commitRename()} sx={{ textTransform: "none" }}>
            保存
          </Button>
        </DialogActions>
      </Dialog>
      <Dialog open={deleting !== null} onClose={() => setDeleting(null)} fullWidth maxWidth="xs">
        <DialogTitle sx={{ fontWeight: 700 }}>删除会话</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13, color: "#8d99ad" }}>
            将永久删除会话「{deleting?.title}」的 JSONL 记录，此操作不可恢复。确定删除？
          </Typography>
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={() => setDeleting(null)} sx={{ textTransform: "none" }}>
            取消
          </Button>
          <Button variant="contained" color="error" onClick={() => void commitDelete()} sx={{ textTransform: "none" }}>
            删除
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
