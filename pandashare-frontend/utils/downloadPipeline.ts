// downloadPipeline.ts — Orchestrates chunked download + decryption
//
// Uses StreamSaver.js exclusively:
//   - Intercepts via a Service Worker → browser's native download manager
//   - No bytes accumulate in JS heap — safe for 2 GB+ files
//   - Supported: Chrome, Edge, Firefox, Samsung Internet, Safari 11.1+
//
// TODO: Add per-chunk retry with exponential back-off.

import { decryptChunk, deriveKey } from "./crypto";
import { getEncryptedDownloadPresignedUrls, fromBase64, getPresignedUrl, getMultipartDownloadPresignedUrl } from "./api";
import { CancelledError } from "./uploadPipeline";

/**
 * Fetch one encrypted chunk directly from S3 via a presigned GET URL.
 * Bypasses the Node server — no rate-limit hits per chunk.
 */
async function fetchChunkFromUrl(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const res = await fetch(url, { signal });
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
    salt?: string;        // base64 encoded
    baseIV?: string;      // base64 encoded
    fileSize?: number;    // total bytes — passed to StreamSaver for accurate progress bar
    isMultipart?: boolean;  // true = file stored as single S3 object (new multipart format)
    chunkSize?: number;     // plaintext chunk size used during encryption
    signal?: AbortSignal;   // caller-supplied AbortSignal for cancellation
    onProgress?: (progress: DownloadProgress) => void;
  } = {}
): Promise<void> {
  const { password, salt, baseIV, fileSize, isMultipart, chunkSize, signal, onProgress } = options;

  function throwIfCancelled() {
    if (signal?.aborted) throw new CancelledError();
  }

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

  // ── Multipart mode: stream single S3 object, decrypt chunk-by-chunk ──────────
  // The whole file is one S3 GET. We read the response body as a stream and
  // reassemble each encrypted chunk (fixed chunkSize + 16-byte AES-GCM tag),
  // decrypt it, and pipe the plaintext to StreamSaver — 0 bytes accumulate in heap.
  if (isMultipart && chunkSize) {
    throwIfCancelled();
    const { url, totalChunks: parts, chunkSize: storedChunkSize } =
      await getMultipartDownloadPresignedUrl(roomId, fileId);

    const encryptedChunkSize = storedChunkSize + 16; // AES-GCM appends 16-byte auth tag
    const writable = await createStreamSaverWritable(fileName, fileSize);
    const writer = writable.getWriter();

    try {
      throwIfCancelled();
      const response = await fetch(url, { signal });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      const reader = response.body!.getReader();
      let partBuffer = new Uint8Array(0);
      let partIndex = 0;
      let receivedBytes = 0;
      // Total expected bytes on the wire = plaintext size + 16-byte AES-GCM tag per chunk
      const expectedEncryptedSize = (fileSize ?? 0) + parts * 16;

      // Shared decrypt-and-write helper to avoid duplicating the logic below.
      async function decryptAndWrite(encryptedBytes: Uint8Array): Promise<void> {
        const chunkBase = (partIndex / parts) * 100;
        const chunkSlot = 100 / parts;

        onProgress?.({
          phase: "decrypting",
          chunkIndex: partIndex,
          totalChunks: parts,
          percent: Math.round(chunkBase + chunkSlot * 0.5),
        });

        const encryptedPart = encryptedBytes.buffer.slice(
          encryptedBytes.byteOffset,
          encryptedBytes.byteOffset + encryptedBytes.byteLength
        ) as ArrayBuffer;

        let decrypted: ArrayBuffer;
        if (key && baseIVBytes) {
          try {
            decrypted = await decryptChunk(encryptedPart, key, partIndex, baseIVBytes!);
          } catch {
            await writer.abort("Decryption failed").catch(() => {});
            throw new Error("Decryption failed — the password may be incorrect or the data is corrupted.");
          }
        } else {
          decrypted = encryptedPart;
        }

        onProgress?.({
          phase: "writing",
          chunkIndex: partIndex,
          totalChunks: parts,
          percent: Math.round(chunkBase + chunkSlot * 0.9),
        });

        await writer.write(new Uint8Array(decrypted));
        partIndex++;

        onProgress?.({
          phase: "writing",
          chunkIndex: partIndex,
          totalChunks: parts,
          percent: Math.round((partIndex / parts) * 100),
        });
      }

      // Read the stream in arbitrary-sized network chunks.
      // Accumulate bytes until we have a full encrypted part, then decrypt + write.
      while (true) {
        throwIfCancelled();
        const { done, value } = await reader.read();
        if (done) break;

        receivedBytes += value.byteLength;

        // Emit byte-level download progress while chunks are still accumulating.
        // Cap at 45 % so per-chunk decryption progress (starting at 50 %) never goes backwards.
        if (partIndex === 0 && expectedEncryptedSize > 0) {
          onProgress?.({
            phase: "downloading",
            chunkIndex: 0,
            totalChunks: parts,
            percent: Math.min(45, Math.round((receivedBytes / expectedEncryptedSize) * 45)),
          });
        }

        // Append incoming bytes to the accumulation buffer
        const combined = new Uint8Array(partBuffer.byteLength + value.byteLength);
        combined.set(partBuffer);
        combined.set(value, partBuffer.byteLength);
        partBuffer = combined;

        // Drain as many complete (full-size) encrypted chunks as possible.
        // The last chunk is allowed to be smaller — it is handled after the loop.
        while (partIndex < parts - 1 && partBuffer.byteLength >= encryptedChunkSize) {
          await decryptAndWrite(partBuffer.slice(0, encryptedChunkSize));
          partBuffer = partBuffer.slice(encryptedChunkSize);
        }
      }

      // Flush the final chunk. It is almost always smaller than encryptedChunkSize
      // because the plaintext file size is rarely an exact multiple of chunkSize.
      // Without this flush the last (or only) chunk is silently discarded, producing
      // a 0-byte file for single-chunk files and truncated files otherwise.
      if (partIndex < parts && partBuffer.byteLength > 0) {
        await decryptAndWrite(partBuffer.slice(0));
      }

      await writer.close();
      onProgress?.({ phase: "writing", chunkIndex: parts, totalChunks: parts, percent: 100 });
    } catch (err) {
      await writer.abort(err).catch(() => {});
      if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
      throw err;
    }
    return;
  }

  // Single request for all presigned S3 GET URLs.
  throwIfCancelled();
  const { urls } = await getEncryptedDownloadPresignedUrls(roomId, fileId, totalChunks);

  const writable = await createStreamSaverWritable(fileName, fileSize);
  const writer = writable.getWriter();
  try {
    // Double-buffer: fetch chunk i+1 while decrypting/writing chunk i.
    let prefetch: Promise<ArrayBuffer> | null = null;
    for (let i = 0; i < totalChunks; i++) {
      throwIfCancelled();
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

      const buffer = prefetch ? await prefetch : await fetchChunkFromUrl(urls[i], signal);
      prefetch = null;
      if (i + 1 < totalChunks) prefetch = fetchChunkFromUrl(urls[i + 1], signal);

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
    if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
    throw err;
  }
}

