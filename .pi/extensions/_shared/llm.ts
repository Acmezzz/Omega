/** Shared auxiliary-model contract used by independent extensions. */
export interface LlmClient {
	complete(input: { systemPrompt: string; userPayload: string; maxTokens: number }): Promise<string>;
}

export function textFromContent(content: unknown): string | null {
	if (!Array.isArray(content)) return null;
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") parts.push(text);
		}
	}
	return parts.length > 0 ? parts.join("\n") : null;
}

export function parseJsonLoose(text: string): unknown | null {
	const trimmed = text.trim();
	const candidates: string[] = [];
	const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fence) candidates.push(fence[1]);
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start !== -1 && end > start) candidates.push(trimmed.slice(start, end + 1));
	candidates.push(trimmed);
	for (const candidate of candidates) {
		try {
			return JSON.parse(candidate);
		} catch {
			// Try the next representation.
		}
	}
	return null;
}
