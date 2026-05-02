"use client";

import React, { useState, useCallback } from "react";
import {
  adminGetRooms,
  adminGetSnippets,
  adminExpireRoom,
  adminExpireAllRooms,
  adminExpireSnippet,
  adminExpireAllSnippets,
  adminGetLogFiles,
  adminGetLogContent,
  AdminRoomRecord,
  AdminSnippetRecord,
  LogFile,
  LogsPage,
} from "@/utils/api";
import { ApiError } from "@/utils/apiClient";
import { toast } from "sonner";
import { ShieldAlert, RefreshCw, Trash2, Clock, FileText, Terminal, Eye, EyeOff, BarChart3, AlertCircle } from "lucide-react";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isExpired(expiresAt: string) {
  return new Date(expiresAt) <= new Date();
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function timeUntil(iso: string) {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const h = Math.floor(diff / 3_600_000);
  const m = Math.floor((diff % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusBadge({ expiresAt }: { expiresAt: string }) {
  const expired = isExpired(expiresAt);
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-full ${
        expired
          ? "bg-red-500/10 text-red-400 border border-red-500/20"
          : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
      }`}
    >
      <Clock size={10} />
      {expired ? "expired" : timeUntil(expiresAt)}
    </span>
  );
}

function ModeBadge({ mode }: { mode: "password" | "public" }) {
  return (
    <span
      className={`inline-flex text-[10px] font-medium px-2 py-0.5 rounded-full ${
        mode === "password"
          ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
          : "bg-blue-500/10 text-blue-400 border border-blue-500/20"
      }`}
    >
      {mode}
    </span>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function AdminPage() {
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [authenticated, setAuthenticated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [currentTab, setCurrentTab] = useState<"rooms" | "snippets" | "logs">("rooms");

  const [rooms, setRooms] = useState<AdminRoomRecord[]>([]);
  const [snippets, setSnippets] = useState<AdminSnippetRecord[]>([]);
  const [expiringId, setExpiringId] = useState<string | null>(null);

  // ── Logs state ────────────────────────────────────────────────────────────
  const [logFiles, setLogFiles] = useState<LogFile[]>([]);
  const [selectedLogFile, setSelectedLogFile] = useState<string | null>(null);
  const [logContent, setLogContent] = useState<LogsPage | null>(null);
  const [logOffset, setLogOffset] = useState(0);

  // ── Fetch data ───────────────────────────────────────────────────────────

  const fetchData = useCallback(
    async (pwd: string) => {
      setLoading(true);
      try {
        const [r, s] = await Promise.all([
          adminGetRooms(pwd),
          adminGetSnippets(pwd),
        ]);
        setRooms(r);
        setSnippets(s);
        setAuthenticated(true);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          toast.error("Invalid admin password");
        } else {
          toast.error("Failed to connect to backend");
        }
        setAuthenticated(false);
      } finally {
        setLoading(false);
      }
    },
    []
  );

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.trim()) fetchData(password.trim());
  };

  // ── Logs actions ──────────────────────────────────────────────────────────

  const fetchLogs = useCallback(
    async (pwd: string) => {
      setLoading(true);
      try {
        const files = await adminGetLogFiles(pwd);
        setLogFiles(files);
        if (files.length > 0 && !selectedLogFile) {
          setSelectedLogFile(files[0].file);
          const content = await adminGetLogContent(pwd, files[0].file, 100, 0);
          setLogContent(content);
        }
      } catch {
        toast.error("Failed to load logs");
      } finally {
        setLoading(false);
      }
    },
    [selectedLogFile]
  );

  const loadLogContent = useCallback(
    async (filename: string) => {
      setLoading(true);
      try {
        const content = await adminGetLogContent(password, filename, 100, logOffset);
        setLogContent(content);
        setLogOffset(0);
      } catch {
        toast.error("Failed to load log content");
      } finally {
        setLoading(false);
      }
    },
    [password, logOffset]
  );

  // ── Expire actions ───────────────────────────────────────────────────────

  const expireRoom = async (id: string) => {
    setExpiringId(id);
    try {
      await adminExpireRoom(password, id);
      setRooms((prev) =>
        prev.map((r) => (r.id === id ? { ...r, expiresAt: new Date().toISOString() } : r))
      );
      toast.success("Room marked as expired — will be cleaned up shortly");
    } catch {
      toast.error("Failed to expire room");
    } finally {
      setExpiringId(null);
    }
  };

  const expireAllRooms = async () => {
    setLoading(true);
    try {
      const { count } = await adminExpireAllRooms(password);
      const now = new Date().toISOString();
      setRooms((prev) => prev.map((r) => ({ ...r, expiresAt: now })));
      toast.success(`${count} room(s) marked as expired`);
    } catch {
      toast.error("Failed to expire all rooms");
    } finally {
      setLoading(false);
    }
  };

  const expireSnippet = async (id: string) => {
    setExpiringId(id);
    try {
      await adminExpireSnippet(password, id);
      setSnippets((prev) =>
        prev.map((s) => (s.id === id ? { ...s, expiresAt: new Date().toISOString() } : s))
      );
      toast.success("Snippet marked as expired — will be cleaned up shortly");
    } catch {
      toast.error("Failed to expire snippet");
    } finally {
      setExpiringId(null);
    }
  };

  const expireAllSnippets = async () => {
    setLoading(true);
    try {
      const { count } = await adminExpireAllSnippets(password);
      const now = new Date().toISOString();
      setSnippets((prev) => prev.map((s) => ({ ...s, expiresAt: now })));
      toast.success(`${count} snippet(s) marked as expired`);
    } catch {
      toast.error("Failed to expire all snippets");
    } finally {
      setLoading(false);
    }
  };

  // ── Login form ────────────────────────────────────────────────────────────

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#0f0f0f] flex items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <div className="flex items-center justify-center gap-2 mb-8">
            <ShieldAlert size={20} className="text-amber-400" />
            <span className="text-white font-mono text-lg font-semibold tracking-tight">
              Admin Panel
            </span>
          </div>
          <form onSubmit={handleLogin} className="flex flex-col gap-4">
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Admin password"
                autoFocus
                className="w-full bg-[#1a1a1a] border border-white/5 rounded-md py-3 px-4 pr-10 text-white text-sm focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/20 transition-all placeholder:text-[#52525b]"
              />
              <button
                type="button"
                onClick={() => setShowPassword((v) => !v)}
                className="absolute inset-y-0 right-0 flex items-center pr-3 text-[#52525b] hover:text-white transition-colors"
              >
                {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
              </button>
            </div>
            <button
              type="submit"
              disabled={!password.trim() || loading}
              className="w-full bg-transparent border border-[#52525b] text-[#a1a1aa] py-3 rounded-md text-sm font-medium hover:text-white hover:border-white transition-colors disabled:opacity-50"
            >
              {loading ? "Authenticating…" : "Sign in"}
            </button>
          </form>
        </div>
      </div>
    );
  }

  // ── Dashboard ─────────────────────────────────────────────────────────────

  const activeRooms = rooms.filter((r) => !isExpired(r.expiresAt));
  const activeSnippets = snippets.filter((s) => !isExpired(s.expiresAt));

  return (
    <div className="min-h-screen bg-[#0f0f0f] text-white font-mono px-4 py-8">
      <div className="max-w-5xl mx-auto space-y-8">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShieldAlert size={18} className="text-amber-400" />
            <span className="text-sm font-semibold tracking-tight text-white">Admin Panel</span>
          </div>
          <button
            onClick={() => {
              if (currentTab === "logs") {
                fetchLogs(password);
              } else {
                fetchData(password);
              }
            }}
            disabled={loading}
            className="flex items-center gap-1.5 text-xs text-[#a1a1aa] hover:text-white transition-colors disabled:opacity-50"
          >
            <RefreshCw size={13} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-white/5">
          {[
            { id: "rooms", label: "Rooms", icon: Terminal },
            { id: "snippets", label: "Snippets", icon: FileText },
            { id: "logs", label: "Logs", icon: BarChart3 },
          ].map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => {
                setCurrentTab(id as any);
                if (id === "logs" && logFiles.length === 0) {
                  fetchLogs(password);
                }
              }}
              className={`flex items-center gap-1.5 text-xs font-medium py-3 px-3 border-b-2 transition-colors ${
                currentTab === id
                  ? "border-white text-white"
                  : "border-transparent text-[#a1a1aa] hover:text-white"
              }`}
            >
              <Icon size={13} />
              {label}
            </button>
          ))}
        </div>

        {/* Stats - only show for rooms/snippets tabs */}
        {currentTab !== "logs" && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {[
              { label: "Total rooms", value: rooms.length },
              { label: "Active rooms", value: activeRooms.length },
              { label: "Total snippets", value: snippets.length },
              { label: "Active snippets", value: activeSnippets.length },
            ].map(({ label, value }) => (
              <div
                key={label}
                className="bg-[#1a1a1a] border border-white/5 rounded-lg px-4 py-3"
              >
                <div className="text-xl font-semibold text-white">{value}</div>
                <div className="text-[11px] text-[#71717a] mt-0.5">{label}</div>
              </div>
            ))}
          </div>
        )}

        {/* Rooms table - only show on rooms tab */}
        {currentTab === "rooms" && (
          <section>
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm text-[#a1a1aa]">
              <Terminal size={14} />
              Rooms
              <span className="text-[#52525b]">({rooms.length})</span>
            </div>
            {rooms.length > 0 && (
              <button
                onClick={expireAllRooms}
                disabled={loading || activeRooms.length === 0}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-40"
              >
                <Trash2 size={12} />
                Expire all
              </button>
            )}
          </div>

          {rooms.length === 0 ? (
            <div className="text-xs text-[#52525b] border border-white/5 rounded-lg px-4 py-6 text-center">
              No rooms found
            </div>
          ) : (
            <div className="border border-white/5 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-[#52525b]">
                    <th className="text-left px-4 py-2.5 font-normal">Name</th>
                    <th className="text-left px-4 py-2.5 font-normal hidden sm:table-cell">Mode</th>
                    <th className="text-left px-4 py-2.5 font-normal hidden md:table-cell">Files</th>
                    <th className="text-left px-4 py-2.5 font-normal hidden lg:table-cell">Created</th>
                    <th className="text-left px-4 py-2.5 font-normal">Expires</th>
                    <th className="text-left px-4 py-2.5 font-normal">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {rooms.map((room, i) => (
                    <tr
                      key={room.id}
                      className={`${
                        i !== rooms.length - 1 ? "border-b border-white/5" : ""
                      } ${isExpired(room.expiresAt) ? "opacity-40" : ""}`}
                    >
                      <td className="px-4 py-3 text-white font-medium truncate max-w-35">
                        {room.name}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <ModeBadge mode={room.mode} />
                      </td>
                      <td className="px-4 py-3 text-[#a1a1aa] hidden md:table-cell">
                        {room._count.files}
                      </td>
                      <td className="px-4 py-3 text-[#71717a] hidden lg:table-cell">
                        {formatDate(room.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-[#71717a]">
                        {formatDate(room.expiresAt)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge expiresAt={room.expiresAt} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => expireRoom(room.id)}
                          disabled={expiringId === room.id || isExpired(room.expiresAt)}
                          className="flex items-center gap-1 text-[#71717a] hover:text-red-400 transition-colors disabled:opacity-30 ml-auto"
                          title="Expire now"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        )}

        {/* Snippets table - only show on snippets tab */}
        {currentTab === "snippets" && (
          <section>
            <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2 text-sm text-[#a1a1aa]">
              <FileText size={14} />
              Text Snippets
              <span className="text-[#52525b]">({snippets.length})</span>
            </div>
            {snippets.length > 0 && (
              <button
                onClick={expireAllSnippets}
                disabled={loading || activeSnippets.length === 0}
                className="flex items-center gap-1.5 text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-40"
              >
                <Trash2 size={12} />
                Expire all
              </button>
            )}
          </div>

          {snippets.length === 0 ? (
            <div className="text-xs text-[#52525b] border border-white/5 rounded-lg px-4 py-6 text-center">
              No snippets found
            </div>
          ) : (
            <div className="border border-white/5 rounded-lg overflow-hidden">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-white/5 text-[#52525b]">
                    <th className="text-left px-4 py-2.5 font-normal">Name</th>
                    <th className="text-left px-4 py-2.5 font-normal hidden sm:table-cell">Mode</th>
                    <th className="text-left px-4 py-2.5 font-normal hidden lg:table-cell">Created</th>
                    <th className="text-left px-4 py-2.5 font-normal">Expires</th>
                    <th className="text-left px-4 py-2.5 font-normal">Status</th>
                    <th className="px-4 py-2.5" />
                  </tr>
                </thead>
                <tbody>
                  {snippets.map((snippet, i) => (
                    <tr
                      key={snippet.id}
                      className={`${
                        i !== snippets.length - 1 ? "border-b border-white/5" : ""
                      } ${isExpired(snippet.expiresAt) ? "opacity-40" : ""}`}
                    >
                      <td className="px-4 py-3 text-white font-medium truncate max-w-35">
                        {snippet.name}
                      </td>
                      <td className="px-4 py-3 hidden sm:table-cell">
                        <ModeBadge mode={snippet.mode} />
                      </td>
                      <td className="px-4 py-3 text-[#71717a] hidden lg:table-cell">
                        {formatDate(snippet.createdAt)}
                      </td>
                      <td className="px-4 py-3 text-[#71717a]">
                        {formatDate(snippet.expiresAt)}
                      </td>
                      <td className="px-4 py-3">
                        <StatusBadge expiresAt={snippet.expiresAt} />
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => expireSnippet(snippet.id)}
                          disabled={expiringId === snippet.id || isExpired(snippet.expiresAt)}
                          className="flex items-center gap-1 text-[#71717a] hover:text-red-400 transition-colors disabled:opacity-30 ml-auto"
                          title="Expire now"
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        )}

        {/* Logs section - only show on logs tab */}
        {currentTab === "logs" && (
          <section className="space-y-4">
            <div className="flex items-center gap-2 text-sm text-[#a1a1aa] mb-4">
              <BarChart3 size={14} />
              Log Files
              <span className="text-[#52525b]">({logFiles.length})</span>
            </div>

            {logFiles.length === 0 ? (
              <div className="bg-[#1a1a1a] border border-white/5 rounded-lg px-4 py-8 text-center">
                <AlertCircle size={16} className="mx-auto mb-2 text-[#71717a]" />
                <p className="text-sm text-[#a1a1aa]">No logs found yet</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
                {/* Log files list */}
                <div className="lg:col-span-1">
                  <div className="bg-[#1a1a1a] border border-white/5 rounded-lg overflow-hidden max-h-96 overflow-y-auto">
                    {logFiles.map((file) => (
                      <button
                        key={file.file}
                        onClick={() => {
                          setSelectedLogFile(file.file);
                          setLogOffset(0);
                          loadLogContent(file.file);
                        }}
                        className={`w-full text-left px-4 py-3 text-xs border-b border-white/5 transition-colors ${
                          selectedLogFile === file.file
                            ? "bg-white/10 text-white"
                            : "text-[#a1a1aa] hover:text-white hover:bg-white/5"
                        }`}
                      >
                        <div className="font-medium">{file.file}</div>
                        <div className="text-[10px] text-[#71717a]">{file.lines} lines</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Log content */}
                <div className="lg:col-span-3">
                  {logContent ? (
                    <div className="space-y-4">
                      <div className="bg-[#1a1a1a] border border-white/5 rounded-lg overflow-hidden max-h-96 overflow-y-auto">
                        <table className="w-full text-[11px]">
                          <thead className="sticky top-0 bg-[#252525] border-b border-white/5">
                            <tr>
                              <th className="px-3 py-2 text-left font-semibold text-[#a1a1aa]">Time</th>
                              <th className="px-3 py-2 text-left font-semibold text-[#a1a1aa]">Level</th>
                              <th className="px-3 py-2 text-left font-semibold text-[#a1a1aa]">Message</th>
                            </tr>
                          </thead>
                          <tbody>
                            {logContent.lines.map((entry, idx) => (
                              <tr
                                key={idx}
                                className="border-b border-white/5 hover:bg-white/5 transition-colors"
                              >
                                <td className="px-3 py-2 text-[#71717a] whitespace-nowrap">
                                  {entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : "—"}
                                </td>
                                <td className="px-3 py-2">
                                  <span
                                    className={`px-2 py-0.5 rounded text-[10px] font-semibold ${
                                      entry.level === "ERROR"
                                        ? "bg-red-500/20 text-red-300"
                                        : entry.level === "WARN"
                                          ? "bg-amber-500/20 text-amber-300"
                                          : entry.level === "INFO"
                                            ? "bg-blue-500/20 text-blue-300"
                                            : "bg-gray-500/20 text-gray-300"
                                    }`}
                                  >
                                    {entry.level || "INFO"}
                                  </span>
                                </td>
                                <td className="px-3 py-2 text-white break-words max-w-md">
                                  {entry.message || entry.raw || "—"}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>

                      {/* Pagination */}
                      <div className="flex items-center justify-between text-[11px] text-[#a1a1aa]">
                        <span>
                          Lines {logContent.offset + 1}-
                          {Math.min(logContent.offset + logContent.lines.length, logContent.total)}
                          {" "}
                          of {logContent.total}
                        </span>
                        <div className="flex gap-2">
                          <button
                            onClick={() => {
                              setLogOffset(Math.max(0, logOffset - 100));
                              loadLogContent(selectedLogFile!);
                            }}
                            disabled={logOffset === 0 || loading}
                            className="px-3 py-1.5 bg-white/10 rounded text-[#a1a1aa] hover:text-white disabled:opacity-40 transition-colors"
                          >
                            Previous
                          </button>
                          <button
                            onClick={() => {
                              if (logContent.offset + 100 < logContent.total) {
                                setLogOffset(logOffset + 100);
                                loadLogContent(selectedLogFile!);
                              }
                            }}
                            disabled={logOffset + 100 >= logContent.total || loading}
                            className="px-3 py-1.5 bg-white/10 rounded text-[#a1a1aa] hover:text-white disabled:opacity-40 transition-colors"
                          >
                            Next
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="bg-[#1a1a1a] border border-white/5 rounded-lg px-4 py-8 text-center">
                      <p className="text-sm text-[#a1a1aa]">Select a log file to view</p>
                    </div>
                  )}
                </div>
              </div>
            )}
          </section>
        )}

        {/* Footer note */}
        <p className="text-[11px] text-[#52525b] text-center pb-4">
          Expired items are permanently deleted on the next cleanup cycle (every 15 min).
          Room S3 files are also deleted at that point. Logs are retained for debugging.
        </p>
      </div>
    </div>
  );
}
