/**
 * EngineTracker: per-session workflow execution state machine.
 * The adapter feeds completed tool calls and checkpoint outcomes.
 */
import type { Step, L1Template } from "../library/types.ts";

export interface CheckpointOutcome {
	satisfied: boolean;
	reason: string;
}

export interface EscapeFailure {
	workflowId: string;
	stepIndex: number;
	expect: string;
	observedResult: string;
	escapeReason: string;
}

export type EngineAction =
	| { type: "advance"; message: string | null }
	| { type: "retry-hint"; message: string }
	| { type: "switch-alternative"; message: string; alternativeId: string }
	| { type: "escape"; message: string; failure: EscapeFailure };

export interface TrackerDeps {
	getL1: (id: string) => L1Template | undefined;
}

export interface ToolCompletion {
	matched: boolean;
	needsCheckpoint: boolean;
	actions: EngineAction[];
}

export interface TrackerSnapshot {
	version: 1;
	workflowId: string;
	stepCount: number;
	currentIndex: number;
	retryCounts: Record<string, number>;
	completedToolCounts: Record<string, number>;
	seenToolCallIds: string[];
	expanded: string[];
	alternativeId: string | null;
	alternativeTools: string[] | null;
	escaped: boolean;
	updatedAt: string;
}

export const ESCAPE_DIRECTIVE =
	"本工作流在当前任务上失效。请立即放弃该工作流，向用户说明失效的步骤与原因，然后以自由模式继续解决任务。不要继续按工作流步骤执行。";

export class EngineTracker {
	readonly workflowId: string;
	private readonly steps: Step[];
	private readonly deps: TrackerDeps;
	private readonly retryCounts = new Map<number, number>();
	private readonly expanded = new Set<string>();
	private readonly seenToolCallIds = new Set<string>();
	private readonly completedToolCounts = new Map<string, number>();
	private currentIndex = 0;
	private escaped = false;
	private alternativeTools: string[] | null = null;
	private alternativeId: string | null = null;

	constructor(workflowId: string, steps: Step[], deps: TrackerDeps, startIndex = 0) {
		this.workflowId = workflowId;
		this.steps = steps;
		this.deps = deps;
		this.currentIndex = Math.max(0, Math.min(startIndex, steps.length));
	}

	static fromSnapshot(snapshot: unknown, steps: Step[], deps: TrackerDeps): EngineTracker | null {
		if (!snapshot || typeof snapshot !== "object") return null;
		const value = snapshot as Partial<TrackerSnapshot>;
		if (value.version !== 1 || typeof value.workflowId !== "string" || typeof value.stepCount !== "number" || value.stepCount !== steps.length) return null;
		const tracker = new EngineTracker(value.workflowId, steps, deps, typeof value.currentIndex === "number" ? value.currentIndex : 0);
		if (tracker.workflowId !== value.workflowId) return null;
		for (const [key, count] of Object.entries(value.retryCounts ?? {})) tracker.retryCounts.set(Number(key), Number(count));
		for (const [tool, count] of Object.entries(value.completedToolCounts ?? {})) tracker.completedToolCounts.set(tool, Number(count));
		for (const id of value.seenToolCallIds ?? []) if (typeof id === "string") tracker.seenToolCallIds.add(id);
		for (const id of value.expanded ?? []) if (typeof id === "string") tracker.expanded.add(id);
		tracker.alternativeId = typeof value.alternativeId === "string" ? value.alternativeId : null;
		tracker.alternativeTools = Array.isArray(value.alternativeTools) ? value.alternativeTools.filter((tool): tool is string => typeof tool === "string") : null;
		tracker.escaped = value.escaped === true;
		return tracker;
	}

	toSnapshot(): TrackerSnapshot {
		return {
			version: 1,
			workflowId: this.workflowId,
			stepCount: this.steps.length,
			currentIndex: this.currentIndex,
			retryCounts: Object.fromEntries(this.retryCounts),
			completedToolCounts: Object.fromEntries(this.completedToolCounts),
			seenToolCallIds: [...this.seenToolCallIds],
			expanded: [...this.expanded],
			alternativeId: this.alternativeId,
			alternativeTools: this.alternativeTools ? [...this.alternativeTools] : null,
			escaped: this.escaped,
			updatedAt: new Date().toISOString(),
		};
	}

	get escapedFlag(): boolean { return this.escaped; }
	get active(): boolean { return !this.escaped && this.currentIndex < this.steps.length; }
	get completed(): boolean { return !this.escaped && this.currentIndex >= this.steps.length; }
	get currentStepIndex(): number { return this.currentIndex; }
	get currentStep(): Step | undefined { return this.steps[this.currentIndex]; }

	currentStepTools(): string[] {
		if (this.alternativeTools) return [...this.alternativeTools];
		const step = this.currentStep;
		if (!step) return [];
		if (step.ref) {
			const l1 = this.deps.getL1(step.ref);
			return l1 ? l1.calls.map((c) => c.tool) : [];
		}
		return step.action ? [step.action.tool] : [];
	}

	hasCheckpointAt(index: number): boolean { return !!this.steps[index]?.expect; }
	markExpanded(l1Id: string): void { this.expanded.add(l1Id); }
	isExpanded(l1Id: string): boolean { return this.expanded.has(l1Id); }

	/** Consume one completed tool call. A step advances only after its expected tool sequence is complete. */
	recordToolCompletion(toolCallId: string, toolName: string): ToolCompletion {
		if (!this.active || this.seenToolCallIds.has(toolCallId)) return { matched: false, needsCheckpoint: false, actions: [] };
		const expected = this.currentStepTools();
		if (!expected.includes(toolName)) return { matched: false, needsCheckpoint: false, actions: [] };
		this.seenToolCallIds.add(toolCallId);
		this.completedToolCounts.set(toolName, (this.completedToolCounts.get(toolName) ?? 0) + 1);
		const required = new Map<string, number>();
		for (const tool of expected) required.set(tool, (required.get(tool) ?? 0) + 1);
		const complete = [...required].every(([tool, count]) => (this.completedToolCounts.get(tool) ?? 0) >= count);
		if (!complete) return { matched: true, needsCheckpoint: false, actions: [] };
		if (this.currentStep?.expect) return { matched: true, needsCheckpoint: true, actions: [] };
		return { matched: true, needsCheckpoint: false, actions: this.advanceStep() };
	}

	/** Feed a checkpoint result for the already-completed current step. */
	handleCheckpoint(outcome: CheckpointOutcome | null, observedResult: string): EngineAction[] {
		if (!this.active) return [];
		const step = this.currentStep;
		const index = this.currentIndex;
		const expect = step?.expect ?? "";
		if (outcome === null) {
			this.resetToolProgress();
			return [{ type: "retry-hint", message: "检查点验证不可用，暂不推进工作流；请重试当前步骤。" }];
		}
		if (outcome.satisfied) return this.advanceStep();
		this.resetToolProgress();
		const retries = step?.retries ?? 2;
		const used = (this.retryCounts.get(index) ?? 0) + 1;
		this.retryCounts.set(index, used);
		if (used < retries) {
			return [{ type: "retry-hint", message: `检查点未通过：${outcome.reason}。请调整参数或换一种做法后重试本步骤。` }];
		}
		if (step?.alternative) {
			const alt = step.alternative;
			const l1 = this.deps.getL1(alt);
			if (l1) {
				this.alternativeId = alt;
				this.alternativeTools = l1.calls.map((call) => call.tool);
				this.retryCounts.set(index, 0);
				return [{ type: "switch-alternative", message: `主路径在"${step.intent}"上连续失败（原因：${outcome.reason}）。切换到备选方案 ${alt}：\n${this.renderL1(alt)}`, alternativeId: alt }];
			}
		}
		this.escaped = true;
		return [{ type: "escape", message: `工作流 ${this.workflowId} 在步骤 ${index + 1}（${step?.intent ?? "?"}）失效：${outcome.reason}。${ESCAPE_DIRECTIVE}`, failure: { workflowId: this.workflowId, stepIndex: index, expect, observedResult, escapeReason: outcome.reason } }];
	}

	skipCurrentStep(): EngineAction[] { return this.advanceStep(); }

	private advanceStep(): EngineAction[] {
		if (!this.active) return [];
		this.currentIndex += 1;
		this.retryCounts.delete(this.currentIndex - 1);
		this.resetToolProgress();
		this.alternativeTools = null;
		this.alternativeId = null;
		return [{ type: "advance", message: this.renderNextStepDetail() }];
	}

	private resetToolProgress(): void {
		this.completedToolCounts.clear();
	}

	private renderNextStepDetail(): string | null {
		const next = this.currentStep;
		if (!next) return null;
		if (next.ref && !this.expanded.has(next.ref)) {
			this.expanded.add(next.ref);
			return `进入下一步（${next.intent}），按模板 ${next.ref} 执行：\n${this.renderL1(next.ref)}`;
		}
		if (next.action) return `进入下一步（${next.intent}）：${next.action.tool} ${next.action.argsTemplate}`;
		return null;
	}

	private renderL1(id: string): string {
		const l1 = this.deps.getL1(id);
		if (!l1) return `（模板 ${id} 不存在，按步骤意图自由执行）`;
		this.expanded.add(id);
		const lines = l1.calls.map((c) => `- ${c.tool} ${c.argsTemplate}`).join("\n");
		const expect = l1.expect ? `\n检查点：${l1.expect}` : "";
		const variants = l1.variants.length > 0 ? `\n失败可切换变体：${l1.variants.join(", ")}` : "";
		return `${lines}${expect}${variants}`;
	}
}
