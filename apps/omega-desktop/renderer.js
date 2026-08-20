const logEl = document.getElementById("log");
const input = document.getElementById("input");
const send = document.getElementById("send");
const composer = document.getElementById("composer");
const emptyState = document.getElementById("empty-state");
const statusLabel = document.getElementById("connection-label");
const statusDot = document.querySelector(".status-dot");
const generationStatus = document.getElementById("generation-status");
const eventCounter = document.getElementById("event-counter");
const jumpLatest = document.getElementById("jump-latest");

const state = {
  messages: new Map(),
  currentAssistantId: null,
  tools: new Map(),
  pendingUsers: [],
  eventCount: 0,
  running: false,
  sending: false,
  nearBottom: true,
  raf: 0,
  pendingDeltas: new Map(),
};

function setConnection(kind, label) {
  statusLabel.textContent = label;
  statusDot.className = `status-dot status-dot--${kind}`;
}

function setRunning(running, label = running ? "正在生成" : "已连接") {
  state.running = running;
  send.disabled = state.sending;
  generationStatus.textContent = label;
  setConnection(running ? "running" : "ready", running ? "生成中" : "就绪");
}

function isNearBottom() {
  return logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 80;
}

function scrollIfNeeded() {
  if (state.nearBottom) logEl.scrollTop = logEl.scrollHeight;
}

function scheduleRender() {
  if (state.raf) return;
  state.raf = requestAnimationFrame(() => {
    state.raf = 0;
    for (const [id, text] of state.pendingDeltas) {
      const message = state.messages.get(id);
      if (message) {
        message.text += text;
        message.content.textContent = message.text;
      }
    }
    state.pendingDeltas.clear();
    scrollIfNeeded();
  });
}

function messageElement(role, id) {
  const wrapper = document.createElement("article");
  wrapper.className = `message message--${role}`;
  wrapper.dataset.messageId = id;
  const avatar = document.createElement("div");
  avatar.className = "message-avatar";
  avatar.textContent = role === "user" ? "你" : "Ω";
  avatar.setAttribute("aria-hidden", "true");
  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  meta.textContent = role === "user" ? "你" : "Omega";
  const content = document.createElement("div");
  content.className = "message-content";
  body.append(meta, content);
  wrapper.append(avatar, body);
  logEl.appendChild(wrapper);
  while (logEl.children.length > 500) logEl.firstElementChild?.remove();
  emptyState.hidden = true;
  return { wrapper, content, text: "" };
}

function ensureAssistant(id) {
  const messageId = id || state.currentAssistantId || `assistant-${Date.now()}`;
  let message = state.messages.get(messageId);
  if (!message) {
    message = messageElement("assistant", messageId);
    state.messages.set(messageId, message);
  }
  state.currentAssistantId = messageId;
  return message;
}

function addUser(text, id = `user-${Date.now()}`) {
  const message = messageElement("user", id);
  message.text = text;
  message.content.textContent = text;
  state.messages.set(id, message);
  return id;
}

function reconcileUserMessage(text, eventId) {
  const pendingIndex = state.pendingUsers.findIndex((item) => item.text === text);
  if (pendingIndex >= 0) {
    const pending = state.pendingUsers.splice(pendingIndex, 1)[0];
    if (eventId && eventId !== pending.id) {
      const message = state.messages.get(pending.id);
      if (message) {
        message.wrapper.dataset.messageId = eventId;
        state.messages.delete(pending.id);
        state.messages.set(eventId, message);
      }
    }
    return;
  }
  addUser(text, eventId);
}

function toolCard(id, name) {
  let card = state.tools.get(id);
  if (card) return card;
  const details = document.createElement("details");
  details.className = "tool-card";
  const summary = document.createElement("summary");
  const dot = document.createElement("span");
  dot.className = "tool-status";
  const label = document.createElement("span");
  label.textContent = name;
  summary.append(dot, label);
  const body = document.createElement("div");
  body.className = "tool-card__body";
  details.append(summary, body);
  const assistant = ensureAssistant();
  assistant.wrapper.querySelector(".message-body").appendChild(details);
  card = { details, dot, body };
  state.tools.set(id, card);
  return card;
}

function handleBootstrapError(data) {
  const message = typeof data?.message === "string" ? data.message : "Agent 初始化失败";
  setConnection("error", "初始化失败");
  generationStatus.textContent = message;
  send.disabled = true;
  input.disabled = true;
  const error = ensureAssistant("bootstrap-error");
  error.wrapper.classList.add("message--error");
  error.content.textContent = message;
}

function handleEvent(event) {
  if (!event || typeof event.type !== "string") return;
  state.eventCount += 1;
  eventCounter.textContent = `${state.eventCount} events`;
  if (event.type === "session_start" || event.type === "agent_start") setConnection("ready", "已连接");
  if (event.type === "agent_start" || event.type === "turn_start") setRunning(true);
  if (event.type === "agent_end" || event.type === "turn_end" || event.type === "agent_settled") {
    setRunning(false);
    if (event.type !== "turn_end") state.currentAssistantId = null;
  }
  if (event.type === "error" || event.type.endsWith("_error")) {
    setConnection("error", "发生错误");
    generationStatus.textContent = event.message || "Agent 发生错误";
    const error = ensureAssistant(`error-${Date.now()}`);
    error.wrapper.classList.add("message--error");
    error.content.textContent = event.message || "Agent 发生错误";
    return;
  }
  if (event.type === "message_start") {
    const role = event.message?.role;
    if (role === "user" && event.message?.text) reconcileUserMessage(event.message.text, event.message.id);
    if (role === "assistant") ensureAssistant(event.message?.id);
    if (role === "assistant" && event.message?.id) state.currentAssistantId = event.message.id;
    return;
  }
  if (event.type === "message_update") {
    const update = event.assistantMessageEvent;
    if (update?.type === "text_delta") {
      const message = ensureAssistant();
      state.pendingDeltas.set(message.wrapper.dataset.messageId, `${state.pendingDeltas.get(message.wrapper.dataset.messageId) || ""}${update.delta || ""}`);
      scheduleRender();
    }
    return;
  }
  if (event.type === "tool_execution_start" || event.type === "tool_execution_update" || event.type === "tool_execution_end") {
    const id = event.toolCallId || `${event.toolName}-${state.eventCount}`;
    const card = toolCard(id, event.toolName || "tool");
    if (event.type === "tool_execution_end") {
      card.dot.className = `tool-status tool-status--${event.isError ? "error" : "done"}`;
      card.body.textContent = event.isError ? "执行失败" : "执行完成";
      card.details.open = false;
    } else if (event.type === "tool_execution_update") {
      card.body.textContent = "执行中…";
    }
  }
}

function updateScrollState() {
  state.nearBottom = isNearBottom();
  jumpLatest.hidden = state.nearBottom;
}

async function doSend() {
  if (state.sending) return;
  const text = input.value.trim();
  if (!text) return;
  state.sending = true;
  send.disabled = true;
  input.value = "";
  const userId = addUser(text);
  state.pendingUsers.push({ text, id: userId });
  setRunning(true, "正在发送");
  try {
    const result = await window.omega.prompt(text);
    if (!result?.ok) throw new Error(result?.message || "消息发送失败");
    generationStatus.textContent = "已发送，等待 Agent 响应";
  } catch (error) {
    state.pendingUsers = state.pendingUsers.filter((item) => item.id !== userId);
    input.value = text;
    setConnection("error", "发送失败");
    generationStatus.textContent = error instanceof Error ? error.message : String(error);
  } finally {
    state.sending = false;
    send.disabled = false;
  }
}

window.omega.onStatus(handleBootstrapError);
window.omega.onEvent(handleEvent);
setConnection("connecting", "连接中");
composer.addEventListener("submit", (event) => { event.preventDefault(); void doSend(); });
input.addEventListener("keydown", (event) => {
  if (event.isComposing) return;
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); composer.requestSubmit(); }
});
input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = `${Math.min(input.scrollHeight, 180)}px`; });
logEl.addEventListener("scroll", updateScrollState);
jumpLatest.addEventListener("click", () => { logEl.scrollTop = logEl.scrollHeight; state.nearBottom = true; updateScrollState(); });
document.querySelectorAll("[data-prompt]").forEach((button) => button.addEventListener("click", () => { input.value = button.dataset.prompt || ""; input.focus(); }));
