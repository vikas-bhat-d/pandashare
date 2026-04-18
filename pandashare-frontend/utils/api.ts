// api.ts — PandaShare API service layer
// All HTTP calls to the backend go through here.

import { apiJson, apiBinary, apiDownload } from "./apiClient";

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
  files: FileMetadata[];
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
    if (err instanceof Error && err.message.includes("404")) {
      return null;
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
