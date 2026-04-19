import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

export interface CompleteUploadInput {
  fileId: string;
  roomId: string;
  fileName: string;
  totalChunks: number;
  size: number;
  /** true when the encrypted file was stored as one S3 object via multipart upload */
  isMultipart?: boolean;
  /** plaintext chunk size used during encryption (needed to reconstruct chunk IVs on download) */
  chunkSize?: number;
}

/**
 * Mark a file upload as complete. Uses upsert so the record can be
 * created lazily on completion rather than requiring a separate
 * "start upload" step.
 */
export async function completeUpload(data: CompleteUploadInput) {
  return prisma.file.upsert({
    where: { id: data.fileId },
    update: {
      isComplete: true,
      totalChunks: data.totalChunks,
      size: BigInt(data.size),
      fileName: data.fileName,
      isMultipart: data.isMultipart ?? false,
      chunkSize: data.chunkSize ?? 0,
    },
    create: {
      id: data.fileId,
      roomId: data.roomId,
      fileName: data.fileName,
      totalChunks: data.totalChunks,
      size: BigInt(data.size),
      isComplete: true,
      isMultipart: data.isMultipart ?? false,
      chunkSize: data.chunkSize ?? 0,
    },
  });
}

/**
 * Get a single file by ID within a room.
 */
export async function getFile(roomId: string, fileId: string) {
  return prisma.file.findFirst({
    where: { id: fileId, roomId },
  });
}

/**
 * Get all complete files in a room.
 */
export async function getFilesByRoom(roomId: string) {
  return prisma.file.findMany({
    where: { roomId, isComplete: true },
    orderBy: { uploadedAt: "desc" },
  });
}

/**
 * Delete a file record from the database.
 * S3 cleanup should happen before calling this.
 */
export async function deleteFile(fileId: string) {
  return prisma.file.delete({ where: { id: fileId } });
}
