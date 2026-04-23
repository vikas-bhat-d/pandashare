import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Hoist Prisma mock ─────────────────────────────────────────────────────────
const { mockPrisma } = vi.hoisted(() => {
  const mockPrisma = {
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
}));

import * as fileService from "../../services/file.service";

// ── Fixtures ──────────────────────────────────────────────────────────────────
const mockFile = {
  id: "file001",
  roomId: "room001",
  fileName: "document.pdf",
  totalChunks: 2,
  size: BigInt(2 * 1024 * 1024),
  uploadedAt: new Date("2026-04-01T00:00:00Z"),
  isComplete: true,
  isMultipart: false,
  chunkSize: 0,
};

// ── completeUpload ─────────────────────────────────────────────────────────────
describe("completeUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a new file record when one does not exist", async () => {
    mockPrisma.file.upsert.mockResolvedValue(mockFile);

    const result = await fileService.completeUpload({
      fileId: "file001",
      roomId: "room001",
      fileName: "document.pdf",
      totalChunks: 2,
      size: 2 * 1024 * 1024,
    });

    expect(result).toEqual(mockFile);
    expect(mockPrisma.file.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "file001" },
        create: expect.objectContaining({
          id: "file001",
          roomId: "room001",
          fileName: "document.pdf",
          totalChunks: 2,
          isComplete: true,
          isMultipart: false,
          chunkSize: 0,
        }),
        update: expect.objectContaining({
          isComplete: true,
          totalChunks: 2,
        }),
      })
    );
  });

  it("upserts a multipart file with isMultipart=true and chunkSize", async () => {
    const multipartFile = { ...mockFile, isMultipart: true, chunkSize: 10 * 1024 * 1024 };
    mockPrisma.file.upsert.mockResolvedValue(multipartFile);

    await fileService.completeUpload({
      fileId: "file001",
      roomId: "room001",
      fileName: "large.bin",
      totalChunks: 5,
      size: 50 * 1024 * 1024,
      isMultipart: true,
      chunkSize: 10 * 1024 * 1024,
    });

    expect(mockPrisma.file.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          isMultipart: true,
          chunkSize: 10 * 1024 * 1024,
        }),
      })
    );
  });

  it("stores size as BigInt", async () => {
    mockPrisma.file.upsert.mockResolvedValue(mockFile);
    await fileService.completeUpload({
      fileId: "file001",
      roomId: "room001",
      fileName: "doc.pdf",
      totalChunks: 1,
      size: 999,
    });

    const createArg = mockPrisma.file.upsert.mock.calls[0][0];
    expect(createArg.create.size).toBe(BigInt(999));
    expect(createArg.update.size).toBe(BigInt(999));
  });

  it("defaults isMultipart to false and chunkSize to 0", async () => {
    mockPrisma.file.upsert.mockResolvedValue(mockFile);
    await fileService.completeUpload({
      fileId: "f",
      roomId: "r",
      fileName: "test.bin",
      totalChunks: 1,
      size: 100,
    });

    const createArg = mockPrisma.file.upsert.mock.calls[0][0];
    expect(createArg.create.isMultipart).toBe(false);
    expect(createArg.create.chunkSize).toBe(0);
  });
});

// ── getFile ───────────────────────────────────────────────────────────────────
describe("getFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a file when found in the given room", async () => {
    mockPrisma.file.findFirst.mockResolvedValue(mockFile);

    const result = await fileService.getFile("room001", "file001");

    expect(result).toEqual(mockFile);
    expect(mockPrisma.file.findFirst).toHaveBeenCalledWith({
      where: { id: "file001", roomId: "room001" },
    });
  });

  it("returns null when file is not found", async () => {
    mockPrisma.file.findFirst.mockResolvedValue(null);
    const result = await fileService.getFile("room001", "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null when file belongs to a different room", async () => {
    mockPrisma.file.findFirst.mockResolvedValue(null);
    const result = await fileService.getFile("other-room", "file001");
    expect(result).toBeNull();
    expect(mockPrisma.file.findFirst).toHaveBeenCalledWith({
      where: { id: "file001", roomId: "other-room" },
    });
  });
});

// ── getFilesByRoom ─────────────────────────────────────────────────────────────
describe("getFilesByRoom", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all complete files for a room ordered by uploadedAt desc", async () => {
    const files = [mockFile, { ...mockFile, id: "file002" }];
    mockPrisma.file.findMany.mockResolvedValue(files);

    const result = await fileService.getFilesByRoom("room001");

    expect(result).toHaveLength(2);
    expect(mockPrisma.file.findMany).toHaveBeenCalledWith({
      where: { roomId: "room001", isComplete: true },
      orderBy: { uploadedAt: "desc" },
    });
  });

  it("returns empty array when room has no files", async () => {
    mockPrisma.file.findMany.mockResolvedValue([]);
    const result = await fileService.getFilesByRoom("empty-room");
    expect(result).toHaveLength(0);
  });
});

// ── deleteFile ────────────────────────────────────────────────────────────────
describe("deleteFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes a file record by ID", async () => {
    mockPrisma.file.delete.mockResolvedValue(mockFile);
    await fileService.deleteFile("file001");
    expect(mockPrisma.file.delete).toHaveBeenCalledWith({ where: { id: "file001" } });
  });

  it("propagates Prisma P2025 (record not found) error", async () => {
    const err: any = new Error("Record not found");
    err.code = "P2025";
    mockPrisma.file.delete.mockRejectedValue(err);

    await expect(fileService.deleteFile("nonexistent")).rejects.toMatchObject({ code: "P2025" });
  });
});
