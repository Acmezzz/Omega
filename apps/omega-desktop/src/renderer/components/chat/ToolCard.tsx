import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import DescriptionIcon from "@mui/icons-material/Description";
import SearchIcon from "@mui/icons-material/Search";
import TerminalIcon from "@mui/icons-material/Terminal";
import EditIcon from "@mui/icons-material/EditOutlined";
import NoteAddIcon from "@mui/icons-material/NoteAddOutlined";
import type { ToolCardState } from "../../store/useAppStore";

const STATUS_COLOR: Record<string, string> = {
  running: "var(--omega-warning)",
  done: "var(--omega-success)",
  error: "var(--omega-danger)",
};

const KIND_LABEL: Record<string, string> = {
  read: "读取",
  edit: "编辑",
  write: "写入",
  bash: "执行",
  search: "搜索",
  other: "工具",
};

const KIND_ICON: Record<string, React.ReactElement> = {
  read: <DescriptionIcon sx={{ fontSize: 15 }} />,
  search: <SearchIcon sx={{ fontSize: 15 }} />,
  bash: <TerminalIcon sx={{ fontSize: 15 }} />,
  edit: <EditIcon sx={{ fontSize: 15 }} />,
  write: <NoteAddIcon sx={{ fontSize: 15 }} />,
};

/** Extract +/- line stats from an edit/write diff-style result (best effort). */
function diffStat(resultText?: string): { added: number; removed: number } | null {
  if (!resultText) return null;
  let added = 0;
  let removed = 0;
  for (const line of resultText.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return added + removed > 0 ? { added, removed } : null;
}

export interface ToolCardProps {
  card: ToolCardState;
}

/**
 * Full-fidelity tool card (V3): collapsed row shows verb + target + status +
 * +/- diff badge; expanded shows raw args JSON and the paired result text.
 */
function ToolCardInner({ card }: ToolCardProps): React.ReactElement {
  const color = STATUS_COLOR[card.status] ?? "var(--omega-text-muted)";
  const stat = card.kind === "edit" || card.kind === "write" ? diffStat(card.resultText) : null;

  return (
    <Accordion
      disableGutters
      elevation={0}
      sx={{
        background: "var(--omega-bg-soft)",
        border: `1px solid ${card.isError ? "var(--omega-danger)" : "var(--omega-border)"}`,
        borderRadius: "12px !important",
        mb: 1,
        maxWidth: "min(78%, 720px)",
        "&:before": { display: "none" },
      }}
    >
      <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: "var(--omega-text-muted)" }} />} sx={{ px: 1.5, py: 0.25, "& .MuiAccordionSummary-content": { minWidth: 0 } }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, width: "100%" }}>
          <Box sx={{ width: 7, height: 7, borderRadius: 999, background: color, flex: "0 0 auto" }} />
          <Box sx={{ color: "var(--omega-text-muted)", flex: "0 0 auto", display: "grid", placeItems: "center" }}>
            {KIND_ICON[card.kind] ?? <DescriptionIcon sx={{ fontSize: 15 }} />}
          </Box>
          <Typography sx={{ fontSize: 13, color: "var(--omega-text)", fontWeight: 600, flex: "0 0 auto" }} noWrap>
            {KIND_LABEL[card.kind] ?? "工具"} · {card.toolName}
          </Typography>
          {card.target ? (
            <Typography sx={{ fontSize: 12, color: "var(--omega-text-muted)", minWidth: 0, flex: 1 }} noWrap title={card.target}>
              {card.target}
            </Typography>
          ) : null}
          {stat ? (
            <Box sx={{ display: "flex", gap: 0.75, flex: "0 0 auto", fontFamily: "ui-monospace, Consolas, monospace", fontSize: 11 }}>
              <span style={{ color: "var(--omega-success)" }}>+{stat.added}</span>
              <span style={{ color: "var(--omega-danger)" }}>-{stat.removed}</span>
            </Box>
          ) : null}
          <Typography sx={{ fontSize: 11, color, flex: "0 0 auto" }}>
            {card.status === "running" ? "运行中" : card.status === "error" ? "失败" : "完成"}
          </Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1.5, pt: 0, pb: 1.25 }}>
        <Box sx={{ display: "flex", flexDirection: "column", gap: 1 }}>
          {card.argsJson ? (
            <Box>
              <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: "var(--omega-text-dim)", letterSpacing: "0.05em", mb: 0.5 }}>
                参数
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1,
                  borderRadius: "8px",
                  border: "1px solid var(--omega-border)",
                  background: "var(--omega-bg-code)",
                  maxHeight: 220,
                  overflow: "auto",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                  color: "var(--omega-text-soft)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {card.argsJson}
              </Box>
            </Box>
          ) : null}
          {card.resultText ? (
            <Box>
              <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: "var(--omega-text-dim)", letterSpacing: "0.05em", mb: 0.5 }}>
                结果{card.isError ? "（出错）" : ""}
              </Typography>
              <Box
                component="pre"
                sx={{
                  m: 0,
                  p: 1,
                  borderRadius: "8px",
                  border: `1px solid ${card.isError ? "var(--omega-danger)" : "var(--omega-border)"}`,
                  background: "var(--omega-bg-code)",
                  maxHeight: 300,
                  overflow: "auto",
                  fontSize: 11.5,
                  lineHeight: 1.55,
                  fontFamily: "ui-monospace, SFMono-Regular, Consolas, monospace",
                  color: card.isError ? "var(--omega-error-text)" : "var(--omega-text-soft)",
                  whiteSpace: "pre-wrap",
                  overflowWrap: "anywhere",
                }}
              >
                {card.resultText}
              </Box>
            </Box>
          ) : null}
          <Box sx={{ display: "flex", gap: 2, color: "var(--omega-text-dim)", fontSize: 11 }}>
            {card.startedAt ? <span>开始 {new Date(card.startedAt).toLocaleTimeString()}</span> : null}
            {card.endedAt ? <span>结束 {new Date(card.endedAt).toLocaleTimeString()}</span> : null}
          </Box>
        </Box>
      </AccordionDetails>
    </Accordion>
  );
}

export const ToolCard = React.memo(ToolCardInner);
