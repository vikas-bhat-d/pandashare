import { Request, Response, NextFunction } from "express";
import { ZodError } from "zod";

export function errorHandler(
  err: Error & { code?: string },
  _req: Request,
  res: Response,
  _next: NextFunction
) {
  console.error("[ERROR]", err.message);

  // Zod validation error
  if (err instanceof ZodError) {
    return res.status(400).json({
      error: "Validation failed",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      details: err.issues.map((e: any) => ({
        field: String(e.path?.join?.(".") ?? ""),
        message: String(e.message ?? "Invalid value"),
      })),
    });
  }

  // Prisma unique constraint violation
  if (err.code === "P2002") {
    return res.status(409).json({ error: "Resource already exists" });
  }

  // Prisma record not found
  if (err.code === "P2025") {
    return res.status(404).json({ error: "Resource not found" });
  }

  // S3 NoSuchKey
  if (err.name === "NoSuchKey") {
    return res.status(404).json({ error: "Object not found in storage" });
  }

  res.status(500).json({ error: "Internal server error" });
}
