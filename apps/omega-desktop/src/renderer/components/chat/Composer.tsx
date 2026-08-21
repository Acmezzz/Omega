import * as React from "react";
import Box from "@mui/material/Box";
import TextareaAutosize from "@mui/material/TextareaAutosize";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import SendIcon from "@mui/icons-material/Send";
import KeyboardCommandKeyIcon from "@mui/icons-material/KeyboardCommandKey";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";

export function Composer(): React.ReactElement {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const setConnection = useAppStore((s) => s.setConnection);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);

  const send = React.useCallback(async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true);
    setText("");
    setConnection("running");
    try {
      const res = await ipc.prompt(value);
      if (!res.ok) {
        // The prompt never started (or failed outright) — give the text back
        // and surface the reason instead of silently dropping the message.
        setText(value);
        useAppStore.getState().appendMessage({
          role: "assistant",
          id: `error-${Date.now()}`,
          text: `⚠️ 发送失败（${res.code}）：${res.message ?? "未知错误"}`,
          ts: new Date().toISOString(),
        });
        setConnection("error");
      }
    } catch (error) {
      setText(value);
      useAppStore.getState().appendMessage({
        role: "assistant",
        id: `error-${Date.now()}`,
        text: `⚠️ 发送异常：${error instanceof Error ? error.message : String(error)}`,
        ts: new Date().toISOString(),
      });
      setConnection("error");
    } finally {
      setBusy(false);
    }
  }, [text, busy, setConnection]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    // Typing "/" at the start opens the command palette (reuses the prompt channel).
    if (value === "/") {
      setText("");
      setCommandPaletteOpen(true);
      return;
    }
    setText(value);
  };

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-end",
        gap: 1,
        mx: 2,
        mb: 2,
        p: 1.25,
        border: "1px solid #2b3444",
        borderRadius: "18px",
        background: "rgba(29,35,48,0.9)",
        boxShadow: "0 14px 34px rgba(0,0,0,0.2)",
      }}
    >
      <Tooltip title="命令面板（/）">
        <IconButton size="small" onClick={() => setCommandPaletteOpen(true)} sx={{ color: "#8d99ad", mb: 0.5 }}>
          <KeyboardCommandKeyIcon />
        </IconButton>
      </Tooltip>
      <TextareaAutosize
        ref={taRef as never}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        placeholder="输入消息…（Enter 发送，Shift+Enter 换行，/ 打开命令）"
        minRows={1}
        maxRows={8}
        style={{
          flex: 1,
          resize: "none",
          border: "none",
          outline: "none",
          background: "transparent",
          color: "#f3f6fb",
          font: "inherit",
          fontSize: 14,
          lineHeight: 1.6,
          padding: "8px 4px",
        }}
      />
      <IconButton
        onClick={() => void send()}
        disabled={busy || !text.trim()}
        sx={{
          color: "#fff",
          background: "linear-gradient(135deg, #5d86f2, #7666d9)",
          borderRadius: "12px",
          width: 42,
          height: 42,
          mb: 0.25,
          "&:hover": { filter: "brightness(1.12)" },
          "&:disabled": { opacity: 0.5, background: "#3a465b" },
        }}
      >
        <SendIcon />
      </IconButton>
    </Box>
  );
}
