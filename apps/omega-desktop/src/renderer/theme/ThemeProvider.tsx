/**
 * MUI theme provider wiring:
 *   CacheProvider (our emotion cache with the CSP nonce AND prepend ordering)
 *   ThemeProvider (dark palette derived from design tokens)
 *   CssBaseline (normalize + apply the dark background)
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
import { colors, fontFamily, monoFamily } from "./tokens";

const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: colors.bgApp, paper: colors.bgPanel },
    primary: { main: colors.accentStrong },
    secondary: { main: colors.accent },
    error: { main: colors.danger },
    success: { main: colors.success },
    warning: { main: colors.warning },
    text: { primary: colors.text, secondary: colors.muted },
    divider: colors.border,
  },
  shape: { borderRadius: 12 },
  typography: {
    fontFamily,
    fontSize: 14,
  },
  components: {
    MuiPaper: {
      styleOverrides: {
        root: { backgroundImage: "none", backgroundColor: colors.bgPanel },
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
          backgroundColor: colors.bgElevated,
          border: `1px solid ${colors.border}`,
          fontSize: 12,
          padding: "5px 9px",
        },
        arrow: { color: colors.bgElevated },
      },
    },
    MuiMenu: {
      styleOverrides: {
        paper: {
          border: `1px solid ${colors.border}`,
          boxShadow: "0 18px 44px rgba(0,0,0,0.45)",
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
          "&.Mui-selected": { background: "rgba(93,134,242,0.18)" },
        },
      },
    },
    MuiDialog: {
      styleOverrides: {
        paper: { border: `1px solid ${colors.border}`, boxShadow: "0 24px 64px rgba(0,0,0,0.5)" },
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
});

export { monoFamily };

export function ThemeProvider({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <CacheProvider value={emotionCache}>
      <MuiThemeProvider theme={theme}>
        <CssBaseline />
        {children}
      </MuiThemeProvider>
    </CacheProvider>
  );
}
