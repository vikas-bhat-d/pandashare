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

const publicPresignSchema = z.object({
  roomId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().positive(),
});

const publicCompleteSchema = z.object({
  roomId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().positive(),
});

// Max chunks = ceil(2 GB / 5 MB) = 410. Cap at 500 to allow headroom.
const MAX_ENCRYPTED_CHUNKS = 500;
const CHUNK_SIZE_BYTES = 5 * 1024 * 1024; // must match frontend CHUNK_SIZE

const encryptedPresignSchema = z.object({
  roomId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().positive().max(2 * 1024 * 1024 * 1024), // 2 GB hard cap
  totalChunks: z.number().int().positive().max(MAX_ENCRYPTED_CHUNKS),
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
 * POST /api/upload/encrypted/presign
 * Returns N presigned S3 PUT URLs — one per encrypted chunk — so the browser
 * can PUT each chunk directly to S3 without going through Node.
 *
 * Node only handles this one tiny JSON request per file upload.
 * All chunk data flows browser → S3 directly, bypassing the rate limiter.
 *
 * Body: { roomId, fileId, fileName, size, totalChunks }
 * Response: { urls: string[] }  (url[i] accepts the PUT for chunk i)
 */
router.post(
  "/upload/encrypted/presign",
  validate(encryptedPresignSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId, size, totalChunks } =
        req.body as z.infer<typeof encryptedPresignSchema>;

      // Verify totalChunks is consistent with the declared file size
      const expectedChunks = Math.ceil(size / CHUNK_SIZE_BYTES);
      if (totalChunks !== expectedChunks) {
        return res.status(400).json({
          error: `totalChunks ${totalChunks} does not match expected ${expectedChunks} for size ${size}`,
        });
      }

      const urls = await storage.getPresignedChunkUploadUrls(roomId, fileId, totalChunks);
      res.json({ urls });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/public-upload/presign
 * Returns a presigned S3 PUT URL so the browser can upload directly to S3.
 * No file data passes through this server.
 *
 * Body: { roomId, fileId, fileName, size }
 */
router.post(
  "/public-upload/presign",
  validate(publicPresignSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId } = req.body as z.infer<typeof publicPresignSchema>;
      const url = await storage.getPresignedUploadUrl(roomId, fileId);
      res.json({ url });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/public-upload/complete
 * Called by the frontend after a successful presigned PUT to S3.
 * Saves the file metadata to the database.
 *
 * Body: { roomId, fileId, fileName, size }
 */
router.post(
  "/public-upload/complete",
  validate(publicCompleteSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId, fileName, size } = req.body as z.infer<
        typeof publicCompleteSchema
      >;

      const file = await fileService.completeUpload({
        fileId,
        roomId,
        fileName,
        totalChunks: 1,
        size,
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
