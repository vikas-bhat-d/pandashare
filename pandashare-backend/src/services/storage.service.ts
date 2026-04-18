import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";
import { Readable } from "stream";

const s3 = new S3Client({
  endpoint: config.S3_ENDPOINT,
  region: config.S3_REGION,
  credentials: {
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  },
  forcePathStyle: true, // Required for MinIO
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
 * Generate a presigned S3 PUT URL for a public file upload.
 * The browser uploads directly to S3 using this URL — the Node server
 * is never in the data path.
 * URL expires in 1 hour by default.
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
 * Generate a pre-signed URL for direct download (public mode only).
 * URL expires in 15 minutes.
 */
export async function getPresignedDownloadUrl(
  roomId: string,
  fileId: string
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.S3_BUCKET,
    Key: getPublicKey(roomId, fileId),
  });
  return getSignedUrl(s3, command, { expiresIn: 900 }); // 15 minutes
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
