import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Chip from "@mui/material/Chip";
import Button from "@mui/material/Button";
import Checkbox from "@mui/material/Checkbox";
import TextField from "@mui/material/TextField";
import Accordion from "@mui/material/Accordion";
import AccordionSummary from "@mui/material/AccordionSummary";
import AccordionDetails from "@mui/material/AccordionDetails";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { DiffFile, GitSnapshot, GitStageItem } from "../../types/dto";
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
  const color = line.type === "add" ? "var(--omega-success)" : line.type === "del" ? "var(--omega-danger)" : "var(--omega-text-muted)";
  const prefix = line.type === "add" ? "+" : line.type === "del" ? "-" : " ";
  return (
    <Box component="div" sx={{ display: "flex", bgcolor: bg, fontFamily: "ui-monospace, monospace", fontSize: 12, whiteSpace: "pre" }}>
      <Box component="span" sx={{ color, flex: "0 0 auto", userSelect: "none", px: 0.5 }}>
        {prefix}
      </Box>
      <Box component="span" sx={{ color: "var(--omega-text-soft)", flex: 1, overflowX: "auto" }}>
        {line.content}
      </Box>
    </Box>
  );
}

interface Selection {
  /** path -> selected hunk indexes (empty set = whole file) */
  files: Map<string, Set<number>>;
}

/** Collect the picked items (whole-file or hunk-level) for stage/unstage. */
function collectItems(selection: Selection, files: DiffFile[]): GitStageItem[] {
  const out: GitStageItem[] = [];
  for (const [path, hunks] of selection.files) {
    if (hunks.size === 0) {
      out.push({ path });
      continue;
    }
    const file = files.find((f) => f.path === path);
    const raws = [...hunks].map((i) => file?.hunks[i]?.raw ?? "").filter(Boolean);
    out.push({ path, hunks: raws.length > 0 ? raws : undefined });
  }
  return out;
}

function FileCard({
  file,
  selection,
  onToggleFile,
  onToggleHunk,
  onOpenFile,
}: {
  file: DiffFile;
  selection: Selection;
  onToggleFile: (path: string) => void;
  onToggleHunk: (path: string, hunkIndex: number) => void;
  onOpenFile: (path: string) => void;
}) {
  const selectedHunks = selection.files.get(file.path);
  const wholeFile = selectedHunks !== undefined && selectedHunks.size === 0;
  return (
    <Accordion disableGutters elevation={0} sx={{ background: "var(--omega-bg-soft)", border: "1px solid var(--omega-border)", borderRadius: "10px !important", mb: 0.75, "&:before": { display: "none" } }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon sx={{ color: "var(--omega-text-muted)" }} />} sx={{ px: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, width: "100%" }}>
          <Checkbox
            size="small"
            checked={wholeFile}
            indeterminate={!wholeFile && (selectedHunks?.size ?? 0) > 0}
            onClick={(e) => {
              e.stopPropagation();
              onToggleFile(file.path);
            }}
            onChange={() => onToggleFile(file.path)}
            sx={{ p: 0.25 }}
          />
          <Typography
            onClick={() => onOpenFile(file.path)}
            title="在查看器中打开"
            sx={{ fontSize: 12.5, color: "var(--omega-text)", fontWeight: 600, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "pointer", "&:hover": { color: "var(--omega-accent)" } }}
          >
            {file.path}
          </Typography>
          <Chip size="small" label={STATUS_LABEL[file.status]} color={STATUS_COLOR[file.status]} />
          <Typography sx={{ fontSize: 11, color: "var(--omega-success)" }}>+{file.additions}</Typography>
          <Typography sx={{ fontSize: 11, color: "var(--omega-danger)" }}>-{file.deletions}</Typography>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: 1, pt: 0 }}>
        {file.hunks.map((hunk, i) => (
          <Box key={i} sx={{ mt: 0.75, border: "1px solid var(--omega-border)", borderRadius: "8px", overflow: "hidden" }}>
            <Box
              sx={{ display: "flex", alignItems: "center", background: "var(--omega-bg)", cursor: "pointer" }}
              onClick={() => onToggleHunk(file.path, i)}
            >
              <Checkbox size="small" checked={wholeFile || (selectedHunks?.has(i) ?? false)} sx={{ p: 0.25 }} />
              <Typography sx={{ fontSize: 11, color: "var(--omega-text-muted)" }}>{hunk.header}</Typography>
            </Box>
            <Box sx={{ px: 1, py: 0.5 }}>
              {hunk.lines.map((line, j) => (
                <HunkLine key={j} line={line} />
              ))}
            </Box>
          </Box>
        ))}
      </AccordionDetails>
    </Accordion>
  );
}

function SectionTitle({ label, count }: { label: string; count: number }): React.ReactElement {
  return (
    <Typography sx={{ fontSize: 11.5, fontWeight: 700, color: "var(--omega-text-muted)", letterSpacing: "0.05em", mt: 1.25, mb: 0.75 }}>
      {label}（{count}）
    </Typography>
  );
}

/** Build stage/unstage items from the selection (whole file when no hunks picked). */

export function DiffViewer(): React.ReactElement {
  const snapshot = useAppStore((s) => s.gitSnapshot);
  const setGitSnapshot = useAppStore((s) => s.setGitSnapshot);
  const openViewer = useAppStore((s) => s.openViewer);
  const [unstagedSel, setUnstagedSel] = React.useState<Selection>({ files: new Map() });
  const [stagedSel, setStagedSel] = React.useState<Selection>({ files: new Map() });
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const refresh = React.useCallback(async () => {
    setBusy(true);
    const res = await ipc.gitSnapshot();
    if (res.ok) setGitSnapshot(res.data);
    else setError(res.message);
    setBusy(false);
  }, [setGitSnapshot]);

  React.useEffect(() => {
    if (!snapshot) void refresh();
  }, [snapshot, refresh]);

  const clearSel = () => {
    setUnstagedSel({ files: new Map() });
    setStagedSel({ files: new Map() });
  };

  const toggleFile = (setter: React.Dispatch<React.SetStateAction<Selection>>) => (path: string) => {
    setter((prev) => {
      const files = new Map(prev.files);
      if (files.has(path)) files.delete(path);
      else files.set(path, new Set());
      return { files };
    });
  };

  const toggleHunk = (setter: React.Dispatch<React.SetStateAction<Selection>>) => (path: string, hunkIndex: number) => {
    setter((prev) => {
      const files = new Map(prev.files);
      let hunks = files.get(path);
      if (hunks === undefined) {
        hunks = new Set<number>();
      } else if (hunks.size === 0) {
        return prev; // whole file selected — hunk toggle disabled
      }
      if (hunks.has(hunkIndex)) hunks.delete(hunkIndex);
      else hunks.add(hunkIndex);
      files.set(path, hunks);
      return { files };
    });
  };

  const stage = React.useCallback(async () => {
    const withHunks = collectItems(unstagedSel, snapshot?.unstaged ?? []);
    if (withHunks.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await ipc.gitStage({ items: withHunks });
    setBusy(false);
    if (res.ok && res.data.applied) {
      clearSel();
      await refresh();
    } else if (res.ok) {
      setError(res.data.errors.join("\n"));
    } else {
      setError(res.message);
    }
  }, [unstagedSel, snapshot, refresh]);

  const unstage = React.useCallback(async () => {
    const withHunks = collectItems(stagedSel, snapshot?.staged ?? []);
    if (withHunks.length === 0) return;
    setBusy(true);
    setError(null);
    const res = await ipc.gitUnstage({ items: withHunks });
    setBusy(false);
    if (res.ok && res.data.applied) {
      clearSel();
      await refresh();
    } else if (res.ok) {
      setError(res.data.errors.join("\n"));
    } else {
      setError(res.message);
    }
  }, [stagedSel, snapshot, refresh]);

  const commit = React.useCallback(async () => {
    const msg = message.trim();
    if (!msg) return;
    setBusy(true);
    setError(null);
    const res = await ipc.gitCommit({ message: msg });
    setBusy(false);
    if (res.ok) {
      setMessage("");
      await refresh();
    } else {
      setError(res.message);
    }
  }, [message, refresh]);

  if (!snapshot) {
    return (
      <Box sx={{ textAlign: "center", mt: 4 }}>
        <Button variant="outlined" onClick={() => void refresh()} disabled={busy} sx={{ textTransform: "none" }}>
          {busy ? "生成中…" : "生成 Git 快照"}
        </Button>
        {error ? (
          <Typography sx={{ fontSize: 12, color: "var(--omega-danger)", mt: 1 }}>{error}</Typography>
        ) : null}
      </Box>
    );
  }

  if (!snapshot.isGitRepo) {
    return (
      <Typography sx={{ color: "var(--omega-warning)", fontSize: 13, mt: 2 }}>
        当前工作区未纳入 git，无法审查变更。
      </Typography>
    );
  }

  const unstagedCount = snapshot.unstaged.length;
  const stagedCount = snapshot.staged.length;

  return (
    <Box>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.5 }}>
        <Chip size="small" label={snapshot.branch || "—"} color="primary" />
        <Typography sx={{ fontSize: 11.5, color: "var(--omega-text-dim)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {snapshot.repoRoot}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button size="small" onClick={() => void refresh()} disabled={busy} sx={{ textTransform: "none", flex: "0 0 auto" }}>
          {busy ? "…" : "刷新"}
        </Button>
      </Box>

      {snapshot.log.length > 0 ? (
        <Box sx={{ maxHeight: 84, overflowY: "auto", mb: 0.75 }}>
          {snapshot.log.slice(0, 5).map((entry) => (
            <Typography key={entry.hash} sx={{ fontSize: 10.5, color: "var(--omega-text-dim)", fontFamily: "ui-monospace, Consolas, monospace" }} noWrap>
              {entry.hash} {entry.message}
            </Typography>
          ))}
        </Box>
      ) : null}

      {error ? (
        <Typography sx={{ fontSize: 12, color: "var(--omega-danger)", whiteSpace: "pre-wrap", mb: 1 }}>{error}</Typography>
      ) : null}

      {unstagedCount + stagedCount === 0 ? (
        <Typography sx={{ color: "var(--omega-text-dim)", fontSize: 13 }}>工作区干净，没有未提交的改动。</Typography>
      ) : (
        <>
          <SectionTitle label="未暂存" count={unstagedCount} />
          {snapshot.unstaged.map((file) => (
            <FileCard key={file.path} file={file} selection={unstagedSel} onToggleFile={toggleFile(setUnstagedSel)} onToggleHunk={toggleHunk(setUnstagedSel)} onOpenFile={(p) => void openViewer(p)} />
          ))}
          {unstagedCount > 0 ? (
            <Button size="small" variant="outlined" onClick={() => void stage()} disabled={busy || unstagedSel.files.size === 0} sx={{ textTransform: "none", mb: 1 }}>
              暂存所选（{unstagedSel.files.size}）
            </Button>
          ) : null}

          <SectionTitle label="已暂存" count={stagedCount} />
          {snapshot.staged.map((file) => (
            <FileCard key={file.path} file={file} selection={stagedSel} onToggleFile={toggleFile(setStagedSel)} onToggleHunk={toggleHunk(setStagedSel)} onOpenFile={(p) => void openViewer(p)} />
          ))}
          {stagedCount > 0 ? (
            <Button size="small" variant="outlined" onClick={() => void unstage()} disabled={busy || stagedSel.files.size === 0} sx={{ textTransform: "none", mb: 1 }}>
              取消暂存所选（{stagedSel.files.size}）
            </Button>
          ) : null}

          {stagedCount > 0 ? (
            <Paper sx={{ p: 1.25, mt: 1, background: "var(--omega-bg-elevated)", border: "1px solid var(--omega-border)" }}>
              <TextField
                fullWidth
                size="small"
                multiline
                minRows={2}
                maxRows={5}
                placeholder="提交信息…"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
              <Box sx={{ display: "flex", justifyContent: "flex-end", mt: 1 }}>
                <Button size="small" variant="contained" onClick={() => void commit()} disabled={busy || !message.trim()} sx={{ textTransform: "none" }}>
                  提交（{stagedCount} 个文件）
                </Button>
              </Box>
            </Paper>
          ) : null}

          {unstagedCount > 0 ? (
            <ApprovalBar
              selectedFiles={[...unstagedSel.files.keys()].filter((p) => snapshot.unstaged.some((f) => f.path === p))}
              hasUntrackedSelected={snapshot.unstaged.some((f) => unstagedSel.files.has(f.path) && f.status === "added")}
              onApplied={() => {
                clearSel();
                void refresh();
              }}
            />
          ) : null}
        </>
      )}
    </Box>
  );
}
