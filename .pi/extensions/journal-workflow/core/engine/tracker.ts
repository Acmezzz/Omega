/**
 * EngineTracker: per-session workflow execution state machine.
 * Pure decision logic — the adapter feeds checkpoint outcomes (from the
 * validator) and executes the returned actions (steer messages, escape).
 *
 * Policy:
 * - checkpoint pass → advance to the next step (render its detail if new)
 * - checkpoint fail → retry hint while retries budget remains
 * - budget exhausted → alternative branch if present, else ESCAPE
 *   (hard instruction + failure record; free mode takes over unconditionally)
 * - validator unavailable (null outcome) → treated as pass (宁松勿紧)
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
	/** Resolve an L1 template by id (for step details and alternatives). */
	getL1: (id: string) => L1Template | undefined;
}

export const ESCAPE_DIRECTIVE =
	"本工作流在当前任务上失效。请立即放弃该工作流，向用户说明失效的步骤与原因，然后以自由模式继续解决任务。不要继续按工作流步骤执行。";

export class EngineTracker {
	readonly workflowId: string;
	private readonly steps: Step[];
	private readonly deps: TrackerDeps;
	private readonly retryCounts = new Map<number, number>();
	private readonly expanded = new Set<string>();
	private currentIndex = 0;
	private escaped = false;

	constructor(workflowId: string, steps: Step[], deps: TrackerDeps) {
		this.workflowId = workflowId;
		this.steps = steps;
		this.deps = deps;
	}

	get escapedFlag(): boolean {
		return this.escaped;
	}

	get active(): boolean {
		return !this.escaped && this.currentIndex < this.steps.length;
	}

	get currentStepIndex(): number {
		return this.currentIndex;
	}

	get currentStep(): Step | undefined {
		return this.steps[this.currentIndex];
	}

	/** Tools that the current step is expected to call (for checkpoint matching). */
	currentStepTools(): string[] {
		const step = this.currentStep;
		if (!step) return [];
		if (step.ref) {
			const l1 = this.deps.getL1(step.ref);
			return l1 ? l1.calls.map((c) => c.tool) : [];
		}
		return step.action ? [step.action.tool] : [];
	}

	hasCheckpointAt(index: number): boolean {
		const step = this.steps[index];
		return !!step?.expect;
	}

	/** Mark an L1 as expanded (dedup: later references don't re-render details). */
	markExpanded(l1Id: string): void {
		this.expanded.add(l1Id);
	}

	isExpanded(l1Id: string): boolean {
		return this.expanded.has(l1Id);
	}

	/**
	 * Feed a checkpoint outcome for the current step.
	 * `observedResult` is the raw result text (used in the failure record).
	 */
	handleCheckpoint(outcome: CheckpointOutcome | null, observedResult: string): EngineAction[] {
		if (!this.active) return [];
		const step = this.currentStep;
		const index = this.currentIndex;
		const expect = step?.expect ?? "";
		// 宁松勿紧: validator unavailable → pass
		if (!outcome || outcome.satisfied) {
			this.currentIndex += 1;
			const next = this.renderNextStepDetail();
			return [{ type: "advance", message: next }];
		}
		const retries = step?.retries ?? 2;
		const used = (this.retryCounts.get(index) ?? 0) + 1;
		this.retryCounts.set(index, used);
		if (used < retries) {
			return [
				{
					type: "retry-hint",
					message: `检查点未通过：${outcome.reason}。请调整参数或换一种做法后重试本步骤。`,
				},
			];
		}
		if (step?.alternative) {
			const alt = step.alternative;
			this.retryCounts.set(index, 0);
			const altDetail = this.renderL1(alt);
			return [
				{
					type: "switch-alternative",
					message: `主路径在"${step.intent}"上连续失败（原因：${outcome.reason}）。切换到备选方案 ${alt}：\n${altDetail}`,
					alternativeId: alt,
				},
			];
		}
		this.escaped = true;
		return [
			{
				type: "escape",
				message: `工作流 ${this.workflowId} 在步骤 ${index + 1}（${step?.intent ?? "?"}）失效：${outcome.reason}。${ESCAPE_DIRECTIVE}`,
				failure: {
					workflowId: this.workflowId,
					stepIndex: index,
					expect,
					observedResult,
					escapeReason: outcome.reason,
				},
			},
		];
	}

	/** Simulate a non-checkpoint step completion (pointer moves without validation). */
	skipCurrentStep(): EngineAction[] {
		if (!this.active) return [];
		this.currentIndex += 1;
		return [{ type: "advance", message: this.renderNextStepDetail() }];
	}

	private renderNextStepDetail(): string | null {
		const next = this.currentStep;
		if (!next) return null;
		if (next.ref && !this.expanded.has(next.ref)) {
			this.expanded.add(next.ref);
			return `进入下一步（${next.intent}），按模板 ${next.ref} 执行：\n${this.renderL1(next.ref)}`;
		}
		if (next.action) {
			return `进入下一步（${next.intent}）：${next.action.tool} ${next.action.argsTemplate}`;
		}
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
