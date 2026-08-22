import * as React from "react";
import AppBar from "@mui/material/AppBar";
import Toolbar from "@mui/material/Toolbar";
import Typography from "@mui/material/Typography";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Chip from "@mui/material/Chip";
import Menu from "@mui/material/Menu";
import MenuItem from "@mui/material/MenuItem";
import Button from "@mui/material/Button";
import LinearProgress from "@mui/material/LinearProgress";
import KeyboardArrowRight from "@mui/icons-material/KeyboardArrowRight";
import KeyboardArrowLeft from "@mui/icons-material/KeyboardArrowLeft";
import AssessmentIcon from "@mui/icons-material/Assessment";
import ExploreIcon from "@mui/icons-material/Explore";
import StopIcon from "@mui/icons-material/Stop";
import CompressIcon from "@mui/icons-material/Compress";
import SettingsIcon from "@mui/icons-material/SettingsOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import AccountTreeIcon from "@mui/icons-material/AccountTree";
import LightModeIcon from "@mui/icons-material/LightMode";
import DarkModeIcon from "@mui/icons-material/DarkMode";
import SettingsBrightnessIcon from "@mui/icons-material/SettingsBrightness";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { ThinkingLevel } from "../../types/dto";
import type { ThemeMode } from "../../theme/palettes";
import { SettingsDialog } from "./SettingsDialog";
import { SessionInfoDialog } from "./SessionInfoDialog";
import { ModelPicker } from "./ModelPicker";

const CONNECTION_LABEL: Record<string, string> = {
  connecting: "连接中",
  ready: "就绪",
  running: "运行中",
  error: "错误",
};

const CONNECTION_COLOR: Record<string, string> = {
  connecting: "var(--omega-text-muted)",
  ready: "var(--omega-success)",
  running: "var(--omega-accent)",
  error: "var(--omega-danger)",
};

const THINKING_LABEL: Record<ThinkingLevel, string> = {
  off: "思考关",
  minimal: "思考 min",
  low: "思考 low",
  medium: "思考 mid",
  high: "思考 high",
  xhigh: "思考 xhigh",
  max: "思考 max",
};

const THEME_LABEL: Record<ThemeMode, string> = {
  light: "浅色",
  dark: "深色",
  system: "跟随系统",
};

function formatUsage(percent: number | null, tokens: number | null, contextWindow: number | null): string {
  if (percent !== null && Number.isFinite(percent)) return `${Math.round(percent)}%`;
  if (tokens !== null && contextWindow) return `${tokens}/${contextWindow}`;
  if (contextWindow) return `${contextWindow} ctx`;
  return "用量 —";
}

export function Header(): React.ReactElement {
  const connection = useAppStore((s) => s.connection);
  const bootstrapError = useAppStore((s) => s.bootstrapError);
  const rightOpen = useAppStore((s) => s.layout.rightPanelOpen);
  const rightTab = useAppStore((s) => s.layout.rightTab);
  const toggleRightPanel = useAppStore((s) => s.toggleRightPanel);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const setTreeOpen = useAppStore((s) => s.setTreeOpen);
  const agent = useAppStore((s) => s.agent);
  const auth = useAppStore((s) => s.auth);
  const compacting = useAppStore((s) => s.compacting);
  const thinkingActive = useAppStore((s) => s.thinkingActive);
  const retrying = useAppStore((s) => s.retrying);
  const setAgent = useAppStore((s) => s.setAgent);
  const setConnection = useAppStore((s) => s.setConnection);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);

  const [thinkingAnchor, setThinkingAnchor] = React.useState<HTMLElement | null>(null);
  const [authAnchor, setAuthAnchor] = React.useState<HTMLElement | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [infoOpen, setInfoOpen] = React.useState(false);
  const [modelAnchor, setModelAnchor] = React.useState<HTMLElement | null>(null);
  const [busy, setBusy] = React.useState(false);

  const statusColor = bootstrapError ? "var(--omega-danger)" : CONNECTION_COLOR[connection];
  const running = connection === "running";
  const modelLabel = agent?.model ? `${agent.model.provider}/${agent.model.id}` : "未选模型";
  const usagePercent = agent?.usage.percent ?? null;
  const usageLabel = formatUsage(usagePercent, agent?.usage.tokens ?? null, agent?.usage.contextWindow ?? null);
  const thinkingLevels = agent?.thinkingLevels?.length ? agent.thinkingLevels : (["off", "minimal", "low", "medium", "high"] as ThinkingLevel[]);
  const nextTheme: ThemeMode = themeMode === "light" ? "dark" : themeMode === "dark" ? "system" : "light";
  const ThemeIcon = themeMode === "light" ? LightModeIcon : themeMode === "dark" ? DarkModeIcon : SettingsBrightnessIcon;

  const handleAbort = React.useCallback(async () => {
    setBusy(true);
    try {
      await ipc.abort();
      setConnection("ready");
    } finally {
      setBusy(false);
    }
  }, [setConnection]);

  const handleCompact = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await ipc.compact();
      if (res.ok) setAgent(res.data);
    } finally {
      setBusy(false);
    }
  }, [setAgent]);

  const handleSetThinking = React.useCallback(
    async (level: ThinkingLevel) => {
      setThinkingAnchor(null);
      const res = await ipc.setThinkingLevel({ level });
      if (res.ok) setAgent(res.data);
    },
    [setAgent],
  );

  return (
    <AppBar
      position="static"
      elevation={0}
      sx={{
        background: "var(--omega-panel-glass)",
        border: "1px solid var(--omega-border)",
        borderRadius: "18px",
        backdropFilter: "blur(6px)",
      }}
    >
      <Toolbar
        sx={{
          gap: 1,
          px: 2,
          rowGap: 0.75,
          minHeight: { xs: 56, md: 64 },
          flexWrap: "wrap",
          "& > *": { flexShrink: 0 },
        }}
      >
        <Box
          sx={{
            width: 38,
            height: 38,
            display: "grid",
            placeItems: "center",
            borderRadius: "12px",
            border: "1px solid var(--omega-border-strong)",
            color: "var(--omega-accent)",
            background: "var(--omega-accent-soft)",
            fontSize: 23,
            fontWeight: 700,
          }}
        >
          Ω
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700, letterSpacing: "0.02em", lineHeight: 1.1 }}>Omega</Typography>
          <Typography sx={{ color: "var(--omega-text-muted)", fontSize: 12 }} noWrap>
            {agent?.sessionName || "Agent workspace"}
          </Typography>
        </Box>

        <Box sx={{ flexGrow: 1 }} />

        <Chip
          size="small"
          label={modelLabel}
          onClick={(e) => setModelAnchor(e.currentTarget)}
          sx={{
            maxWidth: { xs: 150, sm: 200, md: 220 },
            cursor: "pointer",
            "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
          }}
        />
        <ModelPicker anchor={modelAnchor} onClose={() => setModelAnchor(null)} />

        <Chip
          size="small"
          label={THINKING_LABEL[agent?.thinkingLevel ?? "off"]}
          onClick={(e) => setThinkingAnchor(e.currentTarget)}
          disabled={agent?.supportsThinking === false}
          sx={{ cursor: "pointer" }}
        />
        <Menu anchorEl={thinkingAnchor} open={Boolean(thinkingAnchor)} onClose={() => setThinkingAnchor(null)}>
          {thinkingLevels.map((level) => (
            <MenuItem key={level} selected={agent?.thinkingLevel === level} onClick={() => void handleSetThinking(level)}>
              {THINKING_LABEL[level] ?? level}
            </MenuItem>
          ))}
        </Menu>

        <Tooltip title="上下文用量">
          <Box sx={{ width: 92, mr: 0.5, display: { xs: "none", md: "block" } }}>
            <Typography sx={{ fontSize: 10, color: "var(--omega-text-muted)", lineHeight: 1.2 }}>{usageLabel}</Typography>
            <LinearProgress
              variant="determinate"
              value={Math.max(0, Math.min(100, usagePercent ?? 0))}
              sx={{ height: 4, borderRadius: 99, background: "var(--omega-border)" }}
            />
          </Box>
        </Tooltip>

        {thinkingActive ? <Chip size="small" label="思考中" color="secondary" /> : null}
        {compacting ? <Chip size="small" label="压缩中" color="warning" /> : null}
        {retrying ? <Chip size="small" label="重试中" /> : null}

        {running ? (
          <Button
            size="small"
            color="error"
            startIcon={<StopIcon />}
            onClick={() => void handleAbort()}
            disabled={busy}
            sx={{ textTransform: "none", borderRadius: "999px" }}
          >
            停止
          </Button>
        ) : (
          <Tooltip title="压缩上下文">
            <span>
              <IconButton size="small" onClick={() => void handleCompact()} disabled={busy || compacting} sx={{ color: "var(--omega-text-muted)" }}>
                <CompressIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        )}

        <Tooltip title={`主题：${THEME_LABEL[themeMode]}（点击切换）`}>
          <IconButton
            size="small"
            onClick={(e) => setThemeMode(nextTheme, { x: e.clientX, y: e.clientY })}
            sx={{ color: "var(--omega-text-muted)" }}
          >
            <ThemeIcon fontSize="small" />
          </IconButton>
        </Tooltip>

        <Tooltip title={running ? "生成中无法切换分支" : "会话分支树"}>
          <span>
            <IconButton size="small" onClick={() => setTreeOpen(true)} disabled={running} sx={{ color: "var(--omega-text-muted)" }}>
              <AccountTreeIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>

        <Chip
          size="small"
          label={auth?.label ?? "未登录"}
          variant={auth?.ready ? "filled" : "outlined"}
          onClick={(e) => setAuthAnchor(e.currentTarget)}
          sx={{ cursor: "pointer", display: { xs: "none", lg: "inline-flex" } }}
        />
        <Menu anchorEl={authAnchor} open={Boolean(authAnchor)} onClose={() => setAuthAnchor(null)}>
          {(auth?.providers ?? []).length === 0 ? (
            <MenuItem disabled>无已配置 provider</MenuItem>
          ) : (
            (auth?.providers ?? []).map((provider) => (
              <MenuItem key={provider.id} disabled>
                {provider.name} · {provider.configured ? provider.source ?? "已配置" : "未配置"}
              </MenuItem>
            ))
          )}
        </Menu>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1, color: "var(--omega-text-muted)", fontSize: 12 }}>
          <Box
            sx={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: statusColor,
              boxShadow: `0 0 0 4px color-mix(in srgb, ${statusColor} 18%, transparent)`,
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
            sx={{ cursor: "pointer", display: { xs: "none", sm: "inline-flex" } }}
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
            sx={{ cursor: "pointer", display: { xs: "none", sm: "inline-flex" } }}
          />
        </Tooltip>

        <Tooltip title="会话信息 / 导出">
          <IconButton size="small" onClick={() => setInfoOpen(true)} sx={{ color: "var(--omega-text-muted)" }}>
            <InfoOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <SessionInfoDialog open={infoOpen} onClose={() => setInfoOpen(false)} />

        <Tooltip title="设置">
          <IconButton size="small" onClick={() => setSettingsOpen(true)} sx={{ color: "var(--omega-text-muted)" }}>
            <SettingsIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />

        <Tooltip title={rightOpen ? "收起右栏" : "展开右栏"}>
          <IconButton size="small" onClick={toggleRightPanel} sx={{ color: "var(--omega-text-muted)" }}>
            {rightOpen ? <KeyboardArrowRight /> : <KeyboardArrowLeft />}
          </IconButton>
        </Tooltip>
      </Toolbar>
    </AppBar>
  );
}
