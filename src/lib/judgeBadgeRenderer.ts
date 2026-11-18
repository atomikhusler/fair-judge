import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { QRCodeSVG } from 'qrcode.react';
import { toBlob } from 'html-to-image';
import { Organization, SupabaseJudge } from './supabaseTypes';
import { safeName } from './downloadUtils';
import { saveFile, printHtml } from './fileActions';
import {
  JUDGE_BADGE_HEIGHT,
  JUDGE_BADGE_STYLES,
  JUDGE_BADGE_WIDTH,
  JudgeBadgeTemplateData,
  renderBadgeHtml,
} from './judgeBadgeTemplate';

function buildQrSvgMarkup(qrPayload: string): string {
  return renderToStaticMarkup(
    React.createElement(QRCodeSVG, {
      value: qrPayload,
      size: 620,
      level: 'H',
      includeMargin: false,
      bgColor: '#FFFFFF',
      fgColor: '#111111',
    })
  );
}

function buildTemplateData(
  judge: SupabaseJudge,
  organization: Organization
): JudgeBadgeTemplateData {
  return {
    judgeName: (judge.name || 'Judge').trim() || 'Judge',
    orgName: (organization.name || 'Fair Judge').trim() || 'Fair Judge',
    orgId: organization.org_id,
    judgeId: judge.judge_id || judge.id.slice(0, 6),
  };
}

async function ensureLocalGeistLoaded(): Promise<void> {
  if (typeof document === 'undefined' || !('fonts' in document)) return;
  try {
    await Promise.race([
      Promise.all([
        document.fonts.load('500 34px Geist'),
        document.fonts.load('600 56px Geist'),
        document.fonts.load('700 128px Geist'),
      ]),
      new Promise<void>((r) => window.setTimeout(r, 400)),
    ]);
  } catch {
    // Fallback cleanly to system sans-serif if font preload fails
  }
}

/**
 * Renders the 1080x1350 judge badge template via html-to-image (pixelRatio: 1)
 * and saves through fileActions.saveFile() as judge-badge-<judge_id>.png.
 * Never renders the Judge PIN.
 */
export async function exportJudgeBadgePng(
  judge: SupabaseJudge,
  organization: Organization,
  qrPayload: string
): Promise<string> {
  if (typeof document === 'undefined') {
    throw new Error('Badge export is only supported in the browser.');
  }

  await ensureLocalGeistLoaded();

  const data = buildTemplateData(judge, organization);
  const qrSvg = buildQrSvgMarkup(qrPayload);
  const badgeMarkup = renderBadgeHtml(data, qrSvg);

  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.position = 'fixed';
  host.style.left = '-10000px';
  host.style.top = '0';
  host.style.width = `${JUDGE_BADGE_WIDTH}px`;
  host.style.height = `${JUDGE_BADGE_HEIGHT}px`;
  host.style.pointerEvents = 'none';
  host.style.opacity = '1';
  host.style.zIndex = '-1';
  host.innerHTML = `<style>${JUDGE_BADGE_STYLES}</style>${badgeMarkup}`;

  document.body.appendChild(host);

  try {
    const badgeEl = host.querySelector('.badge') as HTMLElement | null;
    if (!badgeEl) {
      throw new Error('Failed to mount badge template.');
    }

    const blob = await toBlob(badgeEl, {
      width: JUDGE_BADGE_WIDTH,
      height: JUDGE_BADGE_HEIGHT,
      canvasWidth: JUDGE_BADGE_WIDTH,
      canvasHeight: JUDGE_BADGE_HEIGHT,
      pixelRatio: 1,
      backgroundColor: '#ffffff',
    });

    if (!blob) {
      throw new Error('Failed to encode PNG badge.');
    }

    const fileName = `judge-badge-${safeName(data.judgeId)}.png`;
    await saveFile(blob, fileName);
    return fileName;
  } finally {
    if (host.parentNode) {
      host.parentNode.removeChild(host);
    }
  }
}

/**
 * Builds one offline HTML document containing one centred badge per A4 portrait page
 * using the exact renderBadgeHtml() output and JUDGE_BADGE_STYLES (zero network calls, no PIN).
 */
export function buildJudgeBadgesPrintHtml(
  judges: SupabaseJudge[],
  organization: Organization,
  getQrPayload: (judge: SupabaseJudge) => string
): string {
  const baseHref =
    typeof window !== 'undefined' ? `${window.location.origin}/` : '/';

  const pagesHtml = judges
    .map((judge) => {
      const data = buildTemplateData(judge, organization);
      const qrSvg = buildQrSvgMarkup(getQrPayload(judge));
      const badgeMarkup = renderBadgeHtml(data, qrSvg);
      return `<section class="badge-page"><div class="badge-slot"><div class="badge-scale">${badgeMarkup}</div></div></section>`;
    })
    .join('\n');

  const safeOrgTitle = (organization.name || 'Fair Judge')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <base href="${baseHref}" />
  <title>${safeOrgTitle} — Judge Badges</title>
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

    html, body {
      margin: 0;
      padding: 0;
      background: #ffffff;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }

    .badge-page {
      width: 100%;
      height: 274mm;
      display: flex;
      align-items: center;
      justify-content: center;
      page-break-after: always;
      break-after: page;
      page-break-inside: avoid;
      break-inside: avoid;
    }

    .badge-page:last-child {
      page-break-after: auto;
      break-after: auto;
    }

    .badge-slot {
      width: 180mm;
      height: 225mm;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }

    .badge-scale {
      width: 1080px;
      height: 1350px;
      flex-shrink: 0;
      transform: scale(0.6296);
      transform-origin: center center;
    }

    ${JUDGE_BADGE_STYLES}
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
