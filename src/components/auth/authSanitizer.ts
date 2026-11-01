/**
 * SPA Error Sanitizer
 * Intercepts raw HTML dumps (e.g. <!DOCTYPE html>, <html, proxy timeouts, or Vite SPA fallbacks)
 * and normalizes them into human-readable network error messages.
 */

export const NETWORK_ERROR_CLEAN_MESSAGE =
  'Network Error: Unable to reach the database. Please check your connection.';

export function sanitizeAuthError(error: any): string {
  if (!error) return NETWORK_ERROR_CLEAN_MESSAGE;

  const raw = typeof error === 'string' 
    ? error 
    : error?.message || error?.error_description || error?.toString?.() || '';

  const lower = raw.toLowerCase();

  // Strict Interceptors: Detect HTML error responses or early websocket / proxy disconnects
  if (
    lower.includes('<!doctype html') ||
    lower.includes('<html') ||
    lower.includes('<body') ||
    lower.includes('send was called before connect') ||
    lower.includes('failed to fetch') ||
    lower.includes('networkerror') ||
    lower.includes('proxy error') ||
    lower.includes('502 bad gateway') ||
    lower.includes('504 gateway timeout') ||
    lower.includes('load failed')
  ) {
    return NETWORK_ERROR_CLEAN_MESSAGE;
  }

  return raw || NETWORK_ERROR_CLEAN_MESSAGE;
}
