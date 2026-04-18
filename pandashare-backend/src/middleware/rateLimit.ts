import rateLimit from "express-rate-limit";

// General API rate limiter
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please try again later." },
});

// Upload-specific rate limiter (higher throughput for chunked uploads)
export const uploadLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // ~300MB/min at 5MB/chunk
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Upload rate limit exceeded. Please slow down." },
});
