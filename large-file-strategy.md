# PandaShare — Large File Strategy

## Problems

### Problem 1 — Password upload: rate limit + server load for large files

**Symptom:** Uploading a file larger than ~600 MB in password mode hits the upload rate
limiter (120 requests/min) mid-way and gets rejected with HTTP 429. Even before the
limit fires, each of the ~400 HTTP requests for a 2 GB file passes through the Node
server: connect → send body → Node buffers chunk → Node forwards to S3 → close. This
creates 400 connection round-trips and a steady 15 MB memory pressure in Node.

**Root cause:** The original password-mode upload sent every encrypted chunk as a
`POST /api/upload/:roomId/:fileId/:chunkIndex` request through Node. With a 5 MB chunk
size and a 2 GB file that is ~410 requests, all counted against the rate limiter.

**Fix: Presigned per-chunk S3 PUT URLs**

```
Browser                      Backend (Node)                  S3 / MinIO
  |                               |                               |
  |── POST /api/upload/encrypted/presign ──>                      |
  |   { roomId, fileId,           │── signs 410 PutObject URLs ──>│
  |     fileName, size,           │<── [ url_0, url_1, … url_N ] ─│
  |     totalChunks }             |                               |
  |<── { urls: string[] }        |                               |
  |                               |                               |
  | [3 in parallel, browser side:]                               |
  |── PUT urls[0] (5 MB encrypted chunk) ─────────────────────>  S3
  |── PUT urls[1] (5 MB encrypted chunk) ─────────────────────>  S3
  |── PUT urls[2] (5 MB encrypted chunk) ─────────────────────>  S3
  |   [ETag ignored — no assembly needed, each chunk is its own object]
  |   ...
  |                               |                               |
  |── POST /api/complete/:roomId ──>                              |
  |   { fileId, fileName,         │── prisma.file.upsert() ──>  DB
  |     totalChunks, size }        |                               |
  |<── { ok: true, file: … }      |                               |
```

**Result:**
- Node only touches 2 tiny JSON requests per file (presign + complete).
- All 410 chunk PUTs go browser → S3 directly.
- Rate limiter is irrelevant for data traffic.
- Works for any file size S3 accepts (up to 5 TB).
- Download pipeline is **unchanged** — chunks are still stored as individual S3 objects
  at `encrypted/{roomId}/{fileId}.{chunkIndex}`, so existing downloads keep working.

---

### Problem 2 — Download memory exhaustion for large files

#### Path analysis

| Download path | Before | Memory for 2 GB |
|---|---|---|
| **Public + FSAPI** (Chrome/Edge/Firefox 111+) | Streams presigned URL via ReadableStream → FileSystemWritableFileStream | ✅ ~1 MB |
| **Password + FSAPI** | Fetches chunks, decrypts, writes to FileSystemWritableFileStream | ✅ ~10 MB |
| **Public + Blob fallback** | `fetch(url).arrayBuffer()` — one allocation | ❌ 2 GB → crash |
| **Password + Blob fallback** | `decryptedChunks.push(buffer)` loop | ❌ 2 GB → crash |

The FSAPI paths are already correct. The two Blob-fallback paths are the crash points.

#### Fix A — Public Blob fallback: anchor redirect (zero JS memory)

The presigned GET URL now includes `response-content-disposition=attachment; filename=...`
as a query parameter (embedded at signing time via `ResponseContentDisposition`). This
causes S3 to send `Content-Disposition: attachment` in its response headers, which tells
every browser to download the file instead of displaying it.

The fallback path is then a simple anchor click — the browser's native download manager
streams the file at the OS level:

```ts
// Zero JS memory — the browser download manager handles it
const a = document.createElement("a");
a.href = presignedUrl; // has response-content-disposition=attachment; filename=…
document.body.appendChild(a);
a.click();
document.body.removeChild(a);
```

No `fetch()`, no `ArrayBuffer`, no `Blob` — memory stays at ~0 MB in JS heap.

#### Fix B — Password Blob fallback: size guard

The `File System Access API` (`showSaveFilePicker`) is required to stream-decrypt large
password files without holding them in memory. Support by browser:

| Browser | FSAPI support since |
|---|---|
| Chrome / Edge | 86 (Oct 2020) |
| Firefox | 111 (Mar 2023) |
| Safari | 15.2 (Dec 2021) |

Coverage is >96% of users as of 2026. For the rare browser that lacks FSAPI, downloading
a 2+ GB encrypted file is not feasible in JS without a Service Worker (StreamSaver),
which would add a significant dependency.

The fix: throw a descriptive error **before starting** the download if:
- FSAPI is not available, **and**
- the file is large (> 100 chunks ≈ 500 MB)

Files ≤ 500 MB continue to work via Blob assembly on all browsers.

---

## Files Changed

| File | Change |
|---|---|
| `pandashare-backend/src/services/storage.service.ts` | Add `getPresignedChunkUploadUrls()`; add `fileName` param to `getPresignedDownloadUrl()` for `ResponseContentDisposition` |
| `pandashare-backend/src/routes/upload.ts` | Add `POST /api/upload/encrypted/presign` |
| `pandashare-backend/src/routes/download.ts` | Look up `fileName` from DB when generating presigned download URL |
| `pandashare-frontend/utils/api.ts` | Add `getEncryptedUploadPresignedUrls()` |
| `pandashare-frontend/utils/uploadPipeline.ts` | Password mode: presign all chunk URLs upfront → encrypt → PUT direct to S3 |
| `pandashare-frontend/utils/downloadPipeline.ts` | Public fallback: anchor-click presigned URL; Password fallback: size guard |

---

## MinIO / S3 CORS Requirement

Because the browser now PUTs encrypted chunks and GETs public files directly from S3,
the bucket CORS policy must allow direct browser access:

```json
[{
  "AllowedHeaders": ["content-type"],
  "AllowedMethods": ["PUT", "GET"],
  "AllowedOrigins": ["http://localhost:3000"],
  "ExposeHeaders": ["ETag"]
}]
```

Set via MinIO Console → Bucket → Access Rules, or:
```
mc anonymous set-json cors.json myminio/pandashare
```
