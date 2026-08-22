import * as React from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import RemoveIcon from "@mui/icons-material/Remove";
import CropSquareIcon from "@mui/icons-material/CropSquare";
import FilterNoneIcon from "@mui/icons-material/FilterNone";
import CloseIcon from "@mui/icons-material/Close";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";

/**
 * Custom frameless title bar. The strip is a drag region (double-click toggles
 * maximize); min/max/close are custom-drawn and go through the guarded
 * window:* IPC. F11 (handled in main) toggles fullscreen.
 */
const dragStyle = { WebkitAppRegion: "drag" } as React.CSSProperties;
const noDragStyle = { WebkitAppRegion: "no-drag" } as React.CSSProperties;

const controlSx = {
  width: 44,
  height: 32,
  borderRadius: "8px",
  color: "#8d99ad",
  "&:hover": { color: "#f3f6fb", background: "rgba(255,255,255,0.08)" },
} as const;

export function TitleBar(): React.ReactElement {
  const agent = useAppStore((s) => s.agent);
  const [maximized, setMaximized] = React.useState(false);

  React.useEffect(() => {
    void ipc.isMaximized().then((res) => {
      if (res.ok) setMaximized(res.data.maximized);
    });
    return ipc.onWindowStateChanged((data) => setMaximized(Boolean(data?.maximized)));
  }, []);

  const workspaceLabel = React.useMemo(() => {
    const cwd = agent?.cwd;
    if (!cwd) return "";
    const parts = cwd.split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? cwd;
  }, [agent?.cwd]);

  return (
    <Box
      style={dragStyle}
      sx={{
        gridColumn: "1 / -1",
        height: 40,
        display: "flex",
        alignItems: "center",
        gap: 1.25,
        px: 1.5,
        userSelect: "none",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Box
          sx={{
            width: 18,
            height: 18,
            display: "grid",
            placeItems: "center",
            borderRadius: "6px",
            border: "1px solid rgba(134,169,255,0.4)",
            color: "#86a9ff",
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          Ω
        </Box>
        <Typography sx={{ fontSize: 12.5, fontWeight: 700, letterSpacing: "0.06em", color: "#a8c2ff" }}>
          OMEGA DESKTOP
        </Typography>
      </Box>
      {workspaceLabel ? (
        <>
          <Typography sx={{ fontSize: 12, color: "#5c6a82" }}>·</Typography>
          <Typography sx={{ fontSize: 12, color: "#8d99ad" }} noWrap>
            {workspaceLabel}
          </Typography>
        </>
      ) : null}
      <Box sx={{ flex: 1 }} />
      <Box style={noDragStyle} sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
        <Tooltip title="最小化">
          <IconButton size="small" disableRipple onClick={() => void ipc.minimize()} sx={controlSx}>
            <RemoveIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
        <Tooltip title={maximized ? "还原" : "最大化"}>
          <IconButton size="small" disableRipple onClick={() => void ipc.toggleMaximize()} sx={controlSx}>
            {maximized ? <FilterNoneIcon sx={{ fontSize: 13 }} /> : <CropSquareIcon sx={{ fontSize: 13 }} />}
          </IconButton>
        </Tooltip>
        <Tooltip title="关闭">
          <IconButton
            size="small"
            disableRipple
            onClick={() => void ipc.closeWindow()}
            sx={{ ...controlSx, "&:hover": { color: "#fff", background: "#f17f8d" } }}
          >
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Tooltip>
      </Box>
    </Box>
  );
}
