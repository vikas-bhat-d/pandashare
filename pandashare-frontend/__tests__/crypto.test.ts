/**
 * Tests for the frontend crypto utility (utils/crypto.ts).
 *
 * All functions use the Web Crypto API (crypto.subtle + crypto.getRandomValues).
 * In Node 18+, these are available on globalThis.crypto, so no polyfill is needed.
 *
 * Covered:
 *  - generateSalt / generateBaseIV
 *  - deriveKey
 *  - encryptChunk / decryptChunk (roundtrip, wrong key, wrong chunkIndex)
 *  - computeVerifier (determinism, format)
 *  - generatePassword (length, character set)
 *  - generateRoomName (format pattern)
 */
import { describe, it, expect } from "vitest";
import {
  generateSalt,
  generateBaseIV,
  deriveKey,
  encryptChunk,
  decryptChunk,
  computeVerifier,
  generatePassword,
  generateRoomName,
} from "../utils/crypto";

// ── generateSalt ──────────────────────────────────────────────────────────────
describe("generateSalt", () => {
  it("returns a Uint8Array of exactly 16 bytes", async () => {
    const salt = await generateSalt();
    expect(salt).toBeInstanceOf(Uint8Array);
    expect(salt.byteLength).toBe(16);
  });

  it("produces a different value on each call (random)", async () => {
    const a = await generateSalt();
    const b = await generateSalt();
    // Probability of collision is 1 / 2^128 — effectively impossible.
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ── generateBaseIV ────────────────────────────────────────────────────────────
describe("generateBaseIV", () => {
  it("returns a Uint8Array of exactly 12 bytes (AES-GCM standard IV)", async () => {
    const iv = await generateBaseIV();
    expect(iv).toBeInstanceOf(Uint8Array);
    expect(iv.byteLength).toBe(12);
  });

  it("is random on each call", async () => {
    const a = await generateBaseIV();
    const b = await generateBaseIV();
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });
});

// ── deriveKey ─────────────────────────────────────────────────────────────────
describe("deriveKey", () => {
  it("returns a non-extractable AES-GCM CryptoKey", async () => {
    const salt = await generateSalt();
    const key = await deriveKey("password123", salt);

    expect(key.type).toBe("secret");
    expect(key.algorithm.name).toBe("AES-GCM");
    expect(key.extractable).toBe(false);
    expect(key.usages).toContain("encrypt");
    expect(key.usages).toContain("decrypt");
  });

  it("derives the same key from the same password + salt", async () => {
    const password = "consistent-password";
    const salt = new Uint8Array(16).fill(42); // deterministic

    const key1 = await deriveKey(password, salt);
    const key2 = await deriveKey(password, salt);

    // Encrypt a known plaintext with key1 and decrypt with key2 to verify equivalence.
    const iv = new Uint8Array(12).fill(1);
    const plaintext = new TextEncoder().encode("test data");
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, plaintext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ciphertext);

    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });

  it("derives different keys for different passwords", async () => {
    const salt = new Uint8Array(16).fill(7);
    const key1 = await deriveKey("password-A", salt);
    const key2 = await deriveKey("password-B", salt);

    // Encrypt with key1, try to decrypt with key2 — should throw.
    const iv = new Uint8Array(12).fill(0);
    const plaintext = new TextEncoder().encode("secret");
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, plaintext);

    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ciphertext)
    ).rejects.toThrow();
  });

  it("derives different keys for different salts", async () => {
    const salt1 = new Uint8Array(16).fill(1);
    const salt2 = new Uint8Array(16).fill(2);
    const key1 = await deriveKey("same-password", salt1);
    const key2 = await deriveKey("same-password", salt2);

    const iv = new Uint8Array(12).fill(0);
    const plaintext = new TextEncoder().encode("data");
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key1, plaintext);

    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, key2, ciphertext)
    ).rejects.toThrow();
  });
});

// ── encryptChunk / decryptChunk ───────────────────────────────────────────────
describe("encryptChunk + decryptChunk", () => {
  async function makeKey(password = "test-password") {
    const salt = new Uint8Array(16).fill(5);
    return deriveKey(password, salt);
  }

  const baseIV = new Uint8Array(12).fill(0);

  it("roundtrip: encrypted data decrypts back to original plaintext", async () => {
    const key = await makeKey();
    const original = new TextEncoder().encode("Hello PandaShare — this is a test chunk!");

    const ciphertext = await encryptChunk(original.buffer, key, 0, baseIV);
    const decrypted = await decryptChunk(ciphertext, key, 0, baseIV);

    expect(new Uint8Array(decrypted)).toEqual(original);
  });

  it("ciphertext differs from plaintext (encryption actually transforms data)", async () => {
    const key = await makeKey();
    const plaintext = new TextEncoder().encode("unencrypted text");

    const ciphertext = await encryptChunk(plaintext.buffer, key, 0, baseIV);

    expect(new Uint8Array(ciphertext)).not.toEqual(plaintext);
  });

  it("different chunkIndex produces different ciphertext (IV derivation works)", async () => {
    const key = await makeKey();
    const plaintext = new TextEncoder().encode("same data for both chunks");

    const ct0 = await encryptChunk(plaintext.buffer, key, 0, baseIV);
    const ct1 = await encryptChunk(plaintext.buffer, key, 1, baseIV);

    expect(new Uint8Array(ct0)).not.toEqual(new Uint8Array(ct1));
  });

  it("decryption fails with a different key", async () => {
    const key1 = await makeKey("password-1");
    const key2 = await makeKey("password-2");
    const plaintext = new TextEncoder().encode("secret data");

    const ciphertext = await encryptChunk(plaintext.buffer, key1, 0, baseIV);

    await expect(decryptChunk(ciphertext, key2, 0, baseIV)).rejects.toThrow();
  });

  it("decryption fails when using wrong chunkIndex (tampered IV)", async () => {
    const key = await makeKey();
    const plaintext = new TextEncoder().encode("chunk zero data");

    const ciphertext = await encryptChunk(plaintext.buffer, key, 0, baseIV);

    // Decrypting chunk 0 ciphertext as if it were chunk 1 — different IV → should fail.
    await expect(decryptChunk(ciphertext, key, 1, baseIV)).rejects.toThrow();
  });

  it("handles an empty plaintext buffer without throwing", async () => {
    const key = await makeKey();
    const empty = new ArrayBuffer(0);

    const ciphertext = await encryptChunk(empty, key, 0, baseIV);
    const decrypted = await decryptChunk(ciphertext, key, 0, baseIV);

    expect(new Uint8Array(decrypted).byteLength).toBe(0);
  });

  it("works correctly for large chunk-index values", async () => {
    const key = await makeKey();
    const plaintext = new TextEncoder().encode("high index chunk");

    const ciphertext = await encryptChunk(plaintext.buffer, key, 127, baseIV);
    const decrypted = await decryptChunk(ciphertext, key, 127, baseIV);

    expect(new Uint8Array(decrypted)).toEqual(plaintext);
  });
});

// ── computeVerifier ───────────────────────────────────────────────────────────
describe("computeVerifier", () => {
  it("returns a 64-character lowercase hex string", async () => {
    const verifier = await computeVerifier("my-room", "password123");
    expect(typeof verifier).toBe("string");
    expect(verifier).toHaveLength(64);
    expect(verifier).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic — same inputs always produce the same verifier", async () => {
    const v1 = await computeVerifier("test-room", "secret");
    const v2 = await computeVerifier("test-room", "secret");
    expect(v1).toBe(v2);
  });

  it("produces different verifiers for different room names", async () => {
    const v1 = await computeVerifier("room-A", "password");
    const v2 = await computeVerifier("room-B", "password");
    expect(v1).not.toBe(v2);
  });

  it("produces different verifiers for different passwords", async () => {
    const v1 = await computeVerifier("same-room", "password-1");
    const v2 = await computeVerifier("same-room", "password-2");
    expect(v1).not.toBe(v2);
  });
});

// ── generatePassword ──────────────────────────────────────────────────────────
describe("generatePassword", () => {
  it("generates a password of the requested length (default 16)", () => {
    const pw = generatePassword();
    expect(pw).toHaveLength(16);
  });

  it("generates a password of a custom length", () => {
    expect(generatePassword(24)).toHaveLength(24);
    expect(generatePassword(8)).toHaveLength(8);
  });

  it("only uses characters from the defined charset", () => {
    const charset = /^[a-zA-Z0-9!@#$%^&*()_+]+$/;
    for (let i = 0; i < 20; i++) {
      expect(generatePassword(32)).toMatch(charset);
    }
  });

  it("produces different passwords on each call", () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generatePassword()));
    // With 16-char passwords from a ~76-char charset, the chance of any collision
    // in 20 samples is astronomically small.
    expect(passwords.size).toBeGreaterThan(15);
  });
});

// ── generateRoomName ──────────────────────────────────────────────────────────
describe("generateRoomName", () => {
  it("returns a lowercase string matching Adj-Noun-Num pattern", () => {
    const name = generateRoomName();
    // e.g. "secure-panda-42"
    expect(name).toMatch(/^[a-z]+-[a-z]+-\d+$/);
  });

  it("returns only lowercase characters (passes room name validation)", () => {
    for (let i = 0; i < 20; i++) {
      const name = generateRoomName();
      expect(name).toBe(name.toLowerCase());
      // Must match the backend validation regex
      expect(name).toMatch(/^[a-zA-Z0-9\-_]+$/);
    }
  });

  it("produces different names across calls (random selection)", () => {
    const names = new Set(Array.from({ length: 30 }, () => generateRoomName()));
    // With 9 adjectives × 9 nouns × 1000 numbers = 81 000 combinations,
    // 30 samples will very rarely repeat.
    expect(names.size).toBeGreaterThan(20);
  });
});
