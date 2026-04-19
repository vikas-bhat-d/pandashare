import { Router } from "express";
import { z } from "zod";
import { validate } from "../middleware/validate";
import * as storage from "../services/storage.service";
import * as fileService from "../services/file.service";

const router = Router();

// ── Constants (must match upload pipeline) ──────────────────────────────────
const MAX_ENCRYPTED_CHUNKS = 150;

// ── Schemas ──────────────────────────────────────────────────────────────────
const encryptedDownloadPresignSchema = z.object({
  roomId: z.string().min(1).max(500),
  fileId: z.string().min(1),
  totalChunks: z.number().int().min(1).max(MAX_ENCRYPTED_CHUNKS),
});

const multipartDownloadPresignSchema = z.object({
  roomId: z.string().min(1).max(500),
  fileId: z.string().min(1),
});

// ──────────────────────────────────────
// Routes
// ──────────────────────────────────────

/**
 * GET /api/download/:roomId/:fileId/:chunkIndex
 * Streams an encrypted chunk from S3 to the client.
 *
 * Validates that:
 *   - chunkIndex is a non-negative integer
 *   - the file record exists and is complete
 *   - chunkIndex is within [0, totalChunks)
 *
 * This prevents clients from issuing unlimited chunk requests which would
 * flood S3 and crash the backend.
 */
router.get("/download/:roomId/:fileId/:chunkIndex", async (req, res, next) => {
  try {
    const roomId = req.params.roomId as string;
    const fileId = req.params.fileId as string;
    const chunkIndex = req.params.chunkIndex as string;
    const idx = parseInt(chunkIndex);

    if (isNaN(idx) || idx < 0) {
      return res.status(400).json({ error: "Invalid chunk index" });
    }

    // Validate file exists and chunk index is in range
    const file = await fileService.getFile(roomId, fileId);
    if (!file || !file.isComplete) {
      return res.status(404).json({ error: "File not found" });
    }

    if (idx >= file.totalChunks) {
      return res.status(400).json({
        error: `Chunk index ${idx} out of range (file has ${file.totalChunks} chunks)`,
      });
    }

    const { stream, contentLength } = await storage.downloadChunk(roomId, fileId, idx);

    res.set("Content-Type", "application/octet-stream");
    res.set("Cache-Control", "private, max-age=3600"); // Allow client-side caching per session
    if (contentLength !== undefined) {
      res.set("Content-Length", String(contentLength));
    }

    stream.pipe(res);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/files/:roomId/:fileId/url
 * Generates a pre-signed URL for public-mode direct download.
 * The URL embeds Content-Disposition: attachment so the browser starts a native
 * download without loading the file into JS memory.
 */
router.get("/files/:roomId/:fileId/url", async (req, res, next) => {
  try {
    const roomId = req.params.roomId as string;
    const fileId = req.params.fileId as string;

    // Look up the original filename so we can embed it in the presigned URL's
    // response-content-disposition header (enables correct filename on save).
    const file = await fileService.getFile(roomId, fileId);
    const url = await storage.getPresignedDownloadUrl(roomId, fileId, file?.fileName);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/download/encrypted/presign
 * Returns presigned S3 GET URLs for every chunk of a password-protected file.
 * The browser fetches chunks directly from S3, so chunk downloads never hit
 * the Node server and are not subject to the API rate limiter.
 *
 * The client is expected to verify filesystem-level access before calling this
 * endpoint (i.e., the file record must exist and be complete).
 *
 * Body: { roomId, fileId, totalChunks }
 */
router.post(
  "/download/encrypted/presign",
  validate(encryptedDownloadPresignSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId, totalChunks } = req.body as z.infer<
        typeof encryptedDownloadPresignSchema
      >;

      // Verify the file exists and is complete before handing out URLs
      const file = await fileService.getFile(roomId, fileId);
      if (!file || !file.isComplete) {
        return res.status(404).json({ error: "File not found" });
      }
      if (file.totalChunks !== totalChunks) {
        return res.status(400).json({ error: "totalChunks mismatch" });
      }

      const urls = await storage.getPresignedChunkDownloadUrls(roomId, fileId, totalChunks);
      res.json({ urls });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/download/multipart/presign
 * Returns a single presigned S3 GET URL for a multipart-uploaded encrypted file.
 * The browser streams the whole object in one request, decrypting chunks on the fly.
 * This is 1 GET instead of N GETs (one per chunk in the old approach).
 *
 * Body: { roomId, fileId }
 * Response: { url, totalChunks, chunkSize }
 */
router.post(
  "/download/multipart/presign",
  validate(multipartDownloadPresignSchema),
  async (req, res, next) => {
    try {
      const { roomId, fileId } = req.body as z.infer<typeof multipartDownloadPresignSchema>;

      const file = await fileService.getFile(roomId, fileId);
      if (!file || !file.isComplete || !file.isMultipart) {
        return res.status(404).json({ error: "File not found" });
      }

      const url = await storage.getPresignedMultipartDownloadUrl(roomId, fileId);
      res.json({ url, totalChunks: file.totalChunks, chunkSize: file.chunkSize });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/files/:roomId/:fileId
 * Deletes a file: removes S3 object(s) then the DB record.
 * Handles both the legacy per-chunk format and the new multipart single-object format.
 */
router.delete("/files/:roomId/:fileId", async (req, res, next) => {
  try {
    const roomId = req.params.roomId as string;
    const fileId = req.params.fileId as string;

    const file = await fileService.getFile(roomId, fileId);
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    if (file.isMultipart) {
      await storage.deleteMultipartObject(roomId, fileId);
    } else {
      await storage.deleteFileChunks(roomId, fileId, file.totalChunks);
    }
    await fileService.deleteFile(fileId);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
