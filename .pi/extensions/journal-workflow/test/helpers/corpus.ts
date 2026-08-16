/**
 * Session corpus: four task scenarios extracted from the design conversation
 * (see fixtures/corpus/README.md for provenance and expected extraction
 * results). Built through the real JournalWriter so fixtures never drift from
 * the on-disk format.
 */
import { JournalWriter } from "../../core/journal/writer.ts";

export const CORPUS_PROJECT_KEY = "--G--try-agent-demo--";

export interface CorpusToolCall {
	tool: string;
	ok: boolean;
	result: string;
}

export interface CorpusTurn {
	userInput: string;
	stopReason: string; // "stop" | "error" | ...
	tools: CorpusToolCall[];
	intent: string;
	relation: "new" | "retry" | "fix_success" | "fix_failed" | "clarify";
	workflowRef?: string;
}

export interface CorpusTask {
	taskId: string;
	turns: CorpusTurn[];
	failures?: Array<{
		workflowId: string;
		stepIndex: number;
		observedResult: string;
		expect: string;
		escapeReason: string;
	}>;
}

export const SESSION_CORPUS: CorpusTask[] = [
	{
		taskId: "task-login-crash-1",
		turns: [
			{
				userInput: "登录页面一提交就崩溃，帮我修复",
				stopReason: "stop",
				tools: [
					{ tool: "bash", ok: false, result: "1 failing: AuthLogin crashes on empty password" },
					{ tool: "grep", ok: true, result: "src/auth/login.ts:42" },
					{ tool: "read", ok: true, result: "export function login(u, p) { if (!p) throw ..." },
					{ tool: "edit", ok: true, result: "ok" },
					{ tool: "bash", ok: true, result: "all passing" },
				],
				intent: "修复登录提交崩溃",
				relation: "new",
			},
		],
	},
	{
		taskId: "task-login-crash-2",
		turns: [
			{
				userInput: "登录又崩了，和上次类似",
				stopReason: "error",
				tools: [
					{ tool: "bash", ok: false, result: "AuthLogin crashes" },
					{ tool: "grep", ok: true, result: "src/auth/login.ts:42" },
					{ tool: "read", ok: true, result: "export function login(u, p) {" },
				],
				intent: "修复登录崩溃（第一次尝试）",
				relation: "retry",
			},
			{
				userInput: "上次的修复没生效，换个思路再修一次",
				stopReason: "stop",
				tools: [
					{ tool: "bash", ok: false, result: "TypeError at login" },
					{ tool: "grep", ok: true, result: "src/auth/session.ts:10" },
					{ tool: "read", ok: true, result: "export function createSession() {" },
					{ tool: "edit", ok: true, result: "ok" },
					{ tool: "bash", ok: true, result: "all passing" },
				],
				intent: "换思路修复登录崩溃",
				relation: "fix_failed",
			},
		],
	},
	{
		taskId: "task-list-callers",
		turns: [
			{
				userInput: "把 login 函数的所有调用点列出来，不用改代码",
				stopReason: "stop",
				tools: [
					{ tool: "bash", ok: true, result: "project layout listed" },
					{ tool: "grep", ok: true, result: "3 call sites found" },
					{ tool: "read", ok: true, result: "call site details" },
				],
				intent: "列出 login 的调用点",
				relation: "new",
			},
		],
	},
	{
		taskId: "task-escape-recover",
		turns: [
			{
				userInput: "修一下这个失败的测试",
				stopReason: "stop",
				tools: [{ tool: "bash", ok: false, result: "(no output, exit 1)" }],
				intent: "修复失败测试（工作流引导，检查点连续失败后跳出）",
				relation: "new",
				workflowRef: "l2-fix-failing-test",
			},
			{
				userInput: "还是不行，你自己看着办吧",
				stopReason: "stop",
				tools: [
					{ tool: "bash", ok: false, result: "vitest: 1 failed" },
					{ tool: "grep", ok: true, result: "src/auth/login.ts:42" },
					{ tool: "read", ok: true, result: "function body" },
					{ tool: "edit", ok: true, result: "ok" },
					{ tool: "bash", ok: true, result: "all passing" },
				],
				intent: "自由模式修复失败测试",
				relation: "retry",
			},
		],
		failures: [
			{
				workflowId: "l2-fix-failing-test",
				stepIndex: 0,
				observedResult: "(no output, exit 1)",
				expect: "得到明确的失败信息（断言差异或堆栈）",
				escapeReason: "测试命令无输出，无法获得失败信息",
			},
		],
	},
];

/** Write the corpus into a journals root using the real writer. */
export async function buildCorpus(journalsRoot: string): Promise<void> {
	for (const task of SESSION_CORPUS) {
		const writer = new JournalWriter(journalsRoot, CORPUS_PROJECT_KEY, task.taskId);
		let seq = 0;
		for (const turn of task.turns) {
			seq += 1;
			writer.handleEvent({ kind: "message_end_user", text: turn.userInput });
			if (turn.workflowRef) writer.setActiveWorkflow(turn.workflowRef);
			for (const [i, tc] of turn.tools.entries()) {
				const toolCallId = `corpus-${task.taskId}-${turn.userInput.length}-${i}`;
				writer.handleEvent({ kind: "tool_start", toolCallId, tool: tc.tool, args: { placeholder: true } });
				writer.handleEvent({ kind: "tool_end", toolCallId, resultContent: tc.result, isError: !tc.ok });
			}
			if (turn.workflowRef) writer.setActiveWorkflow(null);
			writer.handleEvent({ kind: "turn_end", stopReason: turn.stopReason });
			writer.handleEvent({ kind: "agent_settled" });
			// Distillation patch (kept minimal — these turns count as distilled).
			writer.appendPatch(seq, {
				intent: turn.intent,
				taskEssence: null,
				deliverable: null,
				relation: turn.relation,
				plan: null,
				toolPatches: turn.tools.map((tc, idx) => ({
					refSequence: idx + 1,
					intent: null,
					argsSummary: null,
					resultSummary: tc.result.slice(0, 60),
					significance: null,
					followUp: null,
				})),
				unfinished: [],
				errorSummary: null,
			});
		}
		for (const failure of task.failures ?? []) {
			writer.appendFailure(failure);
		}
		writer.handleEvent({ kind: "session_shutdown" });
	}
}
