import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DescriptionIcon from "@mui/icons-material/Description";
import type { ToolCardState } from "../../store/useAppStore";

const STATUS_COLOR: Record<string, string> = {
  running: "#e8bd68",
  done: "#6bd59a",
  error: "#f17f8d",
};

const KIND_LABEL: Record<string, string> = {
  read: "读取",
  edit: "编辑",
  write: "写入",
  bash: "执行",
  other: "工具",
};

export interface ToolCardProps {
  card: ToolCardState;
}

/**
 * Upgraded tool card — shows only the scrubbed summary (tool name + file
 * basename + op + status). No raw parameters, results, or paths are available
 * to the renderer. See system_design.md §3.2.
 */
export function ToolCard({ card }: ToolCardProps): React.ReactElement {
  const color = STATUS_COLOR[card.status] ?? "#8d99ad";
  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{
        background: "#171d29",
        border: "1px solid #2b3444",
        borderRadius: "12px !important",
        mb: 1,
        "&:before": { display: "none" },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: "#8d99ad" }} />} sx={{ px: 1.5, py: 0.25 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, width: "100%" }}>
          <Box sx={{ width: 7, height: 7, borderRadius: 999, background: color, flex: "0 0 auto" }} />
          <DescriptionIcon sx={{ fontSize: 16, color: "#8d99ad", flex: "0 0 auto" }} />
          <Typography sx={{ fontSize: 13, color: "#f3f6fb", fontWeight: 600 }} noWrap>
            {KIND_LABEL[card.kind] ?? "工具"} · {card.toolName}
          </Typography>
          {card.target ? (
            <Typography sx={{ fontSize: 12, color: "#8d99ad", ml: "auto" }} noWrap>
              {card.target}
            </Typography>
          ) : null}
          <Typography sx={{ fontSize: 11, color, ml: card.target ? 1 : "auto" }}>
            {card.status === "running" ? "运行中" : card.status === "error" ? "失败" : "完成"}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pt: 0, color: "#8d99ad", fontSize: 12 }}>
        <Box component="div" sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
          <span>工具：{card.toolName}</span>
          {card.op ? <span>操作：{card.op}</span> : null}
          {card.target ? <span>目标文件：{card.target}</span> : <span>目标文件：—</span>}
          {card.startedAt ? <span>开始：{new Date(card.startedAt).toLocaleTimeString()}</span> : null}
          {card.endedAt ? <span>结束：{new Date(card.endedAt).toLocaleTimeString()}</span> : null}
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}
