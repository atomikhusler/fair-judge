import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Printer, X } from 'lucide-react';
import {
  ActivePrintSheet,
  closeActivePrintSheet,
  getActivePrintSheet,
  subscribePrintSheet,
  waitForDocumentFonts,
} from '../../lib/fileActions';

const PRINT_SHEET_STYLE_ID = 'fj-print-sheet-styles';

const PRINT_SHEET_RUNTIME_CSS = `
@media screen {
  #fj-print-sheet-portal {
    position: fixed;
    inset: 0;
    z-index: 9998;
    display: flex;
    flex-direction: column;
    background: #f4f4f5;
    color: #18181b;
  }
  #fj-print-sheet-content {
    width: 100%;
    max-width: 210mm;
    margin: 0 auto;
    background: #ffffff;
    color: #111827;
    padding: 16px;
    border-radius: 12px;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.08);
  }
  #fj-print-sheet-content .badge-page {
    height: auto;
    min-height: 0;
    padding: 16px 0;
    border-bottom: 1px dashed #d4d4d8;
  }
  #fj-print-sheet-content .badge-page:last-child {
    border-bottom: none;
  }
}

@media print {
  html.fj-printing-html,
  body.fj-printing {
    width: 100% !important;
    height: auto !important;
    min-height: 0 !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
    overflow: visible !important;
    -webkit-print-color-adjust: exact !important;
    print-color-adjust: exact !important;
  }
  body.fj-printing > *:not(#fj-print-sheet-portal) {
    display: none !important;
    visibility: hidden !important;
  }
  body.fj-printing #fj-print-sheet-portal {
    position: static !important;
    inset: auto !important;
    display: block !important;
    width: 100% !important;
    height: auto !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
    overflow: visible !important;
    visibility: visible !important;
  }
  body.fj-printing #fj-print-sheet-portal * {
    visibility: visible !important;
  }
  body.fj-printing #fj-print-sheet-portal .fj-print-sheet-toolbar {
    display: none !important;
  }
  body.fj-printing #fj-print-sheet-portal .fj-print-sheet-scroll {
    display: block !important;
    overflow: visible !important;
    padding: 0 !important;
    margin: 0 !important;
    height: auto !important;
    background: #ffffff !important;
  }
  body.fj-printing #fj-print-sheet-content {
    width: 100% !important;
    max-width: none !important;
    margin: 0 !important;
    padding: 0 !important;
    background: #ffffff !important;
    border-radius: 0 !important;
    box-shadow: none !important;
  }
  /* Restore semantic elements inside print sheet hidden by global print rule */
  body.fj-printing #fj-print-sheet-content header.brand {
    display: flex !important;
  }
  body.fj-printing #fj-print-sheet-content header:not(.brand) {
    display: block !important;
  }
  body.fj-printing #fj-print-sheet-content footer {
    display: block !important;
  }
  body.fj-printing #fj-print-sheet-content nav {
    display: block !important;
  }
}
`;

export function PrintSheetHost() {
  const [sheet, setSheet] = useState<ActivePrintSheet | null>(() => getActivePrintSheet());

  useEffect(() => {
    return subscribePrintSheet(setSheet);
  }, []);

  useEffect(() => {
    if (!sheet || typeof window === 'undefined' || typeof document === 'undefined') {
      return;
    }

    let cancelled = false;
    const prevTitle = document.title;
    const prevBodyOverflow = document.body.style.overflow;

    const existingStyle = document.getElementById(PRINT_SHEET_STYLE_ID);
    if (existingStyle) existingStyle.remove();

    const styleEl = document.createElement('style');
    styleEl.id = PRINT_SHEET_STYLE_ID;
    styleEl.textContent = `${sheet.scopedCss}\n${PRINT_SHEET_RUNTIME_CSS}`;
    document.head.appendChild(styleEl);

    document.documentElement.classList.add('fj-printing-html');
    document.body.classList.add('fj-printing');
    document.body.style.overflow = 'hidden';
    if (sheet.title) {
      document.title = sheet.title;
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeActivePrintSheet();
      }
    };

    const handleAfterPrint = () => {
      if (!cancelled) {
        closeActivePrintSheet();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('afterprint', handleAfterPrint, { once: true });

    let settleTimer: number | null = null;

    (async () => {
      await waitForDocumentFonts(document, 1500);
      if (cancelled) return;
      await new Promise<void>((resolve) => {
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          resolve();
        }, 250);
      });
      if (cancelled) return;
      sheet.onReadyToResolve();
      window.print();
    })();

    return () => {
      cancelled = true;
      if (settleTimer !== null) {
        window.clearTimeout(settleTimer);
        settleTimer = null;
      }
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('afterprint', handleAfterPrint);
      document.documentElement.classList.remove('fj-printing-html');
      document.body.classList.remove('fj-printing');
      document.body.style.overflow = prevBodyOverflow;
      document.title = prevTitle;
      if (styleEl.parentNode) {
        styleEl.parentNode.removeChild(styleEl);
      }
      sheet.onReadyToResolve();
    };
  }, [sheet]);

  if (!sheet || typeof document === 'undefined') {
    return null;
  }

  return createPortal(
    <div
      id="fj-print-sheet-portal"
      role="dialog"
      aria-modal="true"
      aria-label={sheet.title}
    >
      <div className="fj-print-sheet-toolbar shrink-0 flex items-center justify-between gap-3 px-4 py-3 bg-white border-b border-stone-200 shadow-xs">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-zinc-900 truncate">{sheet.title}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => window.print()}
            className="min-h-[40px] px-3.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <Printer className="w-4 h-4" />
            <span>Print</span>
          </button>
          <button
            type="button"
            onClick={closeActivePrintSheet}
            aria-label="Close print preview"
            className="min-h-[40px] px-3 rounded-xl bg-stone-100 hover:bg-stone-200 text-zinc-800 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
          >
            <X className="w-4 h-4" />
            <span>Close</span>
          </button>
        </div>
      </div>

      <div className="fj-print-sheet-scroll flex-1 overflow-auto p-4">
        <div
          id="fj-print-sheet-content"
          dangerouslySetInnerHTML={{ __html: sheet.bodyHtml }}
        />
      </div>
    </div>,
    document.body
  );
}
