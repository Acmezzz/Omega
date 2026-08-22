import * as React from "react";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Paper from "@mui/material/Paper";
import TextareaAutosize from "@mui/material/TextareaAutosize";
import IconButton from "@mui/material/IconButton";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import SendIcon from "@mui/icons-material/Send";
import StopIcon from "@mui/icons-material/Stop";
import BoltIcon from "@mui/icons-material/Bolt";
import ReplayIcon from "@mui/icons-material/Replay";
import KeyboardCommandKeyIcon from "@mui/icons-material/KeyboardCommandKey";
import AttachFileIcon from "@mui/icons-material/AttachFile";
import { useAppStore } from "../../store/useAppStore";
import { ipc } from "../../ipc/client";
import { userMessageKey } from "../../lib/prompt-recovery";
import { clearDraft, getDraft, mergeDraftText, setDraft, type DraftImage } from "../../lib/draft-store";
import type { PromptImage } from "../../types/dto";

const MAX_IMAGES = 4;
/** IME composition guard (port of pi-web, MIT): keyCode 229 + 100ms post-composition grace. */
const COMPOSITION_END_ENTER_GRACE_MS = 100;

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

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function QueuedRow({ kind, text }: { kind: "steer" | "followUp"; text: string }): React.ReactElement {
  const isSteer = kind === "steer";
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, px: 1, py: 0.25, minWidth: 0 }}>
      <Chip
        size="small"
        label={isSteer ? "steer" : "follow-up"}
        sx={{
          flex: "0 0 auto",
          height: 18,
          fontSize: 10,
          fontFamily: "ui-monospace, Consolas, monospace",
          borderRadius: 999,
          border: isSteer ? "1px solid var(--omega-accent)" : "1px solid var(--omega-border)",
          color: isSteer ? "var(--omega-accent)" : "var(--omega-text-muted)",
          background: "transparent",
        }}
      />
      <Typography title={text} sx={{ fontSize: 12, color: "var(--omega-text-muted)", minWidth: 0 }} noWrap>
        {truncate(text)}
      </Typography>
    </Box>
  );
}

export function Composer(): React.ReactElement {
  const [text, setText] = React.useState("");
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const [historyIndex, setHistoryIndex] = React.useState(0);
  const taRef = React.useRef<HTMLTextAreaElement | null>(null);
  const fileRef = React.useRef<HTMLInputElement | null>(null);
  const isComposingRef = React.useRef(false);
  const lastCompositionEndAtRef = React.useRef(0);
  /** Synchronous double-send guard only — the prompt itself is fire-and-forget. */
  const sendingRef = React.useRef(false);
  /** Session that the current `text` belongs to (guards the draft persist effect). */
  const textSessionRef = React.useRef<string | null>(null);

  const setConnection = useAppStore((s) => s.setConnection);
  const setCommandPaletteOpen = useAppStore((s) => s.setCommandPaletteOpen);
  const connection = useAppStore((s) => s.connection);
  const composerError = useAppStore((s) => s.composerError);
  const composerPrefill = useAppStore((s) => s.composerPrefill);
  const setComposerError = useAppStore((s) => s.setComposerError);
  const setComposerPrefill = useAppStore((s) => s.setComposerPrefill);
  const queuedMessages = useAppStore((s) => s.queuedMessages);
  const setQueuedMessages = useAppStore((s) => s.setQueuedMessages);
  const messages = useAppStore((s) => s.messages);
  const activeSessionId = useAppStore((s) => s.activeSessionId);
  const running = connection === "running";

  // Restore the draft whenever the active session changes. Declared BEFORE the
  // persist effect so `textSessionRef` is re-anchored first.
  React.useEffect(() => {
    textSessionRef.current = activeSessionId;
    const draft = getDraft(activeSessionId);
    setText(draft?.value ?? "");
    setAttachments(
      (draft?.images ?? []).map((image: DraftImage, index) => ({
        ...image,
        name: "图片",
        key: `draft-${index}`,
      })),
    );
  }, [activeSessionId]);

  // Fork prefill: consume once; merging on top of whatever the draft restored.
  React.useEffect(() => {
    if (composerPrefill === null) return;
    const prefill = composerPrefill;
    setComposerPrefill(null);
    setText((prev) => (prev.trim() ? mergeDraftText(prefill, prev) : prefill));
    taRef.current?.focus();
  }, [composerPrefill, setComposerPrefill]);

  // Persist the draft only when the text itself changes — the transient commit
  // right after a session switch still carries the OLD text, so keying on the
  // session id here would write A's draft into B's slot.
  React.useEffect(() => {
    setDraft(textSessionRef.current, {
      value: text,
      images: attachments.map(({ mimeType, data }) => ({ mimeType, data })),
    });
  }, [text, attachments]);

  // Input history derived from this session's user messages (port of pi-web).
  const inputHistory = React.useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== "user" || !message.text.trim()) continue;
      if (message.id.startsWith("optimistic-")) continue;
      if (seen.has(message.text)) continue;
      seen.add(message.text);
      history.push(message.text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);

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

  const send = React.useCallback(
    (behavior?: "steer" | "followUp") => {
      const value = text.trim();
      if ((!value && attachments.length === 0) || sendingRef.current) return;
      sendingRef.current = true;
      setTimeout(() => {
        sendingRef.current = false;
      }, 120);
      const sentAt = Date.now();
      const images = attachments.map(({ mimeType, data }) => ({ mimeType, data }));
      const payload = value || "（请查看图片）";
      setText("");
      setHistoryOpen(false);
      setAttachments([]);
      clearDraft(textSessionRef.current);
      setComposerError(null);
      setConnection("running");

      // Optimistic bubble: consumed/replaced when the SDK replays the user
      // message via message_start/message_end.
      const optimistic = {
        role: "user" as const,
        id: `optimistic-${Date.now()}`,
        text: value || "（图片）",
        ts: new Date().toISOString(),
      };
      const key = userMessageKey({ text: payload, images });
      useAppStore.setState((state) => ({
        messages: [...state.messages, optimistic],
        optimisticKey: key,
      }));

      // Fire-and-forget: the IPC promise resolves when the whole turn settles
      // (non-streaming path) — blocking on it would disable Steer/Stop/Enter
      // for the entire run. Errors are handled below.
      void (async () => {
        try {
          const res = await ipc.prompt(payload, behavior ?? (running ? "followUp" : undefined), images.length > 0 ? images : undefined);
          if (!res.ok) {
            const agentStarted = useAppStore.getState().lastAgentStartAt >= sentAt;
            useAppStore.getState().dropLastIfOptimistic(key);
            if (!agentStarted) {
              // Deterministic early rejection: give the text back.
              setText((prev) => mergeDraftText(value || "（请查看图片）", prev));
              setAttachments((prev) => [...prev, ...attachments].slice(0, MAX_IMAGES));
              setConnection("ready");
            }
            setComposerError(`${res.code}: ${res.message ?? "未知错误"}`);
            useAppStore.getState().appendMessage({
              role: "assistant",
              id: `error-${Date.now()}`,
              text: `⚠️ 发送失败（${res.code}）：${res.message ?? "未知错误"}`,
              ts: new Date().toISOString(),
            });
            return;
          }
          // Extension commands never replay a user message — drop the orphan.
          const state = useAppStore.getState();
          if (state.optimisticKey === key) {
            state.dropLastIfOptimistic(key);
          }
        } catch (error) {
          const agentStarted = useAppStore.getState().lastAgentStartAt >= sentAt;
          useAppStore.getState().dropLastIfOptimistic(key);
          if (!agentStarted) {
            setText((prev) => mergeDraftText(value || "（请查看图片）", prev));
            setConnection("ready");
          }
          setComposerError(error instanceof Error ? error.message : String(error));
        }
      })();
    },
    [text, attachments, running, setConnection, setComposerError],
  );

  const abort = React.useCallback(async () => {
    try {
      await ipc.abort();
      setConnection("ready");
    } catch {
      /* best effort */
    }
  }, [setConnection]);

  const recallQueue = React.useCallback(async () => {
    const res = await ipc.clearQueue();
    if (!res.ok) return;
    setQueuedMessages({ steering: [], followUp: [] });
    const texts = [...res.data.steering, ...res.data.followUp];
    if (texts.length > 0) {
      setText((prev) => (prev.trim() ? `${texts.join("\n\n")}\n\n${prev}` : texts.join("\n\n")));
      taRef.current?.focus();
    }
  }, [setQueuedMessages]);

  const applyHistory = React.useCallback((entry: string) => {
    setHistoryOpen(false);
    setText(entry);
    requestAnimationFrame(() => taRef.current?.focus());
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const nativeEvent = e.nativeEvent;
    const sendShortcut = e.key === "Enter" && !e.shiftKey;
    const recentlyComposed = Date.now() - lastCompositionEndAtRef.current < COMPOSITION_END_ENTER_GRACE_MS;
    const isComposing = isComposingRef.current || nativeEvent.isComposing || nativeEvent.keyCode === 229;

    if (sendShortcut && (isComposing || recentlyComposed)) {
      e.preventDefault();
      return;
    }

    if (historyOpen && !isComposing) {
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setHistoryIndex((prev) => Math.max(0, prev - 1));
        return;
      }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHistoryIndex((prev) => Math.min(inputHistory.length - 1, prev + 1));
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setHistoryOpen(false);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        applyHistory(inputHistory[historyIndex]);
        return;
      }
    }

    if (e.key === "ArrowUp" && !isComposing && !running && text.trim().length === 0 && inputHistory.length > 0) {
      e.preventDefault();
      setHistoryIndex(inputHistory.length - 1);
      setHistoryOpen(true);
      return;
    }

    if (sendShortcut) {
      e.preventDefault();
      send();
    }
  };

  const canSend = text.trim().length === 0 && attachments.length === 0;
  const queued = [...queuedMessages.steering, ...queuedMessages.followUp];

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        mx: 2,
        mb: 2,
        position: "relative",
      }}
    >
      {historyOpen && inputHistory.length > 0 ? (
        <Paper
          elevation={0}
          sx={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            right: 0,
            maxHeight: 260,
            overflowY: "auto",
            border: "1px solid var(--omega-border)",
            borderRadius: "14px",
            p: 0.75,
            zIndex: 20,
          }}
        >
          <Typography sx={{ fontSize: 10.5, fontWeight: 700, color: "var(--omega-text-dim)", px: 1, py: 0.5, letterSpacing: "0.05em" }}>
            输入历史（↑↓ 选择，Enter 应用）
          </Typography>
          {inputHistory.map((entry, index) => (
            <Box
              key={`${entry}-${index}`}
              onMouseDown={(e) => {
                e.preventDefault();
                applyHistory(entry);
              }}
              sx={{
                px: 1.25,
                py: 0.6,
                borderRadius: "8px",
                cursor: "pointer",
                background: index === historyIndex ? "var(--omega-selected)" : "transparent",
                "&:hover": { background: "var(--omega-hover-fill)" },
              }}
            >
              <Typography sx={{ fontSize: 12.5, color: "var(--omega-text)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>
                {entry}
              </Typography>
            </Box>
          ))}
        </Paper>
      ) : null}

      {composerError ? (
        <Typography sx={{ fontSize: 12, color: "var(--omega-danger)", px: 1, pb: 0.75 }}>{composerError}</Typography>
      ) : null}

      {queued.length > 0 ? (
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            px: 1,
            pb: 0.75,
            border: "1px solid var(--omega-border)",
            borderRadius: "12px",
            mb: 0.75,
            background: "var(--omega-bg-soft)",
          }}
        >
          <Typography sx={{ fontSize: 11, fontWeight: 700, color: "var(--omega-text-muted)", flex: "0 0 auto", pr: 1 }}>
            队列 · {queued.length}
          </Typography>
          <Box sx={{ flex: 1, minWidth: 0, overflow: "hidden" }}>
            {queuedMessages.steering.map((entry, index) => (
              <QueuedRow key={`s-${index}`} kind="steer" text={entry} />
            ))}
            {queuedMessages.followUp.map((entry, index) => (
              <QueuedRow key={`f-${index}`} kind="followUp" text={entry} />
            ))}
          </Box>
          <Tooltip title="撤回全部排队消息到输入框">
            <IconButton size="small" onClick={() => void recallQueue()} sx={{ color: "var(--omega-text-muted)", "&:hover": { color: "var(--omega-accent)" } }}>
              <ReplayIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
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
          border: "1px solid var(--omega-border)",
          borderRadius: "18px",
          background: "var(--omega-composer-bg)",
          boxShadow: "0 14px 34px var(--omega-shadow)",
          transition: "border-color .18s ease, box-shadow .18s ease",
          "&:focus-within": {
            borderColor: "var(--omega-accent)",
            boxShadow: "0 14px 34px var(--omega-shadow), 0 0 0 3px var(--omega-accent-soft)",
          },
        }}
      >
        <Tooltip title="命令面板（Ctrl+K）">
          <IconButton size="small" onClick={() => setCommandPaletteOpen(true)} sx={{ color: "var(--omega-text-muted)", mb: 0.5 }}>
            <KeyboardCommandKeyIcon />
          </IconButton>
        </Tooltip>
        <Tooltip title="附加图片（最多 4 张）">
          <IconButton
            size="small"
            onClick={() => fileRef.current?.click()}
            disabled={attachments.length >= MAX_IMAGES}
            sx={{ color: "var(--omega-text-muted)", mb: 0.5 }}
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
          onChange={(e) => {
            setText(e.target.value);
            setHistoryOpen(false);
          }}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
            lastCompositionEndAtRef.current = Date.now();
          }}
          placeholder={running ? "生成中… Enter 排队发送，⚡ 打断转向，Stop 停止" : "输入消息…（Enter 发送，Shift+Enter 换行，↑ 历史，可粘贴图片）"}
          minRows={1}
          maxRows={8}
          style={{
            flex: 1,
            resize: "none",
            border: "none",
            outline: "none",
            background: "transparent",
            color: "var(--omega-text)",
            font: "inherit",
            fontSize: 14,
            lineHeight: 1.6,
            padding: "8px 4px",
          }}
        />
        {running ? (
          <>
            <Tooltip title="打断当前生成并注入这条消息（steer）">
              <IconButton
                onClick={() => send("steer")}
                disabled={canSend}
                sx={{
                  color: "#fff",
                  background: "linear-gradient(135deg, #d9a514, #c47f0e)",
                  borderRadius: "12px",
                  width: 42,
                  height: 42,
                  mb: 0.25,
                  "&:hover": { filter: "brightness(1.12)" },
                  "&:disabled": { opacity: 0.5, background: "var(--omega-border-strong)" },
                }}
              >
                <BoltIcon />
              </IconButton>
            </Tooltip>
            <Tooltip title="彻底停止生成">
              <IconButton
                onClick={() => void abort()}
                sx={{
                  color: "#fff",
                  background: "var(--omega-danger)",
                  borderRadius: "12px",
                  width: 42,
                  height: 42,
                  mb: 0.25,
                  "&:hover": { filter: "brightness(1.12)" },
                }}
              >
                <StopIcon />
              </IconButton>
            </Tooltip>
          </>
        ) : (
          <IconButton
            onClick={() => send()}
            disabled={canSend}
            sx={{
              color: "#fff",
              background: "linear-gradient(135deg, var(--omega-accent-strong), #7666d9)",
              borderRadius: "12px",
              width: 42,
              height: 42,
              mb: 0.25,
              "&:hover": { filter: "brightness(1.12)" },
              "&:disabled": { opacity: 0.5, background: "var(--omega-border-strong)" },
            }}
          >
            <SendIcon />
          </IconButton>
        )}
      </Box>
    </Box>
  );
}
