import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { Organization, SupabaseJudge } from './supabaseTypes';
import { safeName } from './downloadUtils';
import { saveFile, printHtml } from './fileActions';

export const BADGE_WIDTH = 1080;
export const BADGE_HEIGHT = 1350;

const APP_NAME = 'Fair Judge';
const APP_TAGLINE = 'Judge transparently';
const SCAN_INSTRUCTION = 'Scan with terminal camera to sign in';
const DEVELOPER_CREDIT = 'Engineered with intent · Sahil Kumar Rout';
const FONT_STACK =
  '"Geist", ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
const MONO_STACK =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

// Exact TippingScaleIcon SVG vector paths from src/components/shared/BrandBadge.tsx
const SCALE_SVG_PATHS = [
  'M12 3v18',
  'M7 21h10',
  'M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2',
  'm2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z',
  'm16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z',
] as const;

interface BadgeModel {
  judgeName: string;
  orgName: string;
  orgId: string;
  judgeId: string;
  qrPayload: string;
  qrSvgMarkup: string;
  qrViewBoxSize: number;
  qrDarkPath: string;
}

function escapeHtml(str: string): string {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function extractQrVectorData(qrPayload: string): {
  svgMarkup: string;
  viewBoxSize: number;
  darkPath: string;
} {
  const svgMarkup = renderToStaticMarkup(
    React.createElement(QRCodeSVG, {
      value: qrPayload,
      size: 512,
      level: 'H',
      includeMargin: false,
      bgColor: '#FFFFFF',
      fgColor: '#09090B',
    })
  );

  const viewBoxMatch = svgMarkup.match(/viewBox="0 0 (\d+) (\d+)"/);
  const viewBoxSize = viewBoxMatch ? Number.parseInt(viewBoxMatch[1], 10) || 21 : 21;

  const pathMatches = Array.from(svgMarkup.matchAll(/<path[^>]*d="([^"]+)"[^>]*>/g));
  const darkPath =
    pathMatches.length >= 2
      ? pathMatches[1][1]
      : pathMatches.length === 1
      ? pathMatches[0][1]
      : '';

  return { svgMarkup, viewBoxSize, darkPath };
}

function buildBadgeModel(
  judge: SupabaseJudge,
  organization: Organization,
  qrPayload: string
): BadgeModel {
  const { svgMarkup, viewBoxSize, darkPath } = extractQrVectorData(qrPayload);
  return {
    judgeName: (judge.name || 'Judge').trim() || 'Judge',
    orgName: (organization.name || 'Fair Judge').trim() || 'Fair Judge',
    orgId: organization.org_id,
    judgeId: judge.judge_id || judge.id.slice(0, 6),
    qrPayload,
    qrSvgMarkup: svgMarkup,
    qrViewBoxSize: viewBoxSize,
    qrDarkPath: darkPath,
  };
}

function drawRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + r);
  ctx.lineTo(x + width, y + height - r);
  ctx.quadraticCurveTo(x + width, y + height, x + width - r, y + height);
  ctx.lineTo(x + r, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function wrapLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxLines: number
): string[] {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return [''];

  const words = clean.split(' ');
  const lines: string[] = [];
  let current = '';

  const pushEllipsized = (base: string) => {
    let clipped = base.trimEnd();
    while (clipped.length > 1 && ctx.measureText(`${clipped}…`).width > maxWidth) {
      clipped = clipped.slice(0, -1);
    }
    return `${clipped}…`;
  };

  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const candidate = current ? `${current} ${word}` : word;

    if (ctx.measureText(candidate).width <= maxWidth) {
      current = candidate;
      continue;
    }

    if (current) {
      if (lines.length + 1 >= maxLines) {
        const remaining = `${current} ${words.slice(i).join(' ')}`;
        lines.push(pushEllipsized(remaining));
        return lines;
      }
      lines.push(current);
      current = '';
      i -= 1;
    } else {
      // Single unbroken word wider than maxWidth: break by character
      let part = '';
      for (let c = 0; c < word.length; c++) {
        const nextPart = part + word[c];
        if (ctx.measureText(nextPart).width <= maxWidth) {
          part = nextPart;
        } else {
          if (lines.length + 1 >= maxLines) {
            lines.push(pushEllipsized(`${part}${word.slice(c)}`));
            return lines;
          }
          lines.push(part);
          part = word[c];
        }
      }
      current = part;
    }
  }

  if (current) {
    lines.push(current);
  }

  return lines.slice(0, maxLines);
}

async function ensureLocalGeistLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('400 32px Geist'),
        document.fonts.load('600 36px Geist'),
        document.fonts.load('700 64px Geist'),
      ]),
      new Promise<void>((r) => setTimeout(r, 350)),
    ]);
  } catch {
    // Fallback cleanly to local system sans-serif if Geist cannot be preloaded
  }
}

/**
 * Shared 1080x1350 canvas renderer for Judge Badge PNG downloads.
 * Uses local Geist font, offline BrandBadge scale Path2D geometry, and unmodified QR payload.
 * Never renders the Judge PIN.
 */
export async function renderJudgeBadgeCanvas(
  judge: SupabaseJudge,
  organization: Organization,
  qrPayload: string
): Promise<HTMLCanvasElement> {
  await ensureLocalGeistLoaded();

  const model = buildBadgeModel(judge, organization, qrPayload);
  const canvas = document.createElement('canvas');
  canvas.width = BADGE_WIDTH;
  canvas.height = BADGE_HEIGHT;

  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context unavailable.');
  }

  // Background
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(0, 0, BADGE_WIDTH, BADGE_HEIGHT);

  // Outer machined badge border
  drawRoundedRect(ctx, 24, 24, BADGE_WIDTH - 48, BADGE_HEIGHT - 48, 44);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#E4E4E7';
  ctx.stroke();

  // Top emerald accent bar
  ctx.save();
  drawRoundedRect(ctx, 24, 24, BADGE_WIDTH - 48, BADGE_HEIGHT - 48, 44);
  ctx.clip();
  ctx.fillStyle = '#059669';
  ctx.fillRect(24, 24, BADGE_WIDTH - 48, 14);
  ctx.restore();

  const centerX = BADGE_WIDTH / 2;

  // 1. Fair Judge Logo + App Name (centered row)
  ctx.font = `700 38px ${FONT_STACK}`;
  const appNameWidth = ctx.measureText(APP_NAME).width;
  const iconBoxSize = 62;
  const headerGap = 18;
  const totalHeaderWidth = iconBoxSize + headerGap + appNameWidth;
  const headerStartX = centerX - totalHeaderWidth / 2;
  const headerTopY = 82;

  // BrandBadge rounded emerald container
  drawRoundedRect(ctx, headerStartX, headerTopY, iconBoxSize, iconBoxSize, 16);
  ctx.fillStyle = 'rgba(16, 185, 129, 0.12)';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = 'rgba(16, 185, 129, 0.35)';
  ctx.stroke();

  // TippingScaleIcon Path2D strokes (viewBox 24x24 scaled cleanly)
  ctx.save();
  const iconInnerSize = 36;
  const iconOffset = (iconBoxSize - iconInnerSize) / 2;
  ctx.translate(headerStartX + iconOffset, headerTopY + iconOffset);
  ctx.scale(iconInnerSize / 24, iconInnerSize / 24);
  ctx.strokeStyle = '#059669';
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const d of SCALE_SVG_PATHS) {
    ctx.stroke(new Path2D(d));
  }
  ctx.restore();

  // App Name
  ctx.fillStyle = '#09090B';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `700 38px ${FONT_STACK}`;
  ctx.fillText(APP_NAME, headerStartX + iconBoxSize + headerGap, headerTopY + iconBoxSize / 2 + 1);

  // 2. Tagline: "Judge transparently"
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#059669';
  ctx.font = `700 22px ${MONO_STACK}`;
  ctx.fillText(APP_TAGLINE.toUpperCase(), centerX, 164);

  // Subtle horizontal divider
  ctx.fillStyle = '#E4E4E7';
  ctx.fillRect(108, 212, BADGE_WIDTH - 216, 2);

  // 3. Judge Full Name (wraps up to 2 lines)
  ctx.fillStyle = '#09090B';
  ctx.font = `700 58px ${FONT_STACK}`;
  const judgeLines = wrapLines(ctx, model.judgeName, BADGE_WIDTH - 140, 2);
  let cursorY = judgeLines.length === 1 ? 258 : 238;
  for (const line of judgeLines) {
    ctx.fillText(line, centerX, cursorY);
    cursorY += 68;
  }

  // 4. Organisation Name (truncates cleanly after 2 lines)
  ctx.fillStyle = '#52525B';
  ctx.font = `600 30px ${FONT_STACK}`;
  const orgLines = wrapLines(ctx, model.orgName, BADGE_WIDTH - 160, 2);
  let orgY = Math.max(cursorY + 12, 396);
  for (const line of orgLines) {
    ctx.fillText(line, centerX, orgY);
    orgY += 38;
  }

  // 5. Organisation ID & Judge ID strip (NO PIN!)
  const stripY = Math.max(orgY + 22, 492);
  const stripW = BADGE_WIDTH - 160;
  const stripH = 104;
  drawRoundedRect(ctx, 80, stripY, stripW, stripH, 24);
  ctx.fillStyle = '#F4F4F5';
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#E4E4E7';
  ctx.stroke();

  // Vertical divider between Org ID and Judge ID
  ctx.fillStyle = '#D4D4D8';
  ctx.fillRect(centerX - 1, stripY + 20, 2, stripH - 40);

  const leftColCenter = 80 + stripW / 4;
  const rightColCenter = 80 + (stripW * 3) / 4;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#71717A';
  ctx.font = `700 18px ${MONO_STACK}`;
  ctx.fillText('ORG ID', leftColCenter, stripY + 20);
  ctx.fillText('JUDGE ID', rightColCenter, stripY + 20);

  ctx.fillStyle = '#09090B';
  ctx.font = `700 30px ${MONO_STACK}`;
  ctx.fillText(model.orgId, leftColCenter, stripY + 50);
  ctx.fillText(model.judgeId, rightColCenter, stripY + 50);

  // 6. Large QR Code (centered in white frame)
  const qrFrameSize = 516;
  const qrFrameX = (BADGE_WIDTH - qrFrameSize) / 2;
  const qrFrameY = stripY + stripH + 34;

  drawRoundedRect(ctx, qrFrameX, qrFrameY, qrFrameSize, qrFrameSize, 32);
  ctx.fillStyle = '#FFFFFF';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#D4D4D8';
  ctx.stroke();

  if (model.qrDarkPath) {
    const qrPadding = 34;
    const qrDrawSize = qrFrameSize - qrPadding * 2;
    const scale = qrDrawSize / model.qrViewBoxSize;
    ctx.save();
    ctx.translate(qrFrameX + qrPadding, qrFrameY + qrPadding);
    ctx.scale(scale, scale);
    ctx.fillStyle = '#09090B';
    ctx.fill(new Path2D(model.qrDarkPath));
    ctx.restore();
  }

  // 7. Scan instruction line
  const scanTextY = qrFrameY + qrFrameSize + 28;
  ctx.fillStyle = '#3F3F46';
  ctx.font = `600 24px ${FONT_STACK}`;
  ctx.fillText(SCAN_INSTRUCTION, centerX, scanTextY);

  // 8. Developer credit line
  ctx.fillStyle = '#E4E4E7';
  ctx.fillRect(140, BADGE_HEIGHT - 110, BADGE_WIDTH - 280, 2);

  ctx.fillStyle = '#71717A';
  ctx.font = `600 21px ${MONO_STACK}`;
  ctx.fillText(DEVELOPER_CREDIT, centerX, BADGE_HEIGHT - 84);

  return canvas;
}

/**
 * Generates and downloads a 1080x1350 PNG judge badge through fileActions.saveFile().
 */
export async function exportJudgeBadgePng(
  judge: SupabaseJudge,
  organization: Organization,
  qrPayload: string
): Promise<string> {
  const canvas = await renderJudgeBadgeCanvas(judge, organization, qrPayload);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((out) => {
      if (out) {
        resolve(out);
      } else {
        reject(new Error('Failed to encode PNG badge.'));
      }
    }, 'image/png');
  });

  const fileName = `judge-badge-${safeName(judge.judge_id || judge.name)}-${safeName(judge.name)}.png`;
  await saveFile(blob, fileName);
  return fileName;
}

/**
 * Builds one offline HTML document containing one centred badge per A4 portrait page
 * using the bundled Geist font and inline Scale & QR SVGs (zero network requests, no PIN).
 * Prints via fileActions.printHtml().
 */
export function buildJudgeBadgesPrintHtml(
  judges: SupabaseJudge[],
  organization: Organization,
  getQrPayload: (judge: SupabaseJudge) => string
): string {
  const baseHref =
    typeof window !== 'undefined' ? `${window.location.origin}/` : '/';

  const logoSvgMarkup = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${SCALE_SVG_PATHS.map(
    (d) => `<path d="${d}" />`
  ).join('')}</svg>`;

  const pagesHtml = judges
    .map((judge) => {
      const model = buildBadgeModel(judge, organization, getQrPayload(judge));
      return `
        <section class="badge-page">
          <article class="badge-card">
            <div class="accent-bar"></div>
            <div class="badge-inner">
              <div class="brand-header">
                <div class="brand-row">
                  <div class="brand-icon">${logoSvgMarkup}</div>
                  <span class="brand-name">${escapeHtml(APP_NAME)}</span>
                </div>
                <p class="brand-tagline">${escapeHtml(APP_TAGLINE)}</p>
              </div>

              <div class="divider"></div>

              <div class="identity-block">
                <h1 class="judge-name">${escapeHtml(model.judgeName)}</h1>
                <p class="org-name">${escapeHtml(model.orgName)}</p>
              </div>

              <div class="id-strip">
                <div class="id-col">
                  <span class="id-label">ORG ID</span>
                  <span class="id-value">${escapeHtml(model.orgId)}</span>
                </div>
                <div class="id-divider"></div>
                <div class="id-col">
                  <span class="id-label">JUDGE ID</span>
                  <span class="id-value">${escapeHtml(model.judgeId)}</span>
                </div>
              </div>

              <div class="qr-section">
                <div class="qr-frame">
                  ${model.qrSvgMarkup}
                </div>
                <p class="scan-note">${escapeHtml(SCAN_INSTRUCTION)}</p>
              </div>

              <div class="badge-footer">
                <p class="dev-credit">${escapeHtml(DEVELOPER_CREDIT)}</p>
              </div>
            </div>
          </article>
        </section>
      `;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="${escapeHtml(baseHref)}" />
  <title>${escapeHtml(organization.name)} — Judge Badges</title>
  <style>
    @font-face {
      font-family: 'Geist';
      src: url('/fonts/Geist-Variable-latin.woff2') format('woff2');
      font-weight: 200 700;
      font-style: normal;
      font-display: swap;
    }

    @page {
      size: A4 portrait;
      margin: 10mm;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    html, body {
      background: #ffffff;
      color: #09090b;
      font-family: ${FONT_STACK};
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .badge-page {
      width: 100%;
      height: 274mm;
      display: flex;
      align-items: center;
      justify-content: center;
      break-after: page;
      page-break-after: always;
      break-inside: avoid;
      page-break-inside: avoid;
    }

    .badge-page:last-child {
      break-after: auto;
      page-break-after: auto;
    }

    .badge-card {
      width: 176mm;
      height: 220mm;
      background: #ffffff;
      border: 1.5pt solid #e4e4e7;
      border-radius: 10mm;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .accent-bar {
      height: 3.5mm;
      width: 100%;
      background: #059669;
      flex-shrink: 0;
    }

    .badge-inner {
      flex: 1;
      padding: 9mm 11mm 8mm 11mm;
      display: flex;
      flex-direction: column;
      align-items: center;
      text-align: center;
    }

    .brand-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2.5mm;
    }

    .brand-row {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 3mm;
    }

    .brand-icon {
      width: 10.5mm;
      height: 10.5mm;
      border-radius: 2.8mm;
      background: rgba(16, 185, 129, 0.12);
      border: 1pt solid rgba(16, 185, 129, 0.35);
      color: #059669;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 2mm;
    }

    .brand-icon svg {
      width: 100%;
      height: 100%;
    }

    .brand-name {
      font-size: 20pt;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: #09090b;
    }

    .brand-tagline {
      font-family: ${MONO_STACK};
      font-size: 9.5pt;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: #059669;
    }

    .divider {
      width: 100%;
      height: 0.75pt;
      background: #e4e4e7;
      margin: 4.5mm 0 5.5mm 0;
    }

    .identity-block {
      width: 100%;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2.5mm;
      margin-bottom: 5.5mm;
    }

    .judge-name {
      font-size: 27pt;
      font-weight: 700;
      line-height: 1.15;
      color: #09090b;
      max-width: 100%;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      overflow-wrap: anywhere;
    }

    .org-name {
      font-size: 14.5pt;
      font-weight: 600;
      line-height: 1.25;
      color: #52525b;
      max-width: 92%;
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
      text-overflow: ellipsis;
      overflow-wrap: anywhere;
    }

    .id-strip {
      width: 100%;
      display: grid;
      grid-template-columns: 1fr 0.75pt 1fr;
      align-items: center;
      background: #f4f4f5;
      border: 1pt solid #e4e4e7;
      border-radius: 4.5mm;
      padding: 3.8mm 4mm;
      margin-bottom: 6mm;
    }

    .id-col {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 1.2mm;
      min-width: 0;
    }

    .id-divider {
      width: 0.75pt;
      height: 10mm;
      background: #d4d4d8;
    }

    .id-label {
      font-family: ${MONO_STACK};
      font-size: 8.5pt;
      font-weight: 700;
      letter-spacing: 0.1em;
      color: #71717a;
      text-transform: uppercase;
    }

    .id-value {
      font-family: ${MONO_STACK};
      font-size: 15pt;
      font-weight: 700;
      color: #09090b;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .qr-section {
      flex: 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4.5mm;
      width: 100%;
    }

    .qr-frame {
      width: 84mm;
      height: 84mm;
      padding: 5.5mm;
      background: #ffffff;
      border: 1.25pt solid #d4d4d8;
      border-radius: 5.5mm;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .qr-frame svg {
      width: 100%;
      height: 100%;
      display: block;
    }

    .scan-note {
      font-size: 11.5pt;
      font-weight: 600;
      color: #3f3f46;
    }

    .badge-footer {
      width: 100%;
      border-top: 0.75pt solid #e4e4e7;
      padding-top: 4mm;
      margin-top: 4mm;
    }

    .dev-credit {
      font-family: ${MONO_STACK};
      font-size: 9.5pt;
      font-weight: 600;
      color: #71717a;
    }
  </style>
</head>
<body>
  ${pagesHtml}
</body>
</html>`;
}

/**
 * Prints all judges (one centred badge per A4 portrait page, in list order, no PIN)
 * through fileActions.printHtml().
 */
export async function exportJudgeBadgesPrint(
  judges: SupabaseJudge[],
  organization: Organization,
  getQrPayload: (judge: SupabaseJudge) => string
): Promise<void> {
  const html = buildJudgeBadgesPrintHtml(judges, organization, getQrPayload);
  await printHtml(html);
}
