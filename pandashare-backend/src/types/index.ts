// Shared types used across the backend

export interface RoomResponse {
  id: string;
  name: string;
  mode: "password" | "public";
  salt: string | null;
  baseIV: string | null;
  createdAt: string;
  expiresAt: string;
  files: FileResponse[];
}

export interface FileResponse {
  id: string;
  roomId: string;
  fileName: string;
  totalChunks: number;
  size: string; // Serialized BigInt
  uploadedAt: string;
  isComplete: boolean;
}

export interface ApiError {
  error: string;
  details?: Array<{
    field: string;
    message: string;
  }>;
}
