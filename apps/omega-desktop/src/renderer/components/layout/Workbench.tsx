import * as React from "react";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import AssessmentIcon from "@mui/icons-material/Assessment";
import ExploreIcon from "@mui/icons-material/Explore";
import DifferenceIcon from "@mui/icons-material/Difference";
import { useAppStore } from "../../store/useAppStore";
import { TitleBar } from "./TitleBar";
import { Header } from "./Header";
import { LeftNav } from "./LeftNav";
import { ChatPanel } from "../chat/ChatPanel";
import { RightPanel } from "./RightPanel";

const RIGHT_COLLAPSED_RAIL_PX = 44;
const MIN_SIDEBAR_PX = 200;
const MAX_SIDEBAR_PX = 420;
const MIN_RIGHT_PX = 300;
const MAX_RIGHT_PX = 620;

function loadWidths(): { left: number; right: number } {
  try {
    const raw = localStorage.getItem("omega-panel-widths");
    if (raw) {
      const parsed = JSON.parse(raw) as { left?: number; right?: number };
      return {
        left: Math.min(MAX_SIDEBAR_PX, Math.max(MIN_SIDEBAR_PX, parsed.left ?? 248)),
        right: Math.min(MAX_RIGHT_PX, Math.max(MIN_RIGHT_PX, parsed.right ?? 440)),
      };
    }
  } catch {
    /* defaults */
  }
  return { left: 248, right: 440 };
}

/**
 * Three-column workbench (Codex-style) with drag-resizable side panels
 * (layout technique ported from pi-app main-layout-shell, MIT): only
 * grid-template-columns transitions, dragging disables the transition, and
 * the collapsed right panel keeps a slim icon rail.
 */
export function Workbench(): React.ReactElement {
  const rightOpen = useAppStore((s) => s.layout.rightPanelOpen);
  const rightTab = useAppStore((s) => s.layout.rightTab);
  const setRightTab = useAppStore((s) => s.setRightTab);
  const [widths, setWidths] = React.useState(loadWidths);
  const [dragging, setDragging] = React.useState<null | "left" | "right">(null);
  const widthsRef = React.useRef(widths);

  const persist = React.useCallback((next: { left: number; right: number }) => {
    try {
      localStorage.setItem("omega-panel-widths", JSON.stringify(next));
    } catch {
      /* best effort */
    }
  }, []);

  // Pointer capture: releasing outside the window still ends the drag
  // (mousemove/mouseup on window would miss it and lock the cursor).
  const startDrag = React.useCallback(
    (side: "left" | "right") => (e: React.PointerEvent) => {
      e.preventDefault();
      const target = e.currentTarget as HTMLElement;
      try {
        target.setPointerCapture(e.pointerId);
      } catch {
        /* older Electron */
      }
      setDragging(side);
      const startX = e.clientX;
      const startWidths = { ...widthsRef.current };
      const onMove = (move: PointerEvent) => {
        const delta = side === "left" ? move.clientX - startX : startX - move.clientX;
        if (side === "left") {
          const left = Math.min(MAX_SIDEBAR_PX, Math.max(MIN_SIDEBAR_PX, startWidths.left + delta));
          widthsRef.current = { ...widthsRef.current, left };
          setWidths(widthsRef.current);
        } else {
          const right = Math.min(MAX_RIGHT_PX, Math.max(MIN_RIGHT_PX, startWidths.right + delta));
          widthsRef.current = { ...widthsRef.current, right };
          setWidths(widthsRef.current);
        }
      };
      const cleanup = (up?: PointerEvent) => {
        if (up) {
          try {
            target.releasePointerCapture(up.pointerId);
          } catch {
            /* already released */
          }
        }
        target.removeEventListener("pointermove", onMove);
        target.removeEventListener("pointerup", onUp);
        target.removeEventListener("lostpointercapture", onLost);
        setDragging(null);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        persist(widthsRef.current);
      };
      const onUp = (up: PointerEvent) => cleanup(up);
      const onLost = () => cleanup();
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      target.addEventListener("pointermove", onMove);
      target.addEventListener("pointerup", onUp);
      target.addEventListener("lostpointercapture", onLost);
    },
    [persist],
  );

  const leftCol = `${widths.left}px`;
  const rightCol = rightOpen ? `${widths.right}px` : `${RIGHT_COLLAPSED_RAIL_PX}px`;

  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateRows: "auto auto 1fr",
        gridTemplateColumns: `${leftCol} minmax(0,1fr) ${rightCol}`,
        height: "100vh",
        gap: 1,
        p: 1,
        pt: 0,
        transition: dragging ? "none" : "grid-template-columns 0.28s cubic-bezier(0.22, 1, 0.36, 1)",
      }}
    >
      <TitleBar />
      <Box sx={{ gridColumn: "1 / -1" }}>
        <Header />
      </Box>
      <Box sx={{ minHeight: 0, overflow: "hidden", display: "flex", position: "relative" }}>
        <LeftNav />
        <Box
          onPointerDown={startDrag("left")}
          sx={{
            position: "absolute",
            right: 0,
            top: 0,
            bottom: 0,
            width: 7,
            cursor: "col-resize",
            zIndex: 5,
            touchAction: "none",
            "&:hover": { background: "var(--omega-accent-soft)" },
          }}
        />
      </Box>
      <Box sx={{ minHeight: 0, overflow: "hidden", display: "flex" }}>
        <ChatPanel />
      </Box>
      <Box sx={{ minHeight: 0, overflow: "hidden", display: "flex", position: "relative" }}>
        {rightOpen ? (
          <RightPanel />
        ) : (
          <Box
            sx={{
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 1,
              pt: 2,
                background: "var(--omega-panel-glass)",
              border: "1px solid var(--omega-border)",
              borderRadius: "18px",
            }}
          >
            <Tooltip title="工作流">
              <IconButton
                size="small"
                onClick={() => setRightTab("workflow")}
                sx={{ color: rightTab === "workflow" ? "var(--omega-accent)" : "var(--omega-text-muted)" }}
              >
                <AssessmentIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="探索 Scout">
              <IconButton
                size="small"
                onClick={() => setRightTab("scout")}
                sx={{ color: rightTab === "scout" ? "var(--omega-accent)" : "var(--omega-text-muted)" }}
              >
                <ExploreIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <Tooltip title="变更 Diff">
              <IconButton
                size="small"
                onClick={() => setRightTab("diff")}
                sx={{ color: rightTab === "diff" ? "var(--omega-accent)" : "var(--omega-text-muted)" }}
              >
                <DifferenceIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Box>
        )}
        {rightOpen ? (
          <Box
            onPointerDown={startDrag("right")}
            sx={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: 7,
              cursor: "col-resize",
              zIndex: 5,
              touchAction: "none",
              "&:hover": { background: "var(--omega-accent-soft)" },
            }}
          />
        ) : null}
      </Box>
    </Box>
  );
}
