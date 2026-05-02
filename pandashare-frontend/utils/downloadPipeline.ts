// downloadPipeline.ts — Orchestrates chunked download + decryption
//
// Uses StreamSaver.js exclusively:
//   - Intercepts via a Service Worker → browser's native download manager
//   - No bytes accumulate in JS heap — safe for 2 GB+ files
//   - Supported: Chrome, Edge, Firefox, Samsung Internet, Safari 11.1+
//
// Optimizations:
//   - Web Worker decryption (off main thread)
//   - Concurrent chunk download + decryption
//   - Aggressive progress throttling
//   - Axios for cleaner API

import axios from "axios";
import { decryptChunk, deriveKey } from "./crypto";
import { getEncryptedDownloadPresignedUrls, fromBase64, getPresignedUrl, getMultipartDownloadPresignedUrl } from "./api";
import { CancelledError } from "./uploadPipeline";

/**
 * Max number of chunks to download+decrypt concurrently.
 * Higher = better throughput, but more memory & CPU usage.
 */
const DOWNLOAD_CONCURRENCY = 4;

// ── Crypto Worker (Decryption) ───────────────────────────────────────────────
// Decryption is CPU-intensive. Running it on the main thread blocks React
// renders and causes UI jank. A Web Worker runs on a separate OS thread.

interface CryptoDecryptor {
  /** Decrypt one chunk. `buffer` is TRANSFERRED — caller must not use it after this call. */
  decrypt(chunkIndex: number, buffer: ArrayBuffer): Promise<ArrayBuffer>;
  /** Terminate the worker immediately (call on success AND failure). */
  terminate(): void;
}

function createWorkerDecryptor(
  password: string,
  salt: Uint8Array,
  baseIV: Uint8Array
): Promise<CryptoDecryptor> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./decrypt.worker.ts", import.meta.url));
    const pending = new Map<number, { res: (b: ArrayBuffer) => void; rej: (e: Error) => void }>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.onmessage = ({ data }: MessageEvent<any>) => {
      if (data.type === "ready") {
        resolve({
          decrypt(idx, buf) {
            return new Promise((res, rej) => {
              pending.set(idx, { res, rej });
              // Transfer buf to the worker — zero-copy, main thread loses the reference
              worker.postMessage({ type: "decrypt", id: idx, buffer: buf, chunkIndex: idx }, [buf]);
            });
          },
          terminate() { worker.terminate(); },
        });
      } else if (data.type === "done") {
        pending.get(data.id)?.res(data.buffer as ArrayBuffer);
        pending.delete(data.id);
      } else if (data.type === "error") {
        const err = new Error((data.message as string) ?? "Crypto worker error");
        if (data.id !== undefined) {
          pending.get(data.id)?.rej(err);
          pending.delete(data.id);
        } else {
          reject(err);
        }
      }
    };

    worker.onerror = (e) => reject(new Error(`Crypto worker failed: ${e.message}`));

    // Copy the typed array data into plain ArrayBuffers before sending
    const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength);
    const ivBuf   = baseIV.buffer.slice(baseIV.byteOffset, baseIV.byteOffset + baseIV.byteLength);
    worker.postMessage({ type: "init", password, salt: saltBuf, baseIV: ivBuf });
  });
}

async function makeCryptoDecryptor(
  password: string,
  salt: Uint8Array,
  baseIV: Uint8Array
): Promise<CryptoDecryptor> {
  if (typeof Worker !== "undefined") {
    try {
      return await createWorkerDecryptor(password, salt, baseIV);
    } catch {
      // Worker unavailable — fall through to main-thread fallback
    }
  }
  // Fallback: derive key on main thread
  const key = await deriveKey(password, salt);
  return {
    decrypt: (idx, buf) => decryptChunk(buf, key, idx, baseIV),
    terminate: () => {},
  };
}

/**
 * Fetch one encrypted chunk directly from S3 via a presigned GET URL.
 * Bypasses the Node server — no rate-limit hits per chunk.
 */
async function fetchChunkFromUrl(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  try {
    const response = await axios.get<ArrayBuffer>(url, {
      responseType: "arraybuffer",
      signal,
    });
    return response.data;
  } catch (err) {
    if (axios.isCancel(err) || (err instanceof Error && err.name === "AbortError")) {
      throw new CancelledError();
    }
    if (axios.isAxiosError(err)) {
      throw new Error(`S3 chunk fetch failed: ${err.response?.status || err.message}`);
    }
    throw err;
  }
}

// ── Progress Throttle ─────────────────────────────────────────────────────────
// Drastically reduce React setState calls. Emit at most ~8 updates/sec.
function makeProgressEmitter(
  cb?: (p: DownloadProgress) => void
): (p: DownloadProgress) => void {
  if (!cb) return () => {};
  let lastMs = 0;
  return (p: DownloadProgress) => {
    const now = Date.now();
    if (p.percent === 0 || p.percent >= 99 || now - lastMs >= 120) {
      lastMs = now;
      cb(p);
    }
  };
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
  const emitProgress = makeProgressEmitter(onProgress);

  function throwIfCancelled() {
    if (signal?.aborted) throw new CancelledError();
  }

  // ── Public mode: single presigned URL → StreamSaver ──────────────────────────
  if (mode === "public") {
    const url = await getPresignedUrl(roomId, fileId);
    emitProgress({ phase: "downloading", chunkIndex: 0, totalChunks: 1, percent: 0 });
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
        emitProgress({
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
    emitProgress({ phase: "writing", chunkIndex: 1, totalChunks: 1, percent: 100 });
    return;
  }

  // ── Password mode: chunked encrypted download → StreamSaver ─────────────────
  let decryptor: CryptoDecryptor | null = null;
  if (password && salt && baseIV) {
    const saltBytes = fromBase64(salt);
    const baseIVBytes = fromBase64(baseIV);
    decryptor = await makeCryptoDecryptor(password, saltBytes, baseIVBytes);
  }

  // ── Multipart mode: stream single S3 object, decrypt chunk-by-chunk ──────────
  // The whole file is one S3 GET. We read the response body as a stream and
  // reassemble each encrypted chunk (fixed chunkSize + 16-byte AES-GCM tag),
  // decrypt it, and pipe the plaintext to StreamSaver — 0 bytes accumulate in heap.
  if (isMultipart && chunkSize && decryptor) {
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

        emitProgress({
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
        try {
          decrypted = await decryptor!.decrypt(partIndex, encryptedPart);
        } catch {
          await writer.abort("Decryption failed").catch(() => {});
          throw new Error("Decryption failed — the password may be incorrect or the data is corrupted.");
        }

        emitProgress({
          phase: "writing",
          chunkIndex: partIndex,
          totalChunks: parts,
          percent: Math.round(chunkBase + chunkSlot * 0.9),
        });

        await writer.write(new Uint8Array(decrypted));
        partIndex++;

        emitProgress({
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
          emitProgress({
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
      emitProgress({ phase: "writing", chunkIndex: parts, totalChunks: parts, percent: 100 });
    } catch (err) {
      await writer.abort(err).catch(() => {});
      if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
      throw err;
    } finally {
      decryptor.terminate();
    }
    return;
  }

  // ── Legacy chunk-by-chunk mode with CONCURRENT download + decryption ─────────
  // Download and decrypt multiple chunks simultaneously for maximum throughput.
  throwIfCancelled();
  const { urls } = await getEncryptedDownloadPresignedUrls(roomId, fileId, totalChunks);

  const writable = await createStreamSaverWritable(fileName, fileSize);
  const writer = writable.getWriter();

  try {
    // Concurrent pipeline: download and decrypt up to DOWNLOAD_CONCURRENCY chunks at once
    const pipeline = new Map<number, Promise<ArrayBuffer>>();
    let nextFetch = 0;
    let nextWrite = 0;

    async function startDownloadAndDecrypt(i: number): Promise<void> {
      const chunkBase = (i / totalChunks) * 100;
      const chunkSlot = 100 / totalChunks;

      emitProgress({
        phase: "downloading",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSlot * 0.2),
      });

      const encrypted = await fetchChunkFromUrl(urls[i], signal);

      emitProgress({
        phase: "decrypting",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSlot * 0.5),
      });

      let decrypted = encrypted;
      if (decryptor) {
        try {
          decrypted = await decryptor.decrypt(i, encrypted);
        } catch {
          throw new Error("Decryption failed — the password may be incorrect or the data is corrupted.");
        }
      }

      emitProgress({
        phase: "decrypting",
        chunkIndex: i,
        totalChunks,
        percent: Math.round(chunkBase + chunkSlot * 0.9),
      });

      pipeline.set(i, Promise.resolve(decrypted));
    }

    // Fill the pipeline with initial batch
    while (nextFetch < Math.min(DOWNLOAD_CONCURRENCY, totalChunks)) {
      throwIfCancelled();
      startDownloadAndDecrypt(nextFetch++).catch(err => {
        pipeline.set(nextFetch - 1, Promise.reject(err));
      });
    }

    // Write chunks in order, fetching new ones as slots free up
    while (nextWrite < totalChunks) {
      throwIfCancelled();

      const decrypted = await pipeline.get(nextWrite)!;
      pipeline.delete(nextWrite);

      emitProgress({
        phase: "writing",
        chunkIndex: nextWrite,
        totalChunks,
        percent: Math.round(((nextWrite + 0.95) / totalChunks) * 100),
      });

      await writer.write(new Uint8Array(decrypted));
      nextWrite++;

      // Start next download if available
      if (nextFetch < totalChunks) {
        startDownloadAndDecrypt(nextFetch++).catch(err => {
          pipeline.set(nextFetch - 1, Promise.reject(err));
        });
      }
    }

    await writer.close();
    emitProgress({ phase: "writing", chunkIndex: totalChunks, totalChunks, percent: 100 });
  } catch (err) {
    await writer.abort(err).catch(() => {});
    if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
    throw err;
  } finally {
    decryptor?.terminate();
  }
}

