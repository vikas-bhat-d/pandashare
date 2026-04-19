import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Generate a RFC-4122 v4 UUID.
 *
 * Preference order:
 *  1. `crypto.randomUUID()` — fastest, requires a secure context (HTTPS / localhost)
 *  2. `crypto.getRandomValues()` — works on HTTP too (Android Chrome, mixed-content pages)
 *  3. `Math.random()` — weak last resort (should never be reached in a real browser)
 */
export function generateUUID(): string {
  // Secure context (HTTPS / localhost)
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Non-secure HTTP context — getRandomValues is still available
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, (c) => {
      const n = +c;
      return (n ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (n / 4)))).toString(16);
    });
  }
  // Final fallback
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}
