// uploadPipeline.ts — Orchestrates chunked encryption + upload

import { encryptChunk, deriveKey } from "./crypto";
import { uploadChunk, completeUpload } from "./api";

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

export interface UploadProgress {
  phase: "encrypting" | "uploading" | "finalizing";
  chunkIndex: number;
  totalChunks: number;
  percent: number;
}

/**
 * Upload a single file to a room with optional client-side encryption.
 *
 * For password mode:
 *   1. Derives AES-256-GCM key from password + salt
 *   2. Slices file into 5MB chunks
 *   3. Encrypts each chunk with unique IV (baseIV + chunkIndex)
 *   4. Uploads each encrypted chunk
 *   5. Calls complete endpoint
 *
 * For public mode:
 *   1. Slices file into 5MB chunks
 *   2. Uploads each chunk directly (no encryption)
 *   3. Calls complete endpoint
 */
export async function uploadFile(
  file: File,
  roomId: string,
  mode: "password" | "public",
  options: {
    password?: string;
    salt?: Uint8Array;
    baseIV?: Uint8Array;
    fileId?: string;
    onProgress?: (progress: UploadProgress) => void;
  } = {}
): Promise<{ fileId: string; totalChunks: number }> {
  const { password, salt, baseIV, onProgress } = options;
  const fileId = options.fileId || crypto.randomUUID();
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Derive encryption key if password mode
  let key: CryptoKey | null = null;
  if (mode === "password" && password && salt) {
    key = await deriveKey(password, salt);
  }

  for (let i = 0; i < totalChunks; i++) {
    // 1. Slice chunk from file
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    let buffer = await file.slice(start, end).arrayBuffer();

    // 2. Encrypt if password mode
    if (key && baseIV) {
      onProgress?.({
        phase: "encrypting",
        chunkIndex: i,
        totalChunks,
        percent: Math.round((i / totalChunks) * 100),
      });
      buffer = await encryptChunk(buffer, key, i, baseIV);
    }

    // 3. Upload chunk
    onProgress?.({
      phase: "uploading",
      chunkIndex: i,
      totalChunks,
      percent: Math.round(((i + 0.5) / totalChunks) * 100),
    });

    await uploadChunk(roomId, fileId, i, buffer);

    onProgress?.({
      phase: "uploading",
      chunkIndex: i,
      totalChunks,
      percent: Math.round(((i + 1) / totalChunks) * 100),
    });
  }

  // 4. Finalize upload
  onProgress?.({
    phase: "finalizing",
    chunkIndex: totalChunks,
    totalChunks,
    percent: 99,
  });

  await completeUpload(roomId, fileId, {
    fileName: file.name,
    totalChunks,
    size: file.size,
  });

  onProgress?.({
    phase: "uploading",
    chunkIndex: totalChunks,
    totalChunks,
    percent: 100,
  });

  return { fileId, totalChunks };
}
