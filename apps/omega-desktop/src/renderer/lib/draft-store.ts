/**
 * In-memory composer drafts keyed by session id (port of pi-web draft-store,
 * MIT). Keeps unsent text + image attachments across session switches within
 * the app lifetime; cleared on send.
 */

export interface DraftImage {
  mimeType: string;
  data: string;
}

export interface ChatDraft {
  value: string;
  images: DraftImage[];
}

const drafts = new Map<string, ChatDraft>();

function isEmptyDraft(draft: ChatDraft): boolean {
  return draft.value.trim().length === 0 && draft.images.length === 0;
}

export function getDraft(key: string | null): ChatDraft | null {
  if (!key) return null;
  return drafts.get(key) ?? null;
}

export function setDraft(key: string | null, draft: ChatDraft): void {
  if (!key) return;
  if (isEmptyDraft(draft)) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, { value: draft.value, images: [...draft.images] });
}

export function clearDraft(key: string | null): void {
  if (key) drafts.delete(key);
}

/** Merge a rejected submission back into the current draft text. */
export function mergeDraftText(submitted: string, current: string): string {
  if (!submitted.trim()) return current;
  if (!current.trim()) return submitted;
  return `${submitted}\n\n${current}`;
}
