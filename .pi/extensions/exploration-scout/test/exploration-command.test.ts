import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";
import { FakePi } from "./helpers/fake-pi.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function context(root: string, taskId = "task-command", idle = true) {
	return {
		cwd: "G:/try/agent/command-test",
		model: { provider: "fake", id: "model" },
		sessionManager: { getHeader: () => ({ id: taskId }), getEntries: () => [] },
		isIdle: () => idle,
		waitForIdle: async () => undefined,
		ui: { notify: (_message: string, _type?: string) => undefined },
	};
}

function commandOf(pi: FakePi): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
	const command = pi.commands.find((item) => item.name === "exploration-scout");
	if (!command) throw new Error("command not registered");
	return (command.options as { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }).handler;
}

describe("/exploration-scout", () => {
	it("toggles manual mode, persists it, and reports status", async () => {
		const root = mkdtempSync(join(tmpdir(), "exploration-command-"));
		roots.push(root);
		const pi = new FakePi();
		wire(pi as unknown as ExtensionAPI, { config: { enabled: true, explorationsRoot: join(root, "explorations"), policy: "manual" }, llm: new FakeLlm([]) });
		const ctx = context(root) as unknown as ExtensionCommandContext;
		const command = commandOf(pi);
		await command("status", ctx);
		await command("on", ctx);
		expect(pi.appendedEntries).toEqual([{ customType: "exploration-scout-mode", data: { enabled: true } }]);
		await command("status", ctx);
	});

	it("sends free task text as a follow-up without executing scouts in the command", async () => {
		const root = mkdtempSync(join(tmpdir(), "exploration-command-followup-"));
		roots.push(root);
		const pi = new FakePi();
		wire(pi as unknown as ExtensionAPI, { config: { enabled: true, explorationsRoot: join(root, "explorations"), policy: "manual" }, llm: new FakeLlm([]) });
		const command = commandOf(pi);
		await command("分析这个失败测试", context(root) as unknown as ExtensionCommandContext);
		expect(pi.userMessages).toEqual([{ content: "分析这个失败测试", options: { deliverAs: "followUp" } }]);
		expect(pi.appendedEntries).toEqual([{ customType: "exploration-scout-mode", data: { enabled: true } }]);
	});

	it("restores the last mode from session entries", async () => {
		const root = mkdtempSync(join(tmpdir(), "exploration-command-restore-"));
		roots.push(root);
		const pi = new FakePi();
		wire(pi as unknown as ExtensionAPI, { config: { enabled: true, explorationsRoot: join(root, "explorations"), policy: "manual" }, llm: new FakeLlm([]) });
		const ctx = { ...context(root), sessionManager: { getHeader: () => ({ id: "task-restore" }), getEntries: () => [{ type: "custom", customType: "exploration-scout-mode", data: { enabled: true } }] } } as unknown as ExtensionCommandContext;
		await pi.emit("session_start", {}, ctx);
		const command = commandOf(pi);
		await command("status", ctx);
	});
});
