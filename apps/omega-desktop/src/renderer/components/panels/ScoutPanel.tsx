import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Paper from "@mui/material/Paper";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Divider from "@mui/material/Divider";
import { useAppStore } from "../../store/useAppStore";
import type { ScoutStatus, ScoutRounds, ScoutProposals } from "../../types/dto";

function StatusCard({ data }: { data: ScoutStatus }) {
  return (
    <Paper sx={{ p: 1.5, mb: 1.5, background: "#171d29", border: "1px solid #2b3444" }}>
      <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap", mb: 0.5 }}>
        <Chip size="small" label={data.enabled ? "启用" : "禁用"} color={data.enabled ? "success" : "default"} />
        <Chip size="small" label={`策略 ${data.policy}`} />
        <Chip size="small" label={data.mode === "active" ? "活动中" : "空闲"} color={data.mode === "active" ? "primary" : "default"} />
        <Chip size="small" label={`每任务上限 ${data.maxRoundsPerTask} 轮`} variant="outlined" />
      </Box>
      <Box sx={{ mt: 0.5 }}>
        {data.currentRoundId ? (
          <Typography sx={{ fontSize: 11, color: "#8d99ad" }}>当前轮：{data.currentRoundId}</Typography>
        ) : (
          <Typography sx={{ fontSize: 11, color: "#697589" }}>暂无进行中的探索轮。</Typography>
        )}
      </Box>
    </Paper>
  );
}

function RoundCard({ round }: { round: NonNullable<ScoutRounds["rounds"][number]> }) {
  return (
    <Paper sx={{ p: 1.5, mb: 1, background: "#171d29", border: "1px solid #2b3444" }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, color: "#f3f6fb" }}>{round.roundId}</Typography>
        <Chip size="small" label={round.trigger} />
        <Chip size="small" label={`verified: ${round.verifiedOutcome}`} color={round.verifiedOutcome === "succeeded" ? "success" : "default"} />
      </Box>
      <Typography sx={{ fontSize: 12, color: "#8d99ad", mt: 0.5 }}>目标：{round.taskBrief.objective || "—"}</Typography>
      <Typography sx={{ fontSize: 11, color: "#697589" }}>
        {round.runs.length} 个 Scout · {round.runs.reduce((acc, r) => acc + r.proposalCount, 0)} 个 proposal · 模型 {round.model}
      </Typography>
      {round.selection ? (
        <Typography sx={{ fontSize: 11, color: "#86a9ff", mt: 0.5 }}>
          已采纳 {round.selection.selectedProposalIds.length} 个提案
        </Typography>
      ) : null}
    </Paper>
  );
}

function ProposalCard({ proposal }: { proposal: NonNullable<ScoutProposals["proposals"][number]> }) {
  return (
    <Paper sx={{ p: 1.25, mb: 1, background: "#151923", border: "1px solid #2b3444" }}>
      <Typography sx={{ fontSize: 13, fontWeight: 600, color: "#f3f6fb" }}>{proposal.idea}</Typography>
      {proposal.steps.length > 0 ? (
        <Box component="ul" sx={{ m: 0, pl: 2, color: "#8d99ad", fontSize: 12 }}>
          {proposal.steps.map((s, i) => (
            <li key={i}>{s}</li>
          ))}
        </Box>
      ) : null}
      {proposal.assumptions.length > 0 ? (
        <Typography sx={{ fontSize: 11, color: "#697589" }}>假设：{proposal.assumptions.join("；")}</Typography>
      ) : null}
      {proposal.expectedEvidence.length > 0 ? (
        <Typography sx={{ fontSize: 11, color: "#697589" }}>预期证据：{proposal.expectedEvidence.join("；")}</Typography>
      ) : null}
      {proposal.closureStatus ? (
        <Chip size="small" label={`闭合：${proposal.closureStatus}`} sx={{ mt: 0.5, height: 20, fontSize: 11 }} />
      ) : null}
    </Paper>
  );
}

export function ScoutPanel(): React.ReactElement {
  const extension = useAppStore((s) => s.extensionState);
  const status = extension.scout_status;
  const rounds = extension.scout_rounds;
  const proposals = extension.scout_proposals;

  if (!status) {
    return <Typography sx={{ color: "#697589", fontSize: 12 }}>暂无 Scout 状态（可能未加载扩展）。</Typography>;
  }

  return (
    <Box>
      <StatusCard data={status} />
      <Divider sx={{ my: 1, borderColor: "#2b3444" }} />
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: "#8d99ad", mb: 0.5 }}>探索轮 Rounds</Typography>
      {rounds && rounds.rounds.length > 0 ? (
        rounds.rounds.map((r) => <RoundCard key={r.roundId} round={r} />)
      ) : (
        <Typography sx={{ color: "#697589", fontSize: 12 }}>无探索轮记录。</Typography>
      )}
      <Divider sx={{ my: 1, borderColor: "#2b3444" }} />
      <Typography sx={{ fontSize: 12, fontWeight: 700, color: "#8d99ad", mb: 0.5 }}>提案 Proposals</Typography>
      {proposals && proposals.proposals.length > 0 ? (
        proposals.proposals.map((p) => <ProposalCard key={p.id} proposal={p} />)
      ) : (
        <Typography sx={{ color: "#697589", fontSize: 12 }}>当前轮无提案。</Typography>
      )}
    </Box>
  );
}
