/**
 * Tailwind configuration. Colors are mirrored from `theme/tokens.ts` (which is
 * the single source of truth for design tokens) so Tailwind utility classes and
 * MUI's palette never drift apart. See system_design.md §5.
 */
import type { Config } from "tailwindcss";

const tokens = {
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
};

export default {
  content: ["./index.html", "./src/renderer/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: tokens,
      borderRadius: {
        lg: "18px",
        md: "12px",
        sm: "9px",
      },
      spacing: {
        1: "4px",
        2: "8px",
        3: "12px",
        4: "16px",
        5: "20px",
        6: "24px",
      },
      boxShadow: {
        panel: "0 22px 60px rgba(0, 0, 0, .28)",
      },
    },
  },
  plugins: [],
} satisfies Config;
