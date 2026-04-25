import { PrismaClient, RoomMode } from "@prisma/client";
import crypto from "crypto";

const prisma = new PrismaClient();

export interface CreateSnippetInput {
  name: string;
  mode: RoomMode;
  content: string; // plaintext for public, base64 ciphertext for password mode
  salt?: string;
  baseIV?: string;
  verifier?: string; // HMAC-SHA256(name|password) hex
  expiresInDays?: number;
}

/**
 * Create a new text snippet with optional encryption metadata.
 */
export async function createSnippet(input: CreateSnippetInput) {
  const days = Math.min(input.expiresInDays || 1, 30);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

  return prisma.textSnippet.create({
    data: {
      name: input.name.toLowerCase(),
      mode: input.mode,
      content: input.content,
      salt: input.salt || null,
      baseIV: input.baseIV || null,
      verifier: input.verifier || null,
      expiresAt,
    },
  });
}

/**
 * Look up a snippet by ID or name. Returns null if not found or expired.
 * Does NOT include content — call getSnippetContent for that.
 */
export async function getSnippet(nameOrId: string) {
  let snippet = await prisma.textSnippet.findUnique({
    where: { id: nameOrId },
    select: { id: true, name: true, mode: true, salt: true, baseIV: true, createdAt: true, expiresAt: true },
  });

  if (!snippet) {
    snippet = await prisma.textSnippet.findUnique({
      where: { name: nameOrId.toLowerCase() },
      select: { id: true, name: true, mode: true, salt: true, baseIV: true, createdAt: true, expiresAt: true },
    });
  }

  if (!snippet || new Date(snippet.expiresAt) < new Date()) {
    return null;
  }

  return snippet;
}

/**
 * Return snippet content if authorized.
 * Public snippets: always returns content.
 * Password snippets: requires correct verifier.
 */
export async function getSnippetContent(
  nameOrId: string,
  verifier?: string
): Promise<{ authorized: boolean; content?: string }> {
  let snippet = await prisma.textSnippet.findUnique({ where: { id: nameOrId } });
  if (!snippet) {
    snippet = await prisma.textSnippet.findUnique({ where: { name: nameOrId.toLowerCase() } });
  }

  if (!snippet || new Date(snippet.expiresAt) < new Date()) {
    return { authorized: false };
  }

  if (snippet.mode === "public") {
    return { authorized: true, content: snippet.content };
  }

  // Password mode — require verifier
  if (!verifier || !snippet.verifier) {
    return { authorized: false };
  }

  // Constant-time comparison to prevent timing attacks
  const storedBuf = Buffer.from(snippet.verifier, "hex");
  const providedBuf = Buffer.from(verifier, "hex");

  if (
    storedBuf.length !== providedBuf.length ||
    !crypto.timingSafeEqual(storedBuf, providedBuf)
  ) {
    return { authorized: false };
  }

  return { authorized: true, content: snippet.content };
}

/**
 * Update a snippet's expiry time, computed from its creation time.
 * Capped at 30 days from creation.
 */
export async function updateSnippetExpiry(id: string, days: number) {
  const snippet = await prisma.textSnippet.findUnique({
    where: { id },
    select: { createdAt: true },
  });
  if (!snippet) throw new Error("Snippet not found");
  const maxDays = Math.min(days, 30);
  const expiresAt = new Date(snippet.createdAt.getTime() + maxDays * 24 * 60 * 60 * 1000);
  return prisma.textSnippet.update({ where: { id }, data: { expiresAt } });
}

/**
 * Update the content of an existing snippet.
 * For password snippets, verifier must match before updating.
 * Accepts new salt and baseIV (for re-encryption on each save).
 */
export async function updateSnippetContent(
  id: string,
  content: string,
  verifier?: string,
  salt?: string,
  baseIV?: string
) {
  const snippet = await prisma.textSnippet.findUnique({ where: { id } });
  if (!snippet || new Date(snippet.expiresAt) < new Date()) {
    throw new Error("Snippet not found");
  }

  if (snippet.mode === "password") {
    if (!verifier || !snippet.verifier) throw new Error("Unauthorized");
    const storedBuf = Buffer.from(snippet.verifier, "hex");
    const providedBuf = Buffer.from(verifier, "hex");
    if (
      storedBuf.length !== providedBuf.length ||
      !crypto.timingSafeEqual(storedBuf, providedBuf)
    ) {
      throw new Error("Unauthorized");
    }
  }

  return prisma.textSnippet.update({
    where: { id },
    data: {
      content,
      ...(salt !== undefined ? { salt } : {}),
      ...(baseIV !== undefined ? { baseIV } : {}),
    },
    select: { id: true, name: true, mode: true, salt: true, baseIV: true, createdAt: true, expiresAt: true },
  });
}

/**
 * Delete a snippet by ID.
 */
export async function deleteSnippet(id: string) {
  return prisma.textSnippet.delete({ where: { id } });
}

/**
 * Return all expired snippets for cleanup.
 */
export async function getExpiredSnippets() {
  return prisma.textSnippet.findMany({
    where: { expiresAt: { lt: new Date() } },
  });
}
