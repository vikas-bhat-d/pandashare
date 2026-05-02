import { Request, Response, NextFunction } from "express";
import crypto from "crypto";
import { config } from "../config";

/**
 * Middleware that authenticates admin requests via the x-admin-password header.
 * Uses a constant-time comparison to prevent timing attacks.
 * Rejects with 401 if ADMIN_PASSWORD env var is not set or the header is missing/wrong.
 */
export function adminAuth(req: Request, res: Response, next: NextFunction) {
  if (!config.ADMIN_PASSWORD) {
    return res.status(503).json({ error: "Admin access is not configured (ADMIN_PASSWORD not set)" });
  }

  const provided = req.headers["x-admin-password"];
  if (!provided || typeof provided !== "string") {
    return res.status(401).json({ error: "Missing x-admin-password header" });
  }

  const storedBuf = Buffer.from(config.ADMIN_PASSWORD);
  const providedBuf = Buffer.from(provided);

  // Constant-time compare to prevent timing attacks
  if (
    storedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(storedBuf, providedBuf)
  ) {
    return res.status(401).json({ error: "Invalid admin password" });
  }

  next();
}
