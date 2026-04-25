import { Router } from "express";
import { z } from "zod";
import * as textService from "../services/text.service";
import { validate } from "../middleware/validate";

const router = Router();

// ──────────────────────────────────────
// Schemas
// ──────────────────────────────────────

const createSnippetSchema = z.object({
  name: z
    .string()
    .min(1, "Snippet name is required")
    .max(100, "Snippet name must be under 100 characters")
    .regex(/^[a-zA-Z0-9\-_]+$/, "Name can only contain letters, numbers, hyphens, and underscores"),
  mode: z.enum(["password", "public"]),
  content: z.string().min(1, "Content is required").max(200_000, "Content must be under 200KB"),
  salt: z.string().optional(),
  baseIV: z.string().optional(),
  verifier: z.string().regex(/^[0-9a-f]{64}$/, "verifier must be a 64-char hex string").optional(),
  expiresInDays: z.number().min(1).max(30).optional(),
});

const updateSnippetContentSchema = z.object({
  content: z.string().min(0).max(200_000, "Content must be under 200KB"),
  salt: z.string().optional(),
  baseIV: z.string().optional(),
});

const updateSnippetExpirySchema = z.object({
  days: z.number().min(1).max(30),
});

// ──────────────────────────────────────
// Helpers
// ──────────────────────────────────────

function serializeSnippet(snippet: any) {
  return { ...snippet, verifier: undefined };
}

// ──────────────────────────────────────
// Routes
// ──────────────────────────────────────

/**
 * POST /api/snippets — Create a new text snippet
 */
router.post("/snippets", validate(createSnippetSchema), async (req, res, next) => {
  try {
    const { mode, verifier } = req.body;
    if (mode === "password" && !verifier) {
      return res.status(400).json({ error: "Password snippets require a verifier" });
    }

    const snippet = await textService.createSnippet(req.body);
    res.status(201).json(serializeSnippet(snippet));
  } catch (err: any) {
    if (err.code === "P2002") {
      return res.status(409).json({ error: "A snippet with this name already exists" });
    }
    next(err);
  }
});

/**
 * GET /api/snippets/:nameOrId — Get snippet metadata (no content)
 */
router.get("/snippets/:nameOrId", async (req, res, next) => {
  try {
    const nameOrId = decodeURIComponent(req.params.nameOrId as string);
    const snippet = await textService.getSnippet(nameOrId);
    if (!snippet) {
      return res.status(404).json({ error: "Snippet not found or expired" });
    }
    res.json(serializeSnippet(snippet));
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/snippets/:nameOrId/content — Get snippet content
 * Public snippets: no auth needed.
 * Password snippets: requires x-snippet-verifier header.
 */
router.get("/snippets/:nameOrId/content", async (req, res, next) => {
  try {
    const nameOrId = decodeURIComponent(req.params.nameOrId as string);
    const verifier = req.headers["x-snippet-verifier"] as string | undefined;

    const { authorized, content } = await textService.getSnippetContent(nameOrId, verifier);

    if (!authorized) {
      return res.status(401).json({ error: "Unauthorized — wrong or missing password" });
    }

    res.json({ content });
  } catch (err) {
    next(err);
  }
});

/**
 * PATCH /api/snippets/:id/content — Update snippet content (re-encrypts on save)
 */
router.patch(
  "/snippets/:id/content",
  validate(updateSnippetContentSchema),
  async (req, res, next) => {
    try {
      const verifier = req.headers["x-snippet-verifier"] as string | undefined;
      const snippet = await textService.updateSnippetContent(
        req.params.id as string,
        req.body.content,
        verifier,
        req.body.salt,
        req.body.baseIV
      );
      res.json(serializeSnippet(snippet));
    } catch (err: any) {
      if (err.message === "Snippet not found") return res.status(404).json({ error: "Snippet not found" });
      if (err.message === "Unauthorized") return res.status(401).json({ error: "Unauthorized" });
      next(err);
    }
  }
);

/**
 * PATCH /api/snippets/:id/expiry — Update snippet expiry (relative to creation time)
 */
router.patch(
  "/snippets/:id/expiry",
  validate(updateSnippetExpirySchema),
  async (req, res, next) => {
    try {
      const snippet = await textService.updateSnippetExpiry(
        req.params.id as string,
        req.body.days
      );
      res.json({ expiresAt: snippet.expiresAt });
    } catch (err: any) {
      if (err.message === "Snippet not found") {
        return res.status(404).json({ error: "Snippet not found" });
      }
      next(err);
    }
  }
);

export default router;
