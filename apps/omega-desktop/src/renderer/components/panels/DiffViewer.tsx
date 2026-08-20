import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import FormControlLabel from "@mui/material/FormControlLabel";
import Stack from "@mui/material/Stack";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { DiffFile, ChangeApprovalResult } from "../../types/dto";
import { ApprovalBar } from "./ApprovalBar";

const STATUS_LABEL: Record<DiffFile["status"], string> = {
  added: "新增",
  modified: "修改",
  deleted: "删除",
  renamed: "重命名",
};

const STATUS_COLOR: Record<DiffFile["status"], "success" | "warning" | "error" | "info"> = {
  added: "success",
  modified: "warning",
  deleted: "error",
  renamed: "info",
};

function HunkLine({ line }: { line: DiffFile["hunks"][number]["lines"][number] }) {
  const bg = line.type === "add" ? "rgba(107,213,154,0.12)" : line.type === "del" ? "rgba(241,127,141,0.12)" : "transparent";
  const color = line.type === "add" ? "#6bd59a" : line.type === "del" ? "#f17f8d" : "#8d99ad";
  const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <Box component="div" sx={{ display: "flex", bgcolor: bg, fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "pre" }}>
      <Box component="span" sx={{ color, flex: "0 0 auto", userSelect: "none", px: 0.5 }}>
        {prefix}
      </Box>
      <Box component="span" sx={{ color: "#e7ebf3", flex: 1, overflowX: "auto" }}>
        {line.content}
      </Box>
    </Box>
  );
}

function FileCard({
  file,
  checked,
  onToggle,
}: {
  file: DiffFile;
  checked: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <Paper sx={{ p: 1.25, mb: 1, background: "#171d29", border: "1px solid #2b3444" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Checkbox size="small" checked={checked} onChange={() => onToggle(file.path)} sx={{ p: 0.25 }} />
        <Typography sx={{ fontSize: 13, color: "#f3f6fb", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {file.path}
        </Typography>
        <Chip size="small" label={STATUS_LABEL[file.status]} color={STATUS_COLOR[file.status]} />
        <Typography sx={{ fontSize: 11, color: "#6bd59a" }}>+{file.additions}</Typography>
        <Typography sx={{ fontSize: 11, color: "#f17f8d" }}>-{file.deletions}</Typography>
      </Box>
      {file.hunks.map((hunk, i) => (
        <Box key={i} sx={{ mt: 0.75, border: "1px solid #2b3444", borderRadius: "8px", overflow: "hidden" }}>
          <Typography sx={{ fontSize: 11, color: "#8d99ad", px: 1, py: 0.25, background: "#0d1016" }}>{hunk.header}</Typography>
          <Box sx={{ px: 1, py: 0.5 }}>
            {hunk.lines.map((line, j) => (
              <HunkLine key={j} line={line} />
            ))}
          </Box>
        </Box>
      ))}
    </Paper>
  );
}

export function DiffViewer(): React.ReactElement {
  const diff = useAppStore((s) => s.diff);
  const setDiff = useAppStore((s) => s.setDiff);
  const setApproval = useAppStore((s) => s.setApproval);
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [busy, setBusy] = React.useState(false);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    const res = await ipc.diffWorkspace({});
    if (res.ok) setDiff(res.data);
    setBusy(false);
  }, [setDiff]);

  React.useEffect(() => {
    if (!diff) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggle = React.useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleApplied = React.useCallback(
    async (_result: ChangeApprovalResult) => {
      setApproval(_result);
      setSelected(new Set());
      // Re-read the diff after a revert.
      await refresh();
    },
    [setApproval, refresh],
  );

  if (!diff) {
    return (
      <Box sx={{ textAlign: "center", mt: 4 }}>
        <Button variant="outlined" onClick={() => void refresh()} disabled={busy} sx={{ textTransform: "none" }}>
          {busy ? "生成中…" : "生成工作区 Diff"}
        </Button>
      </Box>
    );
  }

  if (!diff.isGitRepo) {
    return (
      <Typography sx={{ color: "#e8bd68", fontSize: 13, mt: 2 }}>
        当前工作区未纳入 git，无法生成 diff。请在 git 仓库内运行 Omega Desktop。
      </Typography>
    );
  }

  const selectedList = [...selected].filter((p) => diff.files.some((f) => f.path === p));
  const hasUntrackedSelected = diff.files.some(
    (f) => selected.has(f.path) && f.status === "added",
  );

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontSize: 12, color: "#8d99ad" }}>仓库：{diff.repoRoot}</Typography>
        <Button size="small" onClick={() => void refresh()} disabled={busy} sx={{ textTransform: "none" }}>
          {busy ? "刷新中…" : "刷新"}
        </Button>
      </Box>
      {diff.files.length === 0 ? (
        <Typography sx={{ color: "#697589", fontSize: 13 }}>工作区没有未提交的改动。</Typography>
      ) : (
        <>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={selectedList.length === diff.files.length && diff.files.length > 0}
                indeterminate={selectedList.length > 0 && selectedList.length < diff.files.length}
                onChange={(e) => setSelected(e.target.checked ? new Set(diff.files.map((f) => f.path)) : new Set())}
              />
            }
            label={<Typography sx={{ fontSize: 12, color: "#8d99ad" }}>全选（{diff.files.length} 个文件）</Typography>}
          />
          {diff.files.map((file) => (
            <FileCard key={file.path} file={file} checked={selected.has(file.path)} onToggle={toggle} />
          ))}
          <ApprovalBar selectedFiles={selectedList} hasUntrackedSelected={hasUntrackedSelected} onApplied={handleApplied} />
        </>
      )}
    </Box>
  );
}
