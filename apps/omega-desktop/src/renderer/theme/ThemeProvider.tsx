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
import { colors, fontFamily } from "./tokens";

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
  },
});

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
