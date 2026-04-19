// uploadPipeline.ts — Orchestrates chunked encryption + upload

import { encryptChunk, deriveKey } from "./crypto";
import { generateUUID } from "./utils";
import {
  completeUpload,
  getPublicUploadPresignedUrl,
  completePublicUpload,
  initiateMultipartUpload,
  completeMultipartUpload,
  abortMultipartUpload,
} from "./api";

const CHUNK_SIZE = 20 * 1024 * 1024; // 20 MB — each S3 part (must be ≥5 MB except last)

/** Thrown when the user cancels an upload or download. */
export class CancelledError extends Error {
  constructor() {
    super("Cancelled");
    this.name = "CancelledError";
  }
}

/**
 * Max number of chunks to encrypt+upload concurrently for password mode.
 * 3 is a sweet spot: saturates a typical broadband connection without
 * hammering the server or exhausting the rate limit.
 */
const CHUNK_CONCURRENCY = 3;

// ── Crypto Worker ─────────────────────────────────────────────────────────────
// Encryption is CPU-bound (AES-GCM on 20 MB buffers). Doing it on the main
// thread blocks React renders and causes visible jank. A Web Worker runs on a
// separate OS thread, and ArrayBuffer transfers are zero-copy in both directions.

interface CryptoEncryptor {
  /** Encrypt one chunk. `buffer` is TRANSFERRED — caller must not use it after this call. */
  encrypt(chunkIndex: number, buffer: ArrayBuffer): Promise<ArrayBuffer>;
  /** Terminate the worker immediately (call on success AND failure). */
  terminate(): void;
}

function createWorkerEncryptor(
  password: string,
  salt: Uint8Array,
  baseIV: Uint8Array
): Promise<CryptoEncryptor> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./crypto.worker.ts", import.meta.url));
    const pending = new Map<number, { res: (b: ArrayBuffer) => void; rej: (e: Error) => void }>();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    worker.onmessage = ({ data }: MessageEvent<any>) => {
      if (data.type === "ready") {
        resolve({
          encrypt(idx, buf) {
            return new Promise((res, rej) => {
              pending.set(idx, { res, rej });
              // Transfer buf to the worker — zero-copy, main thread loses the reference
              worker.postMessage({ type: "encrypt", id: idx, buffer: buf, chunkIndex: idx }, [buf]);
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
    // (typed arrays may be offset views into a larger buffer)
    const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength);
    const ivBuf   = baseIV.buffer.slice(baseIV.byteOffset, baseIV.byteOffset + baseIV.byteLength);
    worker.postMessage({ type: "init", password, salt: saltBuf, baseIV: ivBuf });
  });
}

/**
 * Returns a CryptoEncryptor backed by a Web Worker when available,
 * falling back to main-thread crypto for SSR / unsupported environments.
 */
async function makeCryptoEncryptor(
  password: string,
  salt: Uint8Array,
  baseIV: Uint8Array
): Promise<CryptoEncryptor> {
  if (typeof Worker !== "undefined") {
    try {
      return await createWorkerEncryptor(password, salt, baseIV);
    } catch {
      // Worker unavailable — fall through to main-thread fallback
    }
  }
  // Fallback: derive key on main thread
  const key = await deriveKey(password, salt);
  return {
    encrypt: (idx, buf) => encryptChunk(buf, key, idx, baseIV),
    terminate: () => {},
  };
}

// ── Progress Throttle ─────────────────────────────────────────────────────────
// Limit React setState calls. The XHR upload.onprogress fires every ~64 KB;
// for a 20 MB chunk that's ~320 events. Throttling to ≤8 fps keeps the
// progress bar smooth while drastically reducing render pressure.
// 0% and ≥99% always pass through so start/end are always reflected.
function makeProgressEmitter(
  cb?: (p: UploadProgress) => void
): (p: UploadProgress) => void {
  if (!cb) return () => {};
  let lastMs = 0;
  return (p: UploadProgress) => {
    const now = Date.now();
    if (p.percent === 0 || p.percent >= 99 || now - lastMs >= 120) {
      lastMs = now;
      cb(p);
    }
  };
}

export interface UploadProgress {
  phase: "encrypting" | "uploading" | "finalizing";
  chunkIndex: number;
  totalChunks: number;
  percent: number;
}

/**
 * Run an async task for each index [0, total) with bounded concurrency.
 * All tasks complete (or one throws) before the returned promise settles.
 */
async function runConcurrently(
  total: number,
  concurrency: number,
  task: (index: number) => Promise<void>
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < total) {
      const i = next++;
      await task(i);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, worker)
  );
}

/**
 * PUT an encrypted ArrayBuffer to a presigned S3 UploadPart URL.
 * Returns the ETag from the response header — required by CompleteMultipartUpload.
 * S3 CORS must include `ExposeHeaders: ["ETag"]` for the browser to read it.
 */
async function putPartToPresignedUrl(url: string, data: ArrayBuffer, signal?: AbortSignal): Promise<string> {
  const res = await fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/octet-stream" },
    body: data,
    signal,
  });
  if (!res.ok) throw new Error(`S3 part upload failed: ${res.status} ${res.statusText}`);
  const etag = res.headers.get("ETag");
  if (!etag) throw new Error("S3 did not return an ETag for the uploaded part. Ensure CORS ExposeHeaders includes ETag.");
  return etag;
}

/**
 * PUT a File directly to a presigned S3 URL via XHR so we get upload progress.
 * fetch() does not expose upload progress; XHR does via `upload.onprogress`.
 */
function putToPresignedUrl(
  url: string,
  file: File,
  onProgress?: (progress: UploadProgress) => void,
  signal?: AbortSignal
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

    // Forward AbortSignal to the XHR
    if (signal) {
      if (signal.aborted) {
        reject(new CancelledError());
        return;
      }
      signal.addEventListener("abort", () => xhr.abort(), { once: true });
    }

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        onProgress?.({
          phase: "uploading",
          chunkIndex: 0,
          totalChunks: 1,
          // Reserve the last 1% for the /complete call
          percent: Math.min(98, Math.round((e.loaded / e.total) * 98)),
        });
      }
    };

    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`S3 upload failed: ${xhr.status} ${xhr.statusText}`));
      }
    };

    xhr.onerror = () => reject(new Error("S3 upload failed: network error"));
    xhr.onabort = () => reject(new CancelledError());

    xhr.send(file);
  });
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
 * For public mode (presigned S3 PUT):
 *   1. Requests a presigned PUT URL from the backend
 *   2. PUTs the raw file directly to S3 via XHR (real progress events)
 *   3. Calls /public-upload/complete so the backend saves the DB record
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
    signal?: AbortSignal;  // caller-supplied AbortSignal for cancellation
    onProgress?: (progress: UploadProgress) => void;
  } = {}
): Promise<{ fileId: string; totalChunks: number }> {
  const { password, salt, baseIV, signal, onProgress } = options;
  const fileId = options.fileId || generateUUID();

  // Throttled emitter — reduces React setState calls without losing start/end accuracy
  const emit = makeProgressEmitter(onProgress);

  // Helper: throw CancelledError if signal is already aborted
  function throwIfCancelled() {
    if (signal?.aborted) throw new CancelledError();
  }

  // ── Public mode: presigned S3 PUT (no encryption, no Node buffering) ────────
  if (mode === "public") {
    // 1. Get presigned PUT URL from backend
    throwIfCancelled();
    emit({ phase: "uploading", chunkIndex: 0, totalChunks: 1, percent: 0 });
    const { url } = await getPublicUploadPresignedUrl(roomId, fileId, file.name, file.size);

    // 2. PUT directly to S3 with real progress tracking
    throwIfCancelled();
    await putToPresignedUrl(url, file, emit, signal);

    // 3. Save metadata to DB
    throwIfCancelled();
    emit({ phase: "finalizing", chunkIndex: 1, totalChunks: 1, percent: 99 });
    await completePublicUpload(roomId, fileId, file.name, file.size);
    emit({ phase: "uploading", chunkIndex: 1, totalChunks: 1, percent: 100 });

    return { fileId, totalChunks: 1 };
  }

  // ── Password mode: S3 multipart upload (all encrypted parts → 1 S3 object) ─
  // Upload flow:
  //   1. Backend creates an S3 multipart upload → returns uploadId + N presigned UploadPart URLs
  //   2. Browser encrypts each chunk and PUTs it directly to S3 → captures ETag per part
  //   3. Browser sends ETags to backend → backend calls CompleteMultipartUpload
  // Result: N UploadPart requests to S3, but only ONE S3 GET on download (vs N GETs before).
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Create the crypto encryptor — if Worker is available, PBKDF2 key derivation
  // and AES-GCM encryption run on a separate OS thread, keeping the main thread free.
  // Parallelise with initiateMultipartUpload so the ~150 ms PBKDF2 cost is hidden.
  const [encryptor, { uploadId, urls }] = await Promise.all([
    (password && salt && baseIV)
      ? makeCryptoEncryptor(password, salt, baseIV)
      : Promise.resolve(null as CryptoEncryptor | null),
    // 1. Initiate multipart upload — 1 backend request returns uploadId + N presigned URLs
    (throwIfCancelled(),
     emit({ phase: "encrypting", chunkIndex: 0, totalChunks, percent: 0 }),
     initiateMultipartUpload(roomId, fileId, file.name, file.size, totalChunks, CHUNK_SIZE)),
  ]);

  // 2. Encrypt + PUT each part directly to S3 (up to CHUNK_CONCURRENCY at once)
  //    Parts are 1-indexed for S3; ETags indexed by part number (0-based array).
  const etags: string[] = new Array(totalChunks);
  let completedChunks = 0;

  try {
    await runConcurrently(totalChunks, CHUNK_CONCURRENCY, async (i) => {
      throwIfCancelled();
      const start = i * CHUNK_SIZE;
      const end = Math.min(start + CHUNK_SIZE, file.size);
      // Read the raw chunk; transfer it to the worker (zero-copy) if encrypting
      let buffer = await file.slice(start, end).arrayBuffer();
      throwIfCancelled();

      if (encryptor) {
        // Worker encrypts off the main thread; buffer is transferred (zero-copy)
        buffer = await encryptor.encrypt(i, buffer);
      }
      throwIfCancelled();

      // PUT directly to S3 — no rate-limit hit; capture ETag for CompleteMultipartUpload
      etags[i] = await putPartToPresignedUrl(urls[i], buffer, signal);

      completedChunks++;
      emit({
        phase: "uploading",
        chunkIndex: completedChunks,
        totalChunks,
        percent: Math.round((completedChunks / totalChunks) * 98),
      });
    });
  } catch (err) {
    // Terminate worker and abort S3 multipart upload on any failure so S3 frees the parts.
    encryptor?.terminate();
    await abortMultipartUpload(roomId, fileId, uploadId);
    // Re-wrap AbortError (from fetch signal) as CancelledError for consistent handling
    if (err instanceof Error && err.name === "AbortError") throw new CancelledError();
    throw err;
  }
  encryptor?.terminate();

  // 3. Complete multipart upload — assembles all parts into 1 S3 object
  throwIfCancelled();
  emit({ phase: "finalizing", chunkIndex: totalChunks, totalChunks, percent: 99 });

  const parts = etags.map((ETag, i) => ({ PartNumber: i + 1, ETag }));
  await completeMultipartUpload(
    roomId, fileId, file.name, file.size, totalChunks, CHUNK_SIZE, uploadId, parts
  );

  emit({ phase: "uploading", chunkIndex: totalChunks, totalChunks, percent: 100 });

  return { fileId, totalChunks };
}
