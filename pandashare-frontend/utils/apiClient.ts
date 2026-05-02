// apiClient.ts — Centralized HTTP client for PandaShare API (axios-based)

import axios, { AxiosError, AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import { generateUUID } from "./utils";

export const BASE_URL = typeof window !== "undefined"
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
 * Axios instance configured for PandaShare API
 */
const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  timeout: 60000, // 60s timeout for API requests (not for S3 uploads)
  headers: {
    "Content-Type": "application/json",
  },
});

// Request interceptor: Add device ID to all requests
apiClient.interceptors.request.use((config) => {
  const deviceId = getDeviceId();
  if (deviceId) {
    config.headers["x-device-id"] = deviceId;
  }
  return config;
});

// Response interceptor: Convert axios errors to ApiError
apiClient.interceptors.response.use(
  (response: AxiosResponse) => response,
  (error: AxiosError) => {
    if (error.response) {
      const body = error.response.data;
      const message = (body as any)?.error || `API error: ${error.response.status}`;
      throw new ApiError(message, error.response.status, body);
    }
    throw error;
  }
);

/**
 * Make a JSON API request. Automatically parses response.
 */
export async function apiJson<T>(
  path: string,
  config?: AxiosRequestConfig
): Promise<T> {
  const response = await apiClient.request<T>({
    url: path,
    method: config?.method || "GET",
    ...config,
  });
  return response.data;
}

/**
 * Upload a binary chunk. Sets Content-Type to application/octet-stream.
 */
export async function apiBinary(
  path: string,
  body: ArrayBuffer,
  headers?: Record<string, string>
): Promise<{ ok: boolean }> {
  const response = await apiClient.post<{ ok: boolean }>(path, body, {
    headers: {
      "Content-Type": "application/octet-stream",
      ...headers,
    },
  });
  return response.data;
}

/**
 * Download a binary chunk. Returns raw ArrayBuffer.
 */
export async function apiDownload(path: string): Promise<ArrayBuffer> {
  const response = await apiClient.get<ArrayBuffer>(path, {
    responseType: "arraybuffer",
  });
  return response.data;
}

/**
 * Export the configured axios instance for direct use when needed
 * (e.g., for presigned URLs with custom progress callbacks)
 */
export { apiClient };
