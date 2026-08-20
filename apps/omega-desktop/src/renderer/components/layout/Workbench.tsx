import * as React from "react";
import Box from "@mui/material/Box";
import { useAppStore } from "../../store/useAppStore";
import { Header } from "./Header";
import { LeftNav } from "./LeftNav";
import { ChatPanel } from "../chat/ChatPanel";
import { RightPanel } from "./RightPanel";

/**
 * Three-column workbench (Codex-style):
 *   [ LeftNav (fixed) | ChatPanel (flex) | RightPanel (collapsible) ]
 * Header spans the full width on top.
 */
export function Workbench(): React.ReactElement {
  const rightOpen = useAppStore((s) => s.layout.rightPanelOpen);
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateRows: "auto 1fr",
        gridTemplateColumns: rightOpen ? "248px minmax(0,1fr) 440px" : "248px minmax(0,1fr)",
        height: "100vh",
        gap: 1,
        p: 1,
        transition: "grid-template-columns 0.2s ease",
      }}
    >
      <Box sx={{ gridColumn: "1 / -1" }}>
        <Header />
      </Box>
      <Box sx={{ minHeight: 0, overflow: "hidden", display: "flex" }}>
        <LeftNav />
      </Box>
      <Box sx={{ minHeight: 0, overflow: "hidden", display: "flex" }}>
        <ChatPanel />
      </Box>
      {rightOpen ? (
        <Box sx={{ minHeight: 0, overflow: "hidden", display: "flex" }}>
          <RightPanel />
        </Box>
      ) : null}
    </Box>
  );
}
