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

    const stream = await storage.downloadChunk(roomId, fileId, idx);
    res.set("Content-Type", "application/octet-stream");
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
