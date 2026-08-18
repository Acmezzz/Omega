import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ExplorationScoutConfig } from "./config.ts";
import type { ExplorationJournal } from "./core/journal.ts";
import type { ExplorationRoundView } from "./core/types.ts";

export interface ExplorationCommandPi {
	registerCommand(
		name: string,
		options: {
			description?: string;
			handler: (args: string, ctx: ExtensionCommandContext) => Promise<void>;
		},
	): void;
	appendEntry<T = unknown>(customType: string, data?: T): void;
	sendUserMessage(content: string, options?: { deliverAs?: "steer" | "followUp"; expandPromptTemplates?: boolean }): void;
}

export interface ExplorationCommandDeps {
	config: ExplorationScoutConfig;
	getJournal: (ctx: ExtensionCommandContext) => ExplorationJournal | null;
	getCurrentRound: () => ExplorationRoundView | null;
	isEnabled: () => boolean;
	setEnabled: (enabled: boolean, ctx: ExtensionCommandContext) => void;
}

function taskIdOf(ctx: ExtensionCommandContext): string | null {
	const id = ctx.sessionManager.getHeader?.()?.id;
	return typeof id === "string" && id.trim() ? id : null;
}

function summary(round: ExplorationRoundView | null): string {
	if (!round) return "最近探索轮次：无";
	const runs = round.packet.runs;
	const completed = runs.filter((run) => run.status === "completed").length;
	const proposals = runs.reduce((count, run) => count + (run.report?.proposals.length ?? 0), 0);
	return [
		`最近轮次=${round.packet.round}`,
		`roundId=${round.roundId}`,
		`Scout=${completed}/${runs.length} 完成`,
		`候选=${proposals}`,
		`selection=${round.selection?.selectionId ?? "无"}`,
		`状态=${round.verifiedOutcome}`,
	].join("，");
}

export function registerExplorationCommand(pi: ExplorationCommandPi, deps: ExplorationCommandDeps): void {
	pi.registerCommand("exploration-scout", {
		description: "手动开启或关闭 Scout 探索模式",
		handler: async (args, ctx) => {
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const command = tokens[0]?.toLowerCase();
			if (command === "status") {
				deps.getJournal(ctx);
				ctx.ui.notify([`Scout 模式=${deps.isEnabled() ? "on" : "off"}`, `policy=${deps.config.policy}`, `task=${taskIdOf(ctx) ?? "无"}`, summary(deps.getCurrentRound())].join("\n"), "info");
				return;
			}

			if (!ctx.isIdle()) await ctx.waitForIdle();
			const taskId = taskIdOf(ctx);
			if (!taskId) {
				ctx.ui.notify("当前没有活动 session，无法切换 Scout 模式。", "error");
				return;
			}
			if (!deps.getJournal(ctx)) {
				ctx.ui.notify("当前 session 无法绑定 exploration journal。", "error");
				return;
			}
			if (deps.config.policy === "off") {
				ctx.ui.notify("配置已将 exploration-scout 设为 off。", "warning");
				return;
			}

			if (command === "off") {
				deps.setEnabled(false, ctx);
				ctx.ui.notify("Scout 模式已关闭。历史探索记录保留。", "info");
				return;
			}
			if (command === "on" || !command) {
				deps.setEnabled(true, ctx);
				ctx.ui.notify("Scout 模式已开启。接下来可由主 Agent 调用 explore_space。", "info");
				return;
			}

			deps.setEnabled(true, ctx);
			pi.sendUserMessage(tokens.join(" "), { deliverAs: "followUp" });
		},
	});
}
