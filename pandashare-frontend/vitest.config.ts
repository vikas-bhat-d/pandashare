import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Use Node environment — Node 18+ exposes globalThis.crypto with SubtleCrypto.
    environment: "node",
    include: ["__tests__/**/*.test.ts"],
    setupFiles: ["__tests__/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["utils/**/*.ts"],
    },
  },
});
