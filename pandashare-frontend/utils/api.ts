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
    data,
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
    data: { hours },
  });
}

// ──────────────────────────────────────
// Text Snippet API
// ──────────────────────────────────────

export interface SnippetMetadata {
  id: string;
  name: string;
  mode: "password" | "public";
  salt?: string | null;
  baseIV?: string | null;
  createdAt: string;
  expiresAt: string;
}

export async function createSnippet(data: {
  name: string;
  mode: "password" | "public";
  content: string; // plaintext for public; base64 ciphertext for password
  salt?: string;
  baseIV?: string;
  verifier?: string;
  expiresInDays?: number;
}): Promise<SnippetMetadata> {
  return apiJson<SnippetMetadata>("/api/snippets", {
    method: "POST",
    data,
  });
}

export async function getSnippet(nameOrId: string): Promise<SnippetMetadata | null> {
  try {
    return await apiJson<SnippetMetadata>(`/api/snippets/${encodeURIComponent(nameOrId)}`);
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return null;
    throw err;
  }
}

export async function getSnippetContent(
  nameOrId: string,
  verifier?: string
): Promise<string | null> {
  try {
    const result = await apiJson<{ content: string }>(
      `/api/snippets/${encodeURIComponent(nameOrId)}/content`,
      verifier ? { headers: { "x-snippet-verifier": verifier } } : undefined
    );
    return result.content;
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    throw err;
  }
}

export async function updateSnippetExpiry(id: string, days: number): Promise<{ expiresAt: string }> {
  return apiJson<{ expiresAt: string }>(`/api/snippets/${encodeURIComponent(id)}/expiry`, {
    method: "PATCH",
    data: { days },
  });
}

export async function updateSnippetContent(
  id: string,
  content: string,
  verifier?: string,
  salt?: string,
  baseIV?: string
): Promise<SnippetMetadata> {
  return apiJson<SnippetMetadata>(`/api/snippets/${encodeURIComponent(id)}/content`, {
    method: "PATCH",
    data: { content, salt, baseIV },
    ...(verifier ? { headers: { "x-snippet-verifier": verifier } } : {}),
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
    data: { roomId, fileId, fileName, size, totalChunks },
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
    data: { roomId, fileId, fileName, size },
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
    data: { roomId, fileId, fileName, size },
  });
}

export async function completeUpload(
  roomId: string,
  fileId: string,
  data: { fileName: string; totalChunks: number; size: number }
): Promise<void> {
  await apiJson(`/api/complete/${encodeURIComponent(roomId)}`, {
    method: "POST",
    data: { fileId, ...data },
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
    data: { roomId, fileId, fileName, size, totalParts, chunkSize },
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
    data: { roomId, fileId, fileName, size, totalParts, chunkSize, uploadId, parts },
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
      data: { roomId, fileId, uploadId },
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
    data: { roomId, fileId, totalChunks },
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
    { method: "POST", data: { roomId, fileId } }
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

// ──────────────────────────────────────
// Admin API
// ──────────────────────────────────────

export interface AdminRoomRecord {
  id: string;
  name: string;
  mode: "password" | "public";
  createdAt: string;
  expiresAt: string;
  _count: { files: number };
}

export interface AdminSnippetRecord {
  id: string;
  name: string;
  mode: "password" | "public";
  createdAt: string;
  expiresAt: string;
}

function adminHeaders(password: string) {
  return { "x-admin-password": password };
}

export async function adminGetRooms(password: string): Promise<AdminRoomRecord[]> {
  const res = await apiJson<{ rooms: AdminRoomRecord[] }>("/api/admin/rooms", {
    headers: adminHeaders(password),
  });
  return res.rooms;
}

export async function adminExpireRoom(password: string, id: string): Promise<void> {
  await apiJson(`/api/admin/rooms/${encodeURIComponent(id)}/expire`, {
    method: "POST",
    headers: adminHeaders(password),
  });
}

export async function adminExpireAllRooms(password: string): Promise<{ count: number }> {
  return apiJson<{ count: number }>("/api/admin/rooms/expire-all", {
    method: "POST",
    headers: adminHeaders(password),
  });
}

export async function adminGetSnippets(password: string): Promise<AdminSnippetRecord[]> {
  const res = await apiJson<{ snippets: AdminSnippetRecord[] }>("/api/admin/snippets", {
    headers: adminHeaders(password),
  });
  return res.snippets;
}

export async function adminExpireSnippet(password: string, id: string): Promise<void> {
  await apiJson(`/api/admin/snippets/${encodeURIComponent(id)}/expire`, {
    method: "POST",
    headers: adminHeaders(password),
  });
}

export async function adminExpireAllSnippets(password: string): Promise<{ count: number }> {
  return apiJson<{ count: number }>("/api/admin/snippets/expire-all", {
    method: "POST",
    headers: adminHeaders(password),
  });
}

export interface LogFile {
  file: string;
  lines: number;
}

export interface LogEntry {
  timestamp?: string;
  level?: string;
  message?: string;
  meta?: any;
  raw?: string;
}

export interface LogsPage {
  file: string;
  total: number;
  offset: number;
  limit: number;
  lines: LogEntry[];
}

export async function adminGetLogFiles(password: string): Promise<LogFile[]> {
  const res = await apiJson<{ logs: LogFile[] }>("/api/admin/logs", {
    headers: adminHeaders(password),
  });
  return res.logs;
}

export async function adminGetLogContent(
  password: string,
  filename: string,
  limit = 100,
  offset = 0
): Promise<LogsPage> {
  return apiJson<LogsPage>(`/api/admin/logs/${encodeURIComponent(filename)}`, {
    headers: adminHeaders(password),
    params: { limit, offset },
  });
}
