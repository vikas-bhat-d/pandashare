import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist mocks before any imports ───────────────────────────────────────────
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
    room: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    file: {
      upsert: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      delete: vi.fn(),
    },
  };
  return { mockPrisma };
});

vi.mock("@prisma/client", () => ({
  // Must be a regular function — arrow functions cannot be used as constructors
  PrismaClient: vi.fn(function () { return mockPrisma; }),
  RoomMode: { password: "password", public: "public" },
}));

// Also mock the storage service for cleanupExpiredRooms
vi.mock("../../services/storage.service", () => ({
  deleteRoomS3Files: vi.fn(),
}));

import * as roomService from "../../services/room.service";
import * as storageService from "../../services/storage.service";

// ── Fixtures ─────────────────────────────────────────────────────────────────
const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
const pastDate = new Date(Date.now() - 60 * 1000);

const mockRoom = {
  id: "cl123",
  name: "test-room",
  mode: "public" as const,
  salt: null,
  baseIV: null,
  verifier: null,
  createdAt: new Date("2026-04-01"),
  expiresAt: futureDate,
  files: [],
};

const mockPasswordRoom = {
  ...mockRoom,
  id: "cl456",
  name: "secret-room",
  mode: "password" as const,
  verifier: "a".repeat(64),
  files: [],
};

const mockFile = {
  id: "file001",
  roomId: "cl123",
  fileName: "test.txt",
  totalChunks: 1,
  size: BigInt(1024),
  uploadedAt: new Date(),
  isComplete: true,
  isMultipart: false,
  chunkSize: 0,
};

// ── createRoom ────────────────────────────────────────────────────────────────
describe("createRoom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a public room with default 24h expiry", async () => {
    mockPrisma.room.create.mockResolvedValue(mockRoom);

    const result = await roomService.createRoom({ name: "test-room", mode: "public" });

    expect(result).toEqual(mockRoom);
    expect(mockPrisma.room.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: "test-room",
          mode: "public",
        }),
      })
    );
  });

  it("creates a password room with all encryption metadata", async () => {
    mockPrisma.room.create.mockResolvedValue(mockPasswordRoom);

    await roomService.createRoom({
      name: "secret-room",
      mode: "password",
      salt: "salt==",
      baseIV: "iv==",
      verifier: "a".repeat(64),
      expiresInHours: 12,
    });

    expect(mockPrisma.room.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          salt: "salt==",
          baseIV: "iv==",
          verifier: "a".repeat(64),
        }),
      })
    );
  });

  it("caps expiresAt based on expiresInHours", async () => {
    mockPrisma.room.create.mockResolvedValue(mockRoom);
    const before = Date.now();

    await roomService.createRoom({ name: "test-room", mode: "public", expiresInHours: 6 });

    const createCall = mockPrisma.room.create.mock.calls[0][0];
    const expiresAt: Date = createCall.data.expiresAt;
    const expectedMs = 6 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(expectedMs - 100);
    expect(expiresAt.getTime() - before).toBeLessThanOrEqual(expectedMs + 1000);
  });
});

// ── getRoom ───────────────────────────────────────────────────────────────────
describe("getRoom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("finds a room by ID", async () => {
    mockPrisma.room.findUnique
      .mockResolvedValueOnce(mockRoom); // lookup by ID — found, no second call

    const result = await roomService.getRoom("cl123");
    expect(result).toEqual(mockRoom);
    expect(mockPrisma.room.findUnique).toHaveBeenCalledWith({ where: { id: "cl123" } });
  });

  it("falls back to name lookup when ID lookup returns null", async () => {
    mockPrisma.room.findUnique
      .mockResolvedValueOnce(null) // by ID — not found
      .mockResolvedValueOnce(mockRoom); // by name — found

    const result = await roomService.getRoom("test-room");
    expect(result).toEqual(mockRoom);
    expect(mockPrisma.room.findUnique).toHaveBeenCalledWith({ where: { name: "test-room" } });
  });

  it("returns null when room does not exist", async () => {
    mockPrisma.room.findUnique.mockResolvedValue(null);
    const result = await roomService.getRoom("nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when room is expired", async () => {
    mockPrisma.room.findUnique.mockResolvedValue({ ...mockRoom, expiresAt: pastDate });
    const result = await roomService.getRoom("cl123");
    expect(result).toBeNull();
  });
});

// ── getFilesIfAuthorized ──────────────────────────────────────────────────────
describe("getFilesIfAuthorized", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns files for a public room without verifier", async () => {
    mockPrisma.room.findUnique
      .mockResolvedValueOnce({ ...mockRoom, files: [mockFile] })
      .mockResolvedValueOnce(null);

    const result = await roomService.getFilesIfAuthorized("cl123");
    expect(result.authorized).toBe(true);
    expect(result.files).toHaveLength(1);
  });

  it("returns authorized=true for password room with correct verifier", async () => {
    const verifierHex = "a".repeat(64);
    mockPrisma.room.findUnique.mockResolvedValueOnce({
      ...mockPasswordRoom,
      files: [mockFile],
    });

    const result = await roomService.getFilesIfAuthorized("cl456", verifierHex);
    expect(result.authorized).toBe(true);
  });

  it("returns authorized=false for password room with wrong verifier", async () => {
    mockPrisma.room.findUnique.mockResolvedValueOnce({
      ...mockPasswordRoom, // verifier = "a".repeat(64)
      files: [mockFile],
    });

    const result = await roomService.getFilesIfAuthorized("cl456", "b".repeat(64));
    expect(result.authorized).toBe(false);
    expect(result.files).toBeUndefined();
  });

  it("returns authorized=false when verifier is missing for password room", async () => {
    mockPrisma.room.findUnique.mockResolvedValueOnce({
      ...mockPasswordRoom,
      files: [],
    });

    const result = await roomService.getFilesIfAuthorized("cl456");
    expect(result.authorized).toBe(false);
  });

  it("returns authorized=false when room is not found", async () => {
    mockPrisma.room.findUnique.mockResolvedValue(null);
    const result = await roomService.getFilesIfAuthorized("nonexistent");
    expect(result.authorized).toBe(false);
  });

  it("returns authorized=false when room is expired", async () => {
    mockPrisma.room.findUnique.mockResolvedValueOnce({
      ...mockRoom,
      expiresAt: pastDate,
      files: [],
    });
    const result = await roomService.getFilesIfAuthorized("cl123");
    expect(result.authorized).toBe(false);
  });
});

// ── updateExpiry ──────────────────────────────────────────────────────────────
describe("updateExpiry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates room expiry and caps at 48 hours", async () => {
    const newExpiry = new Date(Date.now() + 48 * 60 * 60 * 1000);
    mockPrisma.room.update.mockResolvedValue({ ...mockRoom, expiresAt: newExpiry });

    const result = await roomService.updateExpiry("cl123", 100); // 100h → capped to 48h

    expect(result.expiresAt).toEqual(newExpiry);
    const updateCall = mockPrisma.room.update.mock.calls[0][0];
    const expiresAt: Date = updateCall.data.expiresAt;
    const maxMs = 48 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(maxMs + 500);
  });

  it("sets expiry to the requested hours when under cap", async () => {
    mockPrisma.room.update.mockResolvedValue(mockRoom);
    const before = Date.now();

    await roomService.updateExpiry("cl123", 12);

    const updateCall = mockPrisma.room.update.mock.calls[0][0];
    const expiresAt: Date = updateCall.data.expiresAt;
    const expectedMs = 12 * 60 * 60 * 1000;
    expect(expiresAt.getTime() - before).toBeGreaterThanOrEqual(expectedMs - 100);
  });
});

// ── getExpiredRooms ───────────────────────────────────────────────────────────
describe("getExpiredRooms", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns rooms whose expiresAt is in the past", async () => {
    const expiredRoom = { ...mockRoom, expiresAt: pastDate, files: [] };
    mockPrisma.room.findMany.mockResolvedValue([expiredRoom]);

    const result = await roomService.getExpiredRooms();
    expect(result).toHaveLength(1);
    expect(mockPrisma.room.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: { files: true } })
    );
  });

  it("returns empty array when no rooms have expired", async () => {
    mockPrisma.room.findMany.mockResolvedValue([]);
    const result = await roomService.getExpiredRooms();
    expect(result).toHaveLength(0);
  });
});

// ── deleteRoom ────────────────────────────────────────────────────────────────
describe("deleteRoom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a room by ID", async () => {
    mockPrisma.room.delete.mockResolvedValue(mockRoom);
    await roomService.deleteRoom("cl123");
    expect(mockPrisma.room.delete).toHaveBeenCalledWith({ where: { id: "cl123" } });
  });
});

// ── cleanupExpiredRooms ───────────────────────────────────────────────────────
describe("cleanupExpiredRooms", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes S3 files then DB row for each expired room", async () => {
    const expiredRoom = { ...mockRoom, expiresAt: pastDate, files: [mockFile] };
    mockPrisma.room.findMany.mockResolvedValue([expiredRoom]);
    mockPrisma.room.delete.mockResolvedValue(expiredRoom);
    vi.mocked(storageService.deleteRoomS3Files).mockResolvedValue(undefined);

    const { deleted, errors } = await roomService.cleanupExpiredRooms();

    expect(deleted).toBe(1);
    expect(errors).toHaveLength(0);
    expect(storageService.deleteRoomS3Files).toHaveBeenCalledWith("cl123", [mockFile]);
    expect(mockPrisma.room.delete).toHaveBeenCalledWith({ where: { id: "cl123" } });
  });

  it("skips a room on S3 error and continues with the rest", async () => {
    const room1 = { ...mockRoom, id: "r1", files: [mockFile] };
    const room2 = { ...mockRoom, id: "r2", name: "other-room", files: [] };
    mockPrisma.room.findMany.mockResolvedValue([room1, room2]);
    mockPrisma.room.delete.mockResolvedValue(room2);

    vi.mocked(storageService.deleteRoomS3Files)
      .mockRejectedValueOnce(new Error("S3 failure"))
      .mockResolvedValueOnce(undefined);

    const { deleted, errors } = await roomService.cleanupExpiredRooms();

    expect(deleted).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0].roomId).toBe("r1");
  });

  it("returns zero deleted when there are no expired rooms", async () => {
    mockPrisma.room.findMany.mockResolvedValue([]);
    const { deleted, errors } = await roomService.cleanupExpiredRooms();
    expect(deleted).toBe(0);
    expect(errors).toHaveLength(0);
  });
});
