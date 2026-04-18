// downloadPipeline.ts — Orchestrates chunked download + decryption

import { decryptChunk, deriveKey } from "./crypto";
import { downloadChunk, fromBase64 } from "./api";

export interface DownloadProgress {
  phase: "downloading" | "decrypting" | "assembling";
  chunkIndex: number;
  totalChunks: number;
  percent: number;
}

/**
 * Download a file from a room with optional client-side decryption.
 *
 * For password mode:
 *   1. Derives AES-256-GCM key from password + salt
 *   2. Downloads each encrypted chunk
 *   3. Decrypts each chunk with unique IV (baseIV + chunkIndex)
 *   4. Assembles into Blob and triggers browser download
 *
 * For public mode:
 *   1. Downloads each chunk directly
 *   2. Assembles into Blob and triggers browser download
 *
 * Throws "Decryption failed" if password is wrong (AES-GCM auth tag mismatch).
 */
export async function downloadFile(
  roomId: string,
  fileId: string,
  fileName: string,
  totalChunks: number,
  mode: "password" | "public",
  options: {
    password?: string;
    salt?: string;       // base64 encoded
    baseIV?: string;     // base64 encoded
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<void> {
  const { password, salt, baseIV, onProgress } = options;

  // Derive key if password mode
  let key: CryptoKey | null = null;
  let baseIVBytes: Uint8Array | null = null;

  if (mode === "password" && password && salt && baseIV) {
    const saltBytes = fromBase64(salt);
    baseIVBytes = fromBase64(baseIV);
    key = await deriveKey(password, saltBytes);
  }

  const decryptedChunks: ArrayBuffer[] = [];

  for (let i = 0; i < totalChunks; i++) {
    // 1. Download chunk
    onProgress?.({
      phase: "downloading",
      chunkIndex: i,
      totalChunks,
      percent: Math.round((i / totalChunks) * 50), // first 50% is download
    });

    let buffer = await downloadChunk(roomId, fileId, i);

    // 2. Decrypt if password mode
    if (key && baseIVBytes) {
      onProgress?.({
        phase: "decrypting",
        chunkIndex: i,
        totalChunks,
        percent: 50 + Math.round((i / totalChunks) * 45), // 50-95% is decrypt
      });

      try {
        buffer = await decryptChunk(buffer, key, i, baseIVBytes);
      } catch {
        throw new Error(
          "Decryption failed — the password may be incorrect or the data is corrupted."
        );
      }
    }

    decryptedChunks.push(buffer);
  }

  // 3. Assemble and trigger browser download
  onProgress?.({
    phase: "assembling",
    chunkIndex: totalChunks,
    totalChunks,
    percent: 98,
  });

  const blob = new Blob(decryptedChunks);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);

  // Cleanup object URL to free memory
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  onProgress?.({
    phase: "downloading",
    chunkIndex: totalChunks,
    totalChunks,
    percent: 100,
  });
}
