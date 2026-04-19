// apiClient.ts — Centralized HTTP client for PandaShare API

import { generateUUID } from "./utils";

const BASE_URL = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000")
  : "http://localhost:4000";

/**
 * Returns a stable UUID that identifies this browser instance.
 * Generated once on first call and persisted to localStorage under "ps_device_id".
 * Sent as x-device-id on every API request so the backend can enforce
 * per-device rate limits independently of the client IP address.
 *
 * Why localStorage instead of a cookie: works in all CORS configurations
 * without requiring credentials-mode or SameSite adjustments.
 */
function getDeviceId(): string {
  if (typeof window === "undefined" || typeof localStorage === "undefined") {
    // SSR / server-side calls — no persistent identity, skip header
    return "";
  }
  const KEY = "ps_device_id";
  let id = localStorage.getItem(KEY);
  if (!id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    id = generateUUID();
    localStorage.setItem(KEY, id);
  }
  return id;
}

/**
 * Custom error class for API failures
 */
export class ApiError extends Error {
  status: number;
  body: any;

  constructor(message: string, status: number, body?: any) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

/**
 * Make a JSON API request. Automatically sets Content-Type and parses response.
 */
export async function apiJson<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const deviceId = getDeviceId();
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...(deviceId ? { "x-device-id": deviceId } : {}),
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(body.error || `API error: ${res.status}`, res.status, body);
  }

  return res.json();
}

/**
 * Upload a binary chunk. Sets Content-Type to application/octet-stream.
 * Pass additional headers (e.g. x-file-name) via the optional `headers` param.
 */
export async function apiBinary(
  path: string,
  body: ArrayBuffer,
  headers?: Record<string, string>
): Promise<{ ok: boolean }> {
  const deviceId = getDeviceId();
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      ...(deviceId ? { "x-device-id": deviceId } : {}),
      ...headers,
    },
    body,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new ApiError(errBody.error || `Upload failed: ${res.status}`, res.status, errBody);
  }

  return res.json();
}

/**
 * Download a binary chunk. Returns raw ArrayBuffer.
 */
export async function apiDownload(path: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE_URL}${path}`);

  if (!res.ok) {
    throw new ApiError(`Download failed: ${res.status}`, res.status);
  }

  return res.arrayBuffer();
}
