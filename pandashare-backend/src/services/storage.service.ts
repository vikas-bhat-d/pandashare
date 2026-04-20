import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
  DeleteObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  PutBucketLifecycleConfigurationCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";
import { Readable } from "stream";

const s3 = new S3Client({
  ...(config.S3_ENDPOINT ? { endpoint: config.S3_ENDPOINT, forcePathStyle: true } : {}),
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
});

// ──────────────────────────────────────
// Key helpers
// ──────────────────────────────────────

function getChunkKey(roomId: string, fileId: string, chunkIndex: number): string {
  return `encrypted/${roomId}/${fileId}.${chunkIndex}`;
}

function getPublicKey(roomId: string, fileId: string): string {
  return `public/${roomId}/${fileId}`;
}

/**
 * Key for a multipart-uploaded encrypted file (stored as one S3 object).
 * Kept in a separate prefix from old per-chunk objects so deletes are unambiguous.
 */
function getMultipartKey(roomId: string, fileId: string): string {
  return `multipart/${roomId}/${fileId}`;
}

// ──────────────────────────────────────
// Upload operations
// ──────────────────────────────────────

/**
 * Upload an encrypted chunk to S3.
 */
export async function uploadChunk(
  roomId: string,
  fileId: string,
  chunkIndex: number,
  body: Buffer
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: getChunkKey(roomId, fileId, chunkIndex),
      Body: body,
      ContentType: "application/octet-stream",
    })
  );
}

/**
 * Generate presigned S3 PUT URLs for each encrypted chunk of a password-mode file.
 * The browser PUTs encrypted chunks directly to S3 — Node is never in the data path.
 * Each chunk is stored at encrypted/{roomId}/{fileId}.{chunkIndex}, exactly the same
 * keys the download pipeline already reads, so no download changes are needed.
 *
 * @param totalChunks  Must equal Math.ceil(fileSize / CHUNK_SIZE). Validated by caller.
 * @param expiresIn    URL lifetime in seconds (default 1 hour).
 */
export async function getPresignedChunkUploadUrls(
  roomId: string,
  fileId: string,
  totalChunks: number,
  expiresIn = 3600
): Promise<string[]> {
  return Promise.all(
    Array.from({ length: totalChunks }, (_, i) =>
      getSignedUrl(
        s3,
        new PutObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: getChunkKey(roomId, fileId, i),
          ContentType: "application/octet-stream",
        }),
        { expiresIn }
      )
    )
  );
}

/**
 * Generate a presigned S3 PUT URL for a single public (unencrypted) file upload.
 */
export async function getPresignedUploadUrl(
  roomId: string,
  fileId: string,
  expiresIn = 3600
): Promise<string> {
  const command = new PutObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: getPublicKey(roomId, fileId),
    ContentType: "application/octet-stream",
  });
  return getSignedUrl(s3, command, { expiresIn });
}

// ──────────────────────────────────────
// Download operations
// ──────────────────────────────────────

/**
 * Download a single encrypted chunk from S3.
 * Returns a readable stream and the byte-length if known.
 */
export async function downloadChunk(
  roomId: string,
  fileId: string,
  chunkIndex: number
): Promise<{ stream: Readable; contentLength?: number }> {
  const response = await s3.send(
    new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: getChunkKey(roomId, fileId, chunkIndex),
    })
  );
  return {
    stream: response.Body as Readable,
    contentLength: response.ContentLength,
  };
}

/**
 * Generate presigned S3 GET URLs for every encrypted chunk of a password-mode file.
 * The browser fetches each chunk directly from S3 — Node is never in the download
 * data path, so chunk requests don't count against the API rate limit.
 *
 * @param totalChunks  Total number of chunks (must match what was uploaded).
 * @param expiresIn    URL lifetime in seconds (default 1 hour).
 */
export async function getPresignedChunkDownloadUrls(
  roomId: string,
  fileId: string,
  totalChunks: number,
  expiresIn = 3600
): Promise<string[]> {
  return Promise.all(
    Array.from({ length: totalChunks }, (_, i) =>
      getSignedUrl(
        s3,
        new GetObjectCommand({
          Bucket: config.S3_BUCKET,
          Key: getChunkKey(roomId, fileId, i),
        }),
        { expiresIn }
      )
    )
  );
}

/**
 * Generate a pre-signed URL for direct download (public mode only).
 * Embeds ResponseContentDisposition so S3 sends Content-Disposition: attachment
 * in the response — browsers start a native download instead of navigating to the URL.
 * URL expires in 15 minutes.
 */
export async function getPresignedDownloadUrl(
  roomId: string,
  fileId: string,
  fileName?: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: getPublicKey(roomId, fileId),
    ResponseContentDisposition: fileName
      ? `attachment; filename="${encodeURIComponent(fileName)}"`
      : "attachment",
  });
  return getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes
}

// ──────────────────────────────────────
// Multipart upload (encrypted, single S3 object)
// ──────────────────────────────────────

/**
 * Initiate an S3 multipart upload and return presigned UploadPart URLs.
 *
 * The browser uploads each encrypted part directly to S3 using these URLs.
 * Each part must be >= 5 MB (S3 minimum) except the last part.
 * The browser captures the ETag from each part response and sends them back
 * to completeMultipartUpload.
 *
 * @param totalParts  Number of encrypted parts (= totalChunks from the frontend).
 * @param expiresIn   URL lifetime in seconds (default 1 hour).
 * @returns uploadId and one presigned URL per part.
 */
export async function initiateMultipartUpload(
  roomId: string,
  fileId: string,
  totalParts: number,
  expiresIn = 3600
): Promise<{ uploadId: string; urls: string[] }> {
  const key = getMultipartKey(roomId, fileId);

  const { UploadId } = await s3.send(
    new CreateMultipartUploadCommand({
      Bucket: config.S3_BUCKET,
      Key: key,
      ContentType: "application/octet-stream",
    })
  );

  if (!UploadId) throw new Error("S3 did not return an UploadId");

  const urls = await Promise.all(
    Array.from({ length: totalParts }, (_, i) =>
      getSignedUrl(
        s3,
        new UploadPartCommand({
          Bucket: config.S3_BUCKET,
          Key: key,
          UploadId,
          PartNumber: i + 1, // S3 part numbers are 1-based
        }),
        { expiresIn }
      )
    )
  );

  return { uploadId: UploadId, urls };
}

/**
 * Complete a multipart upload after all parts have been PUT.
 *
 * @param parts  Array of { PartNumber, ETag } captured by the browser from each PUT response.
 */
export async function completeMultipartUpload(
  roomId: string,
  fileId: string,
  uploadId: string,
  parts: Array<{ PartNumber: number; ETag: string }>
): Promise<void> {
  await s3.send(
    new CompleteMultipartUploadCommand({
      Bucket: config.S3_BUCKET,
      Key: getMultipartKey(roomId, fileId),
      UploadId: uploadId,
      MultipartUpload: { Parts: parts },
    })
  );
}

/**
 * Abort a multipart upload (called on error to free S3 storage for incomplete parts).
 */
export async function abortMultipartUpload(
  roomId: string,
  fileId: string,
  uploadId: string
): Promise<void> {
  await s3.send(
    new AbortMultipartUploadCommand({
      Bucket: config.S3_BUCKET,
      Key: getMultipartKey(roomId, fileId),
      UploadId: uploadId,
    })
  ).catch(() => {}); // best-effort
}

/**
 * Generate a presigned GET URL for a multipart-uploaded encrypted file.
 * The browser downloads the entire object in one streaming GET and decrypts
 * each chunk sequentially — only 1 S3 GET request per download.
 */
export async function getPresignedMultipartDownloadUrl(
  roomId: string,
  fileId: string,
  expiresIn = 3600
): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: getMultipartKey(roomId, fileId),
    }),
    { expiresIn }
  );
}

/**
 * Delete a multipart-uploaded encrypted file (single S3 object).
 */
export async function deleteMultipartObject(
  roomId: string,
  fileId: string
): Promise<void> {
  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: getMultipartKey(roomId, fileId),
    })
  );
}

// ──────────────────────────────────────
// Bucket hygiene
// ──────────────────────────────────────

/**
 * Ensures the S3 bucket has a lifecycle rule that automatically aborts any
 * incomplete multipart upload after 1 day.
 *
 * This is the last-resort safety net for the browser-refresh / tab-close scenario
 * where the beforeunload keepalive request did not reach the server in time.
 *
 * NOTE: PutBucketLifecycleConfiguration REPLACES all existing rules. For buckets
 * that already have lifecycle rules managed externally (e.g., Terraform), set
 * SKIP_LIFECYCLE_RULE=true in the environment to disable this call.
 */
export async function ensureAbortIncompleteMultipartLifecycle(): Promise<void> {
  if (process.env.SKIP_LIFECYCLE_RULE === "true") return;
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: config.S3_BUCKET,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "AbortIncompleteMultipartUploads",
            Status: "Enabled",
            Filter: { Prefix: "" }, // applies to all objects in the bucket
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          },
        ],
      },
    })
  );
}

// ──────────────────────────────────────
// Delete operations
// ──────────────────────────────────────

/**
 * Delete all chunks for a file from S3.
 */
export async function deleteFileChunks(
  roomId: string,
  fileId: string,
  totalChunks: number
): Promise<void> {
  const objects = Array.from({ length: totalChunks }, (_, i) => ({
    Key: getChunkKey(roomId, fileId, i),
  }));

  // S3 DeleteObjects supports max 1000 keys per request
  const batchSize = 1000;
  for (let i = 0; i < objects.length; i += batchSize) {
    const batch = objects.slice(i, i + batchSize);
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: config.S3_BUCKET,
        Delete: { Objects: batch },
      })
    );
  }
}

/**
 * Delete a public file from S3.
 */
export async function deletePublicFile(
  roomId: string,
  fileId: string
): Promise<void> {
  const { DeleteObjectCommand } = await import("@aws-sdk/client-s3");
  await s3.send(
    new DeleteObjectCommand({
      Bucket: config.S3_BUCKET,
      Key: getPublicKey(roomId, fileId),
    })
  );
}
