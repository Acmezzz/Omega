/**
 * Self-contained HTML session export (main process).
 *
 * Generates a single static page from a sanitized session record — no scripts,
 * no external assets. Thinking blocks render as <details>; tool cards render
 * as collapsed summaries with full args/results.
 */
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderToolCard(card) {
  const statusLabel = card.status === "error" ? "失败" : card.status === "running" ? "运行中" : "完成";
  return `
    <details class="tool">
      <summary><span class="tool-name">${escapeHtml(card.toolName)}</span>
        <span class="tool-target">${escapeHtml(card.target ?? "")}</span>
        <span class="tool-status ${escapeHtml(card.status)}">${statusLabel}</span></summary>
      ${card.argsJson ? `<pre class="payload">参数\n${escapeHtml(card.argsJson)}</pre>` : ""}
      ${card.resultText ? `<pre class="payload">结果\n${escapeHtml(card.resultText)}</pre>` : ""}
    </details>`;
}

export function buildSessionHtml(record) {
  const cardsByMessage = new Map();
  for (const card of record.toolCards ?? []) {
    const list = cardsByMessage.get(card.afterMessageId) ?? [];
    list.push(card);
    cardsByMessage.set(card.afterMessageId, list);
  }
  const body = (record.messages ?? [])
    .map((message) => {
      const cards = (cardsByMessage.get(message.id) ?? []).map(renderToolCard).join("");
      if (message.role === "user") {
        return `<div class="msg user"><div class="bubble">${escapeHtml(message.text)}</div></div>${cards}`;
      }
      const thinking = message.thinking
        ? `<details class="thinking"><summary>思考</summary><pre>${escapeHtml(message.thinking)}</pre></details>`
        : "";
      const thinkingNote = message.thinkingDeferred ? `<div class="thinking-deferred">（含思考块）</div>` : "";
      return `<div class="msg assistant">${thinking}${thinkingNote}<div class="bubble md">${escapeHtml(message.text)}</div></div>${cards}`;
    })
    .join("\n");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>${escapeHtml(record.title)} — Omega Desktop</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.7 -apple-system, "Segoe UI", sans-serif; margin: 0 auto; max-width: 860px; padding: 32px 20px; }
  h1 { font-size: 20px; } .meta { color: #888; font-size: 12px; margin-bottom: 28px; }
  .msg { margin: 18px 0; display: flex; }
  .msg.user { justify-content: flex-end; }
  .msg.user .bubble { background: #e8edfd; border-radius: 14px 4px 14px 14px; padding: 10px 14px; white-space: pre-wrap; max-width: 78%; }
  .msg.assistant .bubble { max-width: 100%; white-space: pre-wrap; }
  .thinking summary, .tool summary { cursor: pointer; color: #888; font-size: 12px; }
  .thinking pre, .payload { background: #f4f5f9; border: 1px solid #e2e5ec; border-radius: 8px; padding: 10px; overflow-x: auto; font-size: 12px; max-height: 320px; overflow-y: auto; }
  .thinking-deferred { color: #aaa; font-size: 11px; }
  .tool { margin: 10px 0; } .tool-name { font-weight: 600; }
  .tool-status.done { color: #189a5a; } .tool-status.error { color: #d9506a; }
</style>
</head>
<body>
<h1>${escapeHtml(record.title)}</h1>
<div class="meta">Omega Desktop 导出 · ${escapeHtml(record.workspace)} · ${escapeHtml(record.updatedAt)}</div>
${body}
</body>
</html>`;
}
