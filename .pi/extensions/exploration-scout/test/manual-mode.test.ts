import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { wire } from "../adapter.ts";
import { FakeLlm } from "./helpers/fake-llm.ts";
import { FakePi } from "./helpers/fake-pi.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function ctx(root: string) {
	return {
		cwd: "G:/try/agent/manual-mode",
		model: { provider: "fake", id: "model" },
		sessionManager: { getHeader: () => ({ id: "task-manual" }), getEntries: () => [] },
		isIdle: () => true,
		waitForIdle: async () => undefined,
		ui: { notify: () => undefined },
	};
}

describe("manual Scout mode", () => {
	it("does not inject protocol before the user enables it", async () => {
		const root = mkdtempSync(join(tmpdir(), "manual-mode-"));
		roots.push(root);
		const pi = new FakePi();
		wire(pi as unknown as ExtensionAPI, { config: { enabled: true, explorationsRoot: join(root, "explorations"), policy: "manual" }, llm: new FakeLlm([]) });
		const result = await pi.emit("before_agent_start", {}, ctx(root));
		expect(result.some((item) => item && typeof item === "object" && "systemPrompt" in (item as object))).toBe(false);
	});

	it("injects protocol after the persisted mode is enabled", async () => {
		const root = mkdtempSync(join(tmpdir(), "manual-mode-enabled-"));
		roots.push(root);
		const pi = new FakePi();
		wire(pi as unknown as ExtensionAPI, { config: { enabled: true, explorationsRoot: join(root, "explorations"), policy: "manual" }, llm: new FakeLlm([]) });
		const command = pi.commands.find((item) => item.name === "exploration-scout")!.options as { handler: Function };
		const context = ctx(root);
		await command.handler("on", context);
		const result = await pi.emit("before_agent_start", {}, context);
		expect(result.some((item) => item && typeof item === "object" && String((item as { systemPrompt?: string }).systemPrompt ?? "").includes("exploration_protocol"))).toBe(true);
	});
});
