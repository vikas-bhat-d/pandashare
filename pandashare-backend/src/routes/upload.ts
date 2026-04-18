import { Router, raw } from "express";
import { z } from "zod";
import * as storage from "../services/storage.service";
import * as fileService from "../services/file.service";
import { validate } from "../middleware/validate";
import { uploadLimiter } from "../middleware/rateLimit";

const router = Router();

// ──────────────────────────────────────
// Schemas
// ──────────────────────────────────────

const completeUploadSchema = z.object({
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  totalChunks: z.number().int().positive(),
  size: z.number().positive(),
});

// ──────────────────────────────────────
// Routes
// ──────────────────────────────────────

/**
 * POST /api/upload/:roomId/:fileId/:chunkIndex
 * Accepts raw binary body (application/octet-stream) and stores to S3.
 */
router.post(
  "/upload/:roomId/:fileId/:chunkIndex",
  uploadLimiter,
  raw({ type: "application/octet-stream", limit: "6mb" }),
  async (req, res, next) => {
    try {
      const roomId = req.params.roomId as string;
      const fileId = req.params.fileId as string;
      const chunkIndex = req.params.chunkIndex as string;
      const idx = parseInt(chunkIndex);

      if (isNaN(idx) || idx < 0) {
        return res.status(400).json({ error: "Invalid chunk index" });
      }

      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        return res.status(400).json({ error: "Empty or invalid chunk body" });
      }

      await storage.uploadChunk(roomId, fileId, idx, req.body);
      res.json({ ok: true, chunkIndex: idx });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/complete/:roomId
 * Marks a file upload as complete and stores metadata.
 */
router.post(
  "/complete/:roomId",
  validate(completeUploadSchema),
  async (req, res, next) => {
    try {
      const file = await fileService.completeUpload({
        ...req.body,
        roomId: req.params.roomId as string,
      });

      res.json({
        ok: true,
        file: {
          ...file,
          size: file.size.toString(),
        },
      });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
