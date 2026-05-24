import { defineConfig } from "vite";
import vue from "@vitejs/plugin-vue";
import { viteSingleFile } from "vite-plugin-singlefile";

// Inline-everything SPA build. The radio plugin's HTTP surface ships
// a single index.html (read once at boot by web-routes.ts and patched
// with a __PLUGIN_BASE__ injection), and the current CSP only allows
// `script-src 'unsafe-inline'`. Keeping a single self-contained file
// preserves both invariants — no per-asset routes, no CSP relaxation.
export default defineConfig({
  plugins: [vue(), viteSingleFile()],
  root: "web",
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: 100_000_000,
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:3000",
      "/cover": "http://localhost:3000",
    },
  },
});
