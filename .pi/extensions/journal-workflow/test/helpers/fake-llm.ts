/** Scripted LLM client for offline tests: pops queued responses or errors. */
import type { LlmClient } from "../../core/llm.ts";

export interface LlmCallInput {
	systemPrompt: string;
	userPayload: string;
	maxTokens: number;
}

export class FakeLlm implements LlmClient {
	private queue: Array<string | Error>;
	calls: LlmCallInput[] = [];

	constructor(responses: Array<string | Error>) {
		this.queue = [...responses];
	}

	async complete(input: LlmCallInput): Promise<string> {
		this.calls.push(input);
		const next = this.queue.shift();
		if (next instanceof Error) throw next;
		return next ?? "";
	}

	get callCount(): number {
		return this.calls.length;
	}
}

/** Routing LLM: dispatches by systemPrompt — robust against call-order changes. */
export class RouterLlm implements LlmClient {
	calls: LlmCallInput[] = [];

	constructor(private readonly route: (input: LlmCallInput) => string | Error) {}

	async complete(input: LlmCallInput): Promise<string> {
		this.calls.push(input);
		const result = this.route(input);
		if (result instanceof Error) throw result;
		return result;
	}

	get callCount(): number {
		return this.calls.length;
	}
}
