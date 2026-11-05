// chromium-bidi's Node fallback uses the same Web Crypto API available in extension workers.
export const webcrypto = globalThis.crypto;
