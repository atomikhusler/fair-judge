/**
 * Fair Judge Client-Side QR Scanner & Fallback Engine
 * Uses native HTML5 window.BarcodeDetector API first (zero bundle overhead).
 * Falls back to dynamically imported jsQR for unsupported platforms (e.g., iOS Safari).
 */

export interface ParsedJudgeCredentials {
  orgId: string;
  judgeId: string;
  pin: string;
  eventId?: string;
}

/**
 * Extracts Judge credentials from decoded string (JSON or Base64-encoded JSON)
 */
export function extractJudgeCredentials(rawText: string): ParsedJudgeCredentials | null {
  if (!rawText) return null;
  const trimmed = rawText.trim();

  // Helper to validate and return credentials object
  const validateObj = (obj: any): ParsedJudgeCredentials | null => {
    if (!obj || typeof obj !== 'object') return null;
    const orgId = (obj.orgId || obj.org_id || '').toString().trim().toUpperCase();
    const judgeId = (obj.judgeId || obj.judge_id || obj.id || '').toString().trim().toUpperCase();
    const pin = (obj.pin || '').toString().trim();
    const eventId = (obj.eventId || obj.event_id || '').toString().trim();
    if (orgId && judgeId && pin) {
      return {
        orgId,
        judgeId,
        pin,
        ...(eventId ? { eventId } : {}),
      };
    }
    return null;
  };

  // 1. Try parsing directly as JSON
  try {
    const parsed = JSON.parse(trimmed);
    const valid = validateObj(parsed);
    if (valid) return valid;
  } catch {}

  // 2. Try parsing Base64-encoded JSON
  try {
    const decoded = atob(trimmed);
    const parsed = JSON.parse(decoded);
    const valid = validateObj(parsed);
    if (valid) return valid;
  } catch {}

  // 3. Check for URL query params (e.g. ?orgId=...&judgeId=...&pin=...&eventId=...)
  try {
    if (trimmed.includes('?') || trimmed.startsWith('http')) {
      const url = new URL(trimmed.startsWith('http') ? trimmed : `https://fairjudge.local/${trimmed}`);
      const orgId = url.searchParams.get('orgId') || url.searchParams.get('org_id') || '';
      const judgeId = url.searchParams.get('judgeId') || url.searchParams.get('judge_id') || url.searchParams.get('id') || '';
      const pin = url.searchParams.get('pin') || '';
      const eventId = url.searchParams.get('eventId') || url.searchParams.get('event_id') || '';
      if (orgId && judgeId && pin) {
        return {
          orgId: orgId.trim().toUpperCase(),
          judgeId: judgeId.trim().toUpperCase(),
          pin: pin.trim(),
          ...(eventId ? { eventId: eventId.trim() } : {}),
        };
      }
    }
  } catch {}

  return null;
}

/**
 * Client-Side Image Parser for QR Codes
 * Tiers:
 * 1. window.BarcodeDetector API (Native, Hardware Accelerated, 0-byte cost)
 * 2. jsQR micro-library (Dynamically loaded fallback)
 */
export async function parseQrCodeFromImageFile(file: File): Promise<string> {
  // Strategy 1: Attempt native BarcodeDetector API (Chrome, Edge, Android Webview)
  if (typeof window !== 'undefined' && 'BarcodeDetector' in window) {
    try {
      const BarcodeDetectorClass = (window as any).BarcodeDetector;
      const detector = new BarcodeDetectorClass({ formats: ['qr_code'] });
      const imageBitmap = await createImageBitmap(file);
      const barcodes = await detector.detect(imageBitmap);

      if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
        return barcodes[0].rawValue;
      }
    } catch (err) {
      console.warn('Native BarcodeDetector attempt completed without hit, proceeding to canvas fallback:', err);
    }
  }

  // Strategy 2: Client-side HTML Canvas + dynamic jsQR micro-library
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const img = new Image();

      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          if (!ctx) {
            return reject(new Error('Canvas 2D context is not supported on this device.'));
          }

          // Scale down high-resolution smartphone camera photos for rapid decoding
          let width = img.naturalWidth || img.width;
          let height = img.naturalHeight || img.height;
          const maxDim = 1200;

          if (width > maxDim || height > maxDim) {
            if (width > height) {
              height = Math.round((height * maxDim) / width);
              width = maxDim;
            } else {
              width = Math.round((width * maxDim) / height);
              height = maxDim;
            }
          }

          canvas.width = width;
          canvas.height = height;
          ctx.drawImage(img, 0, 0, width, height);

          const imageData = ctx.getImageData(0, 0, width, height);

          // Dynamically import jsQR only when needed to keep initial bundle tiny
          const jsQRModule: any = await import('jsqr');
          const jsQR = jsQRModule.default || jsQRModule;
          const code = jsQR(imageData.data, imageData.width, imageData.height, {
            inversionAttempts: 'attemptBoth',
          });

          if (code && code.data) {
            resolve(code.data);
          } else {
            reject(new Error('No clear QR code detected in this image. Please select a clearer photo.'));
          }
        } catch (err: any) {
          reject(err);
        }
      };

      img.onerror = () => reject(new Error('Failed to render selected image file.'));
      img.src = reader.result as string;
    };

    reader.onerror = () => reject(new Error('Could not read file from device storage.'));
    reader.readAsDataURL(file);
  });
}
