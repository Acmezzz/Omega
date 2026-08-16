/**
 * refId resolution: Pi events do not carry session entry ids, but
 * SessionManager.appendMessage stores the same message object reference into
 * the entry. We therefore match by object identity against the entry tail.
 */

export interface EntryLike {
	id: string;
	message?: unknown;
}

export interface ResolvedEntryIds {
	userEntryId: string | null;
	assistantEntryId: string | null;
}

export function resolveEntryIds(userMessage: unknown, assistantMessage: unknown, entries: EntryLike[]): ResolvedEntryIds {
	const result: ResolvedEntryIds = { userEntryId: null, assistantEntryId: null };
	// Newest entries first: the messages of the current turn sit at the tail.
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry.message === undefined) continue;
		if (result.userEntryId === null && entry.message === userMessage) {
			result.userEntryId = entry.id;
			continue;
		}
		if (result.assistantEntryId === null && entry.message === assistantMessage) {
			result.assistantEntryId = entry.id;
		}
		if (result.userEntryId !== null && result.assistantEntryId !== null) break;
	}
	return result;
}
