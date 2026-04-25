import { PrismaClient, RoomMode } from "@prisma/client";
import crypto from "crypto";
import { deleteRoomS3Files } from "./storage.service";

const prisma = new PrismaClient();

export interface CreateRoomInput {
  name: string;
  mode: RoomMode;
  salt?: string;
  baseIV?: string;
  verifier?: string; // HMAC-SHA256(name|password) computed client-side
  expiresInHours?: number;
}

/**
 * Create a new room with optional encryption metadata.
 * For password-mode rooms, salt, baseIV, and verifier are required.
 */
export async function createRoom(input: CreateRoomInput) {
  const expiresAt = new Date(
    Date.now() + (input.expiresInHours || 24) * 60 * 60 * 1000
  );

  return prisma.room.create({
    data: {
      name: input.name.toLowerCase(),
      mode: input.mode,
      salt: input.salt || null,
      baseIV: input.baseIV || null,
      verifier: input.verifier || null,
      expiresAt,
    },
  });
}

/**
 * Look up a room by its ID or name.
 * Returns null if not found or expired.
 * NOTE: Does NOT include files — call getFilesIfAuthorized for that.
 */
export async function getRoom(nameOrId: string) {
  // Try by ID first, then by name
  let room = await prisma.room.findUnique({
    where: { id: nameOrId },
  });

  if (!room) {
    room = await prisma.room.findUnique({
      where: { name: nameOrId.toLowerCase() },
    });
  }

  // Check expiry
  if (room && new Date(room.expiresAt) < new Date()) {
    return null; // Expired
  }

  return room;
}

/**
 * Verify the provided verifier string (constant-time) against the stored one.
 * Returns the room's files if the verifier matches (or room is public).
 * Returns null if room not found, expired, or verifier is wrong.
 */
export async function getFilesIfAuthorized(
  nameOrId: string,
  verifier?: string
): Promise<{ authorized: boolean; files?: any[] }> {
  // Load room with files
  let room = await prisma.room.findUnique({
    where: { id: nameOrId },
    include: { files: { where: { isComplete: true }, orderBy: { uploadedAt: "desc" } } },
  });

  if (!room) {
    room = await prisma.room.findUnique({
      where: { name: nameOrId.toLowerCase() },
      include: { files: { where: { isComplete: true }, orderBy: { uploadedAt: "desc" } } },
    });
  }

  if (!room || new Date(room.expiresAt) < new Date()) {
    return { authorized: false };
  }

  if (room.mode === "public") {
    return { authorized: true, files: room.files };
  }

  // Password room — require verifier
  if (!verifier || !room.verifier) {
    return { authorized: false };
  }

  // Constant-time comparison to prevent timing attacks
  const storedBuf = Buffer.from(room.verifier, "hex");
  const providedBuf = Buffer.from(verifier, "hex");

  if (
    storedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(storedBuf, providedBuf)
  ) {
    return { authorized: false };
  }

  return { authorized: true, files: room.files };
}

/**
 * Update a room's expiry time, computed from its original creation time.
 * Capped at 48 hours from creation.
 */
export async function updateExpiry(id: string, hours: number) {
  const room = await prisma.room.findUnique({ where: { id }, select: { createdAt: true } });
  if (!room) throw new Error("Room not found");
  const maxHours = Math.min(hours, 48);
  const expiresAt = new Date(room.createdAt.getTime() + maxHours * 60 * 60 * 1000);
  return prisma.room.update({
    where: { id },
    data: { expiresAt },
  });
}

/**
 * Get all expired rooms for cleanup.
 */
export async function getExpiredRooms() {
  return prisma.room.findMany({
    where: { expiresAt: { lt: new Date() } },
    include: { files: true },
  });
}

/**
 * Delete a room and cascade-delete its files metadata.
 * Note: S3 cleanup should happen before calling this.
 */
export async function deleteRoom(id: string) {
  return prisma.room.delete({ where: { id } });
}

/**
 * Delete all expired rooms and their S3 objects.
 *
 * For each expired room:
 *  1. Delete S3 objects for every file (chunked, multipart, or public).
 *  2. Delete the room row from the DB (Prisma cascades to File rows via onDelete: Cascade).
 *
 * Rooms whose S3 cleanup fails are skipped so a single bad room doesn't block the rest.
 * All errors are returned to the caller for logging.
 *
 * @returns counts of successfully deleted rooms and any errors encountered.
 */
export async function cleanupExpiredRooms(): Promise<{
  deleted: number;
  errors: Array<{ roomId: string; error: Error }>;
}> {
  const expiredRooms = await getExpiredRooms();

  let deleted = 0;
  const errors: Array<{ roomId: string; error: Error }> = [];

  for (const room of expiredRooms) {
    try {
      // 1. Remove all S3 objects for this room's files
      await deleteRoomS3Files(room.id, room.files);

      // 2. Remove the room (and cascade-delete File rows) from the DB
      await deleteRoom(room.id);

      deleted++;
    } catch (err) {
      errors.push({ roomId: room.id, error: err as Error });
    }
  }

  return { deleted, errors };
}
