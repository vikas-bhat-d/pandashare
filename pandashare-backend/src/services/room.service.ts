import { PrismaClient, RoomMode } from "@prisma/client";
import crypto from "crypto";

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
 * Update a room's expiry time. Capped at 48 hours from now.
 */
export async function updateExpiry(id: string, hours: number) {
  const maxHours = Math.min(hours, 48);
  const expiresAt = new Date(Date.now() + maxHours * 60 * 60 * 1000);
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
