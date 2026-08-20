/**
 * Design tokens — single source of truth.
 *
 * The exact hex values are lifted from the legacy `styles.css` CSS variables so
 * the React/MUI/Tailwind workbench is visually identical to the old vanilla UI.
 * `tailwind.config.ts` imports the same `colors` map and MUI's `createTheme`
 * below uses the same values, so the three systems cannot drift.
 * See system_design.md §5.
 */

/** Static style nonce shared by the index.html CSP and emotion's cache. */
export const STYLE_NONCE = "omega-static-2026";

export const colors = {
  bgApp: "#0d1016",
  bgPanel: "#151923",
  bgElevated: "#1d2330",
  bgSoft: "#171d29",
  border: "#2b3444",
  borderStrong: "#3a465b",
  text: "#f3f6fb",
  muted: "#8d99ad",
  accent: "#86a9ff",
  accentStrong: "#5d86f2",
  success: "#6bd59a",
  warning: "#e8bd68",
  danger: "#f17f8d",
} as const;

export const spacing = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
} as const;

export const radius = {
  lg: "18px",
  md: "12px",
  sm: "9px",
} as const;

export const fontFamily =
  'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

export const monoFamily =
  'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace';
