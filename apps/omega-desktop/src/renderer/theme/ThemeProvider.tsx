/**
 * MUI theme provider wiring:
 *   CacheProvider (our emotion cache with the CSP nonce AND prepend ordering)
 *   ThemeProvider (MUI theme rebuilt from the active palette)
 *   CssBaseline (normalize + apply the mode background)
 *
 * The active palette also lives in the Zustand store (`usePalette`), so non-MUI
 * inline styles can reference the same tokens without prop drilling.
 *
 * NOTE: do NOT wrap this tree in <StyledEngineProvider injectFirst>. It creates
 * its own NON-nonced emotion cache (`createCache({ key: 'css' })`) and overrides
 * ours via an inner CacheProvider, so every MUI <style> injection violates the
 * index.html CSP (`style-src 'self' 'nonce-...'`). Our cache already sets both
 * `prepend: true` and the shared nonce.
 */
import * as React from "react";
import { createTheme, ThemeProvider as MuiThemeProvider, CssBaseline } from "@mui/material";
import { CacheProvider } from "@emotion/react";
import { emotionCache } from "./emotion-cache";
import { paletteForMode } from "./palettes";
import { fontFamily, monoFamily } from "./tokens";
import { useAppStore } from "../store/useAppStore";

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  const resolvedMode = useAppStore((s) => s.resolvedMode);
  const palette = React.useMemo(() => paletteForMode(resolvedMode), [resolvedMode]);

  const theme = React.useMemo(
    () =>
      createTheme({
        palette: {
          mode: resolvedMode,
          background: { default: palette.bgApp, paper: palette.bgPanel },
          primary: { main: palette.accentStrong },
          secondary: { main: palette.accent },
          error: { main: palette.danger },
          success: { main: palette.success },
          warning: { main: palette.warning },
          text: { primary: palette.text, secondary: palette.textMuted },
          divider: palette.border,
        },
        shape: { borderRadius: 12 },
        typography: {
          fontFamily,
          fontSize: 14,
        },
        components: {
          MuiPaper: {
            styleOverrides: {
              root: { backgroundImage: "none", backgroundColor: palette.bgPanel },
            },
          },
          MuiButton: {
            defaultProps: { disableElevation: true },
            styleOverrides: {
              root: { textTransform: "none", fontWeight: 600 },
            },
          },
          MuiChip: {
            styleOverrides: {
              root: { fontWeight: 500, letterSpacing: "0.01em" },
              sizeSmall: { height: 24 },
            },
          },
          MuiTooltip: {
            styleOverrides: {
              tooltip: {
                backgroundColor: palette.bgElevated,
                border: `1px solid ${palette.border}`,
                color: palette.text,
                fontSize: 12,
                padding: "5px 9px",
              },
              arrow: { color: palette.bgElevated },
            },
          },
          MuiMenu: {
            styleOverrides: {
              paper: {
                border: `1px solid ${palette.border}`,
                boxShadow: `0 18px 44px ${palette.shadow}`,
                maxHeight: 380,
              },
              list: { py: 0.75 },
            },
          },
          MuiMenuItem: {
            styleOverrides: {
              root: {
                fontSize: 13,
                borderRadius: 8,
                mx: 0.75,
                "&.Mui-selected": { background: palette.accentSoft },
              },
            },
          },
          MuiDialog: {
            styleOverrides: {
              paper: { border: `1px solid ${palette.border}`, boxShadow: `0 24px 64px ${palette.shadow}` },
            },
          },
          MuiLinearProgress: {
            styleOverrides: {
              bar: { borderRadius: 999 },
            },
          },
          MuiAccordion: {
            styleOverrides: { root: { fontFamily } },
          },
          MuiInputBase: {
            styleOverrides: { input: { fontFamily } },
          },
        },
      }),
    [palette, resolvedMode],
  );

  return (
    <CacheProvider value={emotionCache}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </CacheProvider>
  );
}

export { monoFamily };
