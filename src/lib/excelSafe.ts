/**
 * Neutralizes spreadsheet formula injection (CWE-1236) in Excel/CSV exports.
 * Prefixes any string cell starting with =, +, -, or @ with a leading apostrophe.
 * Numbers and other non-string types pass through unchanged.
 */
export function safeCell<T>(value: T): T | string {
  if (typeof value === 'string' && /^[=+\-@]/.test(value)) {
    return `'${value}`;
  }
  return value;
}
