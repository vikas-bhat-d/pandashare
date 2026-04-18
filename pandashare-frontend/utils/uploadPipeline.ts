// uploadPipeline.ts — Orchestrates chunked encryption + upload

import { encryptChunk, deriveKey } from "./crypto";
import { uploadChunk, completeUpload, getPublicUploadPresignedUrl, completePublicUpload } from "./api";

const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

/**
 * Max number of chunks to encrypt+upload concurrently for password mode.
 * 3 is a sweet spot: saturates a typical broadband connection without
 * hammering the server or exhausting the rate limit.
 */
const CHUNK_CONCURRENCY = 3;

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
 * PUT a File directly to a presigned S3 URL via XHR so we get upload progress.
 * fetch() does not expose upload progress; XHR does via `upload.onprogress`.
 */
function putToPresignedUrl(
  url: string,
  file: File,
  onProgress?: (progress: UploadProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");

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
    xhr.onabort = () => reject(new Error("S3 upload aborted"));

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
    onProgress?: (progress: UploadProgress) => void;
  } = {}
): Promise<{ fileId: string; totalChunks: number }> {
  const { password, salt, baseIV, onProgress } = options;
  const fileId = options.fileId || crypto.randomUUID();

  // ── Public mode: presigned S3 PUT (no encryption, no Node buffering) ────────
  if (mode === "public") {
    // 1. Get presigned PUT URL from backend
    onProgress?.({ phase: "uploading", chunkIndex: 0, totalChunks: 1, percent: 0 });
    const { url } = await getPublicUploadPresignedUrl(roomId, fileId, file.name, file.size);

    // 2. PUT directly to S3 with real progress tracking
    await putToPresignedUrl(url, file, onProgress);

    // 3. Save metadata to DB
    onProgress?.({ phase: "finalizing", chunkIndex: 1, totalChunks: 1, percent: 99 });
    await completePublicUpload(roomId, fileId, file.name, file.size);
    onProgress?.({ phase: "uploading", chunkIndex: 1, totalChunks: 1, percent: 100 });

    return { fileId, totalChunks: 1 };
  }

  // ── Password mode: chunked + encrypted upload (3 chunks in parallel) ──────
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

  // Derive encryption key
  let key: CryptoKey | null = null;
  if (password && salt) {
    key = await deriveKey(password, salt);
  }

  // Signal that work is starting
  onProgress?.({ phase: "encrypting", chunkIndex: 0, totalChunks, percent: 0 });

  // Track completed chunks for progress; access from async workers is safe
  // because JS is single-threaded (no data race on the counter).
  let completedChunks = 0;

  await runConcurrently(totalChunks, CHUNK_CONCURRENCY, async (i) => {
    const start = i * CHUNK_SIZE;
    const end = Math.min(start + CHUNK_SIZE, file.size);
    let buffer = await file.slice(start, end).arrayBuffer();

    // Encrypt
    if (key && baseIV) {
      buffer = await encryptChunk(buffer, key, i, baseIV);
    }

    // Upload
    await uploadChunk(roomId, fileId, i, buffer);

    completedChunks++;
    onProgress?.({
      phase: "uploading",
      chunkIndex: completedChunks,
      totalChunks,
      // Reserve last 2% for /complete call
      percent: Math.round((completedChunks / totalChunks) * 98),
    });
  });

  // Finalize — save metadata
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
