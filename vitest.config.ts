import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
  // apps/api compiles dashboard.tsx with jsx:react-jsx + jsxImportSource:hono/jsx
  // (apps/api/tsconfig.json). There is no root tsconfig.json, so the same
  // transform is set here for tests that import the API through app.request().
  esbuild: {
    jsx: "automatic",
    jsxImportSource: "hono/jsx",
  },
});
