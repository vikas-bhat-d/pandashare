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

// Max chunks = ceil(2 GB / 20 MB) = 103. Cap at 150 to allow headroom.
const MAX_ENCRYPTED_CHUNKS = 150;
const CHUNK_SIZE_BYTES = 20 * 1024 * 1024; // must match frontend CHUNK_SIZE

const encryptedPresignSchema = z.object({
  roomId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().positive().max(2 * 1024 * 1024 * 1024), // 2 GB hard cap
  totalChunks: z.number().int().positive().max(MAX_ENCRYPTED_CHUNKS),
});

const multipartInitSchema = z.object({
  roomId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().positive().max(2 * 1024 * 1024 * 1024),
  totalParts: z.number().int().positive().max(MAX_ENCRYPTED_CHUNKS),
  chunkSize: z.number().int().positive(), // plaintext chunk size in bytes
});

const multipartCompleteSchema = z.object({
  roomId: z.string().min(1),
  fileId: z.string().min(1),
  fileName: z.string().min(1),
  size: z.number().positive(),
  totalParts: z.number().int().positive(),
  chunkSize: z.number().int().positive(),
  uploadId: z.string().min(1),
  parts: z
    .array(z.object({ PartNumber: z.number().int().positive(), ETag: z.string().min(1) }))
    .min(1),
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

/**
 * POST /api/upload/multipart/initiate
 * Creates an S3 multipart upload and returns presigned UploadPart URLs.
 * The browser uploads each encrypted part directly to S3 (ETag captured per part).
 * Storing the whole file as one S3 object means download = 1 GET regardless of file size.
 *
 * Body: { roomId, fileId, fileName, size, totalParts, chunkSize }
 * Response: { uploadId, urls }
 */
router.post(
  "/upload/multipart/initiate",
  validate(multipartInitSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId, size, totalParts, chunkSize } =
        req.body as z.infer<typeof multipartInitSchema>;

      // Verify totalParts is consistent with declared file size and chunkSize
      const expectedParts = Math.ceil(size / chunkSize);
      if (totalParts !== expectedParts) {
        return res.status(400).json({
          error: `totalParts ${totalParts} does not match expected ${expectedParts} for size ${size} / chunkSize ${chunkSize}`,
        });
      }

      const { uploadId, urls } = await storage.initiateMultipartUpload(
        roomId,
        fileId,
        totalParts
      );

      res.json({ uploadId, urls });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/upload/multipart/complete
 * Completes the S3 multipart upload by combining all parts into one object,
 * then saves file metadata to the database.
 *
 * Body: { roomId, fileId, fileName, size, totalParts, chunkSize, uploadId, parts }
 * Response: { ok, file }
 */
router.post(
  "/upload/multipart/complete",
  validate(multipartCompleteSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId, fileName, size, totalParts, chunkSize, uploadId, parts } =
        req.body as z.infer<typeof multipartCompleteSchema>;

      await storage.completeMultipartUpload(roomId, fileId, uploadId, parts);

      const file = await fileService.completeUpload({
        fileId,
        roomId,
        fileName,
        totalChunks: totalParts,
        size,
        isMultipart: true,
        chunkSize,
      });

      res.json({
        ok: true,
        file: { ...file, size: file.size.toString() },
      });
    } catch (err) {
      // Attempt to clean up the incomplete multipart upload so S3 doesn't
      // keep charging for orphaned parts.
      const body = req.body as Partial<z.infer<typeof multipartCompleteSchema>>;
      if (body.roomId && body.fileId && body.uploadId) {
        await storage.abortMultipartUpload(body.roomId, body.fileId, body.uploadId);
      }
      next(err);
    }
  }
);

export default router;
