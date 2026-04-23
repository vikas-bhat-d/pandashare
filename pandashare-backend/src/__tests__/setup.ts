// Global test environment — set env vars before any module loads.
// Vitest runs this file before every test module via setupFiles in vitest.config.ts.
process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/pandashare_test";
process.env.DIRECT_URL = "postgresql://test:test@localhost:5432/pandashare_test";
process.env.S3_ACCESS_KEY = "test-access-key";
process.env.S3_SECRET_KEY = "test-secret-key";
process.env.S3_BUCKET = "test-bucket";
process.env.S3_REGION = "us-east-1";
process.env.S3_ENDPOINT = "http://localhost:9000";
process.env.PORT = "4001";
process.env.CORS_ORIGIN = "http://localhost:3000";
process.env.SKIP_LIFECYCLE_RULE = "true";
