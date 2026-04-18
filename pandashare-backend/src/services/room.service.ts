import { PrismaClient, RoomMode } from "@prisma/client";

const prisma = new PrismaClient();

export interface CreateRoomInput {
  name: string;
  mode: RoomMode;
  salt?: string;
  baseIV?: string;
  expiresInHours?: number;
}

/**
 * Create a new room with optional encryption metadata.
 * For password-mode rooms, salt and baseIV are required.
 */
export async function createRoom(input: CreateRoomInput) {
  const expiresAt = new Date(
    Date.now() + (input.expiresInHours || 24) * 60 * 60 * 1000
  );

  return prisma.room.create({
    data: {
      name: input.name,
      mode: input.mode,
      salt: input.salt || null,
      baseIV: input.baseIV || null,
      expiresAt,
    },
  });
}

/**
 * Look up a room by its ID or name.
 * Returns null if not found or expired.
 */
export async function getRoom(nameOrId: string) {
  // Try by ID first, then by name
  let room = await prisma.room.findUnique({
    where: { id: nameOrId },
    include: { files: { where: { isComplete: true }, orderBy: { uploadedAt: "desc" } } },
  });

  if (!room) {
    room = await prisma.room.findUnique({
      where: { name: nameOrId },
      include: { files: { where: { isComplete: true }, orderBy: { uploadedAt: "desc" } } },
    });
  }

  // Check expiry
  if (room && new Date(room.expiresAt) < new Date()) {
    return null; // Expired
  }

  return room;
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
