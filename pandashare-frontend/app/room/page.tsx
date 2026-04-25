"use client";

import React, { useEffect, useState, useCallback } from "react";
import { getRoom, updateRoomExpiry, getRoomFiles, RoomMetadata, FileMetadata } from "@/utils/api";
import { computeVerifier } from "@/utils/crypto";
import { cleanupStaleUploads } from "@/utils/uploadPipeline";
import { RoomFilesGrid } from "@/components/RoomFilesGrid";
import { Shield, Clock, Copy, ArrowLeft, LockKeyhole, AlertCircle, Globe } from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

type UnlockState =
  | { phase: "loading" }
  | { phase: "password-prompt" }
  | { phase: "unlocked"; files: FileMetadata[]; verifier: string }
  | { phase: "not-found" }
  | { phase: "error"; message: string };

export default function RoomPage() {
  const [roomId, setRoomId] = useState<string>("");
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [unlockState, setUnlockState] = useState<UnlockState>({ phase: "loading" });

  // Expiry state
  const [expiryHours, setExpiryHours] = useState<number>(24);
  const [isUpdatingExpiry, setIsUpdatingExpiry] = useState(false);

  // Password prompt state
  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied to clipboard");
  };

  const loadRoom = useCallback(async () => {
    setUnlockState({ phase: "loading" });

    let hash = "";
    if (typeof window !== "undefined" && window.location.hash) {
      hash = window.location.hash.substring(1);
    }

    if (!hash) {
      setUnlockState({ phase: "not-found" });
      return;
    }

    const separatorIndex = hash.indexOf("|");
    let idOrName = hash;
    let urlPwd = "";
    if (separatorIndex !== -1) {
      idOrName = hash.substring(0, separatorIndex);
      urlPwd = hash.substring(separatorIndex + 1);
    }

    try {
      idOrName = decodeURIComponent(idOrName);
      if (urlPwd) urlPwd = decodeURIComponent(urlPwd);
    } catch (_e) {}

    setRoomId(idOrName);

    // Fetch room metadata (no files for password rooms)
    const data = await getRoom(idOrName);
    if (!data) {
      setUnlockState({ phase: "not-found" });
      return;
    }

    setRoom(data);

    // Calculate hours elapsed from creation → expiry (so dropdown shows hours-from-creation)
    const createdMs = new Date(data.createdAt).getTime();
    const expiresMs = new Date(data.expiresAt).getTime();
    const hoursFromCreation = Math.round((expiresMs - createdMs) / (1000 * 60 * 60));
    // Clamp to valid options: 1,4,12,24,48
    const validOptions = [1, 4, 12, 24, 48];
    const nearest = validOptions.reduce((prev, cur) =>
      Math.abs(cur - hoursFromCreation) < Math.abs(prev - hoursFromCreation) ? cur : prev
    );
    setExpiryHours(nearest);

    // Public room — files already in response
    if (data.mode === "public") {
      setUnlockState({ phase: "unlocked", files: data.files, verifier: "" });
      return;
    }

    // Password room — try to auto-unlock with URL password
    if (urlPwd && data.salt && data.baseIV) {
      const verifier = await computeVerifier(data.name, urlPwd);
      const files = await getRoomFiles(idOrName, verifier);
      if (files !== null) {
        setUnlockState({ phase: "unlocked", files, verifier });
        return;
      }
    }

    // Need user to enter password
    setUnlockState({ phase: "password-prompt" });
  }, []);

  useEffect(() => {
    loadRoom();
    // Abort any multipart upload abandoned by a previous page load (refresh / tab close)
    cleanupStaleUploads().catch(() => {});
    const handleHashChange = () => loadRoom();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, [loadRoom]);

  const handleUnlock = async () => {
    if (!passwordInput.trim() || !room) return;
    setIsUnlocking(true);
    setPasswordError(null);

    try {
      const verifier = await computeVerifier(room.name, passwordInput.trim());
      const files = await getRoomFiles(roomId, verifier);
      if (files === null) {
        setPasswordError("Incorrect password. Please try again.");
      } else {
        setUnlockState({ phase: "unlocked", files, verifier });
      }
    } catch (err) {
      setPasswordError("Failed to verify password. Please try again.");
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleExpiryChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newHours = parseInt(e.target.value);
    if (!room) return;
    setExpiryHours(newHours);
    setIsUpdatingExpiry(true);
    const result = await updateRoomExpiry(room.id, newHours);
    setIsUpdatingExpiry(false);
    setRoom({
      ...room,
      expiresAt: result.expiresAt,
    });
  };

  // ── Loading state ──────────────────────────────────────────────────────────

  if (unlockState.phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono">
        <div className="flex flex-col items-center space-y-4">
          <div className="relative">
            <Shield size={48} className="text-[#a1a1aa] animate-pulse" />
            <div className="absolute inset-0 animate-ping">
              <Shield size={48} className="text-[#a1a1aa] opacity-20" />
            </div>
          </div>
          <p className="text-[#a1a1aa] text-sm">Loading room environment...</p>
          <div className="mt-8 grid grid-cols-3 gap-4 opacity-20">
            {[1, 2, 3].map((i) => (
              <div key={i} className="w-32 h-40 rounded-lg bg-white/5 animate-pulse" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Not found ──────────────────────────────────────────────────────────────

  if (unlockState.phase === "not-found") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono">
        <div className="text-center space-y-4 border border-white/10 p-8 bg-[#0f0f0f] rounded-lg max-w-md">
          <h1 className="text-3xl font-bold text-red-500">Room Not Found</h1>
          <p className="text-[#a1a1aa]">The room might have expired, or the URL is invalid.</p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 mt-4 text-sm text-[#a1a1aa] hover:text-white transition-colors border border-white/10 px-4 py-2 rounded hover:border-white/30"
          >
            <ArrowLeft size={14} />
            <span>Back to Home</span>
          </Link>
        </div>
      </div>
    );
  }

  // ── Password prompt ────────────────────────────────────────────────────────

  if (unlockState.phase === "password-prompt" && room) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono p-4">
        <div className="w-full max-w-sm border border-white/10 bg-[#0f0f0f] rounded-lg animate-in fade-in zoom-in-95 duration-200">
          <div className="p-6 space-y-5">
            {/* Header */}
            <div className="flex items-center space-x-3">
              <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded">
                <LockKeyhole size={20} className="text-emerald-400" />
              </div>
              <div>
                <h1 className="font-bold text-lg text-white">Encrypted Room</h1>
                <p className="text-xs text-[#a1a1aa]">{room.name}</p>
              </div>
            </div>

            <p className="text-sm text-[#a1a1aa]">
              This room is password-protected. Enter the room password to decrypt and access files.
            </p>

            {passwordError && (
              <div className="p-3 bg-red-500/10 text-red-400 border border-red-500/20 rounded flex items-center space-x-2">
                <AlertCircle size={14} />
                <span className="text-xs font-semibold">{passwordError}</span>
              </div>
            )}

            <input
              type="password"
              className="flex h-10 w-full rounded-md border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-white placeholder:text-[#52525b] focus:outline-none focus:border-white/30 font-mono transition-colors"
              placeholder="Room password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              autoFocus
            />

            <div className="flex justify-between items-center pt-2">
              <Link
                href="/"
                className="text-sm text-[#a1a1aa] hover:text-white transition-colors flex items-center gap-1.5"
              >
                <ArrowLeft size={14} />
                Back
              </Link>
              <button
                className="px-5 py-2 text-sm bg-white text-black font-semibold rounded hover:bg-gray-200 transition-colors disabled:opacity-50 flex items-center gap-2"
                onClick={handleUnlock}
                disabled={!passwordInput.trim() || isUnlocking}
              >
                {isUnlocking ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                    Verifying…
                  </>
                ) : (
                  "Unlock"
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  
  // ── Unlocked room ──────────────────────────────────────────────────────────

  if (unlockState.phase !== "unlocked" || !room) return null;

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f4f4f5] font-mono selection:bg-white/20 p-4 sm:p-8">
      {/* Top Header */}
      <header className="flex flex-col sm:flex-row justify-between items-center mb-10 max-w-7xl mx-auto gap-4">
        <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity cursor-pointer text-white">
          <span className="text-2xl font-bold tracking-tight">pandashare</span>
        </Link>

        <button
          onClick={handleCopy}
          className="bg-transparent border border-[#52525b] text-[#a1a1aa] hover:text-white hover:border-white rounded text-xs px-4 py-2 transition-all flex items-center space-x-2"
        >
          <Copy size={14} />
          <span>Copy Link</span>
        </button>
      </header>

      <main className="max-w-7xl mx-auto space-y-12">
        <div className="text-center space-y-2 mb-8">
          <h1 className="text-4xl font-bold tracking-tight text-white">{room.name}</h1>
          <div className="flex flex-wrap items-center justify-center gap-3 text-sm mt-3">
            <span
              className={`inline-flex items-center gap-2 border font-mono px-3 py-1 rounded-sm text-xs tracking-wide ${
                room.mode === "password"
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/20"
              }`}
            >
              {room.mode === "password" ? (
                <LockKeyhole size={12} className="shrink-0" />
              ) : (
                <Globe size={12} className="shrink-0" />
              )}
              {room.mode === "password" ? "ENCRYPTED" : "PUBLIC"}
            </span>

            {/* Expiry Settings */}
            <div className="flex flex-col items-center gap-1">
              <div className="flex items-center space-x-2 bg-[#121212] border border-white/10 text-[#a1a1aa] px-3 py-1.5 rounded-sm shadow-sm">
                <Clock size={14} className={isUpdatingExpiry ? "animate-spin text-white" : ""} />
                <span className="font-medium text-xs">Expires in:</span>
                <select
                  className="bg-transparent font-semibold outline-none cursor-pointer text-xs focus:ring-0 text-white"
                  value={expiryHours}
                  onChange={handleExpiryChange}
                  disabled={isUpdatingExpiry}
                >
                  <option value={1} className="text-[#f4f4f5] bg-[#121212]">1 hour</option>
                  <option value={4} className="text-[#f4f4f5] bg-[#121212]">4 hours</option>
                  <option value={12} className="text-[#f4f4f5] bg-[#121212]">12 hours</option>
                  <option value={24} className="text-[#f4f4f5] bg-[#121212]">24 hours</option>
                  <option value={48} className="text-[#f4f4f5] bg-[#121212]">48 hours (Max)</option>
                </select>
              </div>
              <span className="text-[10px] text-[#52525b]">
                {new Date(room.expiresAt).toLocaleString("en-IN", {
                  timeZone: "Asia/Kolkata",
                  day: "2-digit",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                  hour12: true,
                })}{" "}IST
              </span>
            </div>
          </div>
        </div>

        {/* File Grid */}
        <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
          <RoomFilesGrid
            roomId={room.id}
            roomName={room.name}
            mode={room.mode}
            verifier={unlockState.verifier}
            salt={room.salt}
            baseIV={room.baseIV}
            initialFiles={unlockState.files}
            // For password rooms, provide the decryption password via URL hash
            urlPassword={
              room.mode === "password" && typeof window !== "undefined"
                ? (() => {
                    const hash = window.location.hash.substring(1);
                    const sep = hash.indexOf("|");
                    return sep !== -1 ? decodeURIComponent(hash.substring(sep + 1)) : "";
                  })()
                : ""
            }
          />
        </div>
      </main>
    </div>
  );
}
