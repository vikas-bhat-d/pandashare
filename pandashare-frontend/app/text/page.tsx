"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import {
  createSnippet,
  getSnippet,
  getSnippetContent,
  updateSnippetContent,
  updateSnippetExpiry,
  SnippetMetadata,
  fromBase64,
  toBase64,
} from "@/utils/api";
import { computeVerifier, generateSalt, generateBaseIV } from "@/utils/crypto";
import {
  FileText,
  Clock,
  Copy,
  ArrowLeft,
  LockKeyhole,
  AlertCircle,
  ShieldCheck,
  Globe,
  CheckCheck,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import Link from "next/link";

// ── Crypto helpers ──────────────────────────────────────────────────────────

async function encryptText(
  plaintext: string,
  password: string,
  salt: Uint8Array,
  baseIV: Uint8Array
): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt"]
  );
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: baseIV as BufferSource },
    key,
    enc.encode(plaintext)
  );
  return toBase64(new Uint8Array(ciphertext));
}

async function decryptText(
  ciphertextB64: string,
  password: string,
  saltB64: string,
  ivB64: string
): Promise<string> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const saltBytes = fromBase64(saltB64);
  const ivBytes = fromBase64(ivB64);
  const cipherBytes = fromBase64(ciphertextB64);
  const keyMaterial = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  const key = await crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBytes as BufferSource, iterations: 100000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"]
  );
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes as BufferSource },
    key,
    cipherBytes as BufferSource
  );
  return dec.decode(plaintext);
}

type Phase = "loading" | "new" | "password-prompt" | "editor" | "no-hash";
type SaveState = "idle" | "saving" | "saved" | "unsaved";

const MAX_CHARS = 100_000;
const AUTOSAVE_DELAY_MS = 1500;

export default function TextPage() {
  const [phase, setPhase] = useState<Phase>("loading");

  const [snippetName, setSnippetName] = useState("");
  const [password, setPassword] = useState("");

  const [snippet, setSnippet] = useState<SnippetMetadata | null>(null);

  const [text, setText] = useState("");
  const [expiryDays, setExpiryDays] = useState(1);
  const [isUpdatingExpiry, setIsUpdatingExpiry] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [copied, setCopied] = useState(false);

  const [passwordInput, setPasswordInput] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [isUnlocking, setIsUnlocking] = useState(false);

  const isCreatedRef = useRef(false);
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const latestRef = useRef({ text, snippet, password, snippetName, expiryDays, phase });
  useEffect(() => {
    latestRef.current = { text, snippet, password, snippetName, expiryDays, phase };
  });

  const loadFromHash = useCallback(async () => {
    setPhase("loading");
    const hash =
      typeof window !== "undefined" ? window.location.hash.substring(1) : "";

    if (!hash) {
      setPhase("no-hash");
      return;
    }

    const sepIdx = hash.indexOf("|");
    let name = hash;
    let pwd = "";
    if (sepIdx !== -1) {
      name = hash.substring(0, sepIdx);
      pwd = hash.substring(sepIdx + 1);
    }
    try {
      name = decodeURIComponent(name);
      if (pwd) pwd = decodeURIComponent(pwd);
    } catch (_e) {}

    setSnippetName(name);
    setPassword(pwd);

    const data = await getSnippet(name).catch(() => null);

    if (!data) {
      isCreatedRef.current = false;
      setSnippet(null);
      setText("");
      setSaveState("idle");
      setPhase("new");
      return;
    }

    isCreatedRef.current = true;
    setSnippet(data);

    const createdMs = new Date(data.createdAt).getTime();
    const expiresMs = new Date(data.expiresAt).getTime();
    const days = Math.round((expiresMs - createdMs) / (1000 * 60 * 60 * 24));
    const validOptions = [1, 3, 7, 14, 30];
    setExpiryDays(
      validOptions.reduce((prev, cur) =>
        Math.abs(cur - days) < Math.abs(prev - days) ? cur : prev
      )
    );

    if (data.mode === "public") {
      const content = await getSnippetContent(name).catch(() => null);
      setText(content ?? "");
      setSaveState("idle");
      setPhase("editor");
      return;
    }

    if (pwd && data.salt && data.baseIV) {
      try {
        const verifier = await computeVerifier(data.name, pwd);
        const ciphertext = await getSnippetContent(name, verifier);
        if (ciphertext !== null) {
          const plaintext = await decryptText(ciphertext, pwd, data.salt, data.baseIV);
          setText(plaintext);
          setSaveState("idle");
          setPhase("editor");
          return;
        }
      } catch (_e) {}
    }

    setPhase("password-prompt");
  }, []);

  useEffect(() => {
    loadFromHash();
    const onHashChange = () => loadFromHash();
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [loadFromHash]);

  const doSave = useCallback(async () => {
    const { text: t, snippet: s, password: pwd, snippetName: name, expiryDays: expiry, phase: p } =
      latestRef.current;

    if (p !== "editor" && p !== "new") return;
    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
      autoSaveTimerRef.current = null;
    }

    setSaveState("saving");
    const isPassword = !!pwd;

    try {
      const buildPayload = async () => {
        if (isPassword) {
          const saltBytes = await generateSalt();
          const ivBytes = await generateBaseIV();
          const salt = toBase64(saltBytes);
          const baseIV = toBase64(ivBytes);
          const content = await encryptText(t, pwd, saltBytes, ivBytes);
          const verifier = await computeVerifier(name.toLowerCase(), pwd);
          return { content, salt, baseIV, verifier };
        }
        return { content: t, salt: undefined, baseIV: undefined, verifier: undefined };
      };

      if (!isCreatedRef.current) {
        if (!t.trim()) {
          setSaveState("idle");
          return;
        }
        const { content, salt, baseIV, verifier } = await buildPayload();
        const created = await createSnippet({
          name,
          mode: isPassword ? "password" : "public",
          content,
          salt,
          baseIV,
          verifier,
          expiresInDays: expiry,
        });
        setSnippet(created);
        isCreatedRef.current = true;
        setPhase("editor");
      } else {
        if (!s) return;
        const { content, salt, baseIV, verifier } = await buildPayload();
        const updated = await updateSnippetContent(s.id, content, verifier, salt, baseIV);
        setSnippet(updated);
      }

      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch (e) {
      console.error(e);
      setSaveState("unsaved");
      toast.error("Save failed — please try again.");
    }
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        doSave();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [doSave]);

  const handleTextChange = (val: string) => {
    if (val.length > MAX_CHARS) return;
    setText(val);
    setSaveState("unsaved");
    if (autoSaveTimerRef.current) clearTimeout(autoSaveTimerRef.current);
    autoSaveTimerRef.current = setTimeout(() => doSave(), AUTOSAVE_DELAY_MS);
  };

  const handleExpiryChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
    const newDays = parseInt(e.target.value);
    setExpiryDays(newDays);
    if (!snippet) return;
    setIsUpdatingExpiry(true);
    try {
      const result = await updateSnippetExpiry(snippet.id, newDays);
      setSnippet({ ...snippet, expiresAt: result.expiresAt });
    } finally {
      setIsUpdatingExpiry(false);
    }
  };

  const handleUnlock = async () => {
    if (!passwordInput.trim() || !snippet) return;
    setIsUnlocking(true);
    setPasswordError(null);
    try {
      const verifier = await computeVerifier(snippet.name, passwordInput.trim());
      const ciphertext = await getSnippetContent(snippet.name, verifier);
      if (ciphertext === null) {
        setPasswordError("Incorrect password. Please try again.");
      } else if (snippet.salt && snippet.baseIV) {
        const plaintext = await decryptText(
          ciphertext, passwordInput.trim(), snippet.salt, snippet.baseIV
        );
        setPassword(passwordInput.trim());
        setText(plaintext);
        setSaveState("idle");
        setPhase("editor");
      }
    } catch (_err) {
      setPasswordError("Incorrect password or decryption failed.");
    } finally {
      setIsUnlocking(false);
    }
  };

  const handleCopyLink = () => {
    navigator.clipboard.writeText(window.location.href);
    toast.success("Link copied!");
  };

  const handleCopyText = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    toast.success("Copied!");
    setTimeout(() => setCopied(false), 2000);
  };

  if (phase === "loading") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono">
        <FileText size={32} className="text-[#a1a1aa] animate-pulse" />
      </div>
    );
  }

  if (phase === "no-hash") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono">
        <div className="text-center space-y-4 border border-white/10 p-8 bg-[#0f0f0f] rounded-lg max-w-md">
          <h1 className="text-2xl font-bold">No snippet name</h1>
          <p className="text-[#a1a1aa] text-sm">Go back and enter a snippet name first.</p>
          <Link
            href="/"
            className="inline-flex items-center gap-2 mt-4 text-sm text-[#a1a1aa] hover:text-white transition-colors border border-white/10 px-4 py-2 rounded hover:border-white/30"
          >
            <ArrowLeft size={14} />
            Back to Home
          </Link>
        </div>
      </div>
    );
  }

  if (phase === "password-prompt" && snippet) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono p-4">
        <div className="w-full max-w-sm border border-white/10 bg-[#0f0f0f] rounded-lg animate-in fade-in zoom-in-95 duration-200">
          <div className="p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded">
                <LockKeyhole size={20} className="text-emerald-400" />
              </div>
              <div>
                <h1 className="font-bold text-lg text-white">Encrypted Snippet</h1>
                <p className="text-xs text-[#a1a1aa]">{snippet.name}</p>
              </div>
            </div>
            <p className="text-sm text-[#a1a1aa]">
              Enter the password to decrypt and edit this snippet.
            </p>
            {passwordError && (
              <div className="p-3 bg-red-500/10 text-red-400 border border-red-500/20 rounded flex items-center gap-2">
                <AlertCircle size={14} />
                <span className="text-xs font-semibold">{passwordError}</span>
              </div>
            )}
            <input
              type="password"
              className="flex h-10 w-full rounded-md border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-white placeholder:text-[#52525b] focus:outline-none focus:border-white/30 font-mono transition-colors"
              placeholder="Snippet password"
              value={passwordInput}
              onChange={(e) => setPasswordInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleUnlock()}
              autoFocus
            />
            <div className="flex justify-between items-center pt-2">
              <Link href="/" className="text-sm text-[#a1a1aa] hover:text-white transition-colors flex items-center gap-1.5">
                <ArrowLeft size={14} /> Back
              </Link>
              <button
                className="px-5 py-2 text-sm bg-white text-black font-semibold rounded hover:bg-gray-200 transition-colors disabled:opacity-50 flex items-center gap-2"
                onClick={handleUnlock}
                disabled={!passwordInput.trim() || isUnlocking}
              >
                {isUnlocking ? (
                  <>
                    <span className="inline-block w-3 h-3 border-2 border-black/30 border-t-black rounded-full animate-spin" />
                    Decrypting…
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

  const isEncrypted = !!password;
  const isNew = phase === "new";

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f4f4f5] font-mono selection:bg-white/20 flex flex-col">
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <Link href="/" className="text-2xl font-bold tracking-tight text-white hover:opacity-80 transition-opacity">
          pandashare
        </Link>
        <div className="flex items-center gap-4">
          <span className="text-xs min-w-[72px] text-right">
            {saveState === "saving" && (
              <span className="text-[#a1a1aa] flex items-center justify-end gap-1.5">
                <Loader2 size={11} className="animate-spin" /> Saving…
              </span>
            )}
            {saveState === "saved" && (
              <span className="text-emerald-400 flex items-center justify-end gap-1.5">
                <CheckCheck size={12} /> Saved
              </span>
            )}
            {saveState === "unsaved" && (
              <span className="text-amber-400">Unsaved</span>
            )}
          </span>
          <button
            onClick={handleCopyLink}
            className="bg-transparent border border-[#52525b] text-[#a1a1aa] hover:text-white hover:border-white rounded text-xs px-4 py-2 transition-all flex items-center gap-2"
          >
            <Copy size={14} /> Copy Link
          </button>
        </div>
      </nav>

      <main className="flex-1 max-w-4xl mx-auto w-full px-6 py-8 flex flex-col gap-5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-3 justify-between">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-white tracking-tight">{snippetName}</h1>
            <span
              className={`inline-flex items-center gap-1.5 border font-mono px-2 py-0.5 rounded-sm text-xs ${
                isEncrypted
                  ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
                  : "bg-amber-500/10 text-amber-400 border-amber-500/20"
              }`}
            >
              {isEncrypted ? <ShieldCheck size={10} /> : <Globe size={10} />}
              {isEncrypted ? "ENCRYPTED" : "PUBLIC"}
            </span>
            {isNew && (
              <span className="text-xs text-[#52525b] border border-white/5 px-2 py-0.5 rounded-sm">
                New · not saved yet
              </span>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5 bg-[#121212] border border-white/10 px-3 py-1.5 rounded-sm text-xs text-[#a1a1aa]">
              <Clock size={12} className={isUpdatingExpiry ? "animate-spin text-white" : ""} />
              <select
                value={expiryDays}
                onChange={handleExpiryChange}
                disabled={isUpdatingExpiry}
                className="bg-transparent text-white outline-none cursor-pointer"
              >
                <option value={1} className="bg-[#121212]">1 day</option>
                <option value={3} className="bg-[#121212]">3 days</option>
                <option value={7} className="bg-[#121212]">7 days</option>
                <option value={14} className="bg-[#121212]">14 days</option>
                <option value={30} className="bg-[#121212]">30 days (Max)</option>
              </select>
            </div>
            <button
              onClick={handleCopyText}
              className="flex items-center gap-1.5 text-xs text-[#a1a1aa] hover:text-white transition-colors border border-white/10 hover:border-white/30 px-3 py-1.5 rounded-sm"
            >
              <Copy size={12} /> {copied ? "Copied!" : "Copy text"}
            </button>
          </div>
        </div>

        {snippet && (
          <p className="text-[10px] text-[#3f3f46] -mt-2">
            Expires{" "}
            {new Date(snippet.expiresAt).toLocaleString("en-IN", {
              timeZone: "Asia/Kolkata",
              day: "2-digit",
              month: "short",
              hour: "2-digit",
              minute: "2-digit",
              hour12: true,
            })}{" "}
            IST
          </p>
        )}

        <div className="relative flex-1">
          <textarea
            autoFocus
            value={text}
            onChange={(e) => handleTextChange(e.target.value)}
            placeholder={
              isNew
                ? "Start typing… saves automatically (or Ctrl+S)"
                : "Edit your text… saves automatically (or Ctrl+S)"
            }
            className="w-full min-h-[60vh] bg-[#0f0f0f] border border-white/10 rounded-lg px-5 py-4 text-sm text-[#f4f4f5] placeholder:text-[#3f3f46] resize-none focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/10 transition-all font-mono leading-relaxed"
          />
          <span
            className={`absolute bottom-3 right-3 text-[10px] pointer-events-none ${
              text.length > MAX_CHARS * 0.9 ? "text-amber-400" : "text-[#3f3f46]"
            }`}
          >
            {text.length.toLocaleString()} / {MAX_CHARS.toLocaleString()}
          </span>
        </div>

        <div className="flex items-center justify-between">
          <Link href="/" className="text-sm text-[#a1a1aa] hover:text-white transition-colors flex items-center gap-1.5">
            <ArrowLeft size={14} /> Back
          </Link>
          <p className="text-xs text-[#3f3f46]">Auto-saves after 1.5s · Ctrl+S to save now</p>
        </div>
      </main>
    </div>
  );
}
