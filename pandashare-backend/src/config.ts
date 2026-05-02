// dotenv/config is the side-effect import — works across all dotenv versions (v6–v17+)
import "dotenv/config";

export const config = {
  PORT: parseInt(process.env.PORT || "4000"),
  CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:3000",
  DATABASE_URL: process.env.DATABASE_URL || "",
  // S3_ENDPOINT: process.env.S3_ENDPOINT || "http://localhost:9000",
  S3_ENDPOINT:null,
  S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || "minioadmin",
  S3_SECRET_KEY: process.env.S3_SECRET_KEY || "minioadmin",
  S3_BUCKET: process.env.S3_BUCKET || "pandashare",
  S3_REGION: process.env.S3_REGION || "us-east-1",
  MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024, // 2GB
  CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
  MAX_EXPIRY_HOURS: 48,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || "1234",
  LOG_RETENTION_DAYS: parseInt(process.env.LOG_RETENTION_DAYS || "3"),
};
