import * as React from "react";
import Popover from "@mui/material/Popover";
import TextField from "@mui/material/TextField";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import CircularProgress from "@mui/material/CircularProgress";
import CheckIcon from "@mui/icons-material/Check";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { ModelInfo } from "../../types/dto";

/** Module-level switch token: stale results from a closed picker are ignored (port of pi-app, MIT). */
let modelSwitchToken = 0;

export interface ModelPickerProps {
  anchor: HTMLElement | null;
  onClose: () => void;
}

function groupByProvider(models: ModelInfo[]): Array<{ provider: string; models: ModelInfo[] }> {
  const groups: Array<{ provider: string; models: ModelInfo[] }> = [];
  for (const model of models) {
    const group = groups.find((entry) => entry.provider === model.provider);
    if (group) group.models.push(model);
    else groups.push({ provider: model.provider, models: [model] });
  }
  return groups;
}

export function ModelPicker({ anchor, onClose }: ModelPickerProps): React.ReactElement {
  const models = useAppStore((s) => s.models);
  const setAgent = useAppStore((s) => s.setAgent);
  const [query, setQuery] = React.useState("");
  const [pending, setPending] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (anchor) setQuery("");
  }, [anchor]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter((model) => `${model.name} ${model.id} ${model.provider}`.toLowerCase().includes(q));
  }, [models, query]);

  const groups = React.useMemo(() => groupByProvider(filtered), [filtered]);

  const pick = React.useCallback(
    async (model: ModelInfo) => {
      const token = ++modelSwitchToken;
      setPending(`${model.provider}/${model.id}`);
      try {
        const res = await ipc.setModel({ provider: model.provider, modelId: model.id });
        if (token !== modelSwitchToken) return;
        if (res.ok) {
          setAgent(res.data);
          onClose();
        }
      } finally {
        if (token === modelSwitchToken) setPending(null);
      }
    },
    [setAgent, onClose],
  );

  return (
    <Popover
      open={Boolean(anchor)}
      anchorEl={anchor}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
      slotProps={{
        paper: {
          sx: { width: 320, maxHeight: 420, display: "flex", flexDirection: "column", p: 0.75 },
        },
      }}
    >
      <Box sx={{ px: 0.75, pt: 0.75, pb: 1 }}>
        <TextField
          autoFocus
          fullWidth
          size="small"
          placeholder="搜索模型…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </Box>
      <Box sx={{ overflowY: "auto", px: 0.75, pb: 0.75 }}>
        {groups.length === 0 ? (
          <Typography sx={{ fontSize: 12, color: "var(--omega-text-dim)", px: 1, py: 1.5 }}>无匹配模型</Typography>
        ) : (
          groups.map((group) => (
            <Box key={group.provider} sx={{ mb: 1 }}>
              <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: "var(--omega-text-dim)", letterSpacing: "0.06em", px: 1, py: 0.5 }}>
                {group.provider.toUpperCase()}
              </Typography>
              {group.models.map((model) => {
                const key = `${model.provider}/${model.id}`;
                const isPending = pending === key;
                return (
                  <Box
                    key={key}
                    onClick={() => (pending ? undefined : void pick(model))}
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      gap: 1,
                      px: 1.25,
                      py: 0.75,
                      borderRadius: "9px",
                      cursor: pending ? "wait" : "pointer",
                      opacity: pending && !isPending ? 0.5 : 1,
                      "&:hover": { background: "var(--omega-hover-fill)" },
                    }}
                  >
                    <Box sx={{ flex: 1, minWidth: 0 }}>
                      <Typography sx={{ fontSize: 13, color: "var(--omega-text)" }} noWrap>
                        {model.id}
                      </Typography>
                      <Typography sx={{ fontSize: 11, color: "var(--omega-text-dim)" }} noWrap>
                        {model.contextWindow ? `${Math.round(model.contextWindow / 1000)}K ctx` : ""}
                        {model.reasoning ? " · reasoning" : ""}
                      </Typography>
                    </Box>
                    {isPending ? <CircularProgress size={14} sx={{ color: "var(--omega-accent)" }} /> : null}
                    {model.selected && !isPending ? <CheckIcon sx={{ fontSize: 16, color: "var(--omega-accent)" }} /> : null}
                  </Box>
                );
              })}
            </Box>
          ))
        )}
      </Box>
    </Popover>
  );
}
