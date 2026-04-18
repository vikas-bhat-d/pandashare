import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler } from "./middleware/errorHandler";
import { apiLimiter } from "./middleware/rateLimit";
import roomRoutes from "./routes/rooms";
import uploadRoutes from "./routes/upload";
import downloadRoutes from "./routes/download";

const app = express();

// ──────────────────────────────────────
// Global middleware
// ──────────────────────────────────────

app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-room-verifier"],
  })
);
app.use(apiLimiter);

// Parse JSON for non-upload routes
app.use(express.json({ limit: "1mb" }));

// ──────────────────────────────────────
// Routes
// ──────────────────────────────────────

app.use("/api", roomRoutes);
app.use("/api", uploadRoutes);
app.use("/api", downloadRoutes);

// Health check endpoint
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    version: "0.1.0",
  });
});

// ──────────────────────────────────────
// Error handler (must be registered last)
// ──────────────────────────────────────

app.use(errorHandler);

// ──────────────────────────────────────
// Start server
// ──────────────────────────────────────

app.listen(config.PORT, () => {
  console.log(`\n  🐼 PandaShare API running on http://localhost:${config.PORT}`);
  console.log(`  📦 S3 endpoint: ${config.S3_ENDPOINT}`);
  console.log(`  🗄️  Database: ${config.DATABASE_URL ? "connected" : "not configured"}\n`);
});

export default app;
