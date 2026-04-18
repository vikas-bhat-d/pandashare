// crypto.ts - A frontend service for encryption/decryption using Web Crypto API.

const ALGO = "AES-GCM";
const PBKDF2_ITERATIONS = 100000;

export async function generateSalt(): Promise<Uint8Array> {
  return crypto.getRandomValues(new Uint8Array(16));
}

export async function generateBaseIV(): Promise<Uint8Array> {
  // AES-GCM standard IV is 12 bytes
  return crypto.getRandomValues(new Uint8Array(12));
}

export async function deriveKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: salt as BufferSource,
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: ALGO, length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

function getArrayBufferFromUint8Array(u8array: Uint8Array): ArrayBuffer {
  return u8array.buffer.slice(u8array.byteOffset, u8array.byteOffset + u8array.byteLength) as ArrayBuffer;
}

/**
 * Encrypt a chunk using the derived key and baseIV + chunkIndex
 */
export async function encryptChunk(
  buffer: ArrayBuffer,
  key: CryptoKey,
  chunkIndex: number,
  baseIV: Uint8Array
): Promise<ArrayBuffer> {
  // Compute iv per chunk: baseIV conceptually + chunkIndex?
  // We can just inject the chunkIndex into the last 4 bytes of the baseIV for simplicity.
  const iv = new Uint8Array(12);
  iv.set(baseIV);
  
  // Create a data view to manipulate bytes easily
  const view = new DataView(getArrayBufferFromUint8Array(iv));
  // Add chunkIndex to the last 4 bytes without overflowing
  const currentChunkBytes = view.getUint32(8);
  view.setUint32(8, currentChunkBytes + chunkIndex);

  return crypto.subtle.encrypt(
    {
      name: ALGO,
      iv: new Uint8Array(view.buffer),
    },
    key,
    buffer
  );
}

/**
 * Decrypt a chunk
 */
export async function decryptChunk(
  buffer: ArrayBuffer,
  key: CryptoKey,
  chunkIndex: number,
  baseIV: Uint8Array
): Promise<ArrayBuffer> {
  const iv = new Uint8Array(12);
  iv.set(baseIV);
  
  const view = new DataView(getArrayBufferFromUint8Array(iv));
  const currentChunkBytes = view.getUint32(8);
  view.setUint32(8, currentChunkBytes + chunkIndex);

  return crypto.subtle.decrypt(
    {
      name: ALGO,
      iv: new Uint8Array(view.buffer),
    },
    key,
    buffer
  );
}

export function generatePassword(length: number = 16): string {
    const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()_+";
    let password = "";
    const values = new Uint32Array(length);
    crypto.getRandomValues(values);
    for (let i = 0; i < length; i++) {
        password += charset[values[i] % charset.length];
    }
    return password;
}

export function generateRoomName(): string {
    const adjectives = ["Secure", "Swift", "Hidden", "Silent", "Fast", "Brave", "Calm", "Dark", "Epic"];
    const nouns = ["Panda", "Tiger", "Fox", "Wolf", "Bear", "Eagle", "Hawk", "Lion", "Shark"];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    const num = Math.floor(Math.random() * 1000);
    return `${adj}-${noun}-${num}`.toLowerCase();
}
