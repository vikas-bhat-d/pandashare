// apiClient.ts — Centralized HTTP client for PandaShare API

const BASE_URL = typeof window !== "undefined"
  ? (process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000")
  : "http://localhost:4000";

/**
 * Make a JSON API request. Automatically sets Content-Type and parses response.
 */
export async function apiJson<T>(
  path: string,
  options?: RequestInit
): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
    ...options,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `API error: ${res.status}`);
  }

  return res.json();
}

/**
 * Upload a binary chunk. Sets Content-Type to application/octet-stream.
 */
export async function apiBinary(
  path: string,
  body: ArrayBuffer
): Promise<{ ok: boolean }> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body,
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(errBody.error || `Upload failed: ${res.status}`);
  }

  return res.json();
}

/**
 * Download a binary chunk. Returns raw ArrayBuffer.
 */
export async function apiDownload(path: string): Promise<ArrayBuffer> {
  const res = await fetch(`${BASE_URL}${path}`);

  if (!res.ok) {
    throw new Error(`Download failed: ${res.status}`);
  }

  return res.arrayBuffer();
}
