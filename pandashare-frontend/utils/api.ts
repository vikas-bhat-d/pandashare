// api.ts — PandaShare API service layer
// All HTTP calls to the backend go through here.

import { apiJson, apiBinary, apiDownload, ApiError } from "./apiClient";

// ──────────────────────────────────────
// Types
// ──────────────────────────────────────

export interface RoomMetadata {
  id: string;
  name: string;
  mode: "password" | "public";
  salt?: string | null;    // base64
  baseIV?: string | null;  // base64
  createdAt: string;
  expiresAt: string;
  files: FileMetadata[]; // empty for password rooms until unlocked via getRoomFiles
}

export interface FileMetadata {
  id: string;
  roomId: string;
  fileName: string;
  totalChunks: number;
  size: string; // stringified BigInt from backend
  uploadedAt: string;
  isComplete: boolean;
  isMultipart: boolean;  // true = stored as single S3 object
  chunkSize: number;     // plaintext chunk size used during encryption
}

// ──────────────────────────────────────
// Room API
// ──────────────────────────────────────

export async function createRoom(data: {
  name: string;
  mode: "password" | "public";
  salt?: string;
  baseIV?: string;
  verifier?: string; // HMAC-SHA256(name|password) hex — required for password rooms
  expiresInHours?: number;
}): Promise<RoomMetadata> {
  return apiJson<RoomMetadata>("/api/rooms", {
    method: "POST",
    body: JSON.stringify(data),
  });
}

export async function getRoom(nameOrId: string): Promise<RoomMetadata | null> {
  try {
    return await apiJson<RoomMetadata>(`/api/rooms/${encodeURIComponent(nameOrId)}`);
  } catch (err) {
    // 404 means room not found — that's expected for new rooms
    if (err instanceof ApiError && err.status === 404) {
      return null;
    }
    throw err;
  }
}

/**
 * Fetch the file listing for a password-protected room.
 * Requires the verifier (HMAC-SHA256(roomName|password)) which is sent
 * as the x-room-verifier header. Returns null if the verifier is wrong (401).
 */
export async function getRoomFiles(
  nameOrId: string,
  verifier: string
): Promise<FileMetadata[] | null> {
  try {
    const result = await apiJson<{ files: FileMetadata[] }>(
      `/api/rooms/${encodeURIComponent(nameOrId)}/files`,
      {
        headers: { "x-room-verifier": verifier },
      }
    );
    return result.files;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      return null; // Wrong password
    }
    throw err;
  }
}

export async function updateRoomExpiry(id: string, hours: number): Promise<{ expiresAt: string }> {
  return apiJson<{ expiresAt: string }>(`/api/rooms/${encodeURIComponent(id)}/expiry`, {
    method: "PATCH",
    body: JSON.stringify({ hours }),
  });
}

// ──────────────────────────────────────
// Upload API
// ──────────────────────────────────────

export async function uploadChunk(
  roomId: string,
  fileId: string,
  chunkIndex: number,
  chunk: ArrayBuffer
): Promise<void> {
  await apiBinary(`/api/upload/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}/${chunkIndex}`, chunk);
}

/**
 * Request presigned S3 PUT URLs for every encrypted chunk of a password-mode file.
 * The browser PUTs each encrypted chunk directly to S3 — Node never sees the data.
 * Returns one URL per chunk; url[i] is the presigned PUT for encrypted chunk i.
 */
export async function getEncryptedUploadPresignedUrls(
  roomId: string,
  fileId: string,
  fileName: string,
  size: number,
  totalChunks: number
): Promise<{ urls: string[] }> {
  return apiJson<{ urls: string[] }>("/api/upload/encrypted/presign", {
    method: "POST",
    body: JSON.stringify({ roomId, fileId, fileName, size, totalChunks }),
  });
}

/**
 * Request a presigned S3 PUT URL for a public file.
 * The browser will PUT the file bytes directly to S3 using this URL.
 */
export async function getPublicUploadPresignedUrl(
  roomId: string,
  fileId: string,
  fileName: string,
  size: number
): Promise<{ url: string }> {
  return apiJson<{ url: string }>("/api/public-upload/presign", {
    method: "POST",
    body: JSON.stringify({ roomId, fileId, fileName, size }),
  });
}

/**
 * Notify the backend that the presigned S3 PUT completed.
 * This creates the file metadata record in the database.
 */
export async function completePublicUpload(
  roomId: string,
  fileId: string,
  fileName: string,
  size: number
): Promise<void> {
  await apiJson("/api/public-upload/complete", {
    method: "POST",
    body: JSON.stringify({ roomId, fileId, fileName, size }),
  });
}

export async function completeUpload(
  roomId: string,
  fileId: string,
  data: { fileName: string; totalChunks: number; size: number }
): Promise<void> {
  await apiJson(`/api/complete/${encodeURIComponent(roomId)}`, {
    method: "POST",
    body: JSON.stringify({ fileId, ...data }),
  });
}

/**
 * Initiate an S3 multipart upload for an encrypted file.
 * Returns one presigned UploadPart URL per encrypted part and the S3 uploadId.
 * The browser PUTs each encrypted part directly to S3 and captures the ETag
 * from the response header — no data passes through Node.
 */
export async function initiateMultipartUpload(
  roomId: string,
  fileId: string,
  fileName: string,
  size: number,
  totalParts: number,
  chunkSize: number
): Promise<{ uploadId: string; urls: string[] }> {
  return apiJson<{ uploadId: string; urls: string[] }>("/api/upload/multipart/initiate", {
    method: "POST",
    body: JSON.stringify({ roomId, fileId, fileName, size, totalParts, chunkSize }),
  });
}

/**
 * Complete the S3 multipart upload and save metadata to the database.
 * parts = [{ PartNumber, ETag }] captured by the browser from each UploadPart response.
 */
export async function completeMultipartUpload(
  roomId: string,
  fileId: string,
  fileName: string,
  size: number,
  totalParts: number,
  chunkSize: number,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>
): Promise<void> {
  await apiJson("/api/upload/multipart/complete", {
    method: "POST",
    body: JSON.stringify({ roomId, fileId, fileName, size, totalParts, chunkSize, uploadId, parts }),
  });
}

/**
 * Abort an in-progress S3 multipart upload.
 * Called on user cancellation to free orphaned parts and stop S3 billing for them.
 * Fire-and-forget safe — failure is swallowed so it never surfaces to the user.
 */
export async function abortMultipartUpload(
  roomId: string,
  fileId: string,
  uploadId: string
): Promise<void> {
  try {
    await apiJson("/api/upload/multipart/abort", {
      method: "POST",
      body: JSON.stringify({ roomId, fileId, uploadId }),
    });
  } catch {
    // best-effort — S3 also expires incomplete multipart uploads via lifecycle rules
  }
}

// ──────────────────────────────────────
// Download API
// ──────────────────────────────────────

export async function downloadChunk(
  roomId: string,
  fileId: string,
  chunkIndex: number
): Promise<ArrayBuffer> {
  return apiDownload(`/api/download/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}/${chunkIndex}`);
}

/**
 * Request presigned S3 GET URLs for every encrypted chunk of a password-mode file.
 * The browser fetches chunks directly from S3 — Node never sees the download traffic
 * and the API rate limiter is not hit on a per-chunk basis.
 * Returns one URL per chunk; url[i] is the presigned GET for encrypted chunk i.
 */
export async function getEncryptedDownloadPresignedUrls(
  roomId: string,
  fileId: string,
  totalChunks: number
): Promise<{ urls: string[] }> {
  return apiJson<{ urls: string[] }>("/api/download/encrypted/presign", {
    method: "POST",
    body: JSON.stringify({ roomId, fileId, totalChunks }),
  });
}

export async function getPresignedUrl(
  roomId: string,
  fileId: string
): Promise<string> {
  const { url } = await apiJson<{ url: string }>(`/api/files/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}/url`);
  return url;
}

/**
 * Request a single presigned GET URL for a multipart-uploaded encrypted file.
 * Returns the URL plus the chunk count and chunk size needed to reconstruct IVs.
 */
export async function getMultipartDownloadPresignedUrl(
  roomId: string,
  fileId: string
): Promise<{ url: string; totalChunks: number; chunkSize: number }> {
  return apiJson<{ url: string; totalChunks: number; chunkSize: number }>(
    "/api/download/multipart/presign",
    { method: "POST", body: JSON.stringify({ roomId, fileId }) }
  );
}

export async function deleteFile(
  roomId: string,
  fileId: string
): Promise<void> {
  await apiJson(`/api/files/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
  });
}

// ──────────────────────────────────────
// Encoding utilities
// ──────────────────────────────────────

export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
  let binary = '';
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
  const binary_string = window.atob(base64);
  const len = binary_string.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binary_string.charCodeAt(i);
  }
  return bytes;
}
