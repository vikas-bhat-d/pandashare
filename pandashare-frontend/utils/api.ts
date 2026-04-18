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

export async function getPresignedUrl(
  roomId: string,
  fileId: string
): Promise<string> {
  const { url } = await apiJson<{ url: string }>(`/api/files/${encodeURIComponent(roomId)}/${encodeURIComponent(fileId)}/url`);
  return url;
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
