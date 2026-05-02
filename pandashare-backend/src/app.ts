import express from "express";
import cors from "cors";
import helmet from "helmet";
import { config } from "./config";
import { errorHandler } from "./middleware/errorHandler";
import { apiLimiter } from "./middleware/rateLimit";
import roomRoutes from "./routes/rooms";
import uploadRoutes from "./routes/upload";
import downloadRoutes from "./routes/download";
import textRoutes from "./routes/text";
import adminRoutes from "./routes/admin";

const app = express();

// ──────────────────────────────────────
// Global middleware
// ──────────────────────────────────────

app.use(helmet());
app.use(
  cors({
    origin: config.CORS_ORIGIN,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "x-room-verifier", "x-snippet-verifier", "x-file-name", "x-device-id", "x-admin-password"],
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
app.use("/api", textRoutes);
app.use("/api", adminRoutes);

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

export default app;
