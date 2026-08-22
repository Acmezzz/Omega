import * as React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { initialResolvedMode, type ThemeMode } from "./theme/palettes";
import { useAppStore } from "./store/useAppStore";
import "./styles/global.css";

// Apply the persisted theme before first paint (no inline script — CSP-safe).
const resolved = initialResolvedMode();
document.documentElement.classList.toggle("dark", resolved === "dark");
document.documentElement.style.colorScheme = resolved;
try {
  const raw = localStorage.getItem("omega-theme");
  const mode: ThemeMode = raw ? (JSON.parse(raw) as ThemeMode) : "system";
  useAppStore.setState({ themeMode: mode, resolvedMode: resolved });
} catch {
  useAppStore.setState({ themeMode: "system", resolvedMode: resolved });
}

const container = document.getElementById("root");
if (container) {
  createRoot(container).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
