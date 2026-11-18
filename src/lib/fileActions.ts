let activePrintFrame: HTMLIFrameElement | null = null;
let activePrintCleanupTimer: number | null = null;

function cleanupPrintFrame(frame: HTMLIFrameElement | null) {
  if (activePrintCleanupTimer !== null && typeof window !== 'undefined') {
    window.clearTimeout(activePrintCleanupTimer);
    activePrintCleanupTimer = null;
  }
  if (frame && frame.parentNode) {
    frame.parentNode.removeChild(frame);
  }
  if (activePrintFrame === frame) {
    activePrintFrame = null;
  }
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

/**
 * Loads an HTML document into a hidden same-page iframe, waits for load and fonts,
 * and invokes print() without window.open so popups/PWAs are not blocked.
 */
export async function printHtml(html: string): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  if (activePrintFrame) {
    cleanupPrintFrame(activePrintFrame);
  }

  await new Promise<void>((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '0';
    iframe.style.height = '0';
    iframe.style.border = '0';
    iframe.style.opacity = '0';
    iframe.style.pointerEvents = 'none';
    activePrintFrame = iframe;

    let finished = false;
    const triggerCleanupAfterPrint = () => {
      cleanupPrintFrame(iframe);
    };

    iframe.onload = async () => {
      if (finished) return;
      finished = true;
      try {
        const win = iframe.contentWindow;
        const doc = iframe.contentDocument;
        if (!win || !doc) {
          cleanupPrintFrame(iframe);
          reject(new Error('Print frame unavailable.'));
          return;
        }

        if (doc.fonts?.ready) {
          await Promise.race([
            doc.fonts.ready.catch(() => undefined),
            new Promise<void>((r) => window.setTimeout(r, 400)),
          ]);
        }

        win.addEventListener('afterprint', triggerCleanupAfterPrint, { once: true });
        activePrintCleanupTimer = window.setTimeout(triggerCleanupAfterPrint, 60_000);

        win.focus();
        win.print();
        resolve();
      } catch (err) {
        cleanupPrintFrame(iframe);
        reject(err);
      }
    };

    iframe.onerror = () => {
      if (finished) return;
      finished = true;
      cleanupPrintFrame(iframe);
      reject(new Error('Failed to load print document.'));
    };

    iframe.srcdoc = html;
    document.body.appendChild(iframe);
  });
}
