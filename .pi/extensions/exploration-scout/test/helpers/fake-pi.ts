/**
 * FakePi: minimal stand-in for the Pi ExtensionAPI surface consumed by wire().
 * The same wiring code runs against this in tests and against the real API in
 * production — event replay drives the identical handler chain.
 */
export interface SentMessage {
	content: unknown;
	options?: { deliverAs?: string; triggerTurn?: boolean };
}

export class FakePi {
	handlers = new Map<string, Array<(event: never, ctx: never) => unknown>>();
	sentMessages: SentMessage[] = [];
	commands: Array<{ name: string; options: unknown }> = [];
	tools: unknown[] = [];

	on(event: string, handler: (event: never, ctx: never) => unknown): void {
		const list = this.handlers.get(event) ?? [];
		list.push(handler);
		this.handlers.set(event, list);
	}

	sendMessage(content: unknown, options?: SentMessage["options"]): void {
		this.sentMessages.push({ content, options });
	}

	registerCommand(name: string, options: unknown): void {
		this.commands.push({ name, options });
	}

	registerTool(tool: unknown): void {
		this.tools.push(tool);
	}

	async emit(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
		const results: unknown[] = [];
		for (const handler of this.handlers.get(event) ?? []) {
			results.push(await handler(payload as never, ctx as never));
		}
		return results;
	}
}
