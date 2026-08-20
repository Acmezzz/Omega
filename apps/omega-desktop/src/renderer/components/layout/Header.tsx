import * as React from "react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import AssessmentIcon from "@mui/icons-material/Assessment";
import ExploreIcon from "@mui/icons-material/Explore";
import { useAppStore } from "../../store/useAppStore";

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "连接中",
  ready: "就绪",
  running: "运行中",
  error: "错误",
};

const CONNECTION_COLOR: Record<string, string> = {
  connecting: "#8d99ad",
  ready: "#6bd59a",
  running: "#86a9ff",
  error: "#f17f8d",
};

export function Header(): React.ReactElement {
  const connection = useAppStore((s) => s.connection);
  const bootstrapError = useAppStore((s) => s.bootstrapError);
  const rightOpen = useAppStore((s) => s.layout.rightPanelOpen);
  const rightTab = useAppStore((s) => s.layout.rightTab);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const setRightTab = useAppStore((s) => s.setRightTab);

  const statusColor = bootstrapError ? CONNECTION_COLOR.error : CONNECTION_COLOR[connection];

  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        background: "rgba(21,25,35,0.78)",
        border: "1px solid #2b3444",
        borderRadius: "18px",
        backdropFilter: "blur(6px)",
      }}
    >
      <Toolbar sx={{ gap: 1.5, px: 2 }}>
        <Box
          sx={{
            width: 38,
            height: 38,
            display: "grid",
            placeItems: "center",
            borderRadius: "12px",
            border: "1px solid rgba(134,169,255,0.42)",
            color: "#86a9ff",
            background: "rgba(134,169,255,0.14)",
            boxShadow: "0 0 26px rgba(93,134,242,0.14)",
            fontSize: 23,
            fontWeight: 700,
          }}
        >
          Ω
        </Box>
        <Box>
          <Typography sx={{ fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1.1 }}>Omega</Typography>
          <Typography sx={{ color: "#8d99ad", fontSize: 12 }}>Agent workspace</Typography>
        </Box>

        <Box sx={{ flexGrow: 1 }} />

        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "#8d99ad", fontSize: 12 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: statusColor,
              boxShadow: `0 0 0 4px ${statusColor}22`,
            }}
          />
          <span>{bootstrapError ? "初始化失败" : CONNECTION_LABEL[connection]}</span>
        </Box>

        <Tooltip title="工作流">
          <Chip
            icon={<AssessmentIcon sx={{ fontSize: 16 }} />}
            label="Workflow"
            size="small"
            variant={rightTab === "workflow" && rightOpen ? "filled" : "outlined"}
            color="primary"
            onClick={() => setRightTab("workflow")}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>
        <Tooltip title="探索 Scout">
          <Chip
            icon={<ExploreIcon sx={{ fontSize: 16 }} />}
            label="Scout"
            size="small"
            variant={rightTab === "scout" && rightOpen ? "filled" : "outlined"}
            color="secondary"
            onClick={() => setRightTab("scout")}
            sx={{ cursor: "pointer" }}
          />
        </Tooltip>

        <Tooltip title={rightOpen ? "收起右栏" : "展开右栏"}>
          <IconButton size="small" onClick={toggleRightPanel} sx={{ color: "#8d99ad" }}>
            {rightOpen ? <KeyboardArrowRight /> : <KeyboardArrowLeft />}
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
