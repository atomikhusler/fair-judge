import { eventBus } from './eventBus';

export interface PrintDocumentOptions {
  forceInApp?: boolean;
}

export interface ActivePrintSheet {
  id: number;
  title: string;
  bodyHtml: string;
  scopedCss: string;
  onReadyToResolve: () => void;
}

type PrintSheetListener = (sheet: ActivePrintSheet | null) => void;

const PRINT_SHEET_CONTENT_SCOPE = '#fj-print-sheet-content';
let nextPrintSheetId = 1;
let activePrintSheet: ActivePrintSheet | null = null;
const printSheetListeners = new Set<PrintSheetListener>();

function notifyPrintSheetListeners(): void {
  printSheetListeners.forEach((listener) => {
    try {
      listener(activePrintSheet);
    } catch {}
  });
}

export function getActivePrintSheet(): ActivePrintSheet | null {
  return activePrintSheet;
}

export function subscribePrintSheet(listener: PrintSheetListener): () => void {
  printSheetListeners.add(listener);
  return () => {
    printSheetListeners.delete(listener);
  };
}

export function closeActivePrintSheet(): void {
  if (!activePrintSheet) return;
  const closing = activePrintSheet;
  activePrintSheet = null;
  notifyPrintSheetListeners();
  closing.onReadyToResolve();
}

/**
 * Saves a Blob as a local file via a temporary anchor download link.
 */
export async function saveFile(blob: Blob, fileName: string): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  window.setTimeout(() => {
    if (anchor.parentNode) {
      anchor.parentNode.removeChild(anchor);
    }
    URL.revokeObjectURL(url);
  }, 1500);
}

export async function waitForDocumentFonts(doc: Document, timeoutMs: number = 1500): Promise<void> {
  if (!doc?.fonts) return;
  try {
    await Promise.race([
      Promise.all([
        doc.fonts.ready.catch(() => undefined),
        doc.fonts.load('500 46px Geist').catch(() => undefined),
        doc.fonts.load('600 64px Geist').catch(() => undefined),
        doc.fonts.load('500 46px "Noto Sans Oriya"', 'ଅ').catch(() => undefined),
        doc.fonts.load('600 64px "Noto Sans Oriya"', 'ଅ').catch(() => undefined),
      ]),
      new Promise<void>((resolve) => window.setTimeout(resolve, timeoutMs)),
    ]);
  } catch {
    // Proceed to print with system fallback if font preload fails
  }
}

function splitSelectorsOutsideDelimiters(selectorList: string): string[] {
  const parts: string[] = [];
  let current = '';
  let parenDepth = 0;
  let bracketDepth = 0;

  for (let i = 0; i < selectorList.length; i++) {
    const ch = selectorList[i];
    if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth = Math.max(0, bracketDepth - 1);

    if (ch === ',' && parenDepth === 0 && bracketDepth === 0) {
      if (current.trim()) parts.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

function scopeSingleSelector(selector: string, scope: string): string {
  const trimmed = selector.trim();
  if (!trimmed) return trimmed;
  if (/^(html|body|:root)$/i.test(trimmed)) {
    return scope;
  }
  if (/^(html|body)\s+/i.test(trimmed)) {
    return trimmed.replace(/^(html|body)\s+/i, `${scope} `);
  }
  if (/^(html|body)([.:#\[])/i.test(trimmed)) {
    return trimmed.replace(/^(html|body)/i, scope);
  }
  return `${scope} ${trimmed}`;
}

/**
 * Scopes extracted HTML document styles to the in-app print sheet container so
 * rules like `* { margin: 0 }` or `body { background: #fff }` never alter the
 * host app's theme or layout while preserving `@page` and `@font-face` rules.
 */
function scopePrintCss(rawCss: string, scope: string): string {
  const css = rawCss.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: string[] = [];
  let i = 0;
  const len = css.length;

  while (i < len) {
    while (i < len && /\s/.test(css[i])) i++;
    if (i >= len) break;

    const headerStart = i;
    while (i < len && css[i] !== '{' && css[i] !== ';') i++;
    if (i >= len) break;

    // Statement at-rule (e.g. @charset, @import)
    if (css[i] === ';') {
      const stmt = css.slice(headerStart, i + 1).trim();
      if (stmt) out.push(stmt);
      i++;
      continue;
    }

    const header = css.slice(headerStart, i).trim();
    // Read balanced block { ... }
    let depth = 0;
    const bodyStart = i + 1;
    while (i < len) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}') {
        depth--;
        if (depth === 0) break;
      }
      i++;
    }
    const body = css.slice(bodyStart, i);
    i++; // consume closing '}'

    if (/^@(font-face|page|keyframes|-webkit-keyframes)\b/i.test(header)) {
      out.push(`${header} {${body}}`);
    } else if (/^@(media|supports|layer)\b/i.test(header)) {
      out.push(`${header} {\n${scopePrintCss(body, scope)}\n}`);
    } else if (header.startsWith('@')) {
      out.push(`${header} {${body}}`);
    } else {
      const scopedSelectors = splitSelectorsOutsideDelimiters(header)
        .map((sel) => scopeSingleSelector(sel, scope))
        .join(', ');
      out.push(`${scopedSelectors} {${body}}`);
    }
  }

  return out.join('\n');
}

function extractPrintDocumentParts(
  html: string,
  title?: string
): { title: string; bodyHtml: string; scopedCss: string } {
  const parser = new DOMParser();
  const parsed = parser.parseFromString(html, 'text/html');

  const styleTexts: string[] = [];
  parsed.querySelectorAll('style').forEach((styleEl) => {
    if (styleEl.textContent) {
      styleTexts.push(styleEl.textContent);
    }
    styleEl.remove();
  });

  const resolvedTitle = (title || parsed.title || 'Print Preview').trim() || 'Print Preview';
  const bodyHtml = parsed.body ? parsed.body.innerHTML : html;
  const scopedCss = scopePrintCss(styleTexts.join('\n'), PRINT_SHEET_CONTENT_SCOPE);

  return {
    title: resolvedTitle,
    bodyHtml,
    scopedCss,
  };
}

function openInAppPrintSheet(html: string, title?: string): Promise<void> {
  const { title: resolvedTitle, bodyHtml, scopedCss } = extractPrintDocumentParts(html, title);

  return new Promise<void>((resolve) => {
    let settled = false;
    const resolveOnce = () => {
      if (settled) return;
      settled = true;
      resolve();
    };

    if (activePrintSheet) {
      const prev = activePrintSheet;
      activePrintSheet = null;
      prev.onReadyToResolve();
    }

    activePrintSheet = {
      id: nextPrintSheetId++,
      title: resolvedTitle,
      bodyHtml,
      scopedCss,
      onReadyToResolve: resolveOnce,
    };
    notifyPrintSheetListeners();
  });
}

/**
 * Shared print fallback chain used by all prints (Judge Badges PDF & Insights PDFs):
 * - Method A (default): synchronously opens a new tab (`window.open('', '_blank')`
 *   with zero awaits beforehand), writes HTML, waits for fonts (1500ms cap) + 250ms
 *   settle, focuses, and prints. Never falls back after a successful Method A open.
 * - Method B (automatic fallback ONLY when `window.open` returns null, OR explicit
 *   via `{ forceInApp: true }` from "Print in app"): mounts an in-app full-screen
 *   print sheet via portal to `document.body` and calls `window.print()`.
 */
export async function printDocument(
  html: string,
  title?: string,
  options?: PrintDocumentOptions
): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  if (options?.forceInApp) {
    await openInAppPrintSheet(html, title);
    return;
  }

  // Method A: MUST be called synchronously on click before any await
  const printWin = window.open('', '_blank');
  if (printWin) {
    printWin.document.open();
    printWin.document.write(html);
    printWin.document.close();
    if (title) {
      try {
        printWin.document.title = title;
      } catch {}
    }

    await waitForDocumentFonts(printWin.document, 1500);
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250));

    printWin.focus();
    printWin.print();
    return;
  }

  // Fallback rule: window.open returned null (pop-up blocked) -> Method B + info toast
  eventBus.emit('toast', {
    id: `toast_print_fallback_${Date.now()}`,
    type: 'info',
    title: 'Pop-ups are off, so printing from inside the app.',
    message: 'Pop-ups are off, so printing from inside the app.',
    duration: 3200,
  });

  await openInAppPrintSheet(html, title);
}

export const printHtml = printDocument;
