/**
 * Emotion cache configured with the SAME static nonce used by the
 * `index.html` CSP `style-src 'self' 'nonce-...'`. This lets MUI/emotion inject
 * `<style>` elements at runtime without triggering a CSP violation, while we
 * still never allow `unsafe-inline`. See system_design.md §1.1.
 */
import createCache from "@emotion/cache";
import { STYLE_NONCE } from "./tokens";

export const emotionCache = createCache({
  key: "mui",
  nonce: STYLE_NONCE,
  prepend: true,
});
