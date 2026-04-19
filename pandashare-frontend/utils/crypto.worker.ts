/// <reference lib="webworker" />
// Runs entirely in a Web Worker thread — keeps the main thread free to
// handle React renders and user interactions during upload.
//
// Protocol:
//   Main → Worker  { type:"init",    password, salt: ArrayBuffer, baseIV: ArrayBuffer }
//   Worker → Main  { type:"ready" }  |  { type:"error", message }
//
//   Main → Worker  { type:"encrypt", id, buffer: ArrayBuffer, chunkIndex }  [buffer transferred]
//   Worker → Main  { type:"done",    id, buffer: ArrayBuffer }              [buffer transferred]
//                | { type:"error",   id, message }

const ALGO = "AES-GCM" as const;
const PBKDF2_ITERATIONS = 100_000;

type InMsg =
  | { type: "init"; password: string; salt: ArrayBuffer; baseIV: ArrayBuffer }
  | { type: "encrypt"; id: number; buffer: ArrayBuffer; chunkIndex: number };

let key: CryptoKey | null = null;
let baseIV: Uint8Array | null = null;

/** Build the per-chunk IV — must match the logic in crypto.ts exactly. */
function makeIV(chunkIndex: number): ArrayBuffer {
  const buf = new ArrayBuffer(12);
  const iv = new Uint8Array(buf);
  iv.set(baseIV!);
  // Add chunkIndex to the last 4 bytes (big-endian), matching encryptChunk() in crypto.ts
  const view = new DataView(buf);
  view.setUint32(8, view.getUint32(8) + chunkIndex);
  return buf;
}

self.onmessage = async ({ data }: MessageEvent<InMsg>) => {
  if (data.type === "init") {
    try {
      const enc = new TextEncoder();
      const raw = await crypto.subtle.importKey(
        "raw",
        enc.encode(data.password),
        { name: "PBKDF2" },
        false,
        ["deriveKey"]
      );
      key = await crypto.subtle.deriveKey(
        { name: "PBKDF2", salt: data.salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
        raw,
        { name: ALGO, length: 256 },
        false,
        ["encrypt"]
      );
      baseIV = new Uint8Array(data.baseIV);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", message: String(err) });
    }
    return;
  }

  if (data.type === "encrypt") {
    if (!key || !baseIV) {
      self.postMessage({ type: "error", id: data.id, message: "Worker not initialized" });
      return;
    }
    try {
      const iv = makeIV(data.chunkIndex);
      // data.buffer arrives as ArrayBuffer (transferred); cast plain for BufferSource compat
      const plain = data.buffer as ArrayBuffer;
      const encrypted = await crypto.subtle.encrypt({ name: ALGO, iv }, key, plain);
      // Transfer the result back — zero-copy, worker releases the buffer
      self.postMessage({ type: "done", id: data.id, buffer: encrypted }, [encrypted]);
    } catch (err) {
      self.postMessage({ type: "error", id: data.id, message: String(err) });
    }
  }
};
