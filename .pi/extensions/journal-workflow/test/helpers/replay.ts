/**
 * Event replay: drives FakePi with fixture event scripts through the SAME
 * wire() handlers used in production. This is the backbone of offline testing.
 */
import { readFileSync } from "node:fs";
import type { HandlerCtx } from "../../adapter.ts";
import type { FakePi } from "./fake-pi.ts";

export interface FixtureCtx {
	cwd: string;
	taskId: string;
	entries?: Array<{ id: string; type: string; message?: unknown }>;
}

export interface FixtureEvent {
	event: string;
	payload?: unknown;
}

export interface Fixture {
	ctx: FixtureCtx;
	events: FixtureEvent[];
}

export function buildCtx(desc: FixtureCtx): HandlerCtx {
	return {
		cwd: desc.cwd,
		sessionManager: {
			getHeader: () => ({ id: desc.taskId }),
			getEntries: () => desc.entries ?? [],
		},
		model: { id: "fake-model" },
		modelRegistry: {
			complete: async (_model: unknown, context: { systemPrompt?: string; messages: Array<{ role: string; content: unknown; timestamp: number }> }) => {
				// Default fake completion: not used by journal tests; distill tests
				// inject their own llm client instead of going through the registry.
				void context;
				return { content: [{ type: "text", text: "{}" }] };
			},
		},
	};
}

export function loadFixture(path: string): Fixture {
	return JSON.parse(readFileSync(path, "utf-8")) as Fixture;
}

export async function replayEvents(fakePi: FakePi, fixture: Fixture): Promise<void> {
	const ctx = buildCtx(fixture.ctx);
	for (const ev of fixture.events) {
		await fakePi.emit(ev.event, ev.payload ?? {}, ctx);
	}
}
