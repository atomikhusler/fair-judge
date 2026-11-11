/**
 * Utility functions for generating sanitized, locally-timestamped download files
 * and triggering safe browser downloads.
 */

/**
 * Returns a local-time timestamp string formatted as "YYYY-MM-DD_HH-mm-ss".
 * Uses local getters (not UTC/toISOString) so the exported filename displays the user's local hour.
 */
export function stampLocal(d: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  return `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
}

/**
 * Normalizes an organization code or name for safe inclusion in filenames.
 * Lowercase, replaces non-alphanumeric chars with '-', trims leading/trailing '-',
 * enforces max 24 chars, and defaults to 'org'.
 */
export function safeName(s: string): string {
  if (!s || typeof s !== 'string') return 'org';
  const cleaned = s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const truncated = cleaned.slice(0, 24).replace(/^-+|-+$/g, '');
  return truncated || 'org';
}

/**
 * Serializes data to JSON and initiates a file download via an invisible anchor element.
 * Cleans up the object URL and DOM node after a 1-second timeout.
 * Returns the downloaded filename.
 */
export function downloadJson(filename: string, data: unknown): string {
  if (typeof window === 'undefined') return filename;
  const jsonStr = JSON.stringify(data, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) {
      a.parentNode.removeChild(a);
    }
    URL.revokeObjectURL(url);
  }, 1000);
  return filename;
}
