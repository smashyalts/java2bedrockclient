import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // Relative base: assets resolve against the page URL, so the same build
  // works at the domain root (tunnel) and under a subpath (GitHub Pages).
  base: "./",
  plugins: [react()],
  worker: {
    format: "es",
  },
  build: {
    target: "es2022",
    rollupOptions: {
      output: {
        manualChunks: {
          "vendor-react": ["react", "react-dom"],
        },
      },
    },
  },
  server: {
    allowedHosts: true
  },
});
