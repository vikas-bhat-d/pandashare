import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";

// UUID v1-v5 pattern
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Rate-limit key strategy: prefer x-device-id over IP.
 *
 * Why: IP-based keying breaks when multiple devices share one public IP
 * (corporate NAT, university networks, mobile carriers with CGNAT). A stable
 * UUID stored in the browser's localStorage, sent as x-device-id, gives each
 * browser tab its own independent counter regardless of network topology.
 *
 * Security: we validate the UUID format so arbitrary strings cannot inflate
 * the in-memory key space. Falls back to IP for non-browser callers.
 */
function keyGenerator(req: Request): string {
  const id = req.headers["x-device-id"];
  if (typeof id === "string" && UUID_RE.test(id.trim())) {
    return id.trim().toLowerCase();
  }
  const ip = req.ip ?? req.socket?.remoteAddress ?? "unknown";
  return ipKeyGenerator(ip);
}

// General API rate limiter — 200 req per device per 15 min
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Upload rate limiter — supports up to 3 concurrent chunks per device per minute.
// 120 req/min = 3 concurrent * ~40 chunks/min each, fine for a 200MB file.
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Upload rate limit exceeded. Please slow down." },
});
