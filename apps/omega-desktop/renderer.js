// Renderer: subscribes to agent events via preload bridge and renders them.
const logEl = document.getElementById("log");
const input = document.getElementById("input");
const send = document.getElementById("send");
let eventCount = 0;

function append(cls, text) {
	const div = document.createElement("div");
	div.className = `msg ${cls}`;
	div.textContent = text;
	logEl.appendChild(div);
	logEl.scrollTop = logEl.scrollHeight;
}

window.omega.onEvent((event) => {
	eventCount++;
	if (eventCount % 1 === 0 && event?.type) {
		console.log(`[event #${eventCount}] type=${event.type}`);
	}
	if (!event?.type) return;
	switch (event.type) {
		case "message_start": {
			const role = event.message?.role;
			append(role === "user" ? "user" : "part", role === "user" ? `你：${event.message?.content ?? ""}` : "助手：");
			break;
		}
		case "message_update": {
			const aev = event.assistantMessageEvent;
			if (aev?.type === "text_delta") append("part", aev.delta);
			else if (aev?.type === "tool_call") append("tool", `[工具] ${aev.tool}` ?? "");
			break;
		}
		case "tool_execution_start":
			append("tool", `[开始] ${event.toolName}`);
			break;
		case "tool_execution_end":
			append("tool", `[结束] ${event.toolName}${event.isError ? " (错误)" : ""}`);
			break;
		default:
			append("part", "");
			break;
	}
});

async function doSend() {
	const text = input.value.trim();
	if (!text) return;
	input.value = "";
	append("user", `你：${text}`);
	await window.omega.prompt(text);
}

send.addEventListener("click", doSend);
input.addEventListener("keydown", (e) => { if (e.key === "Enter") doSend(); });