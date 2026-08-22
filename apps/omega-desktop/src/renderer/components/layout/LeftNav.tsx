import * as React from "react";
import Box from "@mui/material/Box";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import AddIcon from "@mui/icons-material/Add";
import { useAppStore } from "../../store/useAppStore";
import { SessionList } from "../sessions/SessionList";
import { NewSessionDialog } from "../sessions/NewSessionDialog";
import { FileTree } from "../files/FileTree";

export function LeftNav(): React.ReactElement {
  const [newOpen, setNewOpen] = React.useState(false);
  const leftTab = useAppStore((s) => s.layout.leftTab);
  const setLayout = useAppStore((s) => s.setLayout);

  return (
    <Box
      sx={{
        width: "100%",
        display: "flex",
        flexDirection: "column",
        background: "var(--omega-panel-glass)",
        border: "1px solid var(--omega-border)",
        borderRadius: "18px",
        overflow: "hidden",
      }}
    >
      <Box sx={{ px: 1.5, pt: 1, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Tabs
          value={leftTab}
          onChange={(_e, value) => setLayout({ leftTab: value })}
          sx={{ minHeight: 32, "& .MuiTab-root": { minHeight: 32, minWidth: 64, fontSize: 12.5, px: 1.25 } }}
        >
          <Tab label="会话" value="sessions" />
          <Tab label="文件" value="files" />
        </Tabs>
        {leftTab === "sessions" ? (
          <Button
            size="small"
            startIcon={<AddIcon />}
            onClick={() => setNewOpen(true)}
            sx={{ textTransform: "none", borderRadius: "999px", flex: "0 0 auto" }}
          >
            新建
          </Button>
        ) : null}
      </Box>
      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", px: 0.75, pb: 1.5, pt: 0.5 }}>
        {leftTab === "sessions" ? <SessionList /> : <FileTree />}
      </Box>
      <Box sx={{ p: 1.25, pt: 1, borderTop: "1px solid var(--omega-border)" }}>
        <Typography sx={{ fontSize: 11, color: "var(--omega-text-dim)" }}>JSONL 会话与扩展面板在右栏。输入 / 打开命令。</Typography>
      </Box>
      <NewSessionDialog open={newOpen} onClose={() => setNewOpen(false)} />
    </Box>
  );
}
