/**
 * Dual-mode design tokens (light + dark), keyed identically so every
 * component can consume them through `usePalette()` without knowing the mode.
 * Dark values continue the original omega tokens; light is adapted from
 * pi-app's light palette (MIT).
 */

export type ThemeMode = "light" | "dark" | "system";

export interface Palette {
  bgApp: string;
  bgPanel: string;
  bgElevated: string;
  bgSoft: string;
  bgCode: string;
  bgUserBubble: string;
  bgHover: string;
  border: string;
  borderStrong: string;
  text: string;
  textMuted: string;
  textDim: string;
  accent: string;
  accentStrong: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  scrollbar: string;
  scrollbarHover: string;
  shadow: string;
}

export const darkPalette: Palette = {
  bgApp: "#0c0f15",
  bgPanel: "#151923",
  bgElevated: "#1d2330",
  bgSoft: "#171d29",
  bgCode: "#0b0e14",
  bgUserBubble: "#5d86f2",
  bgHover: "rgba(134,169,255,0.08)",
  border: "#2b3444",
  borderStrong: "#3a465b",
  text: "#f3f6fb",
  textMuted: "#8d99ad",
  textDim: "#5c6a82",
  accent: "#86a9ff",
  accentStrong: "#5d86f2",
  accentSoft: "rgba(134,169,255,0.14)",
  success: "#6bd59a",
  warning: "#e8bd68",
  danger: "#f17f8d",
  scrollbar: "#333f55",
  scrollbarHover: "#46587a",
  shadow: "rgba(0,0,0,0.45)",
};

export const lightPalette: Palette = {
  bgApp: "#f2f3f8",
  bgPanel: "#ffffff",
  bgElevated: "#ffffff",
  bgSoft: "#f7f8fb",
  bgCode: "#f4f5f9",
  bgUserBubble: "#5d86f2",
  bgHover: "rgba(93,134,242,0.08)",
  border: "#e2e5ec",
  borderStrong: "#c9cedb",
  text: "#1a1e2a",
  textMuted: "#5c6474",
  textDim: "#8b93a5",
  accent: "#4a6fe0",
  accentStrong: "#3f63d6",
  accentSoft: "rgba(74,111,224,0.10)",
  success: "#189a5a",
  warning: "#b8860b",
  danger: "#d9506a",
  scrollbar: "#c9cedb",
  scrollbarHover: "#aab2c5",
  shadow: "rgba(30,40,70,0.14)",
};

export function paletteForMode(mode: "light" | "dark"): Palette {
  return mode === "dark" ? darkPalette : lightPalette;
}

/** Resolve the persisted preference before React renders (CSP-safe, no inline script). */
export function initialResolvedMode(): "light" | "dark" {
  try {
    const raw = localStorage.getItem("omega-theme");
    const mode = raw ? (JSON.parse(raw) as ThemeMode) : "system";
    if (mode === "dark") return "dark";
    if (mode === "light") return "light";
  } catch {
    /* fall through to system */
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

/** Circular-reveal theme switch via View Transitions (port of pi-web useTheme, MIT). */
export function applyModeWithTransition(nextMode: "light" | "dark", origin?: { x: number; y: number }): void {
  const root = document.documentElement;
  const apply = () => {
    root.classList.toggle("dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  };
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  const supportsVT = typeof document.startViewTransition === "function";
  if (!supportsVT || reduceMotion) {
    apply();
    return;
  }
  const x = origin?.x ?? window.innerWidth / 2;
  const y = origin?.y ?? window.innerHeight / 2;
  const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  const transition = document.startViewTransition(apply);
  transition.ready
    .then(() => {
      root.animate(
        { clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${endRadius}px at ${x}px ${y}px)`] },
        { duration: 420, easing: "cubic-bezier(0.22, 0.61, 0.36, 1)", pseudoElement: "::view-transition-new(root)" },
      );
    })
    .catch(() => {
      /* transition cancelled — theme already applied */
    });
}
