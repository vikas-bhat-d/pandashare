// downloadPipeline.ts — Orchestrates chunked download + decryption
//
// Uses StreamSaver.js exclusively:
//   - Intercepts via a Service Worker → browser's native download manager
//   - No bytes accumulate in JS heap — safe for 2 GB+ files
//   - Supported: Chrome, Edge, Firefox, Samsung Internet, Safari 11.1+
//
// TODO: Add per-chunk retry with exponential back-off.

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
  const mod = (await import("streamsaver")) as any;
  // webpack exposes CJS modules as a Module namespace object where top-level
  // properties are read-only getters; the mutable CJS exports live on .default.
  const streamSaver = mod.default ?? mod;
  streamSaver.mitm = "/mitm.html";
  return streamSaver.createWriteStream(
    fileName,
    size != null ? { size } : undefined
  ) as WritableStream<Uint8Array>;
}

export interface DownloadProgress {
  phase: "downloading" | "decrypting" | "writing";
  chunkIndex: number;
  totalChunks: number;
  percent: number;
}

/**
 * Download a file from a room with optional client-side decryption.
 *
 * Progress (password mode): per-chunk base offset ensures percent is always
 * monotonically increasing — 40% of each chunk = download, 50% = decrypt, 10% = write.
 * Progress (public mode): driven by Content-Length when available.
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
    fileSize?: number;  // total bytes — passed to StreamSaver for accurate progress bar
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<void> {
  const { password, salt, baseIV, fileSize, onProgress } = options;

  // ── Public mode: single presigned URL → StreamSaver ──────────────────────────
  if (mode === "public") {
    const url = await getPresignedUrl(roomId, fileId);
    onProgress?.({ phase: "downloading", chunkIndex: 0, totalChunks: 1, percent: 0 });
    const writable = await createStreamSaverWritable(fileName, fileSize);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: ${response.status}`);
    const contentLength = parseInt(response.headers.get("Content-Length") || "0");
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
          percent: contentLength > 0
            ? Math.min(99, Math.round((received / contentLength) * 100))
            : 50,
        });
      }
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      throw err;
    }
    onProgress?.({ phase: "writing", chunkIndex: 1, totalChunks: 1, percent: 100 });
    return;
  }

  // ── Password mode: chunked encrypted download → StreamSaver ─────────────────
  let key: CryptoKey | null = null;
  let baseIVBytes: Uint8Array | null = null;
  if (password && salt && baseIV) {
    const saltBytes = fromBase64(salt);
    baseIVBytes = fromBase64(baseIV);
    key = await deriveKey(password, saltBytes);
  }

  // Single request for all presigned S3 GET URLs.
  const { urls } = await getEncryptedDownloadPresignedUrls(roomId, fileId, totalChunks);

  const writable = await createStreamSaverWritable(fileName, fileSize);
  const writer = writable.getWriter();
  try {
    // Double-buffer: fetch chunk i+1 while decrypting/writing chunk i.
    let prefetch: Promise<ArrayBuffer> | null = null;
    for (let i = 0; i < totalChunks; i++) {
      // Per-chunk base ensures percent is always monotonically increasing.
      // Each chunk owns (100 / totalChunks)% of the bar, split: 40 download / 50 decrypt / 10 write.
      const chunkBase = (i / totalChunks) * 100;
      const chunkSize = 100 / totalChunks;

      onProgress?.({
        phase: "downloading",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSize * 0.1),
      });

      const buffer = prefetch ? await prefetch : await fetchChunkFromUrl(urls[i]);
      prefetch = null;
      if (i + 1 < totalChunks) prefetch = fetchChunkFromUrl(urls[i + 1]);

      onProgress?.({
        phase: "downloading",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSize * 0.4),
      });

      let decrypted = buffer;
      if (key && baseIVBytes) {
        onProgress?.({
          phase: "decrypting",
          chunkIndex: i,
          totalChunks,
          percent: Math.round(chunkBase + chunkSize * 0.5),
        });
        try {
          decrypted = await decryptChunk(buffer, key, i, baseIVBytes);
        } catch {
          await writer.abort("Decryption failed").catch(() => {});
          throw new Error("Decryption failed — the password may be incorrect or the data is corrupted.");
        }
        onProgress?.({
          phase: "decrypting",
          chunkIndex: i,
          totalChunks,
          percent: Math.round(chunkBase + chunkSize * 0.9),
        });
      }

      onProgress?.({
        phase: "writing",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSize * 0.9),
      });
      // StreamSaver writer expects Uint8Array, not ArrayBuffer
      await writer.write(new Uint8Array(decrypted));

      onProgress?.({
        phase: "writing",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSize),
      });
    }
    await writer.close();
    onProgress?.({ phase: "writing", chunkIndex: totalChunks, totalChunks, percent: 100 });
  } catch (err) {
    await writer.abort(err).catch(() => {});
    throw err;
  }
}

