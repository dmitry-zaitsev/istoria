import { defineConfig } from "vitest/config";

// Pure-logic tests (transformer destructuring). No DOM needed — the
// default `node` environment is enough, and the React plugin from
// vite.config.ts is intentionally not loaded here.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
});
