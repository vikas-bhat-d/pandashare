// Node 18+ already exposes globalThis.crypto (Web Crypto API) as a getter on
// the global object, so no polyfill is needed. Just verify it's available.
if (typeof globalThis.crypto?.subtle === "undefined") {
  throw new Error(
    "Node.js >= 18 is required for frontend crypto tests (crypto.subtle must be available)"
  );
}
