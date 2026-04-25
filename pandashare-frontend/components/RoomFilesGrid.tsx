"use client";

import React, { useState, useRef, useCallback } from "react";
import { Card } from "./ui/Card";
import { Button } from "./ui/Button";
import {
  UploadCloud,
  File as FileIcon,
  Download,
  LockKeyhole,
  AlertCircle,
  Trash2,
  FolderOpen,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { uploadFile, UploadProgress, CancelledError } from "@/utils/uploadPipeline";
import { downloadFile, DownloadProgress } from "@/utils/downloadPipeline";
import {
  deleteFile as apiDeleteFile,
  getRoomFiles,
  FileMetadata,
  fromBase64,
} from "@/utils/api";
import { computeVerifier } from "@/utils/crypto";
import { generateUUID } from "@/utils/utils";

interface RoomFilesGridProps {
  roomId: string;
  roomName: string;
  mode: "password" | "public";
  /** HMAC verifier for authenticated file-list fetches (empty string for public rooms) */
  verifier: string;
  urlPassword?: string;
  salt?: string | null;
  baseIV?: string | null;
  initialFiles?: FileMetadata[];
}

interface FileTile {
  type: "file";
  id: string;
  name: string;
  size: string;
  sizeBytes: number;
  totalChunks: number;
  isMultipart: boolean;
  chunkSize: number;
  status: "idle" | "decrypting" | "downloading" | "done" | "encrypting" | "uploading" | "error" | "cancelled";
  progress: number;
  errorMessage?: string;
}

export function RoomFilesGrid({
  roomId,
  roomName,
  mode,
  verifier,
  urlPassword = "",
  salt,
  baseIV,
  initialFiles = [],
}: RoomFilesGridProps) {
  const [password, setPassword] = useState(urlPassword);
  const [files, setFiles] = useState<FileTile[]>(() =>
    initialFiles.map((f) => ({
      type: "file" as const,
      id: f.id,
      name: f.fileName,
      size: formatFileSize(Number(f.size)),
      sizeBytes: Number(f.size),
      totalChunks: f.totalChunks,
      isMultipart: f.isMultipart,
      chunkSize: f.chunkSize,
      status: "idle" as const,
      progress: 0,
    }))
  );
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  // AbortController per active tile — keyed by tileId
  const abortControllers = useRef<Map<string, AbortController>>(new Map());

  function formatFileSize(bytes: number): string {
    if (bytes === 0) return "0 B";
    const units = ["B", "KB", "MB", "GB", "TB"];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
  }

  const handleUploadClick = () => {
    fileInputRef.current?.click();
  };

  // ── Drag & Drop ────────────────────────────

  const handleDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const { clientX, clientY } = e;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      const droppedFiles = e.dataTransfer?.files;
      if (droppedFiles && droppedFiles.length > 0) {
        processFiles(Array.from(droppedFiles));
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode, password, salt, baseIV, roomId]
  );

  const handleUploadChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      processFiles(Array.from(e.target.files));
      e.target.value = "";
    }
  };

  const [uploadPasswordPrompt, setUploadPasswordPrompt] = useState(false);
  const [pendingUploads, setPendingUploads] = useState<File[] | null>(null);
  const [uploadPasswordError, setUploadPasswordError] = useState<string | null>(null);

  /**
   * Refresh the file list from the backend after a successful upload.
   * For public rooms, just refetch normally; for password rooms, use verifier.
   */
  const refreshFileList = async () => {
    try {
      if (mode === "public") {
        const files = await getRoomFiles(roomId, "");
        if (files) {
          setFiles(
            files.map((f) => ({
              type: "file" as const,
              id: f.id,
              name: f.fileName,
              size: formatFileSize(Number(f.size)),
              sizeBytes: Number(f.size),
              totalChunks: f.totalChunks,
              isMultipart: f.isMultipart,
              chunkSize: f.chunkSize,
              status: "idle" as const,
              progress: 0,
            }))
          );
        }
      } else if (verifier) {
        const files = await getRoomFiles(roomId, verifier);
        if (files) {
          setFiles(
            files.map((f) => ({
              type: "file" as const,
              id: f.id,
              name: f.fileName,
              size: formatFileSize(Number(f.size)),
              sizeBytes: Number(f.size),
              totalChunks: f.totalChunks,
              isMultipart: f.isMultipart,
              chunkSize: f.chunkSize,
              status: "idle" as const,
              progress: 0,
            }))
          );
        }
      }
    } catch (err) {
      console.error("Failed to refresh file list:", err);
    }
  };

  // ── Upload Logic ────────────────────────────

  const FILE_SIZE_LIMIT = 2 * 1024 * 1024 * 1024; // 2 GB for private/password rooms

  const processFiles = (rawFiles: File[]) => {
    if (mode === "password") {
      // Enforce 2 GB per-file limit for private (encrypted) rooms
      const oversized = rawFiles.filter((f) => f.size > FILE_SIZE_LIMIT);
      if (oversized.length > 0) {
        oversized.forEach((f) =>
          toast.error(`"${f.name}" exceeds the 2 GB limit for private rooms.`)
        );
        const allowed = rawFiles.filter((f) => f.size <= FILE_SIZE_LIMIT);
        if (allowed.length === 0) return;
        rawFiles = allowed;
      }
      if (!password) {
        setPendingUploads(rawFiles);
        setUploadPasswordPrompt(true);
        return;
      }
    }
    actualProcessFiles(rawFiles, password);
  };

  const actualProcessFiles = (rawFiles: File[], currentPassword: string) => {
    const newTiles: FileTile[] = rawFiles.map((f) => ({
      type: "file" as const,
      id: generateUUID(),
      name: f.name,
      size: formatFileSize(f.size),
      sizeBytes: f.size,
      totalChunks: Math.ceil(f.size / (20 * 1024 * 1024)),
      isMultipart: mode === "password", // new uploads always use multipart for password mode
      chunkSize: 20 * 1024 * 1024,
      status: (mode === "password" ? "encrypting" : "uploading") as FileTile["status"],
      progress: 0,
    }));

    setFiles((prev) => [...prev, ...newTiles]);

    // Start uploading each file
    rawFiles.forEach((rawFile, i) => {
      const tileId = newTiles[i].id;
      startUpload(rawFile, tileId, currentPassword);
    });
  };

  const startUpload = async (rawFile: File, tileId: string, currentPassword?: string) => {
    const controller = new AbortController();
    abortControllers.current.set(tileId, controller);

    const updateTile = (updates: Partial<FileTile>) => {
      setFiles((prev) =>
        prev.map((t) => (t.id === tileId ? { ...t, ...updates } : t))
      );
    };

    try {
      // Prepare crypto params
      let saltBytes: Uint8Array | undefined;
      if (salt) saltBytes = fromBase64(salt);
      let ivBytes: Uint8Array | undefined;
      if (baseIV) ivBytes = fromBase64(baseIV);

      const result = await uploadFile(rawFile, roomId, mode, {
        password: currentPassword || undefined,
        salt: saltBytes,
        baseIV: ivBytes,
        fileId: tileId,
        signal: controller.signal,
        onProgress: (progress: UploadProgress) => {
          updateTile({
            status: progress.phase === "encrypting" ? "encrypting" : "uploading",
            progress: progress.percent,
          });
        },
      });

      abortControllers.current.delete(tileId);
      // Success — refresh list from server to ensure consistent state
      updateTile({ status: "done", progress: 100, totalChunks: result.totalChunks });
      toast.success(`${rawFile.name} uploaded successfully`);
      setTimeout(async () => {
        updateTile({ status: "idle", progress: 0 });
        await refreshFileList();
      }, 1500);
    } catch (err) {
      abortControllers.current.delete(tileId);
      if (err instanceof CancelledError) {
        // Remove the tile — the upload never completed so there's nothing to keep
        setFiles((prev) => prev.filter((t) => t.id !== tileId));
        toast.info(`${rawFile.name} upload cancelled`);
        return;
      }
      console.error("Upload failed:", err);
      const msg = err instanceof Error ? err.message : "Upload failed";
      updateTile({ status: "error", progress: 0, errorMessage: msg });
      toast.error(`Upload failed: ${msg}`);
    }
  };

  // ── Download Logic ────────────────────────────

  const [passwordPromptFile, setPasswordPromptFile] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState("");
  const [decryptionError, setDecryptionError] = useState<string | null>(null);

  const handleDownload = async (fileId: string, pwdOverride?: string) => {
    const actPwd = pwdOverride || password;

    // If password mode and no password, prompt for it
    if (mode !== "public" && !actPwd) {
      setPasswordPromptFile(fileId);
      return;
    }

    if (pwdOverride) setPassword(pwdOverride);

    const tile = files.find((f) => f.id === fileId);
    if (!tile) return;

    const controller = new AbortController();
    abortControllers.current.set(fileId, controller);

    const updateTile = (updates: Partial<FileTile>) => {
      setFiles((prev) =>
        prev.map((f) => (f.id === fileId ? { ...f, ...updates } : f))
      );
    };

    updateTile({ status: "downloading", progress: 0 });

    try {
      await downloadFile(roomId, fileId, tile.name, tile.totalChunks, mode, {
        password: actPwd,
        salt: salt || undefined,
        baseIV: baseIV || undefined,
        fileSize: tile.sizeBytes,
        isMultipart: tile.isMultipart,
        chunkSize: tile.chunkSize,
        signal: controller.signal,
        onProgress: (progress: DownloadProgress) => {
          updateTile({
            status: progress.phase === "decrypting" ? "decrypting" : "downloading",
            progress: progress.percent,
          });
        },
      });

      abortControllers.current.delete(fileId);
      updateTile({ status: "done", progress: 100 });
      toast.success(`${tile.name} downloaded successfully`);
      setTimeout(() => updateTile({ status: "idle", progress: 0 }), 2000);
    } catch (err) {
      abortControllers.current.delete(fileId);
      if (err instanceof CancelledError) {
        updateTile({ status: "idle", progress: 0 });
        toast.info(`${tile.name} download cancelled`);
        return;
      }
      console.error("Download failed:", err);
      const msg = err instanceof Error ? err.message : "Download failed";

      if (msg.includes("Decryption failed")) {
        setDecryptionError(msg);
        toast.error("Decryption failed. Incorrect password?");
        setPasswordPromptFile(fileId);
        updateTile({ status: "idle", progress: 0 });
      } else {
        updateTile({ status: "error", progress: 0, errorMessage: msg });
        toast.error(`Download failed: ${msg}`);
      }
    }
  };

  const handleCancel = (tileId: string) => {
    const controller = abortControllers.current.get(tileId);
    if (controller) controller.abort();
  };

  const handleDeleteFile = (fileId: string) => {
    const tile = files.find((f) => f.id === fileId);
    toast.warning(`Delete "${tile?.name || "file"}"?`, {
      description: "This action cannot be undone.",
      action: {
        label: "Delete",
        onClick: async () => {
          try {
            await apiDeleteFile(roomId, fileId);
            setFiles((prev) => prev.filter((f) => f.id !== fileId));
            toast.success("File deleted");
          } catch (err) {
            console.error("Delete failed:", err);
            toast.error("Failed to delete file");
          }
        },
      },
    });
  };

  const handleUploadPasswordSubmit = async () => {
    if (!tempPassword.trim()) return;
    setUploadPasswordError(null);
    try {
      const v = await computeVerifier(roomName, tempPassword.trim());
      const filesInfo = await getRoomFiles(roomId, v);
      if (filesInfo === null) {
        setUploadPasswordError("Incorrect password. Please try again.");
      } else {
        const actPwd = tempPassword.trim();
        setPassword(actPwd);
        setUploadPasswordPrompt(false);
        setTempPassword("");
        if (pendingUploads) {
          const p = pendingUploads;
          setPendingUploads(null);
          actualProcessFiles(p, actPwd);
        }
      }
    } catch {
      setUploadPasswordError("Failed to verify password.");
    }
  };

  const handlePasswordSubmit = () => {
    if (!passwordPromptFile || !tempPassword.trim()) return;
    setDecryptionError(null);
    const fileId = passwordPromptFile;
    setPasswordPromptFile(null);
    handleDownload(fileId, tempPassword.trim());
  };

  const getStatusLabel = (status: FileTile["status"]) => {
    switch (status) {
      case "encrypting":  return "ENCRYPTING";
      case "uploading":   return "UPLOADING";
      case "decrypting":  return "DECRYPTING";
      case "downloading": return "DOWNLOADING";
      case "error":       return "ERROR";
      case "done":        return "COMPLETE";
      case "cancelled":   return "CANCELLED";
      default:            return "";
    }
  };

  const isActiveTransfer = (status: FileTile["status"]) =>
    status === "uploading" || status === "downloading" ||
    status === "encrypting" || status === "decrypting";

  // ── Render ────────────────────────────

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6">
        {/* Upload Tile */}
        <Card
          className={`flex flex-col items-center justify-center p-6 border-2 border-dashed cursor-pointer bg-[#0f0f0f] text-white transition-all min-h-[240px] rounded-lg font-mono ${
            isDragOver
              ? "border-emerald-500 bg-emerald-500/5 scale-[1.02]"
              : "border-white/20 hover:border-white hover:bg-white/5"
          }`}
          onClick={handleUploadClick}
          onDragEnter={handleDragEnter}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUploadChange}
          />
          <UploadCloud
            size={48}
            className={`mb-4 transition-colors ${isDragOver ? "text-emerald-500" : "text-primary"}`}
          />
          <p className="font-semibold text-center text-sm">
            {isDragOver ? "Drop files here" : "Upload File"}
          </p>
          <p className="text-xs text-muted-foreground text-center mt-1">
            {isDragOver ? "Release to upload" : "Click or Drag & Drop"}
          </p>
        </Card>

        {/* Empty state */}
        {files.length === 0 && (
          <Card className="flex flex-col items-center justify-center p-6 bg-[#0f0f0f] border border-white/5 min-h-[240px] rounded-lg font-mono text-white col-span-full sm:col-span-1">
            <FolderOpen size={40} className="text-[#52525b] mb-3" />
            <p className="text-sm text-[#a1a1aa]">No files yet</p>
            <p className="text-xs text-[#52525b] mt-1">Upload files to get started</p>
          </Card>
        )}

        {/* File Tiles */}
        {files.map((f, index) => (
          <Card
            key={f.id}
            className="flex flex-col justify-between p-5 bg-[#0f0f0f] border border-white/10 min-h-[240px] rounded-lg hover:border-white/30 transition-all font-mono text-white animate-in fade-in slide-in-from-bottom-2 duration-300"
            style={{ animationDelay: `${index * 50}ms` }}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="p-2 bg-white/10 border border-white/10 text-white rounded flex-shrink-0">
                <FileIcon size={24} />
              </div>
              <div className="flex items-center gap-2">
                {mode === "password" && (
                  <LockKeyhole size={16} className="text-muted-foreground opacity-50" />
                )}
                {f.status === "idle" && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteFile(f.id);
                    }}
                    className="text-[#52525b] hover:text-red-400 transition-colors p-1"
                    title="Delete file"
                  >
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 overflow-hidden min-h-0">
              <p className="font-semibold text-sm truncate" title={f.name}>
                {f.name}
              </p>
              <p className="text-xs text-muted-foreground mt-1">{f.size}</p>
            </div>

            <div className="mt-4">
              {f.status === "idle" || f.status === "done" ? (
                <Button
                  variant="secondary"
                  size="sm"
                  className="w-full flex justify-center items-center space-x-2 text-xs h-9 bg-transparent border border-[#52525b] hover:border-white hover:text-white text-[#a1a1aa] rounded transition-all"
                  onClick={() => handleDownload(f.id)}
                >
                  <Download size={14} />
                  <span>{mode === "password" ? "Decrypt & Download" : "Download"}</span>
                </Button>
              ) : f.status === "error" ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-red-400 text-[10px]">
                    <AlertCircle size={12} />
                    <span className="truncate">{f.errorMessage || "Transfer failed"}</span>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="w-full text-xs h-8 bg-transparent border border-red-500/30 text-red-400 hover:border-red-400 rounded transition-all"
                    onClick={() => handleDownload(f.id)}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-[10px] text-[#a1a1aa] uppercase tracking-widest font-semibold">
                    <span>{getStatusLabel(f.status)}</span>
                    <div className="flex items-center gap-2">
                      <span>{f.progress}%</span>
                      {isActiveTransfer(f.status) && (
                        <button
                          onClick={() => handleCancel(f.id)}
                          title="Cancel transfer"
                          className="text-[#a1a1aa] hover:text-red-400 transition-colors"
                        >
                          <X size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="w-full bg-white/10 rounded-sm h-1.5 overflow-hidden">
                    <div
                      className={`h-1.5 rounded-sm transition-all duration-300 ${
                        f.status === "encrypting" || f.status === "decrypting"
                          ? "bg-amber-400"
                          : "bg-white"
                      }`}
                      style={{ width: `${f.progress}%` }}
                    />
                  </div>
                </div>
              )}
            </div>
          </Card>
        ))}
      </div>

      {/* Password Prompt Modal — only shown when file download needs manual password */}
      {passwordPromptFile && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setPasswordPromptFile(null);
              setTempPassword("");
              setDecryptionError(null);
            }
          }}
        >
          <div className="w-full max-w-sm border border-white/10 bg-[#0f0f0f] text-white rounded-lg animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 space-y-4">
              <div className="flex items-center space-x-2 text-[#f4f4f5]">
                <LockKeyhole size={20} />
                <h3 className="font-bold text-lg">Encrypted File</h3>
              </div>
              <p className="text-sm text-[#a1a1aa]">
                Enter the room password to decrypt and download this file.
              </p>

              {decryptionError && (
                <div className="p-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded flex items-center space-x-2">
                  <AlertCircle size={14} />
                  <span className="text-xs font-semibold">{decryptionError}</span>
                </div>
              )}

              <div className="pt-2">
                <input
                  type="password"
                  className="flex h-10 w-full rounded-md border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-white placeholder:text-[#52525b] focus:outline-none focus:border-white/30 font-mono transition-colors"
                  placeholder="Room Password"
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handlePasswordSubmit()}
                  autoFocus
                />
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  className="px-4 py-2 text-sm text-[#a1a1aa] hover:text-white transition-colors"
                  onClick={() => {
                    setPasswordPromptFile(null);
                    setTempPassword("");
                    setDecryptionError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 text-sm bg-white text-black font-semibold rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
                  onClick={handlePasswordSubmit}
                  disabled={!tempPassword.trim()}
                >
                  Unlock
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Upload Password Prompt Modal */}
      {uploadPasswordPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setUploadPasswordPrompt(false);
              setPendingUploads(null);
              setTempPassword("");
              setUploadPasswordError(null);
            }
          }}
        >
          <div className="w-full max-w-sm border border-white/10 bg-[#0f0f0f] text-white rounded-lg animate-in fade-in zoom-in-95 duration-200">
            <div className="p-6 space-y-4">
              <div className="flex items-center space-x-2 text-[#f4f4f5]">
                <LockKeyhole size={20} />
                <h3 className="font-bold text-lg">Encrypted Room</h3>
              </div>
              <p className="text-sm text-[#a1a1aa]">
                Enter the room password to authorize upload and encrypt the files.
              </p>

              {uploadPasswordError && (
                <div className="p-2 bg-red-500/10 text-red-400 border border-red-500/20 rounded flex items-center space-x-2">
                  <AlertCircle size={14} />
                  <span className="text-xs font-semibold">{uploadPasswordError}</span>
                </div>
              )}

              <div className="pt-2">
                <input
                  type="password"
                  className="flex h-10 w-full rounded-md border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-white placeholder:text-[#52525b] focus:outline-none focus:border-white/30 font-mono transition-colors"
                  placeholder="Room Password"
                  value={tempPassword}
                  onChange={(e) => setTempPassword(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && handleUploadPasswordSubmit()}
                  autoFocus
                />
              </div>
              <div className="flex justify-end space-x-3 pt-4">
                <button
                  className="px-4 py-2 text-sm text-[#a1a1aa] hover:text-white transition-colors"
                  onClick={() => {
                    setUploadPasswordPrompt(false);
                    setPendingUploads(null);
                    setTempPassword("");
                    setUploadPasswordError(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="px-4 py-2 text-sm bg-white text-black font-semibold rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
                  onClick={handleUploadPasswordSubmit}
                  disabled={!tempPassword.trim()}
                >
                  Confirm Upload
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
