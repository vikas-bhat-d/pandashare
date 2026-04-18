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
  expiresInHours: z.number().min(1).max(48).optional(),
});

const updateExpirySchema = z.object({
  hours: z.number().min(1).max(48),
});

// ──────────────────────────────────────
// Routes
// ──────────────────────────────────────

/**
 * POST /api/rooms — Create a new room
 */
router.post("/rooms", validate(createRoomSchema), async (req, res, next) => {
  try {
    const room = await roomService.createRoom(req.body);
    res.status(201).json(room);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/rooms/:nameOrId — Get room by name or ID
 */
router.get("/rooms/:nameOrId", async (req, res, next) => {
  try {
    const nameOrId = decodeURIComponent(req.params.nameOrId as string);
    const room = await roomService.getRoom(nameOrId);
    if (!room) {
      return res.status(404).json({ error: "Room not found or expired" });
    }

    // Serialize BigInt fields as strings for JSON compatibility
    const serialized = {
      ...room,
      files: room.files.map((f) => ({
        ...f,
        size: f.size.toString(),
      })),
    };

    res.json(serialized);
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
