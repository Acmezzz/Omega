/**
 * MUI theme provider wiring:
 *   StyledEngineProvider (use our emotion cache with the CSP nonce)
 *   ThemeProvider (dark palette derived from design tokens)
 *   CssBaseline (normalize + apply the dark background)
 */
import * as React from "react";
import { createTheme, ThemeProvider as MuiThemeProvider, CssBaseline } from "@mui/material";
import { StyledEngineProvider } from "@mui/material/styles";
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
      <StyledEngineProvider injectFirst>
        <MuiThemeProvider theme={theme}>
          <CssBaseline />
          {children}
        </MuiThemeProvider>
      </StyledEngineProvider>
    </CacheProvider>
  );
}
