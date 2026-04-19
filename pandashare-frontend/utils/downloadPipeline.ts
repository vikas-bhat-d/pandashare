// downloadPipeline.ts — Orchestrates chunked download + decryption
//
// Download strategy (in order of preference):
//   1. File System Access API  — user picks save path; browser writes natively.
//      Supported: Chrome 86+, Edge 86+, Chrome Android 86+.
//   2. StreamSaver.js          — intercepts via a Service Worker; browser's own
//      download manager writes to disk. Supported: all SW-capable browsers
//      (Firefox, Samsung Internet, Safari 11.1+, Chrome, Edge).
//
// Neither tier accumulates the file in JS heap — both are safe for 2 GB+ files.

import { decryptChunk, deriveKey } from "./crypto";
import { getEncryptedDownloadPresignedUrls, fromBase64, getPresignedUrl } from "./api";

/**
 * Fetch one encrypted chunk directly from S3 via a presigned GET URL.
 * Bypasses the Node server — no rate-limit hits per chunk.
 */
async function fetchChunkFromUrl(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`S3 chunk fetch failed: ${res.status} ${res.statusText}`);
  return res.arrayBuffer();
}

/**
 * Lazily import StreamSaver and return a WritableStream for the given file.
 *
 * The import MUST be lazy: StreamSaver accesses `window` at module load time and
 * would crash Next.js server-side rendering if imported at the top level.
 *
 * Requires /sw.js and /mitm.html to be served as static files (already copied
 * from node_modules/streamsaver to public/).
 *
 * @param fileName  Suggested filename shown in the download dialog.
 * @param size      Total byte count (enables accurate progress in browser UI).
 */
async function createStreamSaverWritable(
  fileName: string,
  size?: number
): Promise<WritableStream<Uint8Array>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const streamSaver = (await import("streamsaver")) as any;
  streamSaver.mitm = "/mitm.html";
  return streamSaver.createWriteStream(
    fileName,
    size != null ? { size } : undefined
  ) as WritableStream<Uint8Array>;
}

export interface DownloadProgress {
  phase: "downloading" | "decrypting" | "assembling" | "writing";
  chunkIndex: number;
  totalChunks: number;
  percent: number;
}

/**
 * Download a file from a room with optional client-side decryption.
 *
 * Progress shares (password mode):
 *   downloadShare = 40, decryptShare = 50, writeShare = 10
 * Progress shares (public mode):
 *   Single incrementing percent based on Content-Length.
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
    salt?: string;      // base64 encoded
    baseIV?: string;    // base64 encoded
    fileSize?: number;  // total bytes — passed to StreamSaver for accurate progress
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<void> {
  const { password, salt, baseIV, fileSize, onProgress } = options;

  // ── Public mode: single-object presigned URL ─────────────────────────────────
  if (mode === "public") {
    const url = await getPresignedUrl(roomId, fileId);
    const hasFileSystemAccess = typeof window !== "undefined" && "showSaveFilePicker" in window;

    // ── Tier 1: FSAPI — stream inline into a file handle ──────────────────────
    if (hasFileSystemAccess) {
      let fileHandle: FileSystemFileHandle;
      try {
        fileHandle = await (window as any).showSaveFilePicker({ // eslint-disable-line @typescript-eslint/no-explicit-any
          suggestedName: fileName,
          types: [{ description: "File", accept: { "application/octet-stream": [] } }],
        });
      } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
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

    // ── Tier 2: StreamSaver — pipe presigned URL's ReadableStream straight through
    // No bytes land in JS memory; the Service Worker hands them to the browser
    // download manager as a streaming HTTP response.
    onProgress?.({ phase: "downloading", chunkIndex: 0, totalChunks: 1, percent: 0 });
    const writable = await createStreamSaverWritable(fileName, fileSize);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);

    const contentLength = parseInt(response.headers.get("Content-Length") || "0");
    if (contentLength > 0) {
      // With known size we can report incremental progress while piping.
      const reader = response.body!.getReader();
      const writer = writable.getWriter();
      let received = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          await writer.write(value);
          received += value.byteLength;
          onProgress?.({
            phase: "downloading",
            chunkIndex: 0,
            totalChunks: 1,
            percent: Math.min(99, Math.round((received / contentLength) * 100)),
          });
        }
        await writer.close();
      } catch (err) {
        await writer.abort(err).catch(() => {});
        throw err;
      }
    } else {
      // Unknown size — hand the ReadableStream straight to StreamSaver via pipeTo.
      await response.body!.pipeTo(writable);
    }
    onProgress?.({ phase: "downloading", chunkIndex: 1, totalChunks: 1, percent: 100 });
    return;
  }

  // ── Password mode: chunked + decrypted download ──────────────────────────────
  let key: CryptoKey | null = null;
  let baseIVBytes: Uint8Array | null = null;
  if (password && salt && baseIV) {
    const saltBytes = fromBase64(salt);
    baseIVBytes = fromBase64(baseIV);
    key = await deriveKey(password, saltBytes);
  }

  // Single backend request for all presigned S3 GET URLs.
  const { urls } = await getEncryptedDownloadPresignedUrls(roomId, fileId, totalChunks);

  const downloadShare = 40;
  const decryptShare  = 50;
  const writeShare    = 10; // 100 - 40 - 50

  // ── Tier 1: File System Access API ──────────────────────────────────────────
  const hasFileSystemAccess = typeof window !== "undefined" && "showSaveFilePicker" in window;

  if (hasFileSystemAccess) {
    let fileHandle: FileSystemFileHandle;
    try {
      fileHandle = await (window as any).showSaveFilePicker({ // eslint-disable-line @typescript-eslint/no-explicit-any
        suggestedName: fileName,
        types: [{ description: "File", accept: { "application/octet-stream": [] } }],
      });
    } catch (err: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      if (err?.name === "AbortError") return;
      throw err;
    }
    const writable = await fileHandle.createWritable();
    try {
      // Double-buffer: fetch chunk i+1 while decrypting chunk i.
      let prefetch: Promise<ArrayBuffer> | null = null;
      for (let i = 0; i < totalChunks; i++) {
        onProgress?.({
          phase: "downloading",
          chunkIndex: i,
          totalChunks,
          percent: Math.round(((i + 0.5) / totalChunks) * downloadShare),
        });
        const buffer = prefetch ? await prefetch : await fetchChunkFromUrl(urls[i]);
        prefetch = null;
        if (i + 1 < totalChunks) prefetch = fetchChunkFromUrl(urls[i + 1]);

        if (key && baseIVBytes) {
          onProgress?.({
            phase: "decrypting",
            chunkIndex: i,
            totalChunks,
            percent: downloadShare + Math.round(((i + 0.5) / totalChunks) * decryptShare),
          });
          let decrypted: ArrayBuffer;
          try {
            decrypted = await decryptChunk(buffer, key, i, baseIVBytes);
          } catch {
            await writable.abort();
            throw new Error("Decryption failed — the password may be incorrect or the data is corrupted.");
          }
          onProgress?.({
            phase: "writing",
            chunkIndex: i,
            totalChunks,
            percent: downloadShare + decryptShare + Math.round(((i + 0.5) / totalChunks) * writeShare),
          });
          await writable.write(decrypted);
        }
      }
      await writable.close();
      onProgress?.({ phase: "writing", chunkIndex: totalChunks, totalChunks, percent: 100 });
    } catch (err) {
      await writable.abort().catch(() => {});
      throw err;
    }
    return;
  }

  // ── Tier 2: StreamSaver.js ────────────────────────────────────────────────────
  // Each decrypted chunk is written to a StreamSaver WritableStream one at a time.
  // The Service Worker intercepts the writes and delivers them to the browser's
  // native download manager — nothing accumulates in JS heap, safe for 2 GB+.
  const writable = await createStreamSaverWritable(fileName, fileSize);
  const writer = writable.getWriter();
  try {
    // Double-buffer: fetch chunk i+1 while decrypting chunk i.
    let prefetch: Promise<ArrayBuffer> | null = null;
    for (let i = 0; i < totalChunks; i++) {
      onProgress?.({
        phase: "downloading",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(((i + 0.5) / totalChunks) * downloadShare),
      });
      const buffer = prefetch ? await prefetch : await fetchChunkFromUrl(urls[i]);
      prefetch = null;
      if (i + 1 < totalChunks) prefetch = fetchChunkFromUrl(urls[i + 1]);

      let decrypted = buffer;
      if (key && baseIVBytes) {
        onProgress?.({
          phase: "decrypting",
          chunkIndex: i,
          totalChunks,
          percent: downloadShare + Math.round(((i + 0.5) / totalChunks) * decryptShare),
        });
        try {
          decrypted = await decryptChunk(buffer, key, i, baseIVBytes);
        } catch {
          await writer.abort("Decryption failed").catch(() => {});
          throw new Error("Decryption failed — the password may be incorrect or the data is corrupted.");
        }
      }

      onProgress?.({
        phase: "writing",
        chunkIndex: i,
        totalChunks,
        percent: downloadShare + decryptShare + Math.round(((i + 0.5) / totalChunks) * writeShare),
      });
      // StreamSaver's writer expects Uint8Array, not ArrayBuffer
      await writer.write(new Uint8Array(decrypted));
    }
    await writer.close();
    onProgress?.({ phase: "writing", chunkIndex: totalChunks, totalChunks, percent: 100 });
  } catch (err) {
    await writer.abort(err).catch(() => {});
    throw err;
  }
}

