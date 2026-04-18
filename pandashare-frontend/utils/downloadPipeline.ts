// downloadPipeline.ts — Orchestrates chunked download + decryption
// Uses File System Access API when available to stream directly to disk,
// avoiding accumulation of decrypted chunks in memory.

import { decryptChunk, deriveKey } from "./crypto";
import { downloadChunk, fromBase64 } from "./api";

export interface DownloadProgress {
  phase: "downloading" | "decrypting" | "assembling" | "writing";
  chunkIndex: number;
  totalChunks: number;
  percent: number;
}

/**
 * Download a file from a room with optional client-side decryption.
 *
 * Strategy:
 *   - Uses File System Access API (showSaveFilePicker) when available to write
 *     each chunk directly to the filesystem, avoiding holding everything in RAM.
 *   - Falls back to Blob assembly for browsers without the API (Firefox, Safari).
 *
 * Progress:
 *   - For each chunk i (0-indexed):
 *       download: percent = round( ((i + 0.5) / totalChunks) * downloadShare )
 *       decrypt:  percent = downloadShare + round( ((i + 0.5) / totalChunks) * decryptShare )
 *   - downloadShare = 60 (public) or 40 (password mode, more time spent decrypting)
 *   - decryptShare  = 0  (public) or 50 (password mode)
 *   - Writing/assembling: the remaining %
 *
 * Throws "Decryption failed" if the password is wrong (AES-GCM auth tag mismatch).
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

  // Derive key once if password mode
  let key: CryptoKey | null = null;
  let baseIVBytes: Uint8Array | null = null;

  if (mode === "password" && password && salt && baseIV) {
    const saltBytes = fromBase64(salt);
    baseIVBytes = fromBase64(baseIV);
    key = await deriveKey(password, saltBytes);
  }

  // Progress share allocation
  const downloadShare = mode === "password" ? 40 : 70;
  const decryptShare  = mode === "password" ? 50 : 0;
  const writeShare    = 100 - downloadShare - decryptShare; // 10 or 30

  // ── File System Access API path ─────────────────────────────────────────
  const hasFileSystemAccess =
    typeof window !== "undefined" &&
    "showSaveFilePicker" in window;

  if (hasFileSystemAccess) {
    let fileHandle: FileSystemFileHandle;
    try {
      // Prompt user to pick a save location
      fileHandle = await (window as any).showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: "File", accept: { "application/octet-stream": [] } }],
      });
    } catch (err: any) {
      // User cancelled the dialog — abort silently
      if (err?.name === "AbortError") return;
      throw err;
    }

    const writable = await fileHandle.createWritable();

    try {
      for (let i = 0; i < totalChunks; i++) {
        // 1. Download chunk
        onProgress?.({
          phase: "downloading",
          chunkIndex: i,
          totalChunks,
          percent: Math.round(((i + 0.5) / totalChunks) * downloadShare),
        });

        let buffer = await downloadChunk(roomId, fileId, i);

        // 2. Decrypt if password mode
        if (key && baseIVBytes) {
          onProgress?.({
            phase: "decrypting",
            chunkIndex: i,
            totalChunks,
            percent:
              downloadShare +
              Math.round(((i + 0.5) / totalChunks) * decryptShare),
          });

          try {
            buffer = await decryptChunk(buffer, key, i, baseIVBytes);
          } catch {
            await writable.abort();
            throw new Error(
              "Decryption failed — the password may be incorrect or the data is corrupted."
            );
          }
        }

        // 3. Write chunk directly to disk
        onProgress?.({
          phase: "writing",
          chunkIndex: i,
          totalChunks,
          percent:
            downloadShare +
            decryptShare +
            Math.round(((i + 0.5) / totalChunks) * writeShare),
        });

        await writable.write(buffer);
      }

      await writable.close();

      onProgress?.({
        phase: "writing",
        chunkIndex: totalChunks,
        totalChunks,
        percent: 100,
      });
    } catch (err) {
      // Ensure the writable is cleaned up on any error
      await writable.abort().catch(() => {});
      throw err;
    }

    return;
  }

  // ── Fallback: Blob assembly (Firefox / Safari) ───────────────────────────
  // We still process chunks one at a time (sequential) to avoid flooding the
  // server with parallel requests, but we must keep them in memory.

  const decryptedChunks: ArrayBuffer[] = [];

  for (let i = 0; i < totalChunks; i++) {
    // 1. Download chunk
    onProgress?.({
      phase: "downloading",
      chunkIndex: i,
      totalChunks,
      percent: Math.round(((i + 0.5) / totalChunks) * downloadShare),
    });

    let buffer = await downloadChunk(roomId, fileId, i);

    // 2. Decrypt if password mode
    if (key && baseIVBytes) {
      onProgress?.({
        phase: "decrypting",
        chunkIndex: i,
        totalChunks,
        percent:
          downloadShare +
          Math.round(((i + 0.5) / totalChunks) * decryptShare),
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
    percent: downloadShare + decryptShare + Math.round(writeShare / 2),
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
    phase: "assembling",
    chunkIndex: totalChunks,
    totalChunks,
    percent: 100,
  });
}
