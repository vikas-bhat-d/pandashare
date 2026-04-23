import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";
import app from "../../app";

// ── Mock service and storage layers ──────────────────────────────────────────
vi.mock("../../services/storage.service");
vi.mock("../../services/file.service");

import * as storage from "../../services/storage.service";
import * as fileService from "../../services/file.service";

const DEVICE_ID = "a1b2c3d4-0000-4000-8000-000000000002";
const CHUNK_SIZE = 20 * 1024 * 1024; // must match route constant

const mockFile = {
  id: "file001",
  roomId: "room001",
  fileName: "encrypted.bin",
  totalChunks: 3,
  size: BigInt(30 * 1024 * 1024),
  uploadedAt: new Date(),
  isComplete: true,
  isMultipart: false,
  chunkSize: 0,
};

// ── POST /api/upload/:roomId/:fileId/:chunkIndex ──────────────────────────────
describe("POST /api/upload/:roomId/:fileId/:chunkIndex", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uploads a binary chunk and returns ok with chunkIndex", async () => {
    vi.mocked(storage.uploadChunk).mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/upload/room001/file001/0")
      .set("x-device-id", DEVICE_ID)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("encrypted-data-here"));

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.chunkIndex).toBe(0);
    expect(storage.uploadChunk).toHaveBeenCalledWith("room001", "file001", 0, expect.any(Buffer));
  });

  it("returns 400 for NaN chunk index", async () => {
    const res = await request(app)
      .post("/api/upload/room001/file001/abc")
      .set("x-device-id", DEVICE_ID)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("data"));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/invalid chunk index/i);
  });

  it("returns 400 for negative chunk index", async () => {
    const res = await request(app)
      .post("/api/upload/room001/file001/-1")
      .set("x-device-id", DEVICE_ID)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.from("data"));

    expect(res.status).toBe(400);
  });

  it("returns 400 when body is empty", async () => {
    const res = await request(app)
      .post("/api/upload/room001/file001/0")
      .set("x-device-id", DEVICE_ID)
      .set("Content-Type", "application/octet-stream")
      .send(Buffer.alloc(0));

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/empty/i);
  });
});

// ── POST /api/upload/encrypted/presign ───────────────────────────────────────
describe("POST /api/upload/encrypted/presign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns presigned URLs for valid request", async () => {
    const presignUrls = ["https://s3.example.com/url-0", "https://s3.example.com/url-1"];
    vi.mocked(storage.getPresignedChunkUploadUrls).mockResolvedValue(presignUrls);

    const size = 2 * CHUNK_SIZE; // 40 MB → 2 chunks
    const res = await request(app)
      .post("/api/upload/encrypted/presign")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", fileName: "test.bin", size, totalChunks: 2 });

    expect(res.status).toBe(200);
    expect(res.body.urls).toEqual(presignUrls);
    expect(storage.getPresignedChunkUploadUrls).toHaveBeenCalledWith("room001", "file001", 2);
  });

  it("returns 400 when totalChunks does not match file size", async () => {
    const size = 2 * CHUNK_SIZE; // expects 2 chunks
    const res = await request(app)
      .post("/api/upload/encrypted/presign")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", fileName: "test.bin", size, totalChunks: 5 });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
  });

  it("returns 400 when size exceeds 2 GB", async () => {
    const res = await request(app)
      .post("/api/upload/encrypted/presign")
      .set("x-device-id", DEVICE_ID)
      .send({
        roomId: "r",
        fileId: "f",
        fileName: "big.bin",
        size: 3 * 1024 * 1024 * 1024,
        totalChunks: 1,
      });

    expect(res.status).toBe(400);
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await request(app)
      .post("/api/upload/encrypted/presign")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001" });

    expect(res.status).toBe(400);
  });
});

// ── POST /api/public-upload/presign ──────────────────────────────────────────
describe("POST /api/public-upload/presign", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a presigned upload URL", async () => {
    vi.mocked(storage.getPresignedUploadUrl).mockResolvedValue("https://s3.example.com/put-url");

    const res = await request(app)
      .post("/api/public-upload/presign")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", fileName: "photo.jpg", size: 1024 });

    expect(res.status).toBe(200);
    expect(res.body.url).toBe("https://s3.example.com/put-url");
  });

  it("returns 400 when roomId is missing", async () => {
    const res = await request(app)
      .post("/api/public-upload/presign")
      .set("x-device-id", DEVICE_ID)
      .send({ fileId: "file001", fileName: "photo.jpg", size: 1024 });

    expect(res.status).toBe(400);
  });
});

// ── POST /api/public-upload/complete ─────────────────────────────────────────
describe("POST /api/public-upload/complete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("saves file metadata and returns ok", async () => {
    vi.mocked(fileService.completeUpload).mockResolvedValue({
      ...mockFile,
      size: BigInt(1024),
    } as any);

    const res = await request(app)
      .post("/api/public-upload/complete")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", fileName: "photo.jpg", size: 1024 });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.file.size).toBe("string");
  });
});

// ── POST /api/complete/:roomId ────────────────────────────────────────────────
describe("POST /api/complete/:roomId", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes a chunked upload and returns file metadata", async () => {
    vi.mocked(fileService.completeUpload).mockResolvedValue(mockFile as any);

    const res = await request(app)
      .post("/api/complete/room001")
      .set("x-device-id", DEVICE_ID)
      .send({
        fileId: "file001",
        fileName: "encrypted.bin",
        totalChunks: 3,
        size: 30 * 1024 * 1024,
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.file.id).toBe("file001");
    expect(fileService.completeUpload).toHaveBeenCalledWith(
      expect.objectContaining({ roomId: "room001", fileId: "file001", totalChunks: 3 })
    );
  });

  it("returns 400 when fileId is missing", async () => {
    const res = await request(app)
      .post("/api/complete/room001")
      .set("x-device-id", DEVICE_ID)
      .send({ fileName: "test.bin", totalChunks: 1, size: 1024 });

    expect(res.status).toBe(400);
  });
});

// ── POST /api/upload/multipart/initiate ──────────────────────────────────────
describe("POST /api/upload/multipart/initiate", () => {
  beforeEach(() => vi.clearAllMocks());

  it("initiates multipart upload and returns uploadId and URLs", async () => {
    vi.mocked(storage.initiateMultipartUpload).mockResolvedValue({
      uploadId: "upload-id-abc",
      urls: ["https://s3.example.com/part-1", "https://s3.example.com/part-2"],
    });

    const chunkSize = 10 * 1024 * 1024; // 10 MB
    const size = 2 * chunkSize; // 20 MB → 2 parts
    const res = await request(app)
      .post("/api/upload/multipart/initiate")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", fileName: "large.bin", size, totalParts: 2, chunkSize });

    expect(res.status).toBe(200);
    expect(res.body.uploadId).toBe("upload-id-abc");
    expect(res.body.urls).toHaveLength(2);
  });

  it("returns 400 when totalParts does not match size / chunkSize", async () => {
    const chunkSize = 10 * 1024 * 1024;
    const size = 2 * chunkSize;
    const res = await request(app)
      .post("/api/upload/multipart/initiate")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", fileName: "large.bin", size, totalParts: 5, chunkSize });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match/i);
  });
});

// ── POST /api/upload/multipart/complete ──────────────────────────────────────
describe("POST /api/upload/multipart/complete", () => {
  beforeEach(() => vi.clearAllMocks());

  it("completes multipart upload and returns file", async () => {
    vi.mocked(storage.completeMultipartUpload).mockResolvedValue(undefined);
    vi.mocked(fileService.completeUpload).mockResolvedValue({
      ...mockFile,
      isMultipart: true,
      chunkSize: 10 * 1024 * 1024,
    } as any);

    const res = await request(app)
      .post("/api/upload/multipart/complete")
      .set("x-device-id", DEVICE_ID)
      .send({
        roomId: "room001",
        fileId: "file001",
        fileName: "large.bin",
        size: 20 * 1024 * 1024,
        totalParts: 2,
        chunkSize: 10 * 1024 * 1024,
        uploadId: "upload-id-abc",
        parts: [
          { PartNumber: 1, ETag: '"etag-1"' },
          { PartNumber: 2, ETag: '"etag-2"' },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(storage.completeMultipartUpload).toHaveBeenCalledWith(
      "room001",
      "file001",
      "upload-id-abc",
      expect.arrayContaining([{ PartNumber: 1, ETag: '"etag-1"' }])
    );
  });

  it("returns 400 when parts array is empty", async () => {
    const res = await request(app)
      .post("/api/upload/multipart/complete")
      .set("x-device-id", DEVICE_ID)
      .send({
        roomId: "room001",
        fileId: "file001",
        fileName: "large.bin",
        size: 10 * 1024 * 1024,
        totalParts: 1,
        chunkSize: 10 * 1024 * 1024,
        uploadId: "upload-id-abc",
        parts: [],
      });

    expect(res.status).toBe(400);
  });
});

// ── POST /api/upload/multipart/abort ─────────────────────────────────────────
describe("POST /api/upload/multipart/abort", () => {
  beforeEach(() => vi.clearAllMocks());

  it("aborts a multipart upload and returns ok", async () => {
    vi.mocked(storage.abortMultipartUpload).mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/upload/multipart/abort")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001", uploadId: "upload-id-abc" });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(storage.abortMultipartUpload).toHaveBeenCalledWith("room001", "file001", "upload-id-abc");
  });

  it("returns 400 when uploadId is missing", async () => {
    const res = await request(app)
      .post("/api/upload/multipart/abort")
      .set("x-device-id", DEVICE_ID)
      .send({ roomId: "room001", fileId: "file001" });

    expect(res.status).toBe(400);
  });
});
