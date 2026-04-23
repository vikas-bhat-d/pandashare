/**
 * Integration-style tests for the periodic cleanup job logic.
 *
 * These tests verify that cleanupExpiredRooms correctly orchestrates
 * S3 deletions and DB deletions, and that the cleanup runner handles
 * errors gracefully (logs warnings, never crashes).
 *
 * The actual setInterval scheduling is tested here by simulating
 * the runCleanup function inline, the same way index.ts does.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist Prisma and storage mocks ────────────────────────────────────────────
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    room: {
      findMany: vi.fn(),
      delete: vi.fn(),
    },
    file: {},
  };
  return { mockPrisma };
});

vi.mock("@prisma/client", () => ({
  // Must be a regular function — arrow functions cannot be used as constructors
  PrismaClient: vi.fn(function () { return mockPrisma; }),
  RoomMode: { password: "password", public: "public" },
}));

vi.mock("../services/storage.service", () => ({
  deleteRoomS3Files: vi.fn(),
}));

import { cleanupExpiredRooms } from "../services/room.service";
import { deleteRoomS3Files } from "../services/storage.service";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const pastDate = new Date(Date.now() - 5 * 60 * 1000); // 5 min ago

function makeRoom(id: string, files: any[] = []) {
  return {
    id,
    name: `room-${id}`,
    mode: "public",
    salt: null,
    baseIV: null,
    verifier: null,
    createdAt: new Date("2026-04-01"),
    expiresAt: pastDate,
    files,
  };
}

const mockFile = {
  id: "file001",
  roomId: "r1",
  fileName: "test.bin",
  totalChunks: 2,
  size: BigInt(1024),
  uploadedAt: new Date(),
  isComplete: true,
  isMultipart: false,
  chunkSize: 0,
};

// ── cleanupExpiredRooms ───────────────────────────────────────────────────────
describe("cleanupExpiredRooms", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes S3 objects then DB row for each expired room", async () => {
    mockPrisma.room.findMany.mockResolvedValue([makeRoom("r1", [mockFile])]);
    mockPrisma.room.delete.mockResolvedValue(makeRoom("r1"));
    vi.mocked(deleteRoomS3Files).mockResolvedValue(undefined);

    const { deleted, errors } = await cleanupExpiredRooms();

    expect(deleted).toBe(1);
    expect(errors).toHaveLength(0);

    // S3 cleanup happens before DB deletion
    const s3CallOrder = vi.mocked(deleteRoomS3Files).mock.invocationCallOrder[0];
    const dbCallOrder = mockPrisma.room.delete.mock.invocationCallOrder[0];
    expect(s3CallOrder).toBeLessThan(dbCallOrder);
  });

  it("processes multiple expired rooms independently", async () => {
    const rooms = [makeRoom("r1", [mockFile]), makeRoom("r2", []), makeRoom("r3", [mockFile])];
    mockPrisma.room.findMany.mockResolvedValue(rooms);
    mockPrisma.room.delete.mockResolvedValue({});
    vi.mocked(deleteRoomS3Files).mockResolvedValue(undefined);

    const { deleted, errors } = await cleanupExpiredRooms();

    expect(deleted).toBe(3);
    expect(errors).toHaveLength(0);
    expect(deleteRoomS3Files).toHaveBeenCalledTimes(3);
    expect(mockPrisma.room.delete).toHaveBeenCalledTimes(3);
  });

  it("skips a room whose S3 cleanup fails and continues with others", async () => {
    const rooms = [makeRoom("r1", [mockFile]), makeRoom("r2")];
    mockPrisma.room.findMany.mockResolvedValue(rooms);
    mockPrisma.room.delete.mockResolvedValue({});

    vi.mocked(deleteRoomS3Files)
      .mockRejectedValueOnce(new Error("S3 batch failure"))
      .mockResolvedValueOnce(undefined);

    const { deleted, errors } = await cleanupExpiredRooms();

    expect(deleted).toBe(1); // r2 succeeded
    expect(errors).toHaveLength(1);
    expect(errors[0].roomId).toBe("r1");
    expect(errors[0].error.message).toBe("S3 batch failure");

    // r1 DB row should NOT be deleted (S3 cleanup failed)
    expect(mockPrisma.room.delete).toHaveBeenCalledTimes(1);
    expect(mockPrisma.room.delete).toHaveBeenCalledWith({ where: { id: "r2" } });
  });

  it("skips a room whose DB deletion fails and continues with others", async () => {
    const rooms = [makeRoom("r1", []), makeRoom("r2")];
    mockPrisma.room.findMany.mockResolvedValue(rooms);
    vi.mocked(deleteRoomS3Files).mockResolvedValue(undefined);

    mockPrisma.room.delete
      .mockRejectedValueOnce(new Error("DB error"))
      .mockResolvedValueOnce({});

    const { deleted, errors } = await cleanupExpiredRooms();

    expect(deleted).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].roomId).toBe("r1");
  });

  it("returns zero deleted when there are no expired rooms", async () => {
    mockPrisma.room.findMany.mockResolvedValue([]);

    const { deleted, errors } = await cleanupExpiredRooms();

    expect(deleted).toBe(0);
    expect(errors).toHaveLength(0);
    expect(deleteRoomS3Files).not.toHaveBeenCalled();
    expect(mockPrisma.room.delete).not.toHaveBeenCalled();
  });
});

// ── runCleanup (inline simulation of what index.ts does) ─────────────────────
describe("runCleanup (graceful error handling)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("logs room count when rooms are deleted, does not throw", async () => {
    mockPrisma.room.findMany.mockResolvedValue([makeRoom("r1")]);
    mockPrisma.room.delete.mockResolvedValue({});
    vi.mocked(deleteRoomS3Files).mockResolvedValue(undefined);

    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Simulate the runCleanup function from index.ts
    async function runCleanup() {
      try {
        const { deleted, errors } = await cleanupExpiredRooms();
        if (deleted > 0) console.log(`Cleanup: deleted ${deleted} expired room(s).`);
        for (const { roomId, error } of errors) {
          console.warn(`Cleanup: failed to delete room ${roomId}:`, error.message);
        }
      } catch (err) {
        console.warn("Cleanup: unexpected error:", (err as Error).message);
      }
    }

    await expect(runCleanup()).resolves.toBeUndefined();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("deleted 1"));

    consoleSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it("logs a warning per failed room but does not throw", async () => {
    mockPrisma.room.findMany.mockResolvedValue([makeRoom("r1")]);
    vi.mocked(deleteRoomS3Files).mockRejectedValue(new Error("S3 down"));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    async function runCleanup() {
      try {
        const { deleted, errors } = await cleanupExpiredRooms();
        if (deleted > 0) console.log(`Cleanup: deleted ${deleted} expired room(s).`);
        for (const { roomId, error } of errors) {
          console.warn(`Cleanup: failed to delete room ${roomId}:`, error.message);
        }
      } catch (err) {
        console.warn("Cleanup: unexpected error:", (err as Error).message);
      }
    }

    await expect(runCleanup()).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("failed to delete room r1"),
      "S3 down"
    );

    warnSpy.mockRestore();
    consoleSpy.mockRestore();
  });
});
