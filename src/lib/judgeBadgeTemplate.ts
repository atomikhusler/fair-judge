export interface JudgeBadgeTemplateData {
  judgeName: string;
  orgName: string;
  orgId: string;
  judgeId: string;
}

export const JUDGE_BADGE_WIDTH = 1080;
export const JUDGE_BADGE_HEIGHT = 1350;

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
  border: 1px solid #d4d4d8;
  border-radius: 48px;
  padding: 28px;
  font-family: 'Geist', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  color: #111111;
  overflow: hidden;
  -webkit-font-smoothing: antialiased;
}

.badge .frame {
  width: 100%;
  height: 100%;
  background: #ffffff;
  border: 3px solid #c9a24a;
  border-radius: 26px;
  padding: 14px 36px 12px 36px;
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
  gap: 16px;
  margin: 0;
  flex-shrink: 0;
}

.badge .brand .logo {
  width: 52px;
  height: 52px;
  fill: none;
  stroke: #0d3b2e;
  stroke-width: 2.2;
  stroke-linecap: round;
  stroke-linejoin: round;
  flex-shrink: 0;
}

.badge .brand .app-name {
  font-size: 56px;
  font-weight: 600;
  line-height: 1.05;
  letter-spacing: -0.02em;
  color: #0d3b2e;
}

.badge .tagline {
  margin: 4px 0 0 0;
  font-size: 26px;
  font-weight: 600;
  line-height: 1.1;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: #b8893a;
  flex-shrink: 0;
}

.badge .judge-name {
  margin: 8px 0 0 0;
  width: 100%;
  font-size: 128px;
  font-weight: 700;
  line-height: 1.02;
  letter-spacing: -0.025em;
  color: #111111;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: anywhere;
  max-height: 264px;
  flex-shrink: 0;
}

.badge .judge-name.judge-name--compact {
  font-size: 64px;
  line-height: 1.04;
  max-height: 136px;
}

.badge .org-name {
  margin: 6px 0 0 0;
  width: 100%;
  max-width: 92%;
  font-size: 44px;
  font-weight: 500;
  line-height: 1.1;
  color: #555555;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  text-overflow: ellipsis;
  overflow-wrap: anywhere;
  max-height: 98px;
  flex-shrink: 0;
}

.badge .ids {
  margin: 8px 0 0 0;
  width: 100%;
  background: #ffffff;
  border: 1px solid #e5e5e5;
  border-radius: 24px;
  padding: 8px 24px;
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
  min-width: 0;
  padding: 0 12px;
}

.badge .ids .divider {
  width: 1px;
  height: 62px;
  background: #e5e5e5;
}

.badge .ids .label {
  display: block;
  font-size: 24px;
  font-weight: 600;
  line-height: 1.15;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #71717a;
}

.badge .ids .value {
  display: block;
  margin-top: 4px;
  max-width: 100%;
  font-size: 48px;
  font-weight: 600;
  line-height: 1.1;
  color: #111111;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.badge .qr-panel {
  margin: auto 0;
  padding: 40px;
  background: #ffffff;
  border: 1px solid #e5e5e5;
  border-radius: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.badge .qr-panel svg {
  width: 620px;
  height: 620px;
  display: block;
}

.badge .scan-line {
  margin: 0;
  font-size: 34px;
  font-weight: 500;
  line-height: 1.15;
  color: #444444;
  flex-shrink: 0;
}

.badge .dev-line {
  margin: 6px 0 0 0;
  padding-top: 6px;
  width: 100%;
  border-top: 1px solid #e5e5e5;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace;
  font-size: 26px;
  font-weight: 500;
  line-height: 1.15;
  color: #777777;
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
    <p class="tagline">JUDGE TRANSPARENTLY</p>
    <h1 class="{{JUDGE_NAME_CLASS}}">{{JUDGE_NAME}}</h1>
    <p class="org-name">{{ORG_NAME}}</p>
    <div class="ids">
      <div><span class="label">ORG ID</span><span class="value">{{ORG_ID}}</span></div>
      <div class="divider"></div>
      <div><span class="label">JUDGE ID</span><span class="value">{{JUDGE_ID}}</span></div>
    </div>
    <div class="qr-panel">{{QR_SVG}}</div>
    <p class="scan-line">Scan with terminal camera to sign in</p>
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

  const judgeNameClass =
    cleanJudgeName.length > 13 ? 'judge-name judge-name--compact' : 'judge-name';

  return BADGE_HTML_TEMPLATE
    .replace('{{JUDGE_NAME_CLASS}}', judgeNameClass)
    .replace('{{JUDGE_NAME}}', escapeHtml(cleanJudgeName))
    .replace('{{ORG_NAME}}', escapeHtml(cleanOrgName))
    .replace('{{ORG_ID}}', escapeHtml(cleanOrgId))
    .replace('{{JUDGE_ID}}', escapeHtml(cleanJudgeId))
    .replace('{{QR_SVG}}', qrSvg);
}
