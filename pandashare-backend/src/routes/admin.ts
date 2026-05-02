import { Router } from "express";
import fs from "fs/promises";
import path from "path";
import { adminAuth } from "../middleware/adminAuth";
import * as roomService from "../services/room.service";
import * as textService from "../services/text.service";

const router = Router();

// All admin routes require the x-admin-password header.
router.use(adminAuth);

const LOG_DIR = process.env.LOG_DIR || "logs";

// ──────────────────────────────────────
// Rooms
// ──────────────────────────────────────

/**
 * GET /api/admin/rooms — List all rooms with expiry info.
 */
router.get("/admin/rooms", async (_req, res, next) => {
  try {
    const rooms = await roomService.getAllRooms();
    res.json({ rooms });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/rooms/:id/expire — Mark a room as expired now.
 * The next 15-min cleanup cycle will delete it and its S3 files.
 */
router.post("/admin/rooms/:id/expire", async (req, res, next) => {
  try {
    await roomService.expireRoom(req.params.id as string);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/rooms/expire-all — Mark ALL rooms as expired now.
 */
router.post("/admin/rooms/expire-all", async (_req, res, next) => {
  try {
    const rooms = await roomService.getAllRooms();
    await Promise.allSettled(rooms.map((r) => roomService.expireRoom(r.id)));
    res.json({ ok: true, count: rooms.length });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────
// Text Snippets
// ──────────────────────────────────────

/**
 * GET /api/admin/snippets — List all snippets with expiry info.
 */
router.get("/admin/snippets", async (_req, res, next) => {
  try {
    const snippets = await textService.getAllSnippets();
    res.json({ snippets });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/snippets/:id/expire — Mark a snippet as expired now.
 */
router.post("/admin/snippets/:id/expire", async (req, res, next) => {
  try {
    await textService.expireSnippet(req.params.id as string);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/admin/snippets/expire-all — Mark ALL snippets as expired now.
 */
router.post("/admin/snippets/expire-all", async (_req, res, next) => {
  try {
    const snippets = await textService.getAllSnippets();
    await Promise.allSettled(snippets.map((s) => textService.expireSnippet(s.id)));
    res.json({ ok: true, count: snippets.length });
  } catch (err) {
    next(err);
  }
});

// ──────────────────────────────────────
// Logs
// ──────────────────────────────────────

/**
 * GET /api/admin/logs — List all available log files with line counts.
 */
router.get("/admin/logs", async (_req, res, next) => {
  try {
    const files = await fs.readdir(LOG_DIR).catch(() => []);
    const logFiles = files.filter((f) => f.endsWith(".log")).sort().reverse();

    const logs = await Promise.all(
      logFiles.map(async (file) => {
        const filePath = path.join(LOG_DIR, file);
        const content = await fs.readFile(filePath, "utf-8").catch(() => "");
        const lines = content.split("\n").filter((l) => l.trim());
        return { file, lines: lines.length };
      })
    );

    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/admin/logs/:filename — Read a specific log file.
 * Query params: ?limit=100&offset=0 to paginate lines (newest first).
 */
router.get("/admin/logs/:filename", async (req, res, next) => {
  try {
    const filename = req.params.filename as string;

    // Prevent directory traversal attacks
    if (filename.includes("..") || filename.includes("/")) {
      return res.status(400).json({ error: "Invalid filename" });
    }

    const filePath = path.join(LOG_DIR, filename);
    const content = await fs.readFile(filePath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    const limit = Math.min(parseInt(req.query.limit as string) || 100, 1000);
    const offset = parseInt(req.query.offset as string) || 0;

    // Return newest lines first (reverse order)
    const pageLines = lines.reverse().slice(offset, offset + limit);

    res.json({
      file: filename,
      total: lines.length,
      offset,
      limit,
      lines: pageLines.map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { raw: line };
        }
      }),
    });
  } catch (err) {
    if ((err as any).code === "ENOENT") {
      return res.status(404).json({ error: "Log file not found" });
    }
    next(err);
  }
});

export default router;
