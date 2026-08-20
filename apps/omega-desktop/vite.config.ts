/**
 * Vite configuration for the Omega Desktop renderer.
 *
 * Hard constraints (see system_design.md §1.1):
 *  - Output a SINGLE classic (IIFE) script so it can be loaded via
 *    `<script src="./dist/assets/index.js">` without violating the
 *    `script-src 'self'` CSP (no ES modules, no eval, no inline).
 *  - Base is relative (`./`) so the built files work from the file:// page.
 *  - CSS is emitted as an external file (`dist/assets/index.css`) to satisfy
 *    `style-src 'self'`.
 */
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: ".",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    cssCodeSplit: false,
    modulePreload: false,
    rollupOptions: {
      input: "src/renderer/main.tsx",
      output: {
        format: "iife",
        inlineDynamicImports: true,
        entryFileNames: "assets/index.js",
        chunkFileNames: "assets/index.js",
        assetFileNames: "assets/[name][extname]",
      },
    },
  },
});
