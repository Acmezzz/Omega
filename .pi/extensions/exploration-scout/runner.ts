/**
 * Process-based Scout runner.
 * Each Scout gets a fresh `pi --no-session` JSON process, read-only tools,
 * a bounded call/output budget and the same model as the parent session.
 */
import { spawn, type SpawnOptions } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExplorationAngle, ExplorationBudget, PriorResolution, ScoutReport, ScoutRunRecord, TaskBrief } from "./core/types.ts";
import { parseScoutReport, makePacket } from "./core/packet.ts";
import { buildScoutPrompt } from "./core/prompts.ts";
import type { ScoutRole } from "./core/roles.ts";

export interface ScoutModel {
	provider?: string;
	id?: string;
}

export interface ScoutRunOptions {
	cwd: string;
	model?: ScoutModel;
	role: ScoutRole;
	brief: TaskBrief;
	prior: PriorResolution;
	budget: ExplorationBudget;
	focus?: string;
	signal?: AbortSignal;
	/** Test seam; production uses the platform child-process spawn. */
	spawn?: ScoutSpawn;
}

interface ChildResult {
	exitCode: number;
	output: string;
	stderr: string;
	toolCallCount: number;
	aborted: boolean;
	timedOut: boolean;
	budgetExceeded: boolean;
}

interface SpawnedChild {
	stdout: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	stderr: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	on(event: "close", listener: (code: number | null) => void): unknown;
	on(event: "error", listener: (error: Error) => void): unknown;
	kill(signal?: NodeJS.Signals): boolean;
}

function modelRef(model?: ScoutModel): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) return { command: process.execPath, args };
	return { command: "pi", args };
}

async function writePrompt(prompt: string): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-explore-"));
	const file = path.join(dir, "scout-system.md");
	await fs.promises.writeFile(file, prompt, { encoding: "utf8", mode: 0o600 });
	return { dir, file };
}

function consumeJsonLine(line: string, state: { output: string; toolCallCount: number }): void {
	if (!line.trim()) return;
	try {
		const event = JSON.parse(line) as Record<string, unknown>;
		if (event.type === "tool_execution_start") state.toolCallCount += 1;
		if (event.type === "message_end") {
			const message = event.message as { role?: string; content?: unknown } | undefined;
			if (message?.role === "assistant" && Array.isArray(message.content)) {
				const text = message.content
					.filter((part): part is { type: "text"; text: string } => {
						return !!part && typeof part === "object" && (part as { type?: string }).type === "text" && typeof (part as { text?: unknown }).text === "string";
					})
					.map((part) => part.text)
					.join("\n");
				if (text) state.output = text;
			}
		}
	} catch {
		// JSON mode may contain diagnostic lines; ignore them.
	}
}

export type ScoutSpawn = (command: string, args: string[], options: SpawnOptions) => SpawnedChild;

const defaultSpawn: ScoutSpawn = (command, args, options) => spawn(command, args, options) as unknown as SpawnedChild;

function runChild(
	args: string[],
	cwd: string,
	budget: ExplorationBudget,
	signal?: AbortSignal,
	spawnChild: ScoutSpawn = defaultSpawn,
): Promise<ChildResult> {
	return new Promise((resolve) => {
		const invocation = getPiInvocation(args);
		const child = spawnChild(invocation.command, invocation.args, {
			cwd,
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const state = { output: "", toolCallCount: 0 };
		let buffer = "";
		let stderr = "";
		let finished = false;
			let wasAborted = false;
			let timedOut = false;
			let budgetExceeded = false;
			let timer: NodeJS.Timeout | undefined;
		let abortHandler: (() => void) | undefined;

		const finish = (exitCode: number): void => {
			if (finished) return;
			finished = true;
			if (timer) clearTimeout(timer);
			if (abortHandler && signal) signal.removeEventListener("abort", abortHandler);
				if (buffer.trim()) consumeJsonLine(buffer, state);
				resolve({ exitCode, output: state.output, stderr, toolCallCount: state.toolCallCount, aborted: wasAborted, timedOut, budgetExceeded });
			};
			const stop = (kind: "abort" | "timeout" | "budget"): void => {
				if (kind === "abort") wasAborted = true;
				if (kind === "timeout") timedOut = true;
				if (kind === "budget") budgetExceeded = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!finished) child.kill("SIGKILL");
			}, 5_000);
		};

		child.stdout.on("data", (data: Buffer | string) => {
			buffer += data.toString();
			if (buffer.length > budget.maxScoutOutputChars * 3) {
				stop("budget");
				return;
			}
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				consumeJsonLine(line, state);
				if (state.toolCallCount > budget.maxToolCallsPerScout) {
					stop("budget");
					return;
				}
			}
		});
		child.stderr.on("data", (data: Buffer | string) => {
			stderr += data.toString();
			if (stderr.length > 4_000) stderr = stderr.slice(-4_000);
		});
		child.on("close", (code) => finish(code ?? 1));
		child.on("error", (error) => {
			stderr += error.message;
			finish(1);
		});
		if (budget.timeoutMsPerScout > 0) timer = setTimeout(() => stop("timeout"), budget.timeoutMsPerScout);
		if (signal) {
			abortHandler = () => stop("abort");
			if (signal.aborted) abortHandler();
			else signal.addEventListener("abort", abortHandler, { once: true });
		}
	});
}

export async function runScout(options: ScoutRunOptions): Promise<ScoutRunRecord> {
	const started = Date.now();
	const priorStatus = options.prior.kind;
	let promptFile: { dir: string; file: string } | undefined;
	try {
		promptFile = await writePrompt(buildScoutPrompt(options.role, options.brief, options.prior, options.focus));
		const args = ["--mode", "json", "--no-session", "--thinking", "low", "--tools", "read,grep,find,ls"];
		const ref = modelRef(options.model);
		if (ref) args.push("--model", ref);
		args.push("--append-system-prompt", promptFile.file, "-p", options.brief.rawUserInput);
			const child = await runChild(args, options.cwd, options.budget, options.signal, options.spawn);
			const cappedOutput = child.output.slice(0, options.budget.maxScoutOutputChars);
			let status: ScoutRunRecord["status"] = "completed";
			if (child.timedOut) status = "timed_out";
			else if (child.aborted) status = "aborted";
			else if (child.budgetExceeded) status = "budget_exceeded";
			else if (child.exitCode !== 0 && !cappedOutput) status = "spawn_failed";
		const report: ScoutReport | null = status === "completed" ? parseScoutReport(cappedOutput, options.role.id, options.role.id, priorStatus) : null;
		if (status === "completed" && !report) status = "parse_failed";
		return {
			scoutId: options.role.id,
			angle: options.role.id,
			status,
			toolCallCount: child.toolCallCount,
			durationMs: Date.now() - started,
			report,
			rawOutput: cappedOutput || undefined,
			error: child.stderr || undefined,
		};
	} catch (error) {
		return {
			scoutId: options.role.id,
			angle: options.role.id,
			status: options.signal?.aborted ? "aborted" : "spawn_failed",
			toolCallCount: 0,
			durationMs: Date.now() - started,
			report: null,
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		if (promptFile) {
			await fs.promises.rm(promptFile.dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}
}

export async function runScouts(options: Omit<ScoutRunOptions, "role"> & { roles: ScoutRole[] }): Promise<ScoutRunRecord[]> {
	const roles = options.roles.slice(0, Math.max(0, options.budget.maxScouts));
	const results: ScoutRunRecord[] = new Array(roles.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= roles.length) return;
			results[index] = await runScout({ ...options, role: roles[index] });
		}
	};
	const workerCount = Math.min(Math.max(1, options.budget.maxConcurrent), roles.length || 1);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results;
}

export { makePacket };
