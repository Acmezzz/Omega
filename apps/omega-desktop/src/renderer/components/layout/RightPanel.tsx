import * as React from "react";
import Box from "@mui/material/Box";
import Tabs from "@mui/material/Tabs";
import Tab from "@mui/material/Tab";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import { WorkflowPanel } from "../panels/WorkflowPanel";
import { ScoutPanel } from "../panels/ScoutPanel";
import { DiffViewer } from "../panels/DiffViewer";

export function RightPanel(): React.ReactElement {
  const rightTab = useAppStore((s) => s.layout.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const setExtensionState = useAppStore((s) => s.setExtensionState);
  const setExtensionLoading = useAppStore((s) => s.setExtensionLoading);
  const extensionLoading = useAppStore((s) => s.extensionLoading);

  const refresh = React.useCallback(async () => {
    setExtensionLoading(true);
    const res = await ipc.queryExtensionState({ scope: "all" });
    if (res.ok) setExtensionState(res.data);
    setExtensionLoading(false);
  }, [setExtensionState, setExtensionLoading]);

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
      <Box sx={{ display: "flex", alignItems: "center", borderBottom: "1px solid var(--omega-border)" }}>
        <Tabs
          value={rightTab}
          onChange={(_e, v) => setRightTab(v)}
          sx={{ flexGrow: 1, minHeight: 42, "& .MuiTab-root": { minHeight: 42, fontSize: 13 } }}
        >
          <Tab label="Workflow" value="workflow" />
          <Tab label="Scout" value="scout" />
          <Tab label="Diff" value="diff" />
        </Tabs>
        <Tooltip title="刷新扩展状态">
          <IconButton size="small" onClick={() => void refresh()} sx={{ color: "var(--omega-text-muted)", mr: 1 }} disabled={extensionLoading}>
            <RefreshIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ flexGrow: 1, minHeight: 0, overflowY: "auto", p: 1.5 }}>
        {rightTab === "workflow" ? <WorkflowPanel /> : null}
        {rightTab === "scout" ? <ScoutPanel /> : null}
        {rightTab === "diff" ? <DiffViewer /> : null}
      </Box>
    </Box>
  );
}
