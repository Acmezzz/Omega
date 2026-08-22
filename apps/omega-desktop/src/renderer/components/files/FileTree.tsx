import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import FolderIcon from "@mui/icons-material/FolderOutlined";
import FolderOpenIcon from "@mui/icons-material/FolderOpenOutlined";
import InsertDriveFileIcon from "@mui/icons-material/InsertDriveFileOutlined";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { DirListing } from "../../types/dto";

interface DirState {
  loading: boolean;
  error: string | null;
  listing: DirListing | null;
}

function formatSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function TreeRow({
  name,
  rel,
  isDir,
  size,
  depth,
  expanded,
  onToggleDir,
  onOpenFile,
}: {
  name: string;
  rel: string;
  isDir: boolean;
  size: number;
  depth: number;
  expanded: boolean;
  onToggleDir: (rel: string) => void;
  onOpenFile: (rel: string) => void;
}): React.ReactElement {
  return (
    <Box
      onClick={() => (isDir ? onToggleDir(rel) : onOpenFile(rel))}
      sx={{
        display: "flex",
        alignItems: "center",
        gap: 0.5,
        pl: 0.5 + depth * 1.25,
        pr: 0.75,
        py: 0.3,
        borderRadius: "7px",
        cursor: "pointer",
        "&:hover": { background: "var(--omega-hover-fill)" },
      }}
    >
      {isDir ? (
        <>
          <IconButton size="small" sx={{ p: 0, color: "var(--omega-text-dim)" }} onClick={(e) => { e.stopPropagation(); onToggleDir(rel); }}>
            {expanded ? <ExpandMoreIcon sx={{ fontSize: 14 }} /> : <ChevronRightIcon sx={{ fontSize: 14 }} />}
          </IconButton>
          {expanded ? (
            <FolderOpenIcon sx={{ fontSize: 15, color: "var(--omega-accent)" }} />
          ) : (
            <FolderIcon sx={{ fontSize: 15, color: "var(--omega-accent)" }} />
          )}
        </>
      ) : (
        <>
          <Box sx={{ width: 22 }} />
          <InsertDriveFileIcon sx={{ fontSize: 15, color: "var(--omega-text-dim)" }} />
        </>
      )}
      <Typography sx={{ fontSize: 12.5, color: "var(--omega-text)", minWidth: 0 }} noWrap title={rel}>
        {name}
      </Typography>
      {!isDir && size > 0 ? (
        <Typography sx={{ fontSize: 10, color: "var(--omega-text-dim)", ml: "auto", flex: "0 0 auto" }}>{formatSize(size)}</Typography>
      ) : null}
    </Box>
  );
}

/** Lazy-expanding workspace file tree (loads one directory per IPC call). */
export function FileTree(): React.ReactElement {
  const openViewer = useAppStore((s) => s.openViewer);
  const [dirs, setDirs] = React.useState<Map<string, DirState>>(() => new Map([["", { loading: true, error: null, listing: null }]]));
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set([""]));

  const loadDir = React.useCallback(async (rel: string) => {
    setDirs((prev) => new Map(prev).set(rel, { loading: true, error: null, listing: prev.get(rel)?.listing ?? null }));
    const res = await ipc.listDir({ path: rel });
    setDirs((prev) => {
      const next = new Map(prev);
      next.set(rel, res.ok ? { loading: false, error: null, listing: res.data } : { loading: false, error: res.message, listing: null });
      return next;
    });
  }, []);

  React.useEffect(() => {
    void loadDir("");
  }, [loadDir]);

  const toggleDir = React.useCallback(
    (rel: string) => {
      setExpanded((prev) => {
        const next = new Set(prev);
        if (next.has(rel)) next.delete(rel);
        else {
          next.add(rel);
          if (!dirs.get(rel)?.listing) void loadDir(rel);
        }
        return next;
      });
    },
    [dirs, loadDir],
  );

  const refreshAll = React.useCallback(() => {
    setDirs(new Map([["", { loading: true, error: null, listing: null }]]));
    setExpanded(new Set([""]));
    void loadDir("");
  }, [loadDir]);

  const rows: React.ReactNode[] = [];
  const renderDir = (rel: string, depth: number) => {
    const state = dirs.get(rel);
    const listing = state?.listing;
    rows.push(
      rel === "" ? null : (
        <TreeRow
          key={`d:${rel}`}
          name={rel.split("/").pop() ?? rel}
          rel={rel}
          isDir
          size={0}
          depth={depth - 1}
          expanded={expanded.has(rel)}
          onToggleDir={toggleDir}
          onOpenFile={() => undefined}
        />
      ),
    );
    if (state?.loading && !listing) {
      rows.push(
        <Typography key={`l:${rel}`} sx={{ fontSize: 11.5, color: "var(--omega-text-dim)", pl: 1 + depth * 1.25, py: 0.25 }}>
          加载中…
        </Typography>,
      );
      return;
    }
    if (state?.error) {
      rows.push(
        <Typography key={`e:${rel}`} sx={{ fontSize: 11.5, color: "var(--omega-danger)", pl: 1 + depth * 1.25, py: 0.25 }}>
          {state.error}
        </Typography>,
      );
      return;
    }
    for (const entry of listing?.entries ?? []) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDir) {
        if (expanded.has(childRel)) renderDir(childRel, depth + 1);
        else
          rows.push(
            <TreeRow
              key={`d:${childRel}`}
              name={entry.name}
              rel={childRel}
              isDir
              size={0}
              depth={depth}
              expanded={false}
              onToggleDir={toggleDir}
              onOpenFile={() => undefined}
            />,
          );
      } else {
        rows.push(
          <TreeRow
            key={`f:${childRel}`}
            name={entry.name}
            rel={childRel}
            isDir={false}
            size={entry.size}
            depth={depth}
            expanded={false}
            onToggleDir={() => undefined}
            onOpenFile={(path) => void openViewer(path)}
          />,
        );
      }
    }
  };
  renderDir("", 0);

  return (
    <Box sx={{ width: "100%" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", px: 1, py: 0.5 }}>
        <Typography sx={{ fontSize: 11, color: "var(--omega-text-dim)" }}>工作区文件</Typography>
        <Tooltip title="刷新">
          <IconButton size="small" onClick={refreshAll} sx={{ color: "var(--omega-text-dim)" }}>
            <RefreshIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      </Box>
      <Box sx={{ maxHeight: "100%", overflowY: "auto", pb: 1 }}>{rows}</Box>
    </Box>
  );
}
