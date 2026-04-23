import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import app from "../../app";

// ── Mock the service layer so no DB/S3 is touched ───────────────────────────
vi.mock("../../services/room.service");

import * as roomService from "../../services/room.service";

// ── Shared fixtures ──────────────────────────────────────────────────────────
const DEVICE_ID = "a1b2c3d4-0000-4000-8000-000000000001";

const futureDate = new Date(Date.now() + 24 * 60 * 60 * 1000);

const mockPublicRoom = {
  id: "clpublic123",
  name: "public-room",
  mode: "public" as const,
  salt: null,
  baseIV: null,
  verifier: null,
  createdAt: new Date("2026-04-01T00:00:00Z"),
  expiresAt: futureDate,
};

const mockPasswordRoom = {
  id: "clpassword123",
  name: "password-room",
  mode: "password" as const,
  salt: "base64salt==",
  baseIV: "base64iv==",
  verifier: "a".repeat(64),
  createdAt: new Date("2026-04-01T00:00:00Z"),
  expiresAt: futureDate,
};

const mockFile = {
  id: "file001",
  roomId: "clpublic123",
  fileName: "hello.txt",
  totalChunks: 1,
  size: BigInt(1024).toString(), // serialized
  uploadedAt: new Date("2026-04-01T00:00:00Z"),
  isComplete: true,
  isMultipart: false,
  chunkSize: 0,
};

// ── POST /api/rooms ──────────────────────────────────────────────────────────
describe("POST /api/rooms", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates a public room and returns 201", async () => {
    vi.mocked(roomService.createRoom).mockResolvedValue(mockPublicRoom as any);

    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "public-room", mode: "public" });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe("clpublic123");
    expect(res.body.name).toBe("public-room");
    expect(res.body.mode).toBe("public");
    expect(res.body.verifier).toBeUndefined(); // never exposed
  });

  it("creates a password room with verifier", async () => {
    vi.mocked(roomService.createRoom).mockResolvedValue(mockPasswordRoom as any);

    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({
        name: "password-room",
        mode: "password",
        salt: "base64salt==",
        baseIV: "base64iv==",
        verifier: "a".repeat(64),
      });

    expect(res.status).toBe(201);
    expect(res.body.verifier).toBeUndefined();
    expect(res.body.salt).toBe("base64salt==");
  });

  it("returns 400 when name is missing", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ mode: "public" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Validation failed");
  });

  it("returns 400 when name contains invalid characters", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "bad name!", mode: "public" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when name exceeds 100 characters", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "a".repeat(101), mode: "public" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when mode is invalid", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "valid-name", mode: "private" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when password mode has no verifier", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "password-room", mode: "password" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verifier/i);
  });

  it("returns 400 when verifier is not 64-char hex", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "password-room", mode: "password", verifier: "not-hex" });

    expect(res.status).toBe(400);
  });

  it("returns 400 when expiresInHours is out of range (> 48)", async () => {
    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "test-room", mode: "public", expiresInHours: 100 });

    expect(res.status).toBe(400);
  });

  it("returns 409 when room name already exists", async () => {
    const err: any = new Error("Unique constraint failed");
    err.code = "P2002";
    vi.mocked(roomService.createRoom).mockRejectedValue(err);

    const res = await request(app)
      .post("/api/rooms")
      .set("x-device-id", DEVICE_ID)
      .send({ name: "public-room", mode: "public" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Resource already exists");
  });
});

// ── GET /api/rooms/:nameOrId ─────────────────────────────────────────────────
describe("GET /api/rooms/:nameOrId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a public room with files by ID", async () => {
    vi.mocked(roomService.getRoom).mockResolvedValue(mockPublicRoom as any);
    vi.mocked(roomService.getFilesIfAuthorized).mockResolvedValue({
      authorized: true,
      files: [mockFile] as any,
    });

    const res = await request(app)
      .get("/api/rooms/clpublic123")
      .set("x-device-id", DEVICE_ID);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe("clpublic123");
    expect(res.body.files).toHaveLength(1);
    expect(res.body.files[0].id).toBe("file001");
  });

  it("returns a password room with empty files array (no auth)", async () => {
    vi.mocked(roomService.getRoom).mockResolvedValue(mockPasswordRoom as any);

    const res = await request(app)
      .get("/api/rooms/password-room")
      .set("x-device-id", DEVICE_ID);

    expect(res.status).toBe(200);
    expect(res.body.files).toEqual([]);
    expect(res.body.salt).toBe("base64salt==");
  });

  it("returns 404 when room is not found", async () => {
    vi.mocked(roomService.getRoom).mockResolvedValue(null);

    const res = await request(app)
      .get("/api/rooms/nonexistent")
      .set("x-device-id", DEVICE_ID);

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it("URL-decodes the room name parameter", async () => {
    vi.mocked(roomService.getRoom).mockResolvedValue(mockPublicRoom as any);
    vi.mocked(roomService.getFilesIfAuthorized).mockResolvedValue({
      authorized: true,
      files: [],
    });

    await request(app)
      .get("/api/rooms/public-room")
      .set("x-device-id", DEVICE_ID);

    expect(roomService.getRoom).toHaveBeenCalledWith("public-room");
  });
});

// ── GET /api/rooms/:nameOrId/files ───────────────────────────────────────────
describe("GET /api/rooms/:nameOrId/files", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns files when verifier is correct", async () => {
    vi.mocked(roomService.getFilesIfAuthorized).mockResolvedValue({
      authorized: true,
      files: [mockFile] as any,
    });

    const res = await request(app)
      .get("/api/rooms/password-room/files")
      .set("x-device-id", DEVICE_ID)
      .set("x-room-verifier", "a".repeat(64));

    expect(res.status).toBe(200);
    expect(res.body.files).toHaveLength(1);
  });

  it("returns 401 when verifier is wrong", async () => {
    vi.mocked(roomService.getFilesIfAuthorized).mockResolvedValue({
      authorized: false,
    });

    const res = await request(app)
      .get("/api/rooms/password-room/files")
      .set("x-device-id", DEVICE_ID)
      .set("x-room-verifier", "b".repeat(64));

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/unauthorized/i);
  });

  it("returns 401 when verifier header is missing", async () => {
    vi.mocked(roomService.getFilesIfAuthorized).mockResolvedValue({
      authorized: false,
    });

    const res = await request(app)
      .get("/api/rooms/password-room/files")
      .set("x-device-id", DEVICE_ID);

    expect(res.status).toBe(401);
  });

  it("serializes BigInt size as string", async () => {
    vi.mocked(roomService.getFilesIfAuthorized).mockResolvedValue({
      authorized: true,
      files: [{ ...mockFile, size: BigInt(2048) }] as any,
    });

    const res = await request(app)
      .get("/api/rooms/password-room/files")
      .set("x-device-id", DEVICE_ID)
      .set("x-room-verifier", "a".repeat(64));

    expect(res.status).toBe(200);
    expect(typeof res.body.files[0].size).toBe("string");
    expect(res.body.files[0].size).toBe("2048");
  });
});

// ── PATCH /api/rooms/:id/expiry ──────────────────────────────────────────────
describe("PATCH /api/rooms/:id/expiry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates expiry and returns new expiresAt", async () => {
    const newExpiry = new Date(Date.now() + 12 * 60 * 60 * 1000);
    vi.mocked(roomService.updateExpiry).mockResolvedValue({
      ...mockPublicRoom,
      expiresAt: newExpiry,
    } as any);

    const res = await request(app)
      .patch("/api/rooms/clpublic123/expiry")
      .set("x-device-id", DEVICE_ID)
      .send({ hours: 12 });

    expect(res.status).toBe(200);
    expect(res.body.expiresAt).toBeDefined();
  });

  it("returns 400 when hours < 1", async () => {
    const res = await request(app)
      .patch("/api/rooms/clpublic123/expiry")
      .set("x-device-id", DEVICE_ID)
      .send({ hours: 0 });

    expect(res.status).toBe(400);
  });

  it("returns 400 when hours > 48", async () => {
    const res = await request(app)
      .patch("/api/rooms/clpublic123/expiry")
      .set("x-device-id", DEVICE_ID)
      .send({ hours: 49 });

    expect(res.status).toBe(400);
  });

  it("returns 400 when hours is not a number", async () => {
    const res = await request(app)
      .patch("/api/rooms/clpublic123/expiry")
      .set("x-device-id", DEVICE_ID)
      .send({ hours: "twelve" });

    expect(res.status).toBe(400);
  });
});

// ── GET /health ──────────────────────────────────────────────────────────────
describe("GET /health", () => {
  it("returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.timestamp).toBeDefined();
  });
});
