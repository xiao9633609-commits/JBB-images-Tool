import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react()],
  build: {
    outDir: "../dist/renderer",
    emptyOutDir: true,
  },
  server: {
    port: 5174,
    strictPort: true,
  },
});
