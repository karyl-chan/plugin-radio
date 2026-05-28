import { defineConfig } from "vitest/config";

// Vitest runs against the TS sources directly; production build path
// (`vite build && tsc`) is unaffected. Test files live under `tests/`
// at the repo root so a single `tests/**/*.test.ts` glob picks them
// all up and the production `src/` tree stays test-free.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
