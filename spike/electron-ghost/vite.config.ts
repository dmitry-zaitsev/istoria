import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Standalone build for the ghost spike. Root is this folder; deps (react,
// zustand, @tanstack/react-virtual, @tauri-apps/api, highlight.js) resolve up
// the tree from the repo's node_modules. `base: "./"` so the built assets load
// over file:// when Electron does win.loadFile(dist/index.html).
export default defineConfig({
  root: __dirname,
  base: "./",
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
