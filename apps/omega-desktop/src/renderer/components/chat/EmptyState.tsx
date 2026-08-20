import * as React from "react";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import Button from "@mui/material/Button";
import { ipc } from "../../ipc/client";
import { useAppStore } from "../../store/useAppStore";

const SUGGESTIONS = [
  "检查当前项目的测试状态",
  "分析最近一次失败的原因",
  "为这个模块编写单元测试",
];

export function EmptyState(): React.ReactElement {
  const setConnection = useAppStore((s) => s.setConnection);
  const sendSuggestion = React.useCallback(
    async (prompt: string) => {
      setConnection("running");
      try {
        await ipc.prompt(prompt);
      } catch (error) {
        console.error("prompt failed", error);
      }
    },
    [setConnection],
  );

  return (
    <Box
      sx={{
        position: "absolute",
        inset: 0,
        display: "grid",
        placeContent: "center",
        justifyContent: "center",
        textAlign: "center",
        p: 4,
        pointerEvents: "none",
      }}
    >
      <Box sx={{ pointerEvents: "auto" }}>
        <Box
          sx={{
            width: 76,
            height: 76,
            mx: "auto",
            display: "grid",
            placeItems: "center",
            borderRadius: "50%",
            border: "1px solid rgba(134,169,255,0.4)",
            background: "radial-gradient(circle, rgba(134,169,255,0.22), transparent 65%)",
            color: "#86a9ff",
            fontSize: 38,
            boxShadow: "0 0 42px rgba(93,134,242,0.15)",
          }}
        >
          Ω
        </Box>
        <Typography variant="h5" sx={{ mt: 2.5, fontWeight: 700, letterSpacing: "-0.02em" }}>
          开始与 Omega 协作
        </Typography>
        <Typography sx={{ maxWidth: 500, mx: "auto", color: "#8d99ad" }}>
          描述一个问题、目标或需要探索的方向，Agent 会在当前工作区中协助你。
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", justifyContent: "center", gap: 1, mt: 2.5 }}>
          {SUGGESTIONS.map((s) => (
            <Button
              key={s}
              variant="outlined"
              size="small"
              onClick={() => void sendSuggestion(s)}
              sx={{ borderRadius: "999px", textTransform: "none", color: "#8d99ad", borderColor: "#2b3444" }}
            >
              {s}
            </Button>
          ))}
        </Box>
      </Box>
    </Box>
  );
}
