import { Router } from "express";
import { z } from "zod";
import * as roomService from "../services/room.service";
import { validate } from "../middleware/validate";

const router = Router();

// ──────────────────────────────────────
// Schemas
// ──────────────────────────────────────

const createRoomSchema = z.object({
  name: z
    .string()
    .min(1, "Room name is required")
    .max(100, "Room name must be under 100 characters")
    .regex(/^[a-zA-Z0-9\-_]+$/, "Room name can only contain letters, numbers, hyphens, and underscores"),
  mode: z.enum(["password", "public"]),
  salt: z.string().optional(),
  baseIV: z.string().optional(),
  // Client-computed HMAC-SHA256(name + "|" + password) as lowercase hex
  verifier: z.string().regex(/^[0-9a-f]{64}$/, "verifier must be a 64-char hex string").optional(),
  expiresInHours: z.number().min(1).max(48).optional(),
});

const updateExpirySchema = z.object({
  hours: z.number().min(1).max(48),
});

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

/** Serialize a room object, converting BigInt size fields to strings. */
function serializeRoom(room: any) {
  return {
    ...room,
    // Never expose the verifier to clients
    verifier: undefined,
  };
}

// ──────────────────────────────────────
// Routes
// ──────────────────────────────────────

/**
 * POST /api/rooms — Create a new room
 * For password rooms, require verifier (HMAC of name|password).
 */
router.post("/rooms", validate(createRoomSchema), async (req, res, next) => {
  try {
    const { mode, verifier } = req.body;
    if (mode === "password" && !verifier) {
      return res.status(400).json({ error: "Password rooms require a verifier" });
    }

    const room = await roomService.createRoom(req.body);
    res.status(201).json(serializeRoom(room));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms/:nameOrId — Get room metadata
 *
 * Returns room info (id, name, mode, salt, baseIV, expiresAt).
 * For password rooms: files are NOT included here; call /files instead.
 * For public rooms: files array IS included for convenience.
 */
router.get("/rooms/:nameOrId", async (req, res, next) => {
  try {
    const nameOrId = decodeURIComponent(req.params.nameOrId as string);
    const room = await roomService.getRoom(nameOrId);
    if (!room) {
      return res.status(404).json({ error: "Room not found or expired" });
    }

    // For public rooms, include files directly (no auth required)
    if (room.mode === "public") {
      const { authorized, files } = await roomService.getFilesIfAuthorized(nameOrId);
      const serialized = {
        ...serializeRoom(room),
        files: (files ?? []).map((f: any) => ({ ...f, size: f.size.toString() })),
      };
      return res.json(serialized);
    }

    // For password rooms, return metadata only — no files
    res.json({
      ...serializeRoom(room),
      files: [], // intentionally empty; use /files endpoint with verifier
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms/:nameOrId/files — Get file list for a password room
 *
 * Requires header: x-room-verifier: <hex>
 * Returns 401 if verifier is missing or wrong.
 */
router.get("/rooms/:nameOrId/files", async (req, res, next) => {
  try {
    const nameOrId = decodeURIComponent(req.params.nameOrId as string);
    const verifier = req.headers["x-room-verifier"] as string | undefined;

    const { authorized, files } = await roomService.getFilesIfAuthorized(
      nameOrId,
      verifier
    );

    if (!authorized) {
      return res.status(401).json({ error: "Unauthorized — wrong or missing password" });
    }

    const serialized = (files ?? []).map((f: any) => ({
      ...f,
      size: f.size.toString(),
    }));

    res.json({ files: serialized });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/rooms/:id/expiry — Update room expiry
 */
router.patch(
  "/rooms/:id/expiry",
  validate(updateExpirySchema),
  async (req, res, next) => {
    try {
      const room = await roomService.updateExpiry(req.params.id as string, req.body.hours);
      res.json({ expiresAt: room.expiresAt });
    } catch (err) {
      next(err);
    }
  }
);

export default router;
