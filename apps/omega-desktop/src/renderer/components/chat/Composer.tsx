import * as React from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import TextareaAutosize from "@mui/material/TextareaAutosize";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import KeyboardCommandKeyIcon from "@mui/icons-material/KeyboardCommandKey";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import type { PromptImage } from "../../types/dto";

const MAX_IMAGES = 4;

interface Attachment extends PromptImage {
  key: string;
  name: string;
}

function readImageFile(file: File): Promise<PromptImage> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Failed to read image"));
    reader.onload = () => {
      const result = String(reader.result ?? "");
      const comma = result.indexOf(",");
      const header = comma > 0 ? result.slice(0, comma) : "";
      const data = comma > 0 ? result.slice(comma + 1) : "";
      const match = /data:(image\/[\w.+-]+)/.exec(header);
      if (!match || !data) {
        reject(new Error("Unsupported image"));
        return;
      }
      resolve({ mimeType: match[1], data });
    };
    reader.readAsDataURL(file);
  });
}

export function Composer(): React.ReactElement {
  const [text, setText] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const setConnection = useAppStore((s) => s.setConnection);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const connection = useAppStore((s) => s.connection);
  const composerError = useAppStore((s) => s.composerError);
  const setComposerError = useAppStore((s) => s.setComposerError);
  const running = connection === "running";

  const addFiles = React.useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return;
    const images = Array.from(files).filter((file) => file.type.startsWith("image/"));
    if (images.length === 0) return;
    const loaded: Attachment[] = [];
    for (const file of images) {
      try {
        const image = await readImageFile(file);
        loaded.push({ ...image, name: file.name || "image", key: `${file.name}-${Date.now()}-${loaded.length}` });
      } catch (error) {
        setComposerError(error instanceof Error ? error.message : "图片读取失败");
      }
    }
    if (loaded.length > 0) {
      setAttachments((prev) => [...prev, ...loaded].slice(0, MAX_IMAGES));
    }
  }, [setComposerError]);

  const handlePaste = React.useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = e.clipboardData?.files;
      if (files && files.length > 0 && Array.from(files).some((file) => file.type.startsWith("image/"))) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const send = React.useCallback(async () => {
    const value = text.trim();
    if ((!value && attachments.length === 0) || busy) return;
    setBusy(true);
    setText("");
    const images = attachments.map(({ mimeType, data }) => ({ mimeType, data }));
    setAttachments([]);
    setComposerError(null);
    setConnection("running");
    try {
      // While the agent is streaming the message becomes a steering interrupt.
      const res = await ipc.prompt(value || "（请查看图片）", running ? "steer" : undefined, images.length > 0 ? images : undefined);
      if (!res.ok) {
        setText(value);
        setAttachments((prev) => [...prev, ...attachments].slice(0, MAX_IMAGES));
        setComposerError(`${res.code}: ${res.message ?? "未知错误"}`);
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
      const message = error instanceof Error ? error.message : String(error);
      setComposerError(message);
      useAppStore.getState().appendMessage({
        role: "assistant",
        id: `error-${Date.now()}`,
        text: `⚠️ 发送异常：${message}`,
        ts: new Date().toISOString(),
      });
      setConnection("error");
    } finally {
      setBusy(false);
    }
  }, [text, busy, running, attachments, setConnection, setComposerError]);

  const abort = React.useCallback(async () => {
    setBusy(true);
    try {
      await ipc.abort();
      setConnection("ready");
    } finally {
      setBusy(false);
    }
  }, [setConnection]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    if (value === "/") {
      setText("");
      setCommandPaletteOpen(true);
      return;
    }
    setText(value);
  };

  const canSend = busy || (text.trim().length === 0 && attachments.length === 0);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        mx: 2,
        mb: 2,
      }}
    >
      {composerError ? (
        <Typography sx={{ fontSize: 12, color: "#f17f8d", px: 1, pb: 0.75 }}>{composerError}</Typography>
      ) : null}
      {attachments.length > 0 ? (
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.75, px: 1, pb: 0.75 }}>
          {attachments.map((attachment) => (
            <Chip
              key={attachment.key}
              size="small"
              label={attachment.name}
              onDelete={() => setAttachments((prev) => prev.filter((item) => item.key !== attachment.key))}
              sx={{ maxWidth: 220, "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" } }}
            />
          ))}
        </Box>
      ) : null}
      <Box
        sx={{
          display: "flex",
          alignItems: "flex-end",
          gap: 1,
          p: 1.25,
          border: "1px solid #2b3444",
          borderRadius: "18px",
          background: "rgba(29,35,48,0.9)",
          boxShadow: "0 14px 34px rgba(0,0,0,0.2)",
          transition: "border-color .18s ease, box-shadow .18s ease",
          "&:focus-within": {
            borderColor: "rgba(134,169,255,0.55)",
            boxShadow: "0 14px 34px rgba(0,0,0,0.2), 0 0 0 3px rgba(93,134,242,0.14)",
          },
        }}
      >
        <Tooltip title="命令面板（Ctrl+K）">
          <IconButton size="small" onClick={() => setCommandPaletteOpen(true)} sx={{ color: "#8d99ad", mb: 0.5 }}>
            <KeyboardCommandKeyIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="附加图片（最多 4 张）">
          <IconButton
            size="small"
            onClick={() => fileRef.current?.click()}
            disabled={attachments.length >= MAX_IMAGES}
            sx={{ color: "#8d99ad", mb: 0.5 }}
          >
            <AttachFileIcon />
          </IconButton>
        </Tooltip>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <TextareaAutosize
          ref={taRef as never}
          value={text}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={running ? "生成中… 发送将打断并转向（Stop 彻底停止）" : "输入消息…（Enter 发送，Shift+Enter 换行，可粘贴图片）"}
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
        {running ? (
          <>
            <IconButton
              onClick={() => void send()}
              disabled={canSend}
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
            <IconButton
              onClick={() => void abort()}
              disabled={busy}
              sx={{
                color: "#fff",
                background: "#f17f8d",
                borderRadius: "12px",
                width: 42,
                height: 42,
                mb: 0.25,
                "&:hover": { filter: "brightness(1.12)" },
                "&:disabled": { opacity: 0.5, background: "#3a465b" },
              }}
            >
              <StopIcon />
            </IconButton>
          </>
        ) : (
          <IconButton
            onClick={() => void send()}
            disabled={canSend}
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
        )}
      </Box>
    </Box>
  );
}
