export interface JudgeBadgeTemplateData {
  judgeName: string;
  orgName: string;
  orgId: string;
  judgeId: string;
  judgeCode?: string;
}

export const JUDGE_BADGE_WIDTH = 1080;
export const JUDGE_BADGE_HEIGHT = 1350;
export const JUDGE_BADGE_QR_SIZE = 440;

export function deriveJudgeCode(judgeName: string, judgeId?: string): string {
  const cleanName = (judgeName || '').trim();
  if (cleanName) {
    const words = cleanName
      .split(/\s+/)
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter(Boolean);
    if (words.length >= 2) {
      const code = words
        .map((w) => Array.from(w)[0] || '')
        .join('')
        .slice(0, 6)
        .toUpperCase();
      if (code) return code;
    }
    if (words.length === 1) {
      const chars = Array.from(words[0]);
      const code = (chars.length <= 5 ? chars : chars.slice(0, 3))
        .join('')
        .toUpperCase();
      if (code) return code;
    }
  }
  return (judgeId || '').trim().toUpperCase();
}

export const JUDGE_BADGE_STYLES = `
.badge,
.badge * {
  box-sizing: border-box;
  box-shadow: none;
  text-shadow: none;
  filter: none;
  background-image: none;
}

.badge {
  width: 1080px;
  height: 1350px;
  background: #ffffff;
  border: 1px solid #e2e8e4;
  border-radius: 40px;
  padding: 24px;
  font-family: 'Geist', 'Noto Sans Oriya', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #111614;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

.badge .frame {
  width: 100%;
  height: 100%;
  background: #ffffff;
  border: 1.5px solid #c5a059;
  border-radius: 24px;
  padding: 36px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  overflow: hidden;
}

.badge .brand {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin: 0;
  flex-shrink: 0;
}

.badge .brand .logo {
  width: 32px;
  height: 32px;
  fill: none;
  stroke: #111614;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}

.badge .brand .app-name {
  font-size: 34px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: -0.015em;
  color: #111614;
}

.badge .tagline {
  margin: 6px 0 0 0;
  font-size: 20px;
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: 0.22em;
  text-transform: uppercase;
  color: #b48b3e;
  flex-shrink: 0;
}

.badge .brand-rule {
  margin: 16px auto 0 auto;
  width: 96px;
  height: 1px;
  background: #e2e8e4;
  flex-shrink: 0;
}

.badge .org-name {
  margin: 20px 0 0 0;
  padding: 4px 0;
  width: 100%;
  max-width: 96%;
  font-family: 'Geist', 'Noto Sans Oriya', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 64px;
  font-weight: 600;
  line-height: 1.35;
  letter-spacing: -0.02em;
  color: #111614;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: break-word;
  max-height: 188px;
  flex-shrink: 0;
}

.badge .judge-name {
  margin: 12px 0 0 0;
  padding: 2px 0;
  width: 100%;
  max-width: 92%;
  font-family: 'Geist', 'Noto Sans Oriya', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  font-size: 46px;
  font-weight: 500;
  line-height: 1.22;
  letter-spacing: -0.01em;
  color: #111614;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: break-word;
  max-height: 120px;
  flex-shrink: 0;
}

.badge .judge-code {
  margin: 12px 0 0 0;
  padding: 6px 20px;
  background: #F1F3F2;
  border: 1px solid rgba(17, 22, 20, 0.2);
  border-radius: 9999px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #111614;
  flex-shrink: 0;
}

.badge .ids {
  margin: 20px 0 0 0;
  width: 100%;
  background: #f8faf9;
  border: 1px solid #e2e8e4;
  border-radius: 16px;
  padding: 16px 24px;
  display: grid;
  grid-template-columns: 1fr 1px 1fr;
  align-items: center;
  flex-shrink: 0;
}

.badge .ids > div:not(.divider) {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  min-width: 0;
  padding: 0 16px;
}

.badge .ids .divider {
  width: 1px;
  height: 52px;
  background: #dce4df;
}

.badge .ids .label {
  display: block;
  font-size: 24px;
  font-weight: 500;
  line-height: 1.2;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #5c7066;
}

.badge .ids .value {
  display: block;
  max-width: 100%;
  font-size: 36px;
  font-weight: 600;
  line-height: 1.2;
  letter-spacing: 0.02em;
  color: #111614;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge .qr-zone {
  width: 100%;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 0;
}

.badge .qr-panel {
  padding: 24px;
  background: #ffffff;
  border: 1px solid #e2e8e4;
  border-radius: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.badge .qr-panel svg {
  width: 440px;
  height: 440px;
  display: block;
}

.badge .scan-line {
  margin: 0;
  font-size: 28px;
  font-weight: 500;
  line-height: 1.25;
  color: #5c7066;
  flex-shrink: 0;
}

.badge .dev-line {
  margin: 12px 0 0 0;
  padding-top: 12px;
  width: 100%;
  border-top: 1px solid #e2e8e4;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.25;
  letter-spacing: 0.01em;
  color: #7b8f85;
  flex-shrink: 0;
}
`;

const BADGE_HTML_TEMPLATE = `<div class="badge">
  <div class="frame">
    <header class="brand">
      <svg class="logo" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 3v18" />
        <path d="M7 21h10" />
        <path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2" />
        <path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
        <path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z" />
      </svg>
      <span class="app-name">Fair Judge</span>
    </header>
    <p class="tagline">MANAGE &amp; EVALUATE FAIRLY</p>
    <div class="brand-rule" aria-hidden="true"></div>
    <h1 class="org-name">{{ORG_NAME}}</h1>
    <p class="judge-name">{{JUDGE_NAME}}</p>
    <span class="judge-code">Judge</span>
    <div class="ids">
      <div><span class="label">ORG ID</span><span class="value">{{ORG_ID}}</span></div>
      <div class="divider"></div>
      <div><span class="label">JUDGE ID</span><span class="value">{{JUDGE_ID}}</span></div>
    </div>
    <div class="qr-zone">
      <div class="qr-panel">{{QR_SVG}}</div>
    </div>
    <p class="scan-line">Scan to sign in</p>
    <footer class="dev-line">Engineered with intent · Sahil Kumar Rout</footer>
  </div>
</div>`;

function escapeHtml(value: string): string {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderBadgeHtml(data: JudgeBadgeTemplateData, qrSvg: string): string {
  const cleanJudgeName = (data.judgeName || 'Judge').trim() || 'Judge';
  const cleanOrgName = (data.orgName || 'Fair Judge').trim() || 'Fair Judge';
  const cleanOrgId = (data.orgId || '').trim();
  const cleanJudgeId = (data.judgeId || '').trim();

  return BADGE_HTML_TEMPLATE
    .replace('{{ORG_NAME}}', escapeHtml(cleanOrgName))
    .replace('{{JUDGE_NAME}}', escapeHtml(cleanJudgeName))
    .replace('{{ORG_ID}}', escapeHtml(cleanOrgId))
    .replace('{{JUDGE_ID}}', escapeHtml(cleanJudgeId))
    .replace('{{QR_SVG}}', qrSvg);
}
