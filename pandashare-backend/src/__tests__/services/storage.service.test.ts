import { describe, it, expect, vi, beforeEach } from "vitest";
import { Readable } from "stream";

// ── Hoist S3 mocks before any imports ────────────────────────────────────────
const { mockSend, mockGetSignedUrl } = vi.hoisted(() => ({
  mockSend: vi.fn(),
  mockGetSignedUrl: vi.fn().mockResolvedValue("https://s3.example.com/presigned"),
}));

vi.mock("@aws-sdk/client-s3", () => ({
  // Must be regular functions — arrow functions cannot be constructors
  S3Client: vi.fn(function () { return { send: mockSend }; }),
  PutObjectCommand: vi.fn(function (i: any) { return { _cmd: "PutObject", input: i }; }),
  GetObjectCommand: vi.fn(function (i: any) { return { _cmd: "GetObject", input: i }; }),
  DeleteObjectCommand: vi.fn(function (i: any) { return { _cmd: "DeleteObject", input: i }; }),
  DeleteObjectsCommand: vi.fn(function (i: any) { return { _cmd: "DeleteObjects", input: i }; }),
  CreateMultipartUploadCommand: vi.fn(function (i: any) { return { _cmd: "CreateMultipartUpload", input: i }; }),
  UploadPartCommand: vi.fn(function (i: any) { return { _cmd: "UploadPart", input: i }; }),
  CompleteMultipartUploadCommand: vi.fn(function (i: any) { return { _cmd: "CompleteMultipartUpload", input: i }; }),
  AbortMultipartUploadCommand: vi.fn(function (i: any) { return { _cmd: "AbortMultipartUpload", input: i }; }),
  PutBucketLifecycleConfigurationCommand: vi.fn(function (i: any) { return { _cmd: "PutBucketLifecycle", input: i }; }),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: mockGetSignedUrl,
}));

import * as storage from "../../services/storage.service";

const ROOM_ID = "room001";
const FILE_ID = "file001";
const BUCKET = "test-bucket"; // matches setup.ts

// ── uploadChunk ───────────────────────────────────────────────────────────────
describe("uploadChunk", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends a PutObjectCommand with the correct key and body", async () => {
    mockSend.mockResolvedValue({});
    const body = Buffer.from("encrypted-data");

    await storage.uploadChunk(ROOM_ID, FILE_ID, 0, body);

    expect(mockSend).toHaveBeenCalledOnce();
    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("PutObject");
    expect(cmd.input.Key).toBe(`encrypted/${ROOM_ID}/${FILE_ID}.0`);
    expect(cmd.input.Body).toBe(body);
    expect(cmd.input.Bucket).toBe(BUCKET);
  });

  it("uses the correct chunk key for chunk index > 0", async () => {
    mockSend.mockResolvedValue({});
    await storage.uploadChunk(ROOM_ID, FILE_ID, 7, Buffer.from("data"));

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd.input.Key).toBe(`encrypted/${ROOM_ID}/${FILE_ID}.7`);
  });
});

// ── getPresignedChunkUploadUrls ────────────────────────────────────────────────
describe("getPresignedChunkUploadUrls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns one presigned URL per chunk", async () => {
    mockGetSignedUrl
      .mockResolvedValueOnce("https://s3.example.com/chunk-0")
      .mockResolvedValueOnce("https://s3.example.com/chunk-1")
      .mockResolvedValueOnce("https://s3.example.com/chunk-2");

    const urls = await storage.getPresignedChunkUploadUrls(ROOM_ID, FILE_ID, 3);

    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe("https://s3.example.com/chunk-0");
    expect(urls[2]).toBe("https://s3.example.com/chunk-2");
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(3);
  });
});

// ── getPresignedUploadUrl (public) ────────────────────────────────────────────
describe("getPresignedUploadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses the public/ key prefix", async () => {
    mockGetSignedUrl.mockResolvedValue("https://s3.example.com/public-put");

    const url = await storage.getPresignedUploadUrl(ROOM_ID, FILE_ID);

    expect(url).toBe("https://s3.example.com/public-put");
    const [, cmd] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.input.Key).toBe(`public/${ROOM_ID}/${FILE_ID}`);
  });
});

// ── downloadChunk ─────────────────────────────────────────────────────────────
describe("downloadChunk", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns stream and contentLength from S3 GetObject", async () => {
    const fakeStream = Readable.from(Buffer.from("chunk-data"));
    mockSend.mockResolvedValue({ Body: fakeStream, ContentLength: 10 });

    const { stream, contentLength } = await storage.downloadChunk(ROOM_ID, FILE_ID, 2);

    expect(contentLength).toBe(10);
    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("GetObject");
    expect(cmd.input.Key).toBe(`encrypted/${ROOM_ID}/${FILE_ID}.2`);

    // Drain the stream to ensure it is readable
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe("chunk-data");
  });
});

// ── getPresignedChunkDownloadUrls ─────────────────────────────────────────────
describe("getPresignedChunkDownloadUrls", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns one presigned GET URL per chunk", async () => {
    mockGetSignedUrl.mockResolvedValue("https://s3.example.com/get-url");

    const urls = await storage.getPresignedChunkDownloadUrls(ROOM_ID, FILE_ID, 4);

    expect(urls).toHaveLength(4);
    expect(mockGetSignedUrl).toHaveBeenCalledTimes(4);
    const [, cmd] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.input.Key).toBe(`encrypted/${ROOM_ID}/${FILE_ID}.0`);
  });
});

// ── getPresignedDownloadUrl (public) ──────────────────────────────────────────
describe("getPresignedDownloadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("generates a presigned GET URL with Content-Disposition for the file name", async () => {
    mockGetSignedUrl.mockResolvedValue("https://s3.example.com/download");

    const url = await storage.getPresignedDownloadUrl(ROOM_ID, FILE_ID, "report.pdf");

    expect(url).toBe("https://s3.example.com/download");
    const [, cmd] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.input.Key).toBe(`public/${ROOM_ID}/${FILE_ID}`);
    expect(cmd.input.ResponseContentDisposition).toContain("attachment");
    expect(cmd.input.ResponseContentDisposition).toContain("report.pdf");
  });

  it("still generates URL without Content-Disposition when no filename given", async () => {
    mockGetSignedUrl.mockResolvedValue("https://s3.example.com/download");
    await storage.getPresignedDownloadUrl(ROOM_ID, FILE_ID);

    const [, cmd] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.input.ResponseContentDisposition).toBe("attachment");
  });
});

// ── initiateMultipartUpload ───────────────────────────────────────────────────
describe("initiateMultipartUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates an S3 multipart upload and returns uploadId + part URLs", async () => {
    mockSend.mockResolvedValue({ UploadId: "mp-upload-id" });
    mockGetSignedUrl.mockResolvedValue("https://s3.example.com/part");

    const { uploadId, urls } = await storage.initiateMultipartUpload(ROOM_ID, FILE_ID, 3);

    expect(uploadId).toBe("mp-upload-id");
    expect(urls).toHaveLength(3);
    expect(mockSend).toHaveBeenCalledOnce();
    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("CreateMultipartUpload");
    expect(cmd.input.Key).toBe(`multipart/${ROOM_ID}/${FILE_ID}`);
  });

  it("throws if S3 does not return an UploadId", async () => {
    mockSend.mockResolvedValue({ UploadId: undefined });

    await expect(storage.initiateMultipartUpload(ROOM_ID, FILE_ID, 1)).rejects.toThrow(
      "S3 did not return an UploadId"
    );
  });
});

// ── completeMultipartUpload ───────────────────────────────────────────────────
describe("completeMultipartUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends CompleteMultipartUpload with all parts", async () => {
    mockSend.mockResolvedValue({});
    const parts = [
      { PartNumber: 1, ETag: '"etag-1"' },
      { PartNumber: 2, ETag: '"etag-2"' },
    ];

    await storage.completeMultipartUpload(ROOM_ID, FILE_ID, "mp-upload-id", parts);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("CompleteMultipartUpload");
    expect(cmd.input.UploadId).toBe("mp-upload-id");
    expect(cmd.input.MultipartUpload.Parts).toEqual(parts);
    expect(cmd.input.Key).toBe(`multipart/${ROOM_ID}/${FILE_ID}`);
  });
});

// ── abortMultipartUpload ──────────────────────────────────────────────────────
describe("abortMultipartUpload", () => {
  beforeEach(() => vi.clearAllMocks());

  it("sends AbortMultipartUpload and swallows errors", async () => {
    mockSend.mockRejectedValue(new Error("NoSuchUpload"));

    // Should not throw — abort is best-effort
    await expect(
      storage.abortMultipartUpload(ROOM_ID, FILE_ID, "mp-upload-id")
    ).resolves.toBeUndefined();

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("AbortMultipartUpload");
  });
});

// ── getPresignedMultipartDownloadUrl ──────────────────────────────────────────
describe("getPresignedMultipartDownloadUrl", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns a presigned GET URL for the multipart object", async () => {
    mockGetSignedUrl.mockResolvedValue("https://s3.example.com/multipart-get");

    const url = await storage.getPresignedMultipartDownloadUrl(ROOM_ID, FILE_ID);

    expect(url).toBe("https://s3.example.com/multipart-get");
    const [, cmd] = mockGetSignedUrl.mock.calls[0];
    expect(cmd.input.Key).toBe(`multipart/${ROOM_ID}/${FILE_ID}`);
  });
});

// ── deleteMultipartObject ─────────────────────────────────────────────────────
describe("deleteMultipartObject", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the multipart S3 object", async () => {
    mockSend.mockResolvedValue({});

    await storage.deleteMultipartObject(ROOM_ID, FILE_ID);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("DeleteObject");
    expect(cmd.input.Key).toBe(`multipart/${ROOM_ID}/${FILE_ID}`);
  });
});

// ── deleteFileChunks ──────────────────────────────────────────────────────────
describe("deleteFileChunks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes all chunks using DeleteObjects", async () => {
    mockSend.mockResolvedValue({});

    await storage.deleteFileChunks(ROOM_ID, FILE_ID, 3);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("DeleteObjects");
    expect(cmd.input.Delete.Objects).toHaveLength(3);
    expect(cmd.input.Delete.Objects[0].Key).toBe(`encrypted/${ROOM_ID}/${FILE_ID}.0`);
    expect(cmd.input.Delete.Objects[2].Key).toBe(`encrypted/${ROOM_ID}/${FILE_ID}.2`);
  });

  it("batches in groups of 1000 when there are > 1000 chunks", async () => {
    mockSend.mockResolvedValue({});

    await storage.deleteFileChunks(ROOM_ID, FILE_ID, 1500);

    expect(mockSend).toHaveBeenCalledTimes(2);
    const firstBatch = mockSend.mock.calls[0][0].input.Delete.Objects;
    const secondBatch = mockSend.mock.calls[1][0].input.Delete.Objects;
    expect(firstBatch).toHaveLength(1000);
    expect(secondBatch).toHaveLength(500);
  });
});

// ── deletePublicFile ──────────────────────────────────────────────────────────
describe("deletePublicFile", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes the public S3 object", async () => {
    mockSend.mockResolvedValue({});

    await storage.deletePublicFile(ROOM_ID, FILE_ID);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("DeleteObject");
    expect(cmd.input.Key).toBe(`public/${ROOM_ID}/${FILE_ID}`);
  });
});

// ── deleteRoomS3Files ─────────────────────────────────────────────────────────
describe("deleteRoomS3Files", () => {
  beforeEach(() => vi.clearAllMocks());

  it("deletes multipart objects for isMultipart files", async () => {
    mockSend.mockResolvedValue({});
    const files = [{ id: "f1", totalChunks: 0, isMultipart: true }];

    await storage.deleteRoomS3Files(ROOM_ID, files);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("DeleteObjects");
    expect(cmd.input.Delete.Objects[0].Key).toBe(`multipart/${ROOM_ID}/f1`);
  });

  it("deletes per-chunk keys for chunked encrypted files", async () => {
    mockSend.mockResolvedValue({});
    const files = [{ id: "f2", totalChunks: 3, isMultipart: false }];

    await storage.deleteRoomS3Files(ROOM_ID, files);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd.input.Delete.Objects).toHaveLength(3);
    expect(cmd.input.Delete.Objects[0].Key).toBe(`encrypted/${ROOM_ID}/f2.0`);
  });

  it("deletes public key for files with totalChunks=0 and isMultipart=false", async () => {
    mockSend.mockResolvedValue({});
    const files = [{ id: "f3", totalChunks: 0, isMultipart: false }];

    await storage.deleteRoomS3Files(ROOM_ID, files);

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd.input.Delete.Objects[0].Key).toBe(`public/${ROOM_ID}/f3`);
  });

  it("handles a mix of file types in a single room", async () => {
    mockSend.mockResolvedValue({});
    const files = [
      { id: "m1", totalChunks: 0, isMultipart: true },   // multipart key
      { id: "c1", totalChunks: 2, isMultipart: false },  // 2 chunk keys
      { id: "p1", totalChunks: 0, isMultipart: false },  // public key
    ];

    await storage.deleteRoomS3Files(ROOM_ID, files);

    const [cmd] = mockSend.mock.calls[0];
    const keys = cmd.input.Delete.Objects.map((o: any) => o.Key);
    expect(keys).toContain(`multipart/${ROOM_ID}/m1`);
    expect(keys).toContain(`encrypted/${ROOM_ID}/c1.0`);
    expect(keys).toContain(`encrypted/${ROOM_ID}/c1.1`);
    expect(keys).toContain(`public/${ROOM_ID}/p1`);
    expect(keys).toHaveLength(4);
  });

  it("does nothing when files array is empty", async () => {
    await storage.deleteRoomS3Files(ROOM_ID, []);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("throws AggregateError when a batch delete fails", async () => {
    mockSend.mockRejectedValue(new Error("S3 error"));
    const files = [{ id: "f1", totalChunks: 0, isMultipart: true }];

    await expect(storage.deleteRoomS3Files(ROOM_ID, files)).rejects.toThrow(AggregateError);
  });
});

// ── ensureAbortIncompleteMultipartLifecycle ───────────────────────────────────
describe("ensureAbortIncompleteMultipartLifecycle", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is a no-op when SKIP_LIFECYCLE_RULE=true", async () => {
    process.env.SKIP_LIFECYCLE_RULE = "true";
    await storage.ensureAbortIncompleteMultipartLifecycle();
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("sends PutBucketLifecycleConfiguration when env is not set", async () => {
    delete process.env.SKIP_LIFECYCLE_RULE;
    mockSend.mockResolvedValue({});

    await storage.ensureAbortIncompleteMultipartLifecycle();

    const [cmd] = mockSend.mock.calls[0];
    expect(cmd._cmd).toBe("PutBucketLifecycle");
    const rule = cmd.input.LifecycleConfiguration.Rules[0];
    expect(rule.Status).toBe("Enabled");
    expect(rule.AbortIncompleteMultipartUpload.DaysAfterInitiation).toBe(1);

    // Restore for other tests
    process.env.SKIP_LIFECYCLE_RULE = "true";
  });
});
