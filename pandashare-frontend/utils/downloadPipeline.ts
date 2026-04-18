// downloadPipeline.ts — Orchestrates chunked download + decryption
// Uses File System Access API when available to stream directly to disk,
// avoiding accumulation of decrypted chunks in memory.

import { decryptChunk, deriveKey } from "./crypto";
import { downloadChunk, fromBase64, getPresignedUrl } from "./api";

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

  // ── Public mode: single-object presigned URL download ──────────────────────
  // Public files are stored as a single S3 object; no decryption needed.
  // Stream directly from S3 via a short-lived presigned URL.
  if (mode === "public") {
    const url = await getPresignedUrl(roomId, fileId);

    const hasFileSystemAccess =
      typeof window !== "undefined" && "showSaveFilePicker" in window;

    if (hasFileSystemAccess) {
      let fileHandle: FileSystemFileHandle;
      try {
        fileHandle = await (window as any).showSaveFilePicker({
          suggestedName: fileName,
          types: [{ description: "File", accept: { "application/octet-stream": [] } }],
        });
      } catch (err: any) {
        if (err?.name === "AbortError") return;
        throw err;
      }

      const writable = await fileHandle.createWritable();
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Download failed: ${response.status}`);

        const contentLength = parseInt(response.headers.get("Content-Length") || "0");
        const reader = response.body!.getReader();
        let received = 0;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writable.write(value);
          received += value.byteLength;
          onProgress?.({
            phase: "downloading",
            chunkIndex: 0,
            totalChunks: 1,
            percent: contentLength > 0 ? Math.min(99, Math.round((received / contentLength) * 100)) : 50,
          });
        }

        await writable.close();
        onProgress?.({ phase: "writing", chunkIndex: 1, totalChunks: 1, percent: 100 });
      } catch (err) {
        await writable.abort().catch(() => {});
        throw err;
      }
      return;
    }

    // Fallback: fetch into memory, create blob, trigger anchor download
    onProgress?.({ phase: "downloading", chunkIndex: 0, totalChunks: 1, percent: 50 });
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const buffer = await response.arrayBuffer();
    const blob = new Blob([buffer]);
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(a.href);
    onProgress?.({ phase: "downloading", chunkIndex: 1, totalChunks: 1, percent: 100 });
    return;
  }

  // ── Password mode: chunked + decrypted download ─────────────────────────────
  // Derive key once
  let key: CryptoKey | null = null;
  let baseIVBytes: Uint8Array | null = null;

  if (password && salt && baseIV) {
    const saltBytes = fromBase64(salt);
    baseIVBytes = fromBase64(baseIV);
    key = await deriveKey(password, saltBytes);
  }

  // Progress share allocation (password mode only past this point)
  const downloadShare = 40;
  const decryptShare  = 50;
  const writeShare    = 10; // 100 - 40 - 50

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
      // Double-buffer: start fetching chunk i+1 while decrypting chunk i.
      // This overlaps network I/O with CPU (AES-GCM), cutting total time by
      // roughly max(download_time, decrypt_time) per chunk instead of their sum.
      let prefetch: Promise<ArrayBuffer> | null = null;

      for (let i = 0; i < totalChunks; i++) {
        onProgress?.({
          phase: "downloading",
          chunkIndex: i,
          totalChunks,
          percent: Math.round(((i + 0.5) / totalChunks) * downloadShare),
        });

        // Use the already-in-flight request if available, else fetch now
        const buffer = prefetch ? await prefetch : await downloadChunk(roomId, fileId, i);
        prefetch = null;

        // Kick off the next chunk while we decrypt this one
        if (i + 1 < totalChunks) {
          prefetch = downloadChunk(roomId, fileId, i + 1);
        }

        if (key && baseIVBytes) {
          onProgress?.({
            phase: "decrypting",
            chunkIndex: i,
            totalChunks,
            percent:
              downloadShare +
              Math.round(((i + 0.5) / totalChunks) * decryptShare),
          });

          let decrypted: ArrayBuffer;
          try {
            decrypted = await decryptChunk(buffer, key, i, baseIVBytes);
          } catch {
            await writable.abort();
            throw new Error(
              "Decryption failed — the password may be incorrect or the data is corrupted."
            );
          }

          onProgress?.({
            phase: "writing",
            chunkIndex: i,
            totalChunks,
            percent:
              downloadShare +
              decryptShare +
              Math.round(((i + 0.5) / totalChunks) * writeShare),
          });

          await writable.write(decrypted);
        }
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
  const decryptedChunks: ArrayBuffer[] = [];

  // Double-buffer: prefetch next chunk while decrypting current one
  let prefetch: Promise<ArrayBuffer> | null = null;

  for (let i = 0; i < totalChunks; i++) {
    onProgress?.({
      phase: "downloading",
      chunkIndex: i,
      totalChunks,
      percent: Math.round(((i + 0.5) / totalChunks) * downloadShare),
    });

    const buffer = prefetch ? await prefetch : await downloadChunk(roomId, fileId, i);
    prefetch = null;

    // Start fetching next chunk while we decrypt this one
    if (i + 1 < totalChunks) {
      prefetch = downloadChunk(roomId, fileId, i + 1);
    }

    let decrypted = buffer;
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
        decrypted = await decryptChunk(buffer, key, i, baseIVBytes);
      } catch {
        throw new Error(
          "Decryption failed — the password may be incorrect or the data is corrupted."
        );
      }
    }

    decryptedChunks.push(decrypted);
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
