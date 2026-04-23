import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/__tests__/**/*.test.ts"],
    setupFiles: ["src/__tests__/setup.ts"],
    testTimeout: 10000,
    // Provide test-specific env vars — these override whatever is in .env
    // so tests never depend on local developer credentials.
    env: {
      DATABASE_URL: "postgresql://test:test@localhost:5432/pandashare_test",
      DIRECT_URL: "postgresql://test:test@localhost:5432/pandashare_test",
      S3_ACCESS_KEY: "test-access-key",
      S3_SECRET_KEY: "test-secret-key",
      S3_BUCKET: "test-bucket",
      S3_REGION: "us-east-1",
      S3_ENDPOINT: "http://localhost:9000",
      PORT: "4001",
      CORS_ORIGIN: "http://localhost:3000",
      SKIP_LIFECYCLE_RULE: "true",
    },
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts", "src/__tests__/**"],
    },
  },
});
