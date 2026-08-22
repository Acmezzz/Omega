/**
 * Optimistic-send dedupe keys (port of pi-web prompt-recovery, MIT). The user
 * message is appended locally on send; when the SDK replays it via
 * `message_start`, the still-adjacent optimistic bubble is consumed instead of
 * duplicated.
 */

import type { SessionMessage } from "../types/dto";

export function userMessageKey(message: Pick<SessionMessage, "text"> & { images?: Array<{ mimeType: string; data: string }> }): string {
  return JSON.stringify({
    text: message.text ?? "",
    images: (message.images ?? []).map((image) => `${image.mimeType}:${image.data.length}`),
  });
}
