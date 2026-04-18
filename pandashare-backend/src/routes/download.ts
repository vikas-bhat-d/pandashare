import { Router } from "express";
import * as storage from "../services/storage.service";
import * as fileService from "../services/file.service";

const router = Router();

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
 */
router.get("/files/:roomId/:fileId/url", async (req, res, next) => {
  try {
    const roomId = req.params.roomId as string;
    const fileId = req.params.fileId as string;
    const url = await storage.getPresignedDownloadUrl(roomId, fileId);
    res.json({ url });
  } catch (err) {
    next(err);
  }
});

/**
 * DELETE /api/files/:roomId/:fileId
 * Deletes a file: removes all S3 chunks then the DB record.
 */
router.delete("/files/:roomId/:fileId", async (req, res, next) => {
  try {
    const roomId = req.params.roomId as string;
    const fileId = req.params.fileId as string;

    const file = await fileService.getFile(roomId, fileId);
    if (!file) {
      return res.status(404).json({ error: "File not found" });
    }

    // Delete from S3 first, then from DB
    await storage.deleteFileChunks(roomId, fileId, file.totalChunks);
    await fileService.deleteFile(fileId);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

export default router;
